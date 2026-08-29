import { Bot, InlineKeyboard, type ApiClientOptions } from "grammy";
import { Agent } from "node:https";
import { inspect } from "node:util";
import { config } from "./config.js";
import {
  CHARACTER_AGE_BANDS,
  CHARACTER_GENDERS,
  FREE_TEXT_MAX,
  createUserCharacter,
  type CharacterGender,
} from "./character.js";
import {
  ensureTodayPlan,
  isAwayUnavail,
  type DayPlan,
  type PlanBlock,
} from "./day-plan.js";
import { ensureMonthPlan } from "./life-plan.js";
import { buildSystemBlocks, type BuildTrace } from "./context.js";
import {
  decideReplyTiming,
  recordHold,
  type TimingDecision,
} from "./reply-timing.js";
import {
  dropPendingReplies,
  dropWakeRows,
  isWaiting,
  schedulePendingReply,
  scheduleWakeRow,
  setPendingSender,
  setWakeHandler,
} from "./pending.js";
import { traceProactiveSend } from "./reply-trace.js";
import { chat, chatJson, type CallMeta, type ChatTurn } from "./llm.js";
import { saveTodayNote } from "./memory.js";
import { pickTags } from "./tag-pick.js";
import {
  currentSpeechLevel,
  db,
  getActiveCharacter,
  getDayPlan,
  getRecentMessages,
  getRecoveryMark,
  getRelationship,
  hasWaitingWakeRow,
  lastMessage,
  logMessage,
  recentUserGaps,
  setCallContext,
  setRecoveryMark,
  setSpeechLevel,
  type CharacterRow,
  type MessageRow,
  type PendingReplyRow,
} from "./db.js";
import {
  getKstNow,
  kstClock,
  kstDateString,
  logicalDayStartTs,
  timeMarkerFor,
} from "./kst.js";

// 캐릭터가 보내는 메시지의 종류 — 로그·플래그로 남겨 추적을 쉽게 한다
// reply=유저 메시지에 대한 답장, recover=배포로 놓친 답장 복구, morning=아침 선톡,
// checkin=긴 침묵 뒤 안부 선톡, away=자리비움 선톡(나갈 때·돌아왔을 때),
// catchup=낮의 근황 선톡, goodnight=밤 인사 선톡
export type SendKind =
  | "reply"
  | "recover"
  | "morning"
  | "checkin"
  | "away"
  | "catchup"
  | "goodnight";

// 텔레그램 API 연결 풀.
//
// 이 VM에서 선톡이 조용히 유실되던 실제 원인이 여기였다. long polling(getUpdates)은 96시간 동안
// 한 번도 안 깨졌는데 sendMessage만 반복 실패했다 — 경로가 죽은 게 아니라 '새 연결 수립'이
// 간헐적으로 죽는다(같은 순간에 이미 맺힌 연결로는 성공, 새 연결은 ETIMEDOUT).
// getUpdates가 소켓 하나를 30초 주기로 거의 항상 점유하므로, 몇 시간 만에 나가는 선톡은
// 재사용할 유휴 소켓이 없어 매번 새 연결이 됐다. 대화 중 답장이 멀쩡했던 건 몇 초 전에
// 반납된 소켓을 재사용했기 때문.
//
// grammY 기본 agent도 이미 keepAlive는 켜져 있다(platform.node.js). 빠졌던 건 '살려둘 유휴
// 소켓' 자체다 — 폴링이 유일한 소켓을 계속 붙잡고 있으니 풀이 늘 비어 있었다. 그래서 실제 해법은
// 아래 agent 설정이 아니라 keepConnectionWarm()이고, 여기서는 그 유휴 소켓이 오래 살아남게 돕는다.
const apiAgent = new Agent({
  keepAlive: true,
  keepAliveMsecs: 15_000, // TCP keepalive 프로브 — 중간 NAT이 유휴 연결을 끊지 않게
  maxSockets: 8,
  scheduling: "lifo", // 가장 최근에 쓴(=살아 있을 가능성이 높은) 소켓부터 재사용
});

// grammY(node)는 내부적으로 node-fetch를 쓰므로 agent 옵션이 실제로 먹지만,
// 타입은 전역 fetch(undici) 기준이라 agent를 모른다 — 이 한 지점만 좁게 단언한다.
const baseFetchConfig = {
  agent: apiAgent,
} as unknown as ApiClientOptions["baseFetchConfig"];

// client.timeoutSeconds는 건드리지 않는다 — 그 옵션은 getUpdates에도 걸리는데 long polling은
// 서버가 30초를 잡고 있어서, 짧게 잡으면 매 폴링이 통째로 취소된다. 발송만 아래 값으로 끊는다.
export const bot = new Bot(config.telegramToken, {
  client: { baseFetchConfig },
});

// 한 번의 발송 시도가 붙잡힐 수 있는 최대 시간. grammY 기본(500초)이나 OS의 TCP 타임아웃을
// 그대로 기다리면 발송 창 안에서 재시도가 몇 번 못 돈다.
const SEND_TIMEOUT_MS = 20_000;

// grammY의 시그니처는 abort-controller 폴리필의 AbortSignal 타입을 요구하는데(shim.node.d.ts),
// 런타임에는 node-fetch에 그대로 넘겨질 뿐이라 Node 네이티브 시그널로도 요청이 정상적으로 끊긴다.
// 타입만 어긋나므로 여기 한 지점에서만 좁게 단언한다.
type ApiSignal = NonNullable<Parameters<typeof bot.api.getMe>[0]>;
const sendTimeout = (): ApiSignal =>
  AbortSignal.timeout(SEND_TIMEOUT_MS) as unknown as ApiSignal;

// 연결 보온 — 선톡 유실의 실제 해법. 가장 가벼운 API를 주기적으로 두드려, 폴링이 쓰는 소켓과
// 별개로 유휴 소켓 한 개가 항상 풀에 놀고 있게 만든다. 선톡은 그걸 재사용하므로 '새 연결 수립'을
// 건너뛴다(그 수립이 이 VM에서 간헐적으로 죽는다).
// 주기는 텔레그램 쪽 idle timeout보다 짧게 — 안 두드리면 유휴 소켓이 서버에서 닫혀 도로 원점이다.
// 실패는 무시한다(다음 주기에 다시 시도하고, 실제 발송은 sendWithRetry가 따로 버틴다).
export const keepConnectionWarm = (intervalMs = 30_000): void => {
  setInterval(() => {
    void bot.api.getMe(sendTimeout()).catch(() => {
      /* 보온 실패는 무시 — 실제 발송은 sendWithRetry가 따로 버틴다 */
    });
  }, intervalMs).unref();
};

const nowIso = (): string =>
  getKstNow().toISOString().replace("T", " ").slice(0, 19);

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, n));

// 방어적 로그 위생 — 에러 출력에 봇 토큰 같은 민감 값이 섞여 남지 않도록 로그 직전에 가린다.
// 외부 라이브러리가 에러에 요청 정보를 담을 수 있어, 만약을 대비해 값 자체 + 토큰 형태 둘 다 마스킹.
const redactToken = (s: string): string =>
  s
    .split(config.telegramToken)
    .join("<TOKEN>")
    .replace(/\d{6,}:[A-Za-z0-9_-]{30,}/g, "<TOKEN>");

// 에러를 안전하게 로그한다 — 어떤 형태의 에러든 깊이 직렬화한 뒤 민감 값을 가리고 출력.
export const logErr = (prefix: string, e: unknown): void => {
  console.error(prefix, redactToken(inspect(e, { depth: 5 })));
};

// 생각·문장 단위로 나뉜 말풍선(LLM이 줄바꿈으로 끊음). 상한을 넘는 초과분만 마지막에 합침
const MAX_BUBBLES = 6;
const splitBubbles = (text: string): string[] => {
  const parts = text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return [text.trim()];
  if (parts.length <= MAX_BUBBLES) return parts;
  return [
    ...parts.slice(0, MAX_BUBBLES - 1),
    parts.slice(MAX_BUBBLES - 1).join(" "),
  ];
};

// 순간 네트워크 오류로 전송이 통째로 실패하지 않게 재시도한다(VM↔텔레그램 API 일시 단절 대비).
// 나쁜 구간은 수 분~수십 분씩 이어지므로 촘촘히 조르기보다 봉투를 넓게 잡는다.
// 매 시도는 sendTimeout()(20초)으로 끊기니 최악 ~100초. 호출부(틱)는 이 시간만큼 붙잡힌다.
const RETRY_BACKOFF_MS = [2_000, 5_000, 12_000];

const sendWithRetry = async (chatId: string, text: string): Promise<void> => {
  const tries = RETRY_BACKOFF_MS.length + 1;
  for (let i = 0; i < tries; i++) {
    try {
      await bot.api.sendMessage(chatId, text, undefined, sendTimeout());
      return;
    } catch (e) {
      // 최종 실패 시 원본 에러를 정리·마스킹해서 던진다 — 하류 로그가 깔끔하고 민감 값이 안 남게.
      if (i === tries - 1)
        throw new Error(
          `sendMessage 실패(${tries}회): ${redactToken(inspect(e, { depth: 4 }))}`,
        );
      await sleep(RETRY_BACKOFF_MS[i]);
    }
  }
};

// 타이핑 표시를 켠 채로 ms만큼 기다린다. 텔레그램의 'typing' 표시는 ~5초면 사라지므로
// 긴 문장에선 중간에 갱신해 계속 치는 것처럼 보이게 한다. (Date.now = 실제 경과시간)
const sleepWhileTyping = async (chatId: string, ms: number): Promise<void> => {
  const start = Date.now();
  do {
    try {
      await bot.api.sendChatAction(chatId, "typing");
    } catch {
      /* 타이핑 표시 실패는 무시 — 답장 전송을 막지 않는다 */
    }
    const remaining = ms - (Date.now() - start);
    if (remaining <= 0) break;
    await sleep(Math.min(4000, remaining));
  } while (Date.now() - start < ms);
};

// 사람이 치는 것처럼: 봇 즉답 대신 버블별로 타이핑을 표시하고 길이에 비례한 텀을 두고 보낸다.
//
// 중간에 실패해도 이미 나간 말풍선은 되돌릴 수 없다. 그래서 실패를 그냥 던지지 않고
// '어디까지 나갔는지'를 함께 돌려준다 — 호출부가 통째로 재시도해 앞부분을 중복 발송하는 걸 막는다.
// (재시도 봉투를 넓힌 만큼 이 부분 실패 확률도 같이 올라간다. 잘린 채로 두는 게 중복보다 낫다.)
const sendBubbleList = async (
  chatId: string,
  bubbles: string[],
): Promise<{ sent: string[]; error?: unknown }> => {
  const sent: string[] = [];
  for (const bubble of bubbles) {
    // 실제 치는 속도(≈5~6자/초)에 맞춘 타이핑 시간. 90ms/자는 복붙처럼 빨라서 180ms/자로 늦춤.
    const typeMs =
      clamp(bubble.length * 180, 1700, 9000) + Math.random() * 1000;
    await sleepWhileTyping(chatId, typeMs);
    try {
      await sendWithRetry(chatId, bubble);
    } catch (e) {
      return { sent, error: e };
    }
    sent.push(bubble);
  }
  return { sent };
};

// 선톡처럼 만들자마자 보내는 쪽이 쓴다. 답장은 만들어 두고 나중에 보내므로,
// 쪼갠 결과를 저장한 뒤 sendBubbleList로 바로 간다.
const sendBubblesTo = (
  chatId: string,
  text: string,
): Promise<{ sent: string[]; error?: unknown }> =>
  sendBubbleList(chatId, splitBubbles(text));

// 선제 발송(선톡): 유저 메시지 없이 캐릭터가 먼저 보낸다. 아침 안부(morning)·침묵 팔로업(followup)이 호출
// 반환: 실제로 나간 말풍선 수 / 전체. 아무것도 못 나가면 throw(= 호출부가 재시도해도 안전),
// 일부라도 나갔으면 나간 만큼만 기록하고 정상 반환한다(재시도하면 앞부분이 중복되므로).
export interface SendOutcome {
  delivered: number;
  total: number;
}

export const sendProactive = async (
  chatId: string,
  characterId: number,
  text: string,
  kind: Exclude<SendKind, "reply" | "recover"> = "morning",
  extraMeta?: Record<string, unknown>,
): Promise<SendOutcome> => {
  console.log(`[send] kind=${kind} chat=${chatId} len=${text.length}`);
  const total = splitBubbles(text).length;
  const { sent, error } = await sendBubblesTo(chatId, text);
  if (sent.length === 0 && error) throw error;
  logMessage(chatId, characterId, "assistant", sent.join("\n"), nowIso(), {
    proactive: true,
    kind,
    ...(sent.length < total ? { partial: `${sent.length}/${total}` } : {}),
    ...extraMeta,
  });
  if (error)
    console.warn(
      `[send] 부분 발송 kind=${kind} ${sent.length}/${total} — 중복 방지로 재발송 안 함`,
    );
  // 아침·안부는 전날 밤에 만든 문안이라 문안 호출과 발송이 몇 시간 떨어져 있다 —
  // 문안 쪽 트레이스에 잇지 않고 발송을 독립 행으로 둔다.
  traceProactiveSend({
    characterId,
    kind,
    text: sent.join("\n"),
    delivered: sent.length,
    total,
  });
  return { delivered: sent.length, total };
};

// LLM이 답장 앞뒤에 붙인 시스템 태그를 전부 읽고 떼어낸다(유저에게 노출 방지).
// 앞머리에서 값을 읽는 태그는 [남음] 하나 — 조정 가능한 자기 일정을 접거나 미루고 곁에 남기로 한 신호.
// 응답 속도 태그([한참후]·[잠시후]·[즉시])는 지연을 각본 블록에서 계산하게 바뀐 뒤로 값을 쓰지
// 않지만, 유저에게 보이면 안 되므로 떼어내는 대상에는 그대로 남는다.
// 답장 끝의 [메모] 줄은 NOTE_RULE(context.ts)이 시킨 오늘 메모 — 내용을 note로 돌려주고,
// 발송 시 pending.ts가 saveTodayNote로 저장한다.
interface ReplyTags {
  stay: boolean;
  note: string | null;
  text: string;
}

// 앞머리 대괄호는 어떤 형태든 태그로 보고 전부 떼어낸다. [남음][즉시]처럼 겹쳐 나오면
// 하나만 벗기던 버그가 있어 연속으로 벗기고, 종류 판정도 벗기는 자리에서 함께 한다 —
// 맨 앞 하나만 정규식으로 따로 보면 태그가 겹친 순간 뒤쪽 신호를 통째로 놓친다.
// export는 단독 회귀 검증용 — 봇 밖에서 부르는 곳은 없다.
export const parseReplyTags = (reply: string): ReplyTags => {
  // [메모] 줄 추출 — 규칙은 맨 끝 한 줄이지만, 모델이 중간에 찍거나 여러 줄을 찍어도
  // 유저에게 새어 나가면 안 되므로 위치와 개수에 관계없이 전부 떼어낸다.
  // 앞머리 태그 벗기기보다 먼저 한다 — 답장이 [메모]로 시작하면(메모만 있는 답장 등)
  // 아래 루프가 태그만 삼키고 메모 내용이 유저에게 보이는 문장으로 남는다.
  const notes: string[] = [];
  let text = reply
    .split("\n")
    .filter((line) => {
      const nm = line.match(/^\s*\[메모\]\s*(.*)$/);
      if (!nm) return true;
      if (nm[1].trim()) notes.push(nm[1].trim());
      return false;
    })
    .join("\n");
  let stay = false;
  let m: RegExpMatchArray | null;
  // 길이 상한 20 — 응답 속도 태그(4자)뿐 아니라 대화 기록에 붙는 시간 마커를 모델이 흉내 내
  // 답장에 찍는 경우("3일 전(금) 21:40" = 14자)까지 덮는 값.
  while ((m = text.match(/^\s*\[([^\]\n]{1,20})\]\s*/))) {
    if (m[1].includes("남음")) stay = true;
    text = text.slice(m[0].length);
  }
  return {
    stay,
    note: notes.length > 0 ? notes.join(" / ") : null,
    text: text.trim(),
  };
};

// 연속 동일 role 메시지 병합 + 시간이 벌어진 지점에 시간 마커.
// 기록 자체에 시간이 없으면 모델이 며칠 전 대화를 방금 일로 읽는다(프롬프트가 전부 '지금' 기준이라
// 날짜 없는 기록은 오늘로 수렴한다). 마커는 병합된 본문 안에 넣어 role 교대 규약을 건드리지 않는다.
const toTurns = (rows: MessageRow[]): ChatTurn[] => {
  const turns: ChatTurn[] = [];
  let prevTs: string | null = null;
  for (const row of rows) {
    const role = row.role === "user" ? "user" : "assistant";
    const marker = timeMarkerFor(row.sent_at, prevTs);
    const text = marker ? `[${marker}] ${row.text}` : row.text;
    prevTs = row.sent_at;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += `\n${text}`;
    else turns.push({ role, content: text });
  }
  if (turns[0]?.role === "assistant")
    turns.unshift({ role: "user", content: "(대화 시작)" });
  return turns;
};

// ── /start 온보딩 — 유저 입력 다섯으로 캐릭터를 만든다 ──────────────────────
// 선택지 둘(성별·나이대)은 인라인 버튼, 서술형 셋(성격·관계·바라는 모습)은 메시지로 받는다.
// 서술형은 비워도 된다 — 빈 항목은 생성이 앞뒤 맞게 채운다(character.ts).
// 진행 상태는 메모리에만 둔다: 아직 캐릭터가 없어 잃을 것이 없고, 온보딩 중 재시작되면
// /start부터 다시 하면 된다.
type FreeStep = "personality" | "relationship" | "wish";
interface Onboarding {
  step: "gender" | "age" | FreeStep | "creating";
  gender?: CharacterGender;
  ageBand?: string;
  personality?: string;
  relationship?: string;
  wish?: string;
}
const onboarding = new Map<string, Onboarding>();

const FREE_QUESTIONS: readonly { step: FreeStep; ask: string }[] = [
  { step: "personality", ask: "성격이나 분위기는 어떤 사람이면 좋겠어?" },
  { step: "relationship", ask: "너랑 어떤 사이로 시작하면 좋겠어?" },
  { step: "wish", ask: "그 밖에 바라는 모습이 있으면 적어줘." },
];

const skipKeyboard = new InlineKeyboard().text("비워두고 넘어가기", "ob:s");

const ageKeyboard = (): InlineKeyboard => {
  const kb = new InlineKeyboard();
  CHARACTER_AGE_BANDS.forEach((band, i) => {
    kb.text(band, `ob:a:${i}`);
    if (i % 3 === 2) kb.row();
  });
  return kb;
};

const askFreeStep = async (
  chatId: string,
  ob: Onboarding,
  step: FreeStep,
): Promise<void> => {
  const q = FREE_QUESTIONS.find((f) => f.step === step);
  if (!q) return;
  ob.step = step;
  await bot.api.sendMessage(chatId, q.ask, { reply_markup: skipKeyboard });
};

// 서술형 답(또는 비우기)을 받아 다음 질문으로. 마지막 답이면 생성으로 넘어간다.
const advanceOnboarding = async (
  chatId: string,
  ob: Onboarding,
  answer: string | null,
): Promise<void> => {
  if (ob.step === "gender" || ob.step === "age" || ob.step === "creating")
    return;
  if (answer) ob[ob.step] = answer;
  const i = FREE_QUESTIONS.findIndex((f) => f.step === ob.step);
  const next = FREE_QUESTIONS[i + 1]?.step;
  if (next) {
    await askFreeStep(chatId, ob, next);
    return;
  }
  await finishOnboarding(chatId, ob);
};

// 다섯 입력이 모이면 생성 두 콜(사람 전부 → 삶의 흐름)을 돌리고 첫 인사를 보낸다.
const finishOnboarding = async (
  chatId: string,
  ob: Onboarding,
): Promise<void> => {
  if (!ob.gender || !ob.ageBand) return;
  ob.step = "creating";
  await bot.api.sendMessage(
    chatId,
    "여기까지면 됐어. 이제 만날 사람을 만들게 — 조금 걸려.",
  );
  await bot.api.sendChatAction(chatId, "typing").catch(() => {
    /* 타이핑 표시 실패는 무시 */
  });
  try {
    const { id, output } = await createUserCharacter(chatId, {
      gender: ob.gender,
      ageBand: ob.ageBand,
      personality: ob.personality,
      relationship: ob.relationship,
      wish: ob.wish,
    });
    onboarding.delete(chatId);
    const { sent } = await sendBubblesTo(chatId, output.firstGreeting);
    if (sent.length > 0)
      logMessage(chatId, id, "assistant", sent.join("\n"), nowIso(), {
        first: true,
      });
    // 월 리듬·오늘 각본 첫 실행. 첫 인사를 기다리게 하지 않으려고 뒤에서 돌린다 —
    // 실패해도 첫 답장 때 ensureTodayPlan(lazy)이 다시 시도한다.
    void ensureMonthPlan(id, kstDateString().slice(0, 7))
      .then(() => ensureTodayPlan(id))
      .catch((e) => logErr("[start] first plan error:", e));
  } catch (e) {
    logErr("[start] create error:", e);
    onboarding.delete(chatId);
    await bot.api
      .sendMessage(
        chatId,
        "만드는 데 문제가 생겼어. 잠깐 있다가 /start 로 다시 해줘.",
      )
      .catch(() => {
        /* 안내 실패는 무시 — 다음 /start가 처음부터 다시 간다 */
      });
  }
};

bot.command("start", async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (getActiveCharacter(chatId)) {
    await ctx.reply("이미 연결된 상대가 있어. 그냥 말을 걸면 돼.");
    return;
  }
  if (onboarding.get(chatId)?.step === "creating") {
    await ctx.reply("지금 만들고 있어. 조금만 기다려줘.");
    return;
  }
  // 온보딩 중 /start 재실행은 처음부터 다시 — 아직 아무것도 저장되지 않았다.
  onboarding.set(chatId, { step: "gender" });
  await ctx.reply(
    "어떤 사람을 만나고 싶은지 다섯 가지만 물어볼게. 먼저, 성별은?",
    {
      reply_markup: new InlineKeyboard()
        .text(CHARACTER_GENDERS[0], "ob:g:0")
        .text(CHARACTER_GENDERS[1], "ob:g:1"),
    },
  );
});

// 온보딩 인라인 버튼 처리. 지나간 단계의 버튼을 늦게 눌러도 상태가 어긋나지 않게
// 현재 단계와 맞는 입력만 받는다(안 맞으면 스피너만 멈추고 무시).
bot.on("callback_query:data", async (ctx) => {
  const chatId = String(ctx.chat?.id ?? ctx.callbackQuery.from.id);
  const data = ctx.callbackQuery.data;
  await ctx.answerCallbackQuery().catch(() => {
    /* 응답 실패는 무시 — 오래된 콜백은 텔레그램이 거부한다 */
  });
  if (!data.startsWith("ob:")) return;
  if (getActiveCharacter(chatId)) return; // 생성이 끝난 뒤 남은 버튼
  const ob = onboarding.get(chatId);
  if (!ob) {
    await bot.api
      .sendMessage(chatId, "/start 로 처음부터 다시 해줘.")
      .catch(() => {
        /* 안내 실패는 무시 */
      });
    return;
  }
  if (ob.step === "gender" && data.startsWith("ob:g:")) {
    const gender = CHARACTER_GENDERS[Number(data.slice(5))];
    if (!gender) return;
    ob.gender = gender;
    ob.step = "age";
    await bot.api.sendMessage(chatId, "나이대는?", {
      reply_markup: ageKeyboard(),
    });
    return;
  }
  if (ob.step === "age" && data.startsWith("ob:a:")) {
    const band = CHARACTER_AGE_BANDS[Number(data.slice(5))];
    if (!band) return;
    ob.ageBand = band;
    await askFreeStep(chatId, ob, "personality");
    return;
  }
  if (data === "ob:s") await advanceOnboarding(chatId, ob, null);
});

// TODO(D1 전): /새로만나기 — 비가역 확인 → 아카이브 → "어떤 점이 아쉬웠어?" → user_preferences 반영 → 신규 매칭

// 유저가 문장을 끊어 보내는 동안 기다렸다가, 멈추면 그동안 온 것을 한 번에 읽고 응답한다(디바운스)
// 텔레그램 봇 API는 유저의 '입력중'을 봇에 주지 않고(수신 불가), 끝맺음으로도 확실히 못 가늠한다
// (질문을 문장 중간에 하기도 함). 그래서 최소 20초는 기다리고, 거기서 '위로만' 조정한다:
// 한 번에 길게 치는 사람(이어 보내기 텀이 긴)일수록 더 오래. 아래로는 줄이지 않는다 —
// '답장 올까봐' 급히 친 짧은 텀에 벌주듯 대기를 더 줄이면 재촉 악순환이 되기 때문(실측으로 확인).
// (자체 앱이라면 유저의 '입력중' 신호를 받아 치는 동안엔 안 답하고 멈춤에만 답할 수 있다 — 텔레그램 봇의 한계)
const WAIT_BASE_MS = 20000; // 최소 대기(짧게 치는 사람 기본 20~25초). 이 아래로는 내려가지 않는다
const WAIT_CEIL_MS = 40000; // 길게 치는 사람도 이 이상은 응답이 끊긴 듯 느껴짐
const pending = new Map<string, ReturnType<typeof setTimeout>>();
const responding = new Set<string>();
// 도착 대기 기록 — 유저 말이 다 오기를 기다린 시간, 그동안 도착한 메시지 수, 첫 메시지 시각.
// 답장 텀에 넣지 않는 값이라 따로 들고 있다가 답장 호출 기록에 붙인다(reply-trace가 읽는다).
const arrivals = new Map<
  string,
  { waitMs: number; firstAt: number; msgs: number }
>();

// 선톡 틱(dispatch·followup·presence) 간 chat 단위 상호 배제.
// 크론 주기상 매 15분(디스패치+팔로업)·매 30분(3종 전부)마다 같은 분에 발화하는데, 각 틱은
// 조건 확인과 발송 사이가 LLM 호출·타이핑 시뮬레이션으로 수십 초 벌어져 있어 서로의 미기록
// 발송을 못 본다 — 락 없이는 같은 chat에 선톡 두 개가 겹쳐 나갈 수 있다(구조적으로 확정 재현).
// 답장(respond)이 진행 중일 때도 선톡은 접는다 — 방금 말 건 유저에게 근황톡을 얹지 않게.
const proactiveBusy = new Set<string>();
export const acquireProactive = (chatId: string): boolean => {
  if (proactiveBusy.has(chatId) || responding.has(chatId)) return false;
  // 만들어 두고 발송을 기다리는 답장이 있으면 선톡을 접는다 — 답장이 나가기 직전에
  // 근황톡이 먼저 도착하면 유저는 자기 말이 씹힌 것으로 읽는다.
  if (isWaiting(chatId)) return false;
  proactiveBusy.add(chatId);
  return true;
};
export const releaseProactive = (chatId: string): void => {
  proactiveBusy.delete(chatId);
};

// 대기 시간 = 20초 바닥에서 위로만. 이어 보내기 텀이 길면(길게 치는 사람) 그 상위값(p80)에 맞춰 늘린다.
const computeWait = (chatId: string): number => {
  const gaps = recentUserGaps(chatId);
  let base = WAIT_BASE_MS;
  if (gaps.length >= 3) {
    const sorted = [...gaps].sort((a, b) => a - b);
    const p80 =
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.8))];
    base = clamp(p80 * 1.4, WAIT_BASE_MS, WAIT_CEIL_MS); // 20초 미만으로는 안 내려감
  }
  const wait = base + Math.random() * 5000; // +0~5초 (짧게 치는 사람 20~25초, 길게 치는 사람은 더)
  console.log(
    `[debounce] chat=${chatId} n=${gaps.length} wait=${Math.round(wait / 1000)}s`,
  );
  return wait;
};

// 답장 대상이 되는 유저 발화. 마지막 캐릭터 발화 뒤에 온 유저 메시지를 모은다 —
// 나눠 보낸 여러 줄이 한 덩어리로 붙잡기 판정에 들어간다.
const pendingUserTurn = (
  chatId: string,
): { at: string; text: string; n: number } | null => {
  const rows = getRecentMessages(chatId, 12);
  const mine: MessageRow[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (!r || r.role !== "user") break;
    mine.unshift(r);
  }
  const last = mine[mine.length - 1];
  if (!last) return null;
  return {
    at: last.sent_at,
    text: mine.map((m) => m.text).join("\n"),
    n: mine.length,
  };
};

const toMinOfDay = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

// 예고를 이미 보낸 자리 비움 블록이 곧 시작되는가 — 그 사이에 온 말은 배웅 답이 된다.
// 예고가 아직 안 나갔으면(닥친 일이거나 예고 틱이 못 돌았으면) 평범한 답장으로 간다.
const upcomingAnnouncedAway = (
  chatId: string,
  characterId: number,
): PlanBlock | null => {
  const raw = getDayPlan(characterId, kstDateString());
  if (!raw) return null;
  let blocks: PlanBlock[];
  try {
    blocks = (JSON.parse(raw) as DayPlan).blocks;
  } catch {
    return null;
  }
  const nowMin = toMinOfDay(kstClock());
  for (const b of blocks) {
    if (!isAwayUnavail(b)) continue;
    const rel = toMinOfDay(b.start) - nowMin;
    if (rel <= 0 || rel > 15) continue;
    const announced = db
      .prepare(
        `SELECT 1 FROM messages WHERE chat_id = ? AND sent_at >= ? AND meta_json LIKE ? AND meta_json LIKE ? LIMIT 1`,
      )
      .get(
        chatId,
        logicalDayStartTs(),
        '%"kind":"away"%',
        `%"block":"${b.start}"%`,
      );
    if (announced) return b;
  }
  return null;
};

// 배웅 답 — 나간다고 이미 알린 뒤, 나가기 전까지 온 말에 짧게 받는 상황 문단.
const farewellSituation = (b: PlanBlock): string =>
  [
    `[배웅 답 — 곧 자리를 비운다]`,
    `너는 곧 ${b.start}부터 "${b.activity}" 때문에 자리를 비운다. 상대에게는 이미 예고해 뒀다.`,
    `나가기 직전의 짧은 주고받음이다 — 지금 온 말에 짧게만 받고, 새 화제를 벌이지 않는다. 필요하면 다녀와서 이어 가자는 결로.`,
  ].join("\n");

// 몰아 답장 — 불가 구간이 끝나 깨어난 자리. 그 사이 온 메시지를 한 번에 읽고 답하는 상황 문단.
const gatherSituation = (activity: string): string =>
  [
    `[몰아 답장 — 방금 자리에서 돌아왔다]`,
    `너는 방금 "${activity}"을(를) 끝냈다. 대화 기록 끝의 상대 메시지들은 그 동안 온 것이라 이제야 본다.`,
    `이제 끝나고 봤다는 결로, 쌓인 말을 한 번에 자연스럽게 받는다. 메시지가 여러 개면 억지로 하나하나 다 짚지 말고 흐름으로 답한다.`,
  ].join("\n");

// 복귀 인사 — 예고하고 나간 사이 상대가 답이 없었을 때, 돌아왔음을 먼저 알리는 상황 문단.
const returnSituation = (activity: string): string =>
  [
    `[문안 — 지금 보낼 복귀 인사 한 통]`,
    `너는 아까 곧 자리를 비운다고 알리고 다녀왔다. 방금 "${activity}"을(를) 끝내고 돌아왔는데, 그 사이 상대에게선 답이 없었다.`,
    `- 돌아왔음을 가볍게 알린다(그 일이 이제 끝났고 돌아왔다는 결). 아까 하려던 안부를 자연스럽게 이어도 좋다. 매달림이 아니라 자연스러운 복귀 인사다.`,
    `- 짧게 1~2개 말풍선(줄바꿈 구분). 재촉·서운함 없음.`,
    `- 억지스러우면 send=false.`,
    ``,
    `JSON으로만 답한다: {"send":true,"text":"..."} 또는 {"send":false}`,
  ].join("\n");

// 답장 한 번의 순서: 텀 결정 → 생성 → 대기 → 발송.
//
// 예전에는 각본상 자리를 비운 시간만큼 먼저 기다린 뒤 생성했다. 그러면 30분 뒤에 나가는 답장도
// 방금 대화를 보고 쓴 것처럼 읽혔고, 그사이 일정이 바뀐 것도 반영하지 못했다.
// 지금은 유저 말이 도착한 참에 답장을 만들어 두고, 정한 시각에 그대로 내보낸다.
// 만들어 둔 답장은 pending_replies에 남아 프로세스가 다시 떠도 이어진다.
//
// 답장 불가 구간만 예외다 — 몇 시간 뒤의 답장을 지금 만들지 않고, 깨우기 표시(wake 행)를 걸어
// 구간이 끝날 때 쌓인 메시지를 한 번에 읽고 답한다(setWakeHandler 아래).
const respond = async (
  chatId: string,
  kind: "reply" | "recover" = "reply",
): Promise<void> => {
  responding.add(chatId);
  try {
    const character = getActiveCharacter(chatId);
    if (!character) return;
    // 오늘의 하루 각본이 없으면 생성(그날 첫 대화 때 한 번). 실패해도 대화는 계속
    await ensureTodayPlan(character.id).catch((e) =>
      logErr("[bot] day plan error:", e),
    );
    // 도착 대기 — 유저 말이 다 오기를 기다린 시간. 답장을 만들기 시작하는 지금 시점에
    // 걸린 시간까지 재 둔다(생성에 걸린 시간이 섞이지 않게 여기서 계산한다).
    const arrived = arrivals.get(chatId);
    arrivals.delete(chatId);
    const arrival = arrived
      ? {
          waitMs: arrived.waitMs,
          spanMs: Math.max(0, Date.now() - arrived.firstAt),
          msgs: arrived.msgs,
        }
      : null;
    // 지금 답장하는 유저 메시지. 생성이 끝났을 때 이보다 새 메시지가 와 있으면 이 답장은 버린다.
    const turn = pendingUserTurn(chatId);
    if (!turn) {
      console.warn(`[bot] 답장할 유저 메시지가 없다 — skip (chat=${chatId})`);
      return;
    }

    // 1. 텀부터 정한다. 붙잡기 판정도 여기서 끝나고, 접거나 미룬 일정은 오늘 실제 기록에 바로 적힌다.
    // 복구 답장은 이미 늦은 것이라 텀을 다시 얹지 않는다.
    const timing: TimingDecision =
      kind === "recover"
        ? {
            waitMs: 0,
            held: null,
            gather: null,
            trace: { path: "recover", block: null, asked: false },
          }
        : await decideReplyTiming(character.id, turn.text);
    if (timing.held)
      console.log(
        `[hold] ${chatId} ${timing.held.activity} → ${timing.held.outcome}`,
      );

    // 답장 불가 구간 — 지금 만들지 않는다. 구간 끝에 울릴 깨우기 표시만 걸어 두면
    // 그때 쌓인 메시지를 한 번에 읽고 답한다. 표시가 이미 걸려 있으면 메시지만 쌓는다.
    if (timing.gather) {
      if (!hasWaitingWakeRow(chatId))
        scheduleWakeRow({
          chatId,
          characterId: character.id,
          userMsgAt: turn.at,
          waitMs: timing.waitMs,
          meta: timing.gather,
        });
      else
        console.log(
          `[pending] 깨우기 이미 걸림 — 메시지만 쌓는다 (chat=${chatId})`,
        );
      // 이 메시지의 답장 책임은 깨우기 행이 진다 — 복구 틱이 다시 답하지 않게 표시한다.
      setRecoveryMark(chatId, turn.at);
      return;
    }
    // 불가 구간이 아닌 길로 답장이 나간다 — 걸려 있던 깨우기 표시가 있으면 거둔다.
    // (붙잡혀 일정을 접었거나 구간이 끝난 경우. 지금 만드는 답장이 쌓인 메시지까지 함께 답한다.)
    const droppedWake = dropWakeRows(chatId);
    if (droppedWake)
      console.log(
        `[pending] 깨우기 ${droppedWake}건 거둠 — 지금 답장이 대신한다 (chat=${chatId})`,
      );

    // 말투 래칫: 최근 답장이 반말로 정착했으면(휴리스틱 판정) 관계의 말투 값을 casual로
    // 굳힌다. casual이 된 뒤에는 되돌리지 않는다 — 존댓말 회귀를 막는 한 방향 래칫.
    // 저장해 두면 최근 대화를 안 보는 경로(선톡 문안)도 같은 값을 읽는다.
    const prevSpeech = getRelationship(character.id)?.speech_level ?? null;
    let relUpdate: { field: string; from: string | null; to: string } | null =
      null;
    if (prevSpeech !== "casual" && currentSpeechLevel(chatId) === "반말") {
      setSpeechLevel(character.id, "casual", nowIso());
      relUpdate = { field: "말투", from: prevSpeech, to: "casual" };
    }

    // 2. 지금 만든다
    // 3층(불변/일간/실시간) 블록 — 앞 두 층은 프롬프트 캐시 경계가 걸려 재사용된다.
    // 검색 태그는 답장을 만들기 전에 짧은 호출로 먼저 고른다 — 이번 답장에 바로 쓰기
    // 때문에 여기서 돌아야 한다. 무엇을 찾아 넣었는지(검색 태그·기억)를 받아 둬서 답장
    // 호출 기록에 함께 남긴다. 예고해 둔 자리 비움이 곧 시작되면 배웅 답 상황 문단을
    // 얹는다(곧 나간다는 걸 아는 채로 짧게 받는다).
    const built: BuildTrace = {
      tags: [],
      tagPool: 0,
      memories: [],
      oldDiaries: [],
      dropped: [],
    };
    const pick = await pickTags(character.id, turn.text);
    const away =
      kind === "reply" ? upcomingAnnouncedAway(chatId, character.id) : null;
    const system = buildSystemBlocks(character.id, chatId, {
      pick,
      trace: built,
      ...(away ? { situation: farewellSituation(away) } : {}),
    });
    const turns = toTurns(getRecentMessages(chatId, 40));
    const meta: CallMeta = {
      purpose: "reply",
      characterId: character.id,
      chatId,
    };
    // 태그는 여기서 전부 떼어낸다(유저 비노출).
    let { text, stay, note } = parseReplyTags(
      await chat(system, turns, 1024, config.model, meta),
    );
    // 빈 답장 방어: LLM이 태그만 뱉거나 빈 문자열을 주는 경우가 있다 → 한 번 재생성, 그래도 비면 스킵.
    // (빈 텍스트를 그대로 보내면 텔레그램이 400으로 거부해 대화가 막혔었다.)
    // 태그만 뱉은 답이 바로 이 경우라, 재생성분의 신호도 함께 살린다.
    let retryCallId: number | null = null;
    if (!text) {
      const retryMeta: CallMeta = { ...meta, attempt: 2 };
      const retry = parseReplyTags(
        await chat(system, turns, 1024, config.model, retryMeta),
      );
      text = retry.text;
      stay = stay || retry.stay;
      note = retry.note ?? note;
      retryCallId = retryMeta.callId ?? null;
    }
    // 이 답장이 어떤 근거로 나왔는지를 호출 기록에 붙인다 — 검색한 태그·기억, 텀 계산의
    // 입력과 결과, 말풍선 수. 기록이 실패해도 답장은 그대로 나간다.
    // 여러 번 나눠 부르므로 덮어쓰지 않고 쌓는다 — 뒤에 붙는 발송 예정 시각이 앞의
    // 검색 기록을 지우면 안 된다.
    const facts: Record<string, unknown> = {};
    const attach = (extra: Record<string, unknown>): void => {
      Object.assign(facts, extra);
      if (!meta.callId) return;
      try {
        setCallContext(meta.callId, {
          timing: {
            waitMs: timing.waitMs,
            ...timing.trace,
            held: timing.held,
          },
          search: built,
          turns: turns.length,
          userMsgs: turn.n,
          ...(arrival ? { arrival } : {}),
          ...(relUpdate ? { relUpdate } : {}),
          ...(retryCallId ? { retryCallId } : {}),
          ...facts,
        });
      } catch (e) {
        logErr("[llm] 판단 근거 기록 실패:", e);
      }
    };
    // 재생성 호출은 답장 스레드에 딸린 것으로 표시한다 — 그냥 두면 판단 근거 없는
    // 낱개 행으로 올라가 어느 답장의 두 번째 시도인지 알 수 없다.
    if (retryCallId && meta.callId)
      try {
        setCallContext(retryCallId, { partOf: meta.callId });
      } catch (e) {
        logErr("[llm] 재생성 호출 표시 실패:", e);
      }

    // 조정 가능한(개인·사회) 자기 일정을 접거나 미루고 남기로 한 신호([남음]).
    // 붙잡기 판정이 이미 접었으면 그 기록이 남아 있어 recordHold가 알아서 넘어간다.
    const staged = stay ? recordHold(character.id) : null;
    if (timing.held)
      attach({
        dayActual: {
          blockStart: timing.trace.block?.start ?? null,
          activity: timing.held.activity,
          outcome: timing.held.outcome,
          by: "judge",
        },
      });
    else if (staged) attach({ dayActual: { ...staged, by: "stay" } });
    if (!text) {
      attach({ dropped: "빈 답장" });
      console.warn(`[bot] empty reply — skip (chat=${chatId})`);
      return;
    }
    // 만드는 동안 유저가 말을 더 보냈으면 이 답장은 버린다 — 새 타이머가 합쳐서 다시 만든다.
    const now = pendingUserTurn(chatId);
    if (now && now.at !== turn.at) {
      attach({ dropped: "생성 중 새 메시지 도착" });
      console.log(`[send] 생성 중 새 메시지 도착 — 폐기 (chat=${chatId})`);
      return;
    }

    // 3. 정한 시각에 나가게 저장한다. 대기가 0이어도 같은 길로 보낸다 —
    // 발송 직전에 죽어도 pending_replies에 남아 다시 뜰 때 이어진다.
    const bubbles = splitBubbles(text);
    attach({
      stay,
      note,
      bubbles: bubbles.length,
      // 말풍선 사이 간격은 발송할 때 글자 수에서 나온다(1초 안쪽 흔들림) — 길이를 남겨 둔다.
      bubbleLens: bubbles.map((b) => b.length),
    });
    const scheduled = schedulePendingReply({
      chatId,
      characterId: character.id,
      userMsgAt: turn.at,
      bubbles,
      // 답장 끝 [메모] 줄(NOTE_RULE) — 발송이 성공하면 pending.ts가 saveTodayNote로 저장한다.
      noteToSave: note,
      waitMs: timing.waitMs,
      kind,
      // 발송·폐기 결과를 이 답장을 만든 호출의 트레이스에 잇는다.
      callId: meta.callId ?? null,
    });
    attach({ sendAt: scheduled.sendAt });
    // 답장 책임은 여기서 확정된다 — 저장된 행이 발송을 보장하므로 복구 틱이 다시 답하지 않게 한다.
    setRecoveryMark(chatId, turn.at);
    console.log(
      `[send] kind=${kind} chat=${chatId} len=${text.length} wait=${Math.round(timing.waitMs / 1000)}s`,
    );
  } finally {
    responding.delete(chatId);
  }
};

// 저장해 둔 답장을 실제로 내보내는 자리 — pending.ts가 정한 시각에 부른다.
// (pending.ts가 bot.ts를 부르면 서로 물고 늘어져서, 발송만 여기서 끼워 넣는다.)
setPendingSender(async (row: PendingReplyRow, bubbles: string[]) => {
  const kind = (row.kind === "recover" ? "recover" : "reply") as SendKind;
  const { sent, error } = await sendBubbleList(row.chat_id, bubbles);
  // 한 마디도 못 나갔으면 throw → 아래 기록 생략 → pending 재시도에 맡긴다.
  // 일부라도 나갔으면 답장 책임을 완료로 확정한다: 재시도하면 이미 나간 앞부분이 중복되기 때문.
  if (sent.length === 0 && error) throw error;
  if (error)
    console.warn(
      `[send] 부분 발송 kind=${kind} ${sent.length}/${bubbles.length}`,
    );
  logMessage(
    row.chat_id,
    row.character_id,
    "assistant",
    sent.join("\n"),
    nowIso(),
    {
      kind,
      ...(sent.length < bubbles.length
        ? { partial: `${sent.length}/${bubbles.length}` }
        : {}),
    },
  );
});

// 깨우기 표시가 울리는 자리 — 답장 불가 구간이 끝났다. 갈래는 셋:
// ① 그 사이 온 메시지가 있으면 몰아 답장 한 번 ("방금 끝났고 이제 봤다"가 사실인 시점에 만든다)
// ② 온 말은 없지만 자리 비움을 예고해 뒀으면 복귀 인사 ("이제 끝났어")
// ③ 둘 다 아니면 조용히 지나간다.
// presence.ts에 따로 있던 복귀 알림 경로를 여기로 합쳤다 — 답장과 복귀 인사가 겹쳐 나가는
// 이중 발송이 구조적으로 사라진다(깨우기 행이 있는 동안 isWaiting이 선톡 틱을 전부 막는다).
setWakeHandler(async (row: PendingReplyRow) => {
  const chatId = row.chat_id;
  // 디바운스·답장 생성이 진행 중이면 그쪽이 답한다(불가 구간은 이미 끝났으니 평범한 길로 나간다).
  if (pending.has(chatId) || responding.has(chatId)) return;
  let meta: { activity?: string; blockStart?: string } = {};
  try {
    meta = JSON.parse(row.meta_json ?? "{}") as typeof meta;
  } catch {
    /* 깨우기 자체는 유효 — 활동 이름 없이 진행한다 */
  }
  const activity = meta.activity ?? "하던 일";
  // 이 구간에 처음 온 메시지가 얼마나 기다렸는지 — 깨우기 표시를 건 그 메시지 시각 기준.
  const firstAt = Date.parse(row.user_msg_at.replace(" ", "T") + "+09:00");
  const waitedMs = Number.isFinite(firstAt)
    ? Math.max(0, Date.now() - firstAt)
    : null;
  const last = lastMessage(chatId);

  // ① 몰아 답장 — 마지막 말이 유저 차례로 남아 있으면 그 사이 온 메시지가 있다는 뜻.
  if (last?.role === "user") {
    const turn = pendingUserTurn(chatId);
    if (!turn) return;
    const built: BuildTrace = {
      tags: [],
      tagPool: 0,
      memories: [],
      oldDiaries: [],
      dropped: [],
    };
    const system = buildSystemBlocks(row.character_id, chatId, {
      pick: await pickTags(row.character_id, turn.text),
      trace: built,
      situation: gatherSituation(activity),
    });
    const turns = toTurns(getRecentMessages(chatId, 40));
    const wakeMeta: CallMeta = {
      purpose: "reply",
      characterId: row.character_id,
      chatId,
    };
    let { text, stay, note } = parseReplyTags(
      await chat(system, turns, 1024, config.model, wakeMeta),
    );
    let retryCallId: number | null = null;
    if (!text) {
      const retryMeta: CallMeta = { ...wakeMeta, attempt: 2 };
      const retry = parseReplyTags(
        await chat(system, turns, 1024, config.model, retryMeta),
      );
      text = retry.text;
      stay = stay || retry.stay;
      note = retry.note ?? note;
      retryCallId = retryMeta.callId ?? null;
    }
    // 몰아 답장의 근거. 텀 대신 어느 구간이 끝나 답하는지를 남긴다 — 이 길은 표를 타지 않는다.
    const facts: Record<string, unknown> = {};
    const attach = (extra: Record<string, unknown>): void => {
      Object.assign(facts, extra);
      if (!wakeMeta.callId) return;
      try {
        setCallContext(wakeMeta.callId, {
          gathered: {
            activity,
            blockStart: meta.blockStart ?? null,
            waitedMs,
          },
          search: built,
          turns: turns.length,
          userMsgs: turn.n,
          ...(retryCallId ? { retryCallId } : {}),
          ...facts,
        });
      } catch (e) {
        logErr("[llm] 판단 근거 기록 실패:", e);
      }
    };
    if (retryCallId && wakeMeta.callId)
      try {
        setCallContext(retryCallId, { partOf: wakeMeta.callId });
      } catch (e) {
        logErr("[llm] 재생성 호출 표시 실패:", e);
      }
    const staged = stay ? recordHold(row.character_id) : null;
    if (staged) attach({ dayActual: { ...staged, by: "stay" } });
    if (!text) {
      attach({ dropped: "빈 답장" });
      console.warn(`[wake] empty reply — skip (chat=${chatId})`);
      return;
    }
    // 만드는 동안 유저가 말을 더 보냈으면 버린다 — 디바운스 타이머가 합쳐서 다시 만든다.
    const now = pendingUserTurn(chatId);
    if (now && now.at !== turn.at) {
      attach({ dropped: "생성 중 새 메시지 도착" });
      console.log(`[wake] 생성 중 새 메시지 도착 — 폐기 (chat=${chatId})`);
      return;
    }
    // 바로 보낸다 — 구간이 끝나는 시각이 이미 이 답장의 텀이다.
    const bubbles = splitBubbles(text);
    attach({
      stay,
      note,
      bubbles: bubbles.length,
      bubbleLens: bubbles.map((b) => b.length),
    });
    const { sent, error } = await sendBubbleList(chatId, bubbles);
    if (sent.length === 0 && error) throw error; // pending의 재시도에 맡긴다
    // 이 길은 pending을 타지 않아 발송 결과가 따로 붙지 않는다 — 여기서 남긴다.
    attach({ sent: `${sent.length}/${bubbles.length}` });
    if (error)
      console.warn(`[wake] 부분 발송 ${sent.length}/${bubbles.length}`);
    logMessage(
      chatId,
      row.character_id,
      "assistant",
      sent.join("\n"),
      nowIso(),
      {
        kind: "reply",
        gathered: meta.blockStart ?? true,
        ...(sent.length < bubbles.length
          ? { partial: `${sent.length}/${bubbles.length}` }
          : {}),
      },
    );
    if (note) saveTodayNote(row.character_id, note);
    setRecoveryMark(chatId, turn.at);
    console.log(
      `[wake] 몰아 답장 chat=${chatId} @ ${activity} len=${text.length}`,
    );
    return;
  }

  // ② 복귀 인사 — 예고하고 나간 자리였고, 그 사이 상대가 답이 없었던 경우만.
  const dayStart = logicalDayStartTs();
  const announced =
    meta.blockStart &&
    db
      .prepare(
        `SELECT 1 FROM messages WHERE chat_id = ? AND sent_at >= ? AND meta_json LIKE ? AND meta_json LIKE ? LIMIT 1`,
      )
      .get(
        chatId,
        dayStart,
        '%"kind":"away"%',
        `%"block":"${meta.blockStart}"%`,
      );
  if (!announced || !last || last.role !== "assistant") return;
  const draft = await chatJson<{ send: boolean; text?: string }>(
    buildSystemBlocks(row.character_id, chatId, {
      situation: returnSituation(activity),
    }),
    "위 상황 문단대로 문안을 만들어.",
    400,
    config.model,
    { purpose: "away", characterId: row.character_id, chatId },
  );
  // 발송 직전 재확인 — LLM을 기다리는 사이 유저가 답했거나 다른 경로가 보냈으면 접는다.
  if (
    draft.send &&
    draft.text &&
    lastMessage(chatId)?.sent_at === last.sent_at
  ) {
    await sendProactive(chatId, row.character_id, draft.text, "away", {
      return: meta.blockStart ?? true,
    });
    console.log(`[wake] return @ ${activity} → ${chatId}`);
  }
});

// 마지막 메시지 뒤 waitMs 동안 조용하면 응답. 이미 답장 보내는 중이면 끝날 때까지 다시 대기(겹침 방지)
const arm = (chatId: string, waitMs: number): void => {
  const existing = pending.get(chatId);
  if (existing) clearTimeout(existing);
  pending.set(
    chatId,
    setTimeout(() => {
      pending.delete(chatId);
      if (responding.has(chatId)) {
        arm(chatId, waitMs);
        return;
      }
      respond(chatId).catch((e) => logErr("[bot] respond error:", e));
    }, waitMs),
  );
};

bot.on("message:text", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const character = getActiveCharacter(chatId);
  if (!character) {
    // 온보딩 중이면 이 메시지는 서술형 질문의 답이다. 질문 하나에 메시지 하나로 받는다.
    const ob = onboarding.get(chatId);
    if (!ob) {
      await ctx.reply("아직 연결된 상대가 없어. /start 로 시작해줘.");
      return;
    }
    if (ob.step === "gender" || ob.step === "age") {
      await ctx.reply("위 버튼에서 골라줘.");
      return;
    }
    if (ob.step === "creating") {
      await ctx.reply("지금 만들고 있어. 조금만 기다려줘.");
      return;
    }
    const answer = ctx.message.text.trim();
    if (answer.length > FREE_TEXT_MAX) {
      await ctx.reply(
        `조금 길어. ${FREE_TEXT_MAX}자 안으로 줄여서 다시 보내줘.`,
      );
      return;
    }
    await advanceOnboarding(chatId, ob, answer || null);
    return;
  }
  logMessage(chatId, character.id, "user", ctx.message.text, nowIso());
  // 만들어 두고 기다리던 답장이 있으면 버린다 — 유저가 말을 더 보탰으니 내용도 텀도 다시 정한다.
  const dropped = dropPendingReplies(chatId);
  if (dropped)
    console.log(
      `[pending] 유저 추가 발화로 ${dropped}건 폐기 (chat=${chatId})`,
    );
  // 여기서 기다리는 건 유저 말이 다 도착할 때까지의 시간뿐이다(20~40초).
  // 각본상 자리를 비운 만큼의 텀은 답장을 만든 뒤 pending_replies가 맡는다.
  const waitMs = computeWait(chatId);
  const prevArrival = arrivals.get(chatId);
  arrivals.set(chatId, {
    waitMs,
    firstAt: prevArrival?.firstAt ?? Date.now(),
    msgs: (prevArrival?.msgs ?? 0) + 1,
  });
  arm(chatId, waitMs);
});

// 배포·재시작으로 놓친 답장 복구: 유저 메시지가 디바운스 대기 중에 프로세스가 죽으면
// 텔레그램은 이미 전달했다고 보고 타이머는 사라져 영영 무응답이 된다.
// 부팅 후 한 번, 마지막 메시지가 유저 차례로 끝나 있으면(오늘 것만) 이어서 답한다.
// 워터마크로 중복을 막는다: 이미 답장 책임을 진 유저 메시지(같은 ts)에는 다시 답하지 않는다.
// (답장을 보냈지만 로그 전에 죽어 마지막 메시지가 여전히 유저로 보이는 배포 연쇄 상황 방지)
export const recoverMissedReplies = async (): Promise<void> => {
  const rows = db
    .prepare(`SELECT * FROM characters WHERE status = 'active'`)
    .all() as CharacterRow[];
  for (const c of rows) {
    const last = lastMessage(c.chat_id);
    if (!last || last.role !== "user") continue;
    // 최근(3시간 내) 놓친 것만 복구한다 — 그보다 오래된 건 아침 안부·팔로업이 담당.
    // (예전엔 "오늘 새벽 5시 이후"로 걸렀는데, 자정~새벽 대화가 통째로 걸러지는 버그가 있었다.)
    const ageMin =
      (Date.now() -
        new Date(last.sent_at.replace(" ", "T") + "+09:00").getTime()) /
      60000;
    if (ageMin > 180) continue;
    if (pending.has(c.chat_id) || responding.has(c.chat_id)) continue; // 이미 처리 중
    // 만들어 두고 발송을 기다리는 답장이 있으면 이미 답한 것으로 본다 — 그 행이 발송을 책임진다.
    if (isWaiting(c.chat_id)) continue;
    if (getRecoveryMark(c.chat_id) === last.sent_at) {
      console.log(
        `[recover] 이미 답장한 메시지 — 건너뜀: ${c.chat_id} (${last.sent_at})`,
      );
      continue;
    }
    const prev = getRecoveryMark(c.chat_id);
    setRecoveryMark(c.chat_id, last.sent_at); // 보내기 전에 책임 표시(재부팅 중복 방지)
    console.log(
      `[recover] 놓친 답장 복구: ${c.chat_id} (마지막 ${last.sent_at})`,
    );
    try {
      await respond(c.chat_id, "recover");
    } catch (e) {
      setRecoveryMark(c.chat_id, prev ?? ""); // 전송 실패 → 되돌려 다음 복구 틱에 재시도
      logErr("[recover] error:", e);
    }
  }
};

bot.catch((err) => {
  logErr("[bot] error:", err.error);
});
