// 텔레그램과 주고받는 자리 — 받은 말을 모아 답장 한 통으로 내보낸다.
//
// grammY long polling으로 받는다. 유저가 말을 나눠 보내면 디바운스로 모아 한 번에 읽고,
// 기다리는 시간은 그 유저가 이어 보내던 간격을 학습해 20~40초 사이에서 정한다.
//
// 답장 순서는 텀 결정(reply-timing.ts) → 생성(reply-compose.ts) → 대기 → 발송(pending.ts)이다.
// 답장 불가 구간에 온 말은 답장을 만들지 않고 깨우기 표시만 걸어 두고, 구간이 끝나면
// wake 핸들러가 네 갈래로 나뉜다 — 쌓인 메시지에 몰아 답하거나, 답할 수 있는 블록이면
// 복귀 인사를 하거나, 다음 블록도 자리 비움이면 사이 예고를 보내고 그 끝에 표시를 다시 걸거나,
// 아무것도 하지 않는다(pickReturnAction). 몰아 답장도 같은 생성 순서를 타고, 상황 문단과
// 시간 표시 기준만 다르게 준다. 예고한 블록이 시작하기 전까지 온 말에는 farewellSituation으로
// 배웅 답을 보낸다. 자리를 비우러 가는 말의 결(LEAVING_LINES)은 자리 비움 예고와 같은 줄을 쓴다. 답장에서 연락 약속을 하면 코드가 각본 경계에서 시각을 골라 걸어 두고,
// 그 시각에 promise 핸들러가 그 사이 온 말에 답하거나 먼저 연락한다(이슈 #308). 약속이 그 뒤
// 어떻게 됐는지는 단계마다 약속을 한 답장의 슬랙 스레드에 남긴다(tracePromise, 이슈 #312).
//
// 부팅하면 recoverMissedReplies가 놓친 답장을 복구한다. 워터마크로 중복을 막고 최근
// 3시간 것만 본다 — 더 멀리 보면 자정 경계에서 어제 것까지 딸려 온다.
//
// 선톡 틱과는 acquireProactive로 chat 단위 상호 배제를 건다(대기 중인 답장이 있으면
// 선톡을 접는다). 발송·깨우기·약속 함수는 setPendingSender·setWakeHandler·setPromiseHandler로
// pending.ts에 넘겨 준다 — 순환 참조를 피하려고 주입한다. 발송기가 돌려주는 값은 그 답장을
// 적은 대화 기록 행의 번호다. 오늘 메모를 그 번호로 이어 두면 다음 답장 프롬프트의 기록에서
// 그 턴의 메모 칸이 실제 값으로 채워진다(이슈 #346) — 몰아 답장과 약속 답장은 여기서 직접
// 기록을 적으므로 그 자리에서 번호를 받아 넘긴다.

import { Bot, InlineKeyboard, type ApiClientOptions } from "grammy";
import { Agent } from "node:https";
import { inspect } from "node:util";
import { config } from "./config.js";
import {
  CHARACTER_AGE_BANDS,
  CHARACTER_GENDERS,
  FLAWS,
  FREE_TEXT_MAX,
  LEAD_TONES,
  MIX_TONE_MAX,
  SPEECH_LEVELS,
  START_SETTING,
  createUserCharacter,
  type CharacterGender,
} from "./character.js";
import {
  FLAW_NAME,
  LEAD_TONE_NAME,
  SPEECH_LEVEL_NAME,
  type Flaw,
  type LeadTone,
  type ProactiveKind,
  type SpeechLevel,
} from "./labels.js";
import {
  ensureTodayPlan,
  isAwayUnavail,
  type DayPlan,
  type PlanBlock,
} from "./day-plan.js";
import { ensureMonthPlan } from "./life-plan.js";
import { buildSystemBlocks, currentBlock } from "./context.js";
import {
  decideReplyTiming,
  recentUserGaps,
  type TimingDecision,
} from "./reply-timing.js";
import { awayNoticeSent, basisLineFromMeta } from "./proactive-policy.js";
import { composeReply, pendingUserTurn } from "./reply-compose.js";
import { promiseSlotFor } from "./reply-promise.js";
import {
  armReturnRow,
  dropPendingReplies,
  dropPromiseRows,
  dropWakeRows,
  isWaiting,
  schedulePendingReply,
  scheduleWakeRow,
  setPendingSender,
  setPromiseHandler,
  setWakeHandler,
  parseWakeMeta,
  type WakeMeta,
} from "./pending.js";
import {
  traceProactiveSend,
  tracePromise,
  type PromiseStage,
} from "./reply-trace.js";
import { chatJson, type CallMeta } from "./llm.js";
import { capBubbles } from "./reply-signal.js";
import { saveTodayNote } from "./memory.js";
import {
  ARRIVAL_WAIT_MAX_MS,
  ARRIVAL_WAIT_MIN_MS,
  PROACTIVE_RECENT_LINES,
  PROACTIVE_USER_MEMORY_LINES,
} from "./thresholds.js";
import {
  getActiveCharacter,
  getActiveCharacters,
  getDayPlan,
  getRecoveryMark,
  hasWaitingWakeRow,
  lastMessage,
  logMessage,
  promoteWakeRow,
  setCallContext,
  setRecoveryMark,
  type PendingReplyRow,
} from "./db.js";
import {
  kstLogicalClock,
  kstLogicalDate,
  kstStamp,
  clockLabel,
  logicalDayStartTs,
} from "./kst.js";

// 캐릭터가 보내는 메시지의 종류 — 로그·플래그로 남겨 추적을 쉽게 한다
// reply=유저 메시지에 대한 답장, recover=배포로 놓친 답장 복구, morning=아침 선톡,
// checkin=긴 침묵 뒤 안부 선톡, intent=오늘의 관계 의도 한 줄로 거는 선톡(이슈 #357),
// away=자리비움 선톡(나갈 때·돌아왔을 때),
// catchup=낮의 근황 선톡, goodnight=밤 인사 선톡, mend=서운해한 뒤 보내는 달래기 선톡,
// care=상대가 자기 일로 안 좋은 채 답이 끊긴 뒤 보내는 살피기 선톡(이슈 #361),
// lunch=무응답 이틀째에 아침 선톡과 함께 나가는 점심 선톡(이슈 #314),
// promise=답장에서 한 연락 약속을 지키는 연락(이슈 #308),
// glance=불가 구간에 온 확인 말에 지금 하는 일과 끝나는 시각을 알리는 틈새 한 줄(이슈 #339)
//
// 먼저 거는 연락의 목록은 labels.ts의 ProactiveKind가 갖는다 — 하루 예산과 근거를 정하는
// 관제탑(proactive-policy.ts)이 그 목록을 봐야 하는데, 여기서 가져가면 발송이 판정을 거꾸로
// 물게 된다.
export type SendKind = "reply" | "recover" | ProactiveKind;

// 텔레그램 API 연결 풀.
//
// 이 서버에서 텔레그램으로 가는 '새 연결'은 기본 설정으로는 매번 ETIMEDOUT으로 끝난다(이슈 #363).
// Node는 주소 자동 선택(autoSelectFamily, 이른바 Happy Eyeballs)이 켜져 있어 IPv4·IPv6를 번갈아
// 시도하는데, 한 시도에 주는 시간이 기본 250ms다. 이 서버에서 텔레그램 IPv4 접속은 맺히기까지
// 약 260ms가 걸려 그 안에 못 붙고, IPv6는 경로가 없어 즉시 실패한다. 그래서 새 연결은 250ms 만에
// 묶음 에러(AggregateError, code ETIMEDOUT)로 거절된다. grammY가 쓰는 node-fetch는 그 안쪽
// 에러를 버려서 로그에는 reason이 빈 ETIMEDOUT만 남는다. 모델 API와 슬랙은 접속이 몇십 ms라
// 이 경계에 걸리지 않고, long polling(getUpdates)은 이미 맺힌 소켓을 재사용해서 멀쩡했다.
// '새 연결 수립이 간헐적으로 죽는다'고 보였던 건 왕복 시간이 250ms 언저리에서 흔들린 탓이다.
//
// 그래서 한 시도에 주는 시간을 넉넉히 준다. 자동 선택 자체는 그대로 두어 IPv6 경로가 생겨도
// 동작이 같다. 컨테이너 안에서 잰 값은 기본 설정으로 9번 전부 실패, 시도 시간을 늘리면 9번 전부
// 약 265ms에 성공이었다.
const CONNECT_ATTEMPT_TIMEOUT_MS = 3_000;

const apiAgent = new Agent({
  keepAlive: true,
  keepAliveMsecs: 15_000, // TCP keepalive 프로브 — 중간 NAT이 유휴 연결을 끊지 않게
  maxSockets: 8,
  scheduling: "lifo", // 가장 최근에 쓴(=살아 있을 가능성이 높은) 소켓부터 재사용
  autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_TIMEOUT_MS,
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

// 연결 보온. 가장 가벼운 API를 주기적으로 두드려, 폴링이 쓰는 소켓과 별개로 유휴 소켓 한 개가
// 항상 풀에 놀고 있게 만든다. 선톡은 그걸 재사용하므로 새 연결의 TLS 왕복을 건너뛴다.
// 새 연결이 죽던 문제의 해법은 위 agent의 접속 시도 시간이고(이슈 #363), 보온은 그 위에서
// 발송을 빠르게 하는 용도다 — 유휴 소켓이 서버 쪽에서 닫힌 직후에는 어차피 새 연결이 필요하다.
// 주기는 텔레그램 쪽 idle timeout보다 짧게 — 안 두드리면 유휴 소켓이 서버에서 닫혀 매번 새 연결이다.
// 실패는 무시한다(다음 주기에 다시 시도하고, 실제 발송은 sendWithRetry가 따로 버틴다).
export const keepConnectionWarm = (intervalMs = 30_000): void => {
  setInterval(() => {
    void bot.api.getMe(sendTimeout()).catch(() => {
      /* 보온 실패는 무시 — 실제 발송은 sendWithRetry가 따로 버틴다 */
    });
  }, intervalMs).unref();
};

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, n));

// 방어적 로그 위생 — 에러 출력에 봇 토큰 같은 민감 값이 섞여 남지 않도록 로그 직전에 가린다.
// 외부 라이브러리가 에러에 요청 정보를 담을 수 있어, 만약을 대비해 값 자체 + 토큰 형태 둘 다 마스킹.
export const redactToken = (s: string): string =>
  s
    .split(config.telegramToken)
    .join("<TOKEN>")
    .replace(/\d{6,}:[A-Za-z0-9_-]{30,}/g, "<TOKEN>");

// 에러를 안전하게 로그한다 — 어떤 형태의 에러든 깊이 직렬화한 뒤 민감 값을 가리고 출력.
export const logErr = (prefix: string, e: unknown): void => {
  console.error(prefix, redactToken(inspect(e, { depth: 5 })));
};

// 줄바꿈으로 끊은 말풍선 — 선톡 문안이 쓴다(문안 여섯 곳은 자기 형식으로 답해 본문이 통글이다).
// 답장은 객체의 reply 배열에서 나오므로 이 길을 타지 않는다. 상한 계산만 한곳(capBubbles)에서 쓴다.
export const splitBubbles = (text: string): string[] => {
  const parts = text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return [text.trim()];
  return capBubbles(parts);
};

// 순간 네트워크 오류로 전송이 통째로 실패하지 않게 재시도한다(VM↔텔레그램 API 일시 단절 대비).
// 나쁜 구간은 수 분~수십 분씩 이어지므로 촘촘히 조르기보다 간격을 넓게 잡는다.
// 매 시도는 sendTimeout()(20초)으로 끊기니 최악 ~130초. 호출부(틱)는 이 시간만큼 붙잡힌다.
//
// 여기서 더 늘리지 않는 이유는 한 통을 붙잡는 시간이 곧 틱이 쉬는 시간이기 때문이다. 가장 짧은
// 틱이 3분(dispatch)이고, 그보다 오래 붙잡으면 다음 틱이 재진입 가드에 막혀 통째로 건너뛴다 —
// 창 안에서 여러 번 두드리려고 틱을 3분으로 줄인 것이 무의미해진다. 몇 분씩 끊기는 구간은
// 여기서 버티는 대신 만든 것을 남겨 두고 다음 틱에 다시 보내 넘긴다(pending.ts의 RETRY_MS,
// followup·presence의 실패 문안 보관).
const RETRY_BACKOFF_MS = [5_000, 15_000, 30_000];

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
// (재시도 간격을 넓힌 만큼 이 부분 실패 확률도 같이 올라간다. 잘린 채로 두는 게 중복보다 낫다.)
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
  logMessage(chatId, characterId, "assistant", sent.join("\n"), kstStamp(), {
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
    // 무슨 근거로 나갔는지는 기록에 적은 값에서 나온다 — 근거를 고른 자리와 게시가 떨어져
    // 있어서, 여기서 다시 판단하지 않고 meta_json에 적힌 것을 그대로 읽는다.
    basis: basisLineFromMeta(kind, extraMeta ?? {}),
  });
  return { delivered: sent.length, total };
};

// ── /start 온보딩 — 유저 입력 여덟으로 캐릭터를 만든다 ──────────────────────
// 선택지 다섯(성별·나이대·말투·원하는 방식·결점)은 인라인 버튼, 서술형 셋(성격·출발 설정에
// 덧붙일 것·바라는 모습)은 메시지로 받는다. 순서와 물음은 relationship.md §12 「온보딩 문안」.
// 서술형은 비워도 된다 — 빈 항목은 생성이 앞뒤 맞게 채운다(character.ts). 출발 설정(소개로
// 만나 몇 번 본 사이)은 고정이라 문안을 보여 주고 덧붙일 것만 받는다. 섞는 결은 버튼을
// 눌러 켜고 끄는 다중 선택이고 두 개까지다.
// 진행 상태는 메모리에만 둔다: 아직 캐릭터가 없어 잃을 것이 없고, 온보딩 중 재시작되면
// /start부터 다시 하면 된다.
type FreeStep = "personality" | "relationship" | "wish";
type PickStep = "gender" | "age" | "speech" | "lead" | "mix" | "flaw";
type OnboardingStep = PickStep | FreeStep | "creating";
interface Onboarding {
  step: OnboardingStep;
  gender?: CharacterGender;
  ageBand?: string;
  personality?: string;
  relationship?: string;
  speechLevel?: SpeechLevel;
  leadTone?: LeadTone;
  mixTones: LeadTone[];
  flaw?: Flaw;
  wish?: string;
}
const onboarding = new Map<string, Onboarding>();

const STEP_ORDER: readonly OnboardingStep[] = [
  "gender",
  "age",
  "personality",
  "relationship",
  "speech",
  "lead",
  "mix",
  "flaw",
  "wish",
  "creating",
];
const nextStep = (step: OnboardingStep): OnboardingStep =>
  STEP_ORDER[STEP_ORDER.indexOf(step) + 1] ?? "creating";
const isFreeStep = (step: OnboardingStep): step is FreeStep =>
  step === "personality" || step === "relationship" || step === "wish";
const isPickStep = (step: OnboardingStep): step is PickStep =>
  !isFreeStep(step) && step !== "creating";

const FREE_QUESTIONS: Record<FreeStep, { ask: string; skip: string }> = {
  personality: {
    ask: "성격이나 분위기는 어떤 사람이면 좋겠어?",
    skip: "비워두고 넘어가기",
  },
  relationship: {
    ask: `어떤 사이로 시작할지는 정해져 있어.\n\n${START_SETTING}\n\n여기에 덧붙이고 싶은 게 있으면 적어줘. 누가 소개했는지, 몇 번 봤는지, 뭘 같이 했는지 같은 거.`,
    skip: "덧붙일 것 없이 넘어가기",
  },
  wish: {
    ask: "그 밖에 바라는 모습이 있으면 적어줘.",
    skip: "비워두고 넘어가기",
  },
};

const genderKeyboard = (): InlineKeyboard =>
  new InlineKeyboard()
    .text(CHARACTER_GENDERS[0], "ob:g:0")
    .text(CHARACTER_GENDERS[1], "ob:g:1");

const ageKeyboard = (): InlineKeyboard => {
  const kb = new InlineKeyboard();
  CHARACTER_AGE_BANDS.forEach((band, i) => {
    kb.text(band, `ob:a:${i}`);
    if (i % 3 === 2) kb.row();
  });
  return kb;
};

const speechKeyboard = (): InlineKeyboard =>
  new InlineKeyboard()
    .text(SPEECH_LEVEL_NAME.casual, "ob:sp:casual")
    .text(SPEECH_LEVEL_NAME.polite, "ob:sp:polite");

const leadKeyboard = (): InlineKeyboard => {
  const kb = new InlineKeyboard();
  for (const tone of LEAD_TONES)
    kb.text(LEAD_TONE_NAME[tone], `ob:l:${tone}`).row();
  return kb;
};

// 섞는 결 — 주 결을 뺀 나머지를 한 줄에 하나씩, 고른 것에는 표시를 붙인다.
const mixKeyboard = (ob: Onboarding): InlineKeyboard => {
  const kb = new InlineKeyboard();
  for (const tone of LEAD_TONES) {
    if (tone === ob.leadTone) continue;
    const on = ob.mixTones.includes(tone);
    kb.text(`${on ? "✓ " : ""}${LEAD_TONE_NAME[tone]}`, `ob:m:${tone}`).row();
  }
  kb.text(
    ob.mixTones.length ? "이대로 넘어가기" : "섞지 않고 넘어가기",
    "ob:m:done",
  );
  return kb;
};

const flawKeyboard = (): InlineKeyboard => {
  const kb = new InlineKeyboard();
  for (const flaw of FLAWS) kb.text(FLAW_NAME[flaw], `ob:f:${flaw}`).row();
  return kb;
};

// 단계의 물음을 보낸다. creating이면 물음 대신 생성으로 넘어간다.
const askStep = async (
  chatId: string,
  ob: Onboarding,
  step: OnboardingStep,
): Promise<void> => {
  ob.step = step;
  const send = (text: string, reply_markup: InlineKeyboard): Promise<unknown> =>
    bot.api.sendMessage(chatId, text, { reply_markup });
  if (isFreeStep(step)) {
    const q = FREE_QUESTIONS[step];
    await send(q.ask, new InlineKeyboard().text(q.skip, "ob:s"));
    return;
  }
  switch (step) {
    case "gender":
      await send(
        "어떤 사람을 만나고 싶은지 여덟 가지만 물어볼게. 먼저, 성별은?",
        genderKeyboard(),
      );
      return;
    case "age":
      await send("나이대는?", ageKeyboard());
      return;
    case "speech":
      await send("처음엔 어떤 말투로 얘기할까?", speechKeyboard());
      return;
    case "lead":
      await send(
        "그 사람이 너를 원하는 방식은? 제일 가까운 걸 하나 골라줘.",
        leadKeyboard(),
      );
      return;
    case "mix":
      await send(
        `거기에 섞고 싶은 결이 있으면 ${MIX_TONE_MAX}개까지 골라줘. 없으면 그냥 넘어가도 돼.`,
        mixKeyboard(ob),
      );
      return;
    case "flaw":
      await send("약한 구석은? 하나 골라줘.", flawKeyboard());
      return;
    case "creating":
      await finishOnboarding(chatId, ob);
  }
};

// 서술형 답(또는 비우기)을 받아 다음 물음으로.
const advanceOnboarding = async (
  chatId: string,
  ob: Onboarding,
  answer: string | null,
): Promise<void> => {
  if (!isFreeStep(ob.step)) return;
  if (answer) ob[ob.step] = answer;
  await askStep(chatId, ob, nextStep(ob.step));
};

// 여덟 입력이 모이면 생성 두 콜(사람 전부 → 삶의 흐름)을 돌리고 첫 인사를 보낸다.
const finishOnboarding = async (
  chatId: string,
  ob: Onboarding,
): Promise<void> => {
  if (!ob.gender || !ob.ageBand || !ob.speechLevel || !ob.leadTone || !ob.flaw)
    return;
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
      speechLevel: ob.speechLevel,
      leadTone: ob.leadTone,
      mixTones: ob.mixTones,
      flaw: ob.flaw,
      wish: ob.wish,
    });
    onboarding.delete(chatId);
    const { sent } = await sendBubblesTo(chatId, output.firstGreeting);
    if (sent.length > 0)
      logMessage(chatId, id, "assistant", sent.join("\n"), kstStamp(), {
        first: true,
      });
    // 월 리듬·오늘 각본 첫 실행. 첫 인사를 기다리게 하지 않으려고 뒤에서 돌린다 —
    // 실패해도 첫 답장 때 ensureTodayPlan(lazy)이 다시 시도한다.
    void ensureMonthPlan(id, kstLogicalDate().slice(0, 7))
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

// 활성 캐릭터가 있으면 새로 만들지 않는다. 종료된 캐릭터만 있는 대화방은 처음부터 다시 만든다.
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
  const ob: Onboarding = { step: "gender", mixTones: [] };
  onboarding.set(chatId, ob);
  await askStep(chatId, ob, "gender");
});

// 온보딩 버튼 하나를 처리한다. 지나간 단계의 버튼을 늦게 눌러도 상태가 어긋나지 않게
// 현재 단계와 맞는 입력만 받는다(안 맞으면 무시). 돌려주는 글은 버튼 위에 잠깐 뜨는 안내다.
const handleOnboardingButton = async (
  chatId: string,
  data: string,
  messageId: number | undefined,
): Promise<string | undefined> => {
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
  const [, kind, arg = ""] = data.split(":");
  if (kind === "s") {
    if (isFreeStep(ob.step)) await advanceOnboarding(chatId, ob, null);
    return;
  }
  if (ob.step === "gender" && kind === "g") {
    const gender = CHARACTER_GENDERS[Number(arg)];
    if (!gender) return;
    ob.gender = gender;
    await askStep(chatId, ob, nextStep(ob.step));
    return;
  }
  if (ob.step === "age" && kind === "a") {
    const band = CHARACTER_AGE_BANDS[Number(arg)];
    if (!band) return;
    ob.ageBand = band;
    await askStep(chatId, ob, nextStep(ob.step));
    return;
  }
  if (ob.step === "speech" && kind === "sp") {
    if (!SPEECH_LEVELS.includes(arg as SpeechLevel)) return;
    ob.speechLevel = arg as SpeechLevel;
    await askStep(chatId, ob, nextStep(ob.step));
    return;
  }
  if (ob.step === "lead" && kind === "l") {
    if (!LEAD_TONES.includes(arg as LeadTone)) return;
    ob.leadTone = arg as LeadTone;
    ob.mixTones = [];
    await askStep(chatId, ob, nextStep(ob.step));
    return;
  }
  if (ob.step === "mix" && kind === "m") {
    if (arg === "done") {
      await askStep(chatId, ob, nextStep(ob.step));
      return;
    }
    const tone = arg as LeadTone;
    if (!LEAD_TONES.includes(tone) || tone === ob.leadTone) return;
    if (ob.mixTones.includes(tone))
      ob.mixTones = ob.mixTones.filter((t) => t !== tone);
    else if (ob.mixTones.length >= MIX_TONE_MAX)
      return `${MIX_TONE_MAX}개까지만 고를 수 있어. 하나를 빼고 골라줘.`;
    else ob.mixTones.push(tone);
    if (messageId !== undefined)
      await bot.api
        .editMessageReplyMarkup(chatId, messageId, {
          reply_markup: mixKeyboard(ob),
        })
        .catch(() => {
          /* 같은 표시로 고치면 텔레그램이 거부한다 — 무시 */
        });
    return;
  }
  if (ob.step === "flaw" && kind === "f") {
    if (!FLAWS.includes(arg as Flaw)) return;
    ob.flaw = arg as Flaw;
    await askStep(chatId, ob, nextStep(ob.step));
  }
  return;
};

// 섞는 결 버튼만 처리 결과를 안내로 돌려주고, 나머지는 먼저 응답하고 처리한다 — 마지막 버튼은
// 생성 두 콜을 기다리게 되어, 처리 뒤에 응답하면 텔레그램이 늦었다고 거부하고 스피너가 남는다.
bot.on("callback_query:data", async (ctx) => {
  const chatId = String(ctx.chat?.id ?? ctx.callbackQuery.from.id);
  const data = ctx.callbackQuery.data;
  const answer = (toast?: string): Promise<void> =>
    ctx
      .answerCallbackQuery(toast ? { text: toast } : undefined)
      .then(() => undefined)
      .catch(() => {
        /* 응답 실패는 무시 — 오래된 콜백은 텔레그램이 거부한다 */
      });
  if (!data.startsWith("ob:m:")) {
    await answer();
    if (data.startsWith("ob:"))
      await handleOnboardingButton(chatId, data, undefined);
    return;
  }
  const toast = await handleOnboardingButton(
    chatId,
    data,
    ctx.callbackQuery.message?.message_id,
  );
  await answer(toast);
});

// TODO(D1 전): /새로만나기 — 비가역 확인 → 아카이브 → "어떤 점이 아쉬웠어?" → 새 캐릭터 생성

// 유저가 문장을 끊어 보내는 동안 기다렸다가, 멈추면 그동안 온 것을 한 번에 읽고 응답한다(디바운스)
// 텔레그램 봇 API는 유저의 '입력중'을 봇에 주지 않고(수신 불가), 끝맺음으로도 확실히 못 가늠한다
// (질문을 문장 중간에 하기도 함). 그래서 최소 20초는 기다리고, 거기서 '위로만' 조정한다:
// 한 번에 길게 치는 사람(이어 보내기 텀이 긴)일수록 더 오래. 아래로는 줄이지 않는다 —
// '답장 올까봐' 급히 친 짧은 텀에 벌주듯 대기를 더 줄이면 재촉 악순환이 되기 때문(실측으로 확인).
// (자체 앱이라면 유저의 '입력중' 신호를 받아 치는 동안엔 안 답하고 멈춤에만 답할 수 있다 — 텔레그램 봇의 한계)
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
const computeWait = (chatId: string, characterId: number): number => {
  const gaps = recentUserGaps(chatId, characterId);
  let base = ARRIVAL_WAIT_MIN_MS;
  if (gaps.length >= 3) {
    const sorted = [...gaps].sort((a, b) => a - b);
    const p80 =
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.8))];
    base = clamp(p80 * 1.4, ARRIVAL_WAIT_MIN_MS, ARRIVAL_WAIT_MAX_MS); // 20초 미만으로는 안 내려감
  }
  const wait = base + Math.random() * 5000; // +0~5초 (짧게 치는 사람 20~25초, 길게 치는 사람은 더)
  console.log(
    `[debounce] chat=${chatId} n=${gaps.length} wait=${Math.round(wait / 1000)}s`,
  );
  return wait;
};

// 답장 프롬프트에 넣는 대화 기록. 행을 넉넉히 읽어 최근 몇 턴에서 자른다 — 한 사람이
const toMinOfDay = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

// 예고를 이미 보낸 자리 비움 블록이 곧 시작되는가 — 그 사이에 온 말은 배웅 답이 된다.
// 예고가 아직 안 나갔으면(닥친 일이거나 예고 틱이 못 돌았으면) 평범한 답장으로 간다.
export const upcomingAnnouncedAway = (
  chatId: string,
  characterId: number,
): PlanBlock | null => {
  const raw = getDayPlan(characterId, kstLogicalDate());
  if (!raw) return null;
  let blocks: PlanBlock[];
  try {
    blocks = (JSON.parse(raw) as DayPlan).blocks;
  } catch {
    return null;
  }
  const nowMin = toMinOfDay(kstLogicalClock());
  for (const b of blocks) {
    if (!isAwayUnavail(b)) continue;
    const rel = toMinOfDay(b.start) - nowMin;
    if (rel <= 0 || rel > 15) continue;
    if (awayNoticeSent(chatId, characterId, logicalDayStartTs(), b.start))
      return b;
  }
  return null;
};

// 자리를 비우러 가는 말의 결 — 자리 비움 예고(presence.ts)·몰아 답장·배웅 답·사이 예고가
// 같은 줄을 쓴다(이슈 #341). 끝나고 다시 물어보겠다는 식으로 대화를 닫으면 상대는 그 말을
// 듣고 기다리는 자리가 되고, 몇 분 걸린다고 재는 말은 예고가 아니라 통보로 읽힌다. 얼른 하고
// 오겠다는 결에, 그 일이 어떤지 상대가 그려 볼 수 있는 한 마디를 붙인다.
export const LEAVING_LINES = [
  `- 자리를 비우러 가는 말은 얼른 하고 오겠다는 결로 짧게 한다(얼른 씻고 올게, 금방 올게처럼). 끝나면 다시 물어보겠다는 식으로 대화를 닫거나, 몇 분 걸린다고 재는 말로 끝내지 않는다.`,
  `- 그 일이 어떤지 상대가 그려 볼 수 있는 한 마디를 붙인다 — 운동 뒤라 땀이 많이 났다든가, 밖이 벌써 어둡다든가. 지어낸 사건이 아니라 각본과 [지금] 절에 있는 일에서 나온 한 마디다.`,
].join("\n");

// 각본에 없는 일을 지어내지 않는 줄 — 상황 문단이 말한 일과 [지금] 절의 일만 말한다. 이 줄이
// 없으면 돌아왔다는 문안에서 씻으러 간다는 식으로 각본에 없는 다음 일을 만들어 붙인다.
export const NO_INVENT_LINE = `- 지금 하는 일과 이제 할 일은 이 문단과 [지금] 절에 적힌 것만 말한다. 거기 없는 일을 하러 간다거나 했다고 지어내지 않는다.`;

// 배웅 답 — 나간다고 이미 알린 뒤, 나가기 전까지 온 말에 짧게 받는 상황 문단.
export const farewellSituation = (b: PlanBlock): string =>
  [
    `[배웅 답 — 곧 자리를 비운다]`,
    `너는 곧 ${clockLabel(b.start)}부터 "${b.activity}" 때문에 자리를 비운다. 상대에게는 이미 예고해 뒀다.`,
    `나가기 직전의 짧은 주고받음이다 — 지금 온 말에 짧게만 받고, 새 화제를 벌이지 않는다. 필요하면 얼른 다녀오겠다는 결로.`,
    LEAVING_LINES,
  ].join("\n");

// 몰아 답장 — 불가 구간이 끝나 깨어난 자리. 그 사이 온 메시지를 한 번에 읽고 답하는 상황 문단.
export const gatherSituation = (activity: string): string =>
  [
    `[몰아 답장 — 방금 하던 일이 끝나 이제야 본다]`,
    `너는 방금 "${activity}"을(를) 끝냈다. 대화 기록 끝의 상대 메시지들은 그 동안 온 것이라 이제야 본다.`,
    `이제 끝나고 봤다는 결로, 쌓인 말을 한 번에 자연스럽게 받는다. 메시지가 여러 개면 억지로 하나하나 다 짚지 말고 흐름으로 답한다.`,
    `[지금] 절의 "지금 하는 일"은 방금 시작한 다음 일정이다 — 아직 하지 않았으니 끝냈다고 말하지 않는다.`,
    `그 다음 일정의 답장 여건이 불가면, 이제 그리로 간다는 것까지 이 답장에서 함께 알린다. 같은 말을 하는 예고가 따로 나가지 않는다.`,
    LEAVING_LINES,
    NO_INVENT_LINE,
  ].join("\n");

// 사이 예고 — 불가 구간이 끝났는데 다음 블록도 자리 비움 불가일 때, 돌아왔다는 말 대신 방금 한
// 일과 이제 하러 가는 일을 알리는 상황 문단(이슈 #341). 자리 비움 틱의 경계 예고와 같은 자리지만
// 이 문안은 구간 끝 핸들러가 만들어 보내므로 away 칸 없이 선톡 형식으로 받는다.
export const betweenSituation = (
  prevActivity: string,
  next: PlanBlock,
): string =>
  [
    `[문안 — 지금 보낼 사이 예고 한 통]`,
    `너는 방금 "${prevActivity}"을(를) 막 끝냈고, 이제 곧 "${next.activity}"을(를) 하러 간다. 아직 집에 돌아온 것도, 한가해진 것도 아니다. 그 동안은 답장이 어렵다.`,
    `이 일은 ${clockLabel(next.end)}에 끝난다(${toMinOfDay(next.end) - toMinOfDay(next.start)}분짜리). 얼마나 걸리는지 말할지는 네가 정하되, 말한다면 이 시각 그대로 쓴다 — 어림해서 다른 시각을 지어내지 않는다.`,
    `- 방금 한 일을 자연스럽게 언급하며 이제 다음 걸 하러 간다고 말한다. 상대 말에는 그때 이미 답했으니 다시 답하지 않는다.`,
    `- 무슨 일로 자리를 비우는지는 반드시 남긴다. 상대가 네가 뭘 하는지 알고 기다리게 하는 말이다.`,
    LEAVING_LINES,
    NO_INVENT_LINE,
    `- 짧게 1~2개 말풍선(줄바꿈 구분). 재촉하거나 답을 요구하지 않는다.`,
    `- 억지스러우면 send=false.`,
    ``,
    `JSON으로만 답한다: {"send":true,"text":"..."} 또는 {"send":false}`,
  ].join("\n");

/** 구간 끝 표시가 울렸는데 온 말이 없을 때 무엇을 할지(이슈 #341). */
export type ReturnAction = "greet" | "between" | "rearm" | "skip";

/**
 * 구간 끝 표시가 울렸는데 온 말이 없을 때의 갈래. 직전 말이 복귀 인사면 또 하지 않는다(불가
 * 구간이 이어지는 날 유저가 답하지 않는 동안 인사가 구간마다 쌓인다). 지금 블록이 답할 수 있는
 * 블록이거나 각본에 없으면 복귀 인사(greet), 자리 비움 불가면 돌아왔다고 말하는 대신 사이
 * 예고(between)를 보내고 그 끝에 표시를 다시 건다. 직전 말이 이미 사이 예고면 문안 없이 표시만
 * 다시 건다(rearm). 잠이면 조용히 지나간다 — 굿나잇과 잠 정책이 따로 있다.
 */
export const pickReturnAction = (
  lastMetaJson: string | null,
  cur: PlanBlock | null,
): ReturnAction => {
  if (lastMetaJson?.includes('"return"')) return "skip";
  if (!cur || cur.responsiveness !== "unavailable") return "greet";
  if (!isAwayUnavail(cur)) return "skip";
  return lastMetaJson?.includes('"between"') ? "rearm" : "between";
};

// 복귀 인사 — 자리를 비운 사이 상대에게서 온 말이 없었을 때, 돌아왔음을 먼저 알리는 상황 문단.
//
// 나가기 전에 그 말을 해 뒀는지는 여기서 단정하지 않는다. 자리 비움 예고가 나갔는지는 코드가
// 알지만, 예고 없이 답장 안에서 이따 보자고 해 둔 경우도 많아 예고 여부만으로는 어느 쪽인지
// 정해지지 않는다. 둘 다 되는 문안을 주고 대화 기록을 보고 고르게 한다 — 아니라고 못 박으면
// 방금 그 말을 해 놓고도 못 했다고 하는 답이 나온다.
export const returnSituation = (activity: string): string =>
  [
    `[문안 — 지금 보낼 복귀 인사 한 통]`,
    `너는 방금 "${activity}"을(를) 끝내고 돌아왔다. 그 사이 상대에게선 말이 없었다.`,
    `- 돌아왔음을 가볍게 알린다(그 일이 이제 끝났고 돌아왔다는 결). 아까 하려던 안부를 자연스럽게 이어도 좋다. 매달림이 아니라 자연스러운 복귀 인사다.`,
    `- 나가기 전에 이따 보자고 해 뒀으면 그 말을 지키는 자리다. 대화 기록에서 그때 한 말을 보고 어긋나지 않게 받는다.`,
    `- 나가면서 아무 말도 못 했으면 무엇을 하다 왔는지 한 마디만 붙인다. 길게 변명하지 않는다.`,
    NO_INVENT_LINE,
    `- 짧게 1~2개 말풍선(줄바꿈 구분). 재촉하거나 답을 요구하지 않는다.`,
    `- 억지스러우면 send=false.`,
    ``,
    `JSON으로만 답한다: {"send":true,"text":"..."} 또는 {"send":false}`,
  ].join("\n");

// 약속한 연락 — 답장에서 무엇을 마치고 연락하겠다고 한 그 시각이 온 자리의 상황 문단(이슈 #308).
//
// replying이 참이면 그 사이 상대가 말을 보내 답장으로 나가는 자리라 JSON 형식 줄을 붙이지
// 않는다(답장 형식은 REPLY_ENVELOPE가 정한다). 거짓이면 선톡과 같은 형식으로 문안을 받는다.
// 약속을 이미 지켰거나 대화가 그 뒤로 이어졌으면 send=false로 접게 한다 — 약속 시각은 각본
// 경계에서 코드가 고른 것이라 실제로는 그 전에 대화가 재개됐을 수 있다.
export const promiseSituation = (
  promise: string,
  activity: string,
  replying: boolean,
): string =>
  [
    replying
      ? `[약속한 연락 — 이 답장이 그 약속을 지키는 자리다]`
      : `[문안 — 약속한 연락 한 통]`,
    `너는 아까 답장에서 "${promise}"라고 했고, 방금 "${activity}"을(를) 끝냈다. 지금 그 약속을 지키는 자리다.`,
    replying
      ? `- 대화 기록 끝의 상대 메시지는 그 사이 온 것이다. 약속대로 돌아왔다는 결로 그 말을 받는다.`
      : `- 약속한 대로 돌아왔다는 결로 말을 건다. 무엇을 하다 왔는지는 한 마디면 된다.`,
    `- 대화 기록에서 이미 그 연락을 했거나 그 뒤로 대화가 이어지고 있으면 같은 말을 되풀이하지 않는다${replying ? "" : " — 그때는 send=false"}.`,
    `- 짧게 1~2개 말풍선(줄바꿈 구분). 재촉하거나 답을 요구하지 않는다.`,
    ...(replying
      ? []
      : [
          ``,
          `JSON으로만 답한다: {"send":true,"text":"..."} 또는 {"send":false}`,
        ]),
  ].join("\n");

/**
 * 답장에서 한 연락 약속을 코드가 지킬 시각에 걸어 둔다(이슈 #308). 시각은 각본 블록 경계에서
 * 고른다(reply-promise.ts). 한 대화에 약속은 하나라 앞 약속이 있으면 거두고 새로 건다 —
 * 거둔 건수는 replaced로 돌려줘 답장 게시에 적힌다. callId는 약속을 한 답장의 호출 번호로,
 * 행의 meta에 실어 두면 약속이 그 뒤 어떻게 됐는지가 그 답장 스레드에 달린다(이슈 #312).
 * 각본에 남은 블록이 없으면 걸지 않고 null — 그 약속은 코드가 시각을 정할 수 없다.
 * exceptRowId는 지금 울리고 있는 약속 행 — 그 핸들러 안에서 새로 걸 때는 그 행을 거두지 않는다
 * (울린 행은 핸들러가 끝나면 sent로 닫힌다).
 */
const keepPromise = (
  chatId: string,
  characterId: number,
  userMsgAt: string,
  promise: string,
  callId: number | null,
  exceptRowId?: number,
): {
  sendAt: string;
  block: string;
  activity: string;
  replaced: number;
} | null => {
  const slot = promiseSlotFor(characterId);
  if (!slot) {
    console.warn(
      `[promise] 각본에 남은 블록이 없어 약속 시각을 못 정함 (chat=${chatId}): ${promise}`,
    );
    return null;
  }
  const replaced = dropPromiseRows(chatId, undefined, exceptRowId);
  if (replaced)
    console.log(
      `[promise] 앞 약속 ${replaced}건 거둠 — 새 약속으로 갈아 끼운다`,
    );
  const meta: WakeMeta = {
    activity: slot.block.activity,
    blockStart: slot.block.start,
    blockEnd: slot.block.end,
    promise,
    callId,
  };
  const { sendAt } = scheduleWakeRow({
    chatId,
    characterId,
    userMsgAt,
    waitMs: slot.waitMs,
    meta,
    kind: "promise",
  });
  return {
    sendAt,
    block: `${slot.block.start}~${slot.block.end}`,
    activity: slot.block.activity,
    replaced,
  };
};

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
    const turn = pendingUserTurn(chatId, character.id);
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
        : await decideReplyTiming(character.id, turn.text, {
            burst: { n: turn.n, firstAt: turn.firstAt },
          });
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
      // 이미 걸려 있으면 새로 만들지 않는다 — 한 구간에 행은 하나다. 다만 자리 비움 틱이
      // 걸어 둔 'return' 행이면 답할 말이 생긴 것이라 'wake'로 올린다. 그래야 구간이 끝날 때
      // 복귀 인사가 아니라 몰아 답장으로 간다.
      else if (promoteWakeRow(chatId, turn.at))
        console.log(
          `[pending] 구간 끝 표시를 깨우기로 올림 — 이 구간에 온 말에 답한다 (chat=${chatId})`,
        );
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

    // 2. 지금 만든다 — 순서는 reply-compose.ts에 있다. 예고해 둔 자리 비움이 곧 시작되면
    // 배웅 답 상황 문단을 얹는다(곧 나간다는 걸 아는 채로 짧게 받는다). 호출 기록에는 텀 계산의
    // 입력과 결과, 도착 대기, 붙잡기 판정이 접은 일정을 앞세워 붙인다.
    const away =
      kind === "reply" ? upcomingAnnouncedAway(chatId, character.id) : null;
    const reply = await composeReply({
      characterId: character.id,
      chatId,
      turn,
      ...(away ? { situation: farewellSituation(away) } : {}),
      context: {
        timing: { waitMs: timing.waitMs, ...timing.trace, held: timing.held },
        ...(arrival ? { arrival } : {}),
      },
      ...(timing.held
        ? {
            heldActual: {
              blockStart: timing.trace.block?.start ?? null,
              activity: timing.held.activity,
              outcome: timing.held.outcome,
            },
          }
        : {}),
      logTag: "[send]",
    });
    if (!reply) return;
    const { bubbles, signals } = reply;

    // 3. 정한 시각에 나가게 저장한다. 대기가 0이어도 같은 길로 보낸다 —
    // 발송 직전에 죽어도 pending_replies에 남아 다시 뜰 때 이어진다.
    const scheduled = schedulePendingReply({
      chatId,
      characterId: character.id,
      userMsgAt: turn.at,
      bubbles,
      // 객체의 note 신호(NOTE_RULE) — 발송이 성공하면 pending.ts가 saveTodayNote로 저장한다.
      noteToSave: signals.note,
      waitMs: timing.waitMs,
      kind,
      // 발송·폐기 결과를 이 답장을 만든 호출의 트레이스에 잇는다.
      callId: reply.callId,
      // 쓴 플러팅·오늘 일정 말함 — 발송할 때 대화 기록 행의 meta_json으로 옮겨 적는다.
      replyMeta: reply.replyMeta,
    });
    reply.attach({ sendAt: scheduled.sendAt });
    // 답장 책임은 여기서 확정된다 — 저장된 행이 발송을 보장하므로 복구 틱이 다시 답하지 않게 한다.
    setRecoveryMark(chatId, turn.at);
    // 답장에서 연락 약속을 했으면 코드가 그 시각을 정해 걸어 둔다(이슈 #308).
    if (signals.promise) {
      const kept = keepPromise(
        chatId,
        character.id,
        turn.at,
        signals.promise,
        reply.callId,
      );
      reply.attach({
        promise: kept
          ? { text: signals.promise, ...kept }
          : { text: signals.promise, dropped: "각본에 남은 블록이 없음" },
      });
    }
    console.log(
      `[send] kind=${kind} chat=${chatId} bubbles=${bubbles.length} wait=${Math.round(timing.waitMs / 1000)}s`,
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
  return logMessage(
    row.chat_id,
    row.character_id,
    "assistant",
    sent.join("\n"),
    kstStamp(),
    {
      kind,
      // 답장 행의 meta_json에 실어 온 관계 값(move·told_plan)을 기록 행으로 옮긴다. 복구 답장도
      // 같은 길로 만든 것이라 같이 옮긴다 — 빠지면 다음 판정이 직전 플러팅을 못 본다.
      ...parseReplyMeta(row.meta_json),
      ...(sent.length < bubbles.length
        ? { partial: `${sent.length}/${bubbles.length}` }
        : {}),
    },
  );
});

/** 예약 답장 행의 meta_json을 기록 행에 옮길 모양으로. 없거나 깨졌으면 빈 객체. */
const parseReplyMeta = (raw: string | null): Record<string, unknown> => {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

// 구간 끝 표시가 울리는 자리 — 답장 불가 구간이 끝났다. 갈래는 넷:
// ① 그 사이 온 메시지가 있으면 몰아 답장 한 번 ("방금 끝났고 이제 봤다"가 사실인 시점에 만든다).
//    지금 블록이 자리 비움 불가면 답장에서 그리로 간다고 말했으니 그 끝에 표시를 다시 건다.
// ② 온 말이 없고 지금 답할 수 있으면 복귀 인사 ("이제 끝났어") — 나가기 전에 예고를 보냈는지로
//    문안만 갈린다.
// ③ 온 말이 없는데 지금 블록도 자리 비움 불가면 돌아왔다는 말 대신 사이 예고를 보내고 그 끝에
//    표시를 다시 건다. 직전 말이 이미 사이 예고면 문안 없이 표시만 다시 건다(이슈 #341).
// ④ 직전에 이미 복귀 인사를 했거나 잠이면 조용히 지나간다.
// presence.ts에 따로 있던 복귀 알림 경로를 여기로 합쳤다 — 답장과 복귀 인사가 겹쳐 나가는
// 이중 발송이 구조적으로 사라진다(답할 말이 있는 kind='wake' 행이 있는 동안 isWaiting이
// 선톡 틱을 전부 막고, 이 자리에서 둘 중 하나만 고른다).
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
  const last = lastMessage(chatId, row.character_id);

  // ① 몰아 답장 — 마지막 말이 유저 차례로 남아 있으면 그 사이 온 메시지가 있다는 뜻.
  if (last?.role === "user") {
    const turn = pendingUserTurn(chatId, row.character_id);
    if (!turn) return;
    // 순서는 답장과 같다(reply-compose.ts). 다른 것은 셋 — 방금 돌아왔다는 상황 문단, 구간에
    // 처음 온 메시지에 강제하는 시간 표시(자리를 비운 사이가 한 시간이 안 되면 마커가 안 붙어
    // 나가기 직전 발화와 그 뒤에 온 말이 기록에서 맞붙는다), 텀 대신 어느 구간이 끝나 답하는지를
    // 남기는 근거. 이 길은 텀 표를 타지 않는다.
    const reply = await composeReply({
      characterId: row.character_id,
      chatId,
      turn,
      situation: gatherSituation(activity),
      markFrom: row.user_msg_at,
      context: {
        gathered: { activity, blockStart: meta.blockStart ?? null, waitedMs },
      },
      logTag: "[wake]",
    });
    if (!reply) return;
    const { bubbles, signals } = reply;
    // 바로 보낸다 — 구간이 끝나는 시각이 이미 이 답장의 텀이다.
    const { sent, error } = await sendBubbleList(chatId, bubbles);
    if (sent.length === 0 && error) throw error; // pending의 재시도에 맡긴다
    // 이 길은 pending을 타지 않아 발송 결과가 따로 붙지 않는다 — 여기서 남긴다.
    reply.attach({ sent: `${sent.length}/${bubbles.length}` });
    if (error)
      console.warn(`[wake] 부분 발송 ${sent.length}/${bubbles.length}`);
    const messageId = logMessage(
      chatId,
      row.character_id,
      "assistant",
      sent.join("\n"),
      kstStamp(),
      {
        kind: "reply",
        gathered: meta.blockStart ?? true,
        ...(reply.replyMeta ?? {}),
        ...(sent.length < bubbles.length
          ? { partial: `${sent.length}/${bubbles.length}` }
          : {}),
      },
    );
    if (signals.note)
      saveTodayNote(row.character_id, signals.note, messageId);
    setRecoveryMark(chatId, turn.at);
    if (signals.promise) {
      const kept = keepPromise(
        chatId,
        row.character_id,
        turn.at,
        signals.promise,
        reply.callId,
      );
      reply.attach({
        promise: kept
          ? { text: signals.promise, ...kept }
          : { text: signals.promise, dropped: "각본에 남은 블록이 없음" },
      });
    }
    // 지금 블록이 자리 비움 불가면 그 끝에 표시를 건다 — 이 답장에서 그리로 간다고 말했으니
    // 돌아와서 말할 자리가 있어야 한다. 자리 비움 틱은 알리지 않은 짧은 구간을 거르지만 여기서는
    // 방금 알렸으므로 길이를 보지 않는다. 약속을 걸었으면 그 약속이 그 자리라 armReturnRow가
    // 약속 행을 보고 걸지 않는다. 울리고 있는 이 행은 아직 waiting이라 빼고 센다.
    const next = currentBlock(row.character_id);
    if (next && isAwayUnavail(next)) {
      const armed = armReturnRow({
        chatId,
        characterId: row.character_id,
        block: next,
        userMsgAt: turn.at,
        exceptRowId: row.id,
      });
      if (armed)
        reply.attach({
          returnRow: { sendAt: armed.sendAt, activity: next.activity },
        });
    }
    console.log(
      `[wake] 몰아 답장 chat=${chatId} @ ${activity} bubbles=${bubbles.length}`,
    );
    return;
  }

  // ② 복귀 인사 — 자리를 비운 사이 상대에게서 온 말이 없었던 경우.
  //
  // 예전에는 자리 비움 예고를 보낸 자리에서만 인사했는데, 그 예고는 하루 상한·중복 검사·침묵
  // 검사에 자주 막힌다. 그래서 나갈 때 답장으로 이따 보자고 해 놓고 예고만 막힌 날에는 상대가
  // 그 말을 믿고 기다리는데도 캐릭터가 다음 날 아침까지 아무 말도 하지 않았다.
  if (!last || last.role !== "assistant") return;
  // 지금 블록을 보고 갈래를 고른다. 방금 보낸 것이 복귀 인사면 또 하지 않는다 — 불가 구간이
  // 이어지는 날 유저가 답하지 않는 동안 인사가 구간마다 쌓인다. 유저가 한 번 답하면 last.role이
  // 유저가 되어 다시 열린다. 지금 블록도 자리 비움 불가면 돌아왔다고 말하지 않는다 — 그 문안은
  // 다음 일을 모르니 집에 왔다고 하거나 각본에 없는 일을 하러 간다고 지어냈다(이슈 #341).
  const cur = currentBlock(row.character_id);
  const action = pickReturnAction(last.meta_json, cur);
  if (action === "skip") {
    console.log(
      `[wake] 복귀 인사 접음 — ${last.meta_json?.includes('"return"') ? "직전에 이미 했다" : "잠"} (chat=${chatId})`,
    );
    return;
  }
  // 사이 예고와 표시 다시 걸기는 문안이 나가든 접히든 먼저 건다 — 그 끝에 울릴 행이 있어야
  // 마지막 불가 구간 뒤에 복귀 인사가 나간다. 울리고 있는 이 행은 아직 waiting이라 빼고 센다.
  const between = action === "between" || action === "rearm" ? cur : null;
  if (between) {
    const armed = armReturnRow({
      chatId,
      characterId: row.character_id,
      block: between,
      userMsgAt: row.user_msg_at,
      exceptRowId: row.id,
    });
    console.log(
      `[wake] 다음 블록도 자리 비움(${between.activity}) — ${armed ? `${armed.sendAt}에 표시 다시 걺` : "표시 안 걺(이미 있음)"} (chat=${chatId})`,
    );
    if (action === "rearm") return;
  }
  // 이 인사는 선톡과 같은 자리를 쓴다. 답할 말이 있는 'wake' 행과 달리 이 행은 선톡 틱을
  // 막지 않으므로(그래야 구간 안에서 다음 예고와 아침·점심 선톡이 창을 지킨다), 보내는 동안만
  // 자리를 잡아 같은 순간에 도는 자리 비움 예고와 겹치지 않게 한다.
  if (!acquireProactive(chatId)) return;
  try {
    const draft = await chatJson<{ send: boolean; text?: string }>(
      buildSystemBlocks(row.character_id, chatId, {
        recent: PROACTIVE_RECENT_LINES,
        userMemories: PROACTIVE_USER_MEMORY_LINES,
        situation: between
          ? betweenSituation(activity, between)
          : returnSituation(activity),
      }),
      "위 상황 문단대로 문안을 만들어.",
      400,
      config.model,
      {
        purpose: between ? "away" : "comeback",
        characterId: row.character_id,
        chatId,
      },
    );
    // 발송 직전 재확인 — LLM을 기다리는 사이 유저가 답했거나 다른 경로가 보냈으면 접는다.
    if (
      draft.send &&
      draft.text &&
      lastMessage(chatId, row.character_id)?.sent_at === last.sent_at
    ) {
      // 사이 예고의 block은 자리 비움 틱의 예고와 같은 칸이다 — 틱이 같은 블록에 예고를 또
      // 보내지 않게(awayNoticeSent) 하고, between은 하루 상한에서 빼는 표시다.
      await sendProactive(
        chatId,
        row.character_id,
        draft.text,
        "away",
        between
          ? { between: between.start, block: between.start }
          : { return: meta.blockStart ?? true },
      );
      console.log(
        `[wake] ${between ? "between" : "return"} @ ${activity} → ${chatId}`,
      );
    }
  } finally {
    releaseProactive(chatId);
  }
});

// 약속 시각이 울리는 자리 — 답장에서 한 연락 약속을 지킨다(이슈 #308). 갈래는 넷:
// ① 같은 대화에 깨우기 표시가 걸려 있으면 지나간다 — 그 구간이 끝날 때 몰아 답장이나 복귀
//    인사가 나가고, 그 자리에서 대화 기록의 약속을 보고 받는다.
// ② 지금 블록이 답장 불가면 그 블록 끝으로 다시 건다 — 약속 시각을 고른 뒤 각본이 바뀌었거나
//    잠든 시간에 걸린 경우다.
// ③ 그 사이 상대가 말을 보냈으면 그 말에 답하는 답장으로 약속을 지킨다.
// ④ 온 말이 없으면 약속대로 먼저 연락한다. 선톡 자리를 쓰되 하루 상한에는 세지 않는다.
// 답장 생성이 진행 중이면 던져서 pending의 재시도(1·2분)를 탄다.
setPromiseHandler(async (row: PendingReplyRow) => {
  const chatId = row.chat_id;
  const meta = parseWakeMeta(row);
  const activity = meta.activity ?? "하던 일";
  const promise = meta.promise ?? "끝나고 다시 연락";
  // 약속이 그 뒤 어떻게 됐는지는 약속을 한 답장 스레드에 단다(이슈 #312).
  const trace = (
    stage: PromiseStage,
    detail?: string,
    draftCallId?: number | null,
  ): void =>
    tracePromise({
      characterId: row.character_id,
      rowId: row.id,
      stage,
      promise,
      callId: meta.callId,
      draftCallId,
      detail,
    });
  if (hasWaitingWakeRow(chatId)) {
    console.log(
      `[promise] 깨우기 표시가 걸려 있어 그쪽에 맡김 (chat=${chatId}): ${promise}`,
    );
    trace("deferred");
    return;
  }
  if (pending.has(chatId) || responding.has(chatId))
    throw new Error("답장을 만드는 중 — 잠시 뒤 다시");
  const cur = currentBlock(row.character_id);
  if (cur && cur.responsiveness === "unavailable") {
    // 다시 거는 행은 같은 답장의 약속이라 원래 호출 번호를 그대로 잇는다.
    const kept = keepPromise(
      chatId,
      row.character_id,
      row.user_msg_at,
      promise,
      meta.callId ?? null,
      row.id,
    );
    console.log(
      `[promise] 지금은 답장 불가 구간(${cur.activity}) — ${kept ? `${kept.sendAt}로 다시 검` : "다시 걸 블록 없음"} (chat=${chatId})`,
    );
    if (kept)
      trace(
        "rescheduled",
        `${cur.activity} 중 → ${kept.sendAt.slice(11, 16)} (${kept.activity} 끝)`,
      );
    else trace("no_slot", `${cur.activity} 중`);
    return;
  }
  const last = lastMessage(chatId, row.character_id);

  // ③ 그 사이 온 말이 있다 — 약속을 지키는 답장.
  if (last?.role === "user") {
    // 만들어 둔 답장이 있으면 버린다 — 약속 시각의 답장이 그 말까지 함께 받는다.
    const droppedReply = dropPendingReplies(
      chatId,
      "약속 시각이 되어 다시 만든다",
    );
    if (droppedReply)
      console.log(
        `[promise] 만들어 둔 답장 ${droppedReply}건 거둠 (chat=${chatId})`,
      );
    const turn = pendingUserTurn(chatId, row.character_id);
    if (!turn) return;
    const reply = await composeReply({
      characterId: row.character_id,
      chatId,
      turn,
      situation: promiseSituation(promise, activity, true),
      context: {
        promised: { promise, activity, blockStart: meta.blockStart ?? null },
      },
      logTag: "[promise]",
    });
    if (!reply) return;
    const { bubbles, signals } = reply;
    const { sent, error } = await sendBubbleList(chatId, bubbles);
    if (sent.length === 0 && error) throw error; // pending의 재시도에 맡긴다
    reply.attach({ sent: `${sent.length}/${bubbles.length}` });
    if (error)
      console.warn(`[promise] 부분 발송 ${sent.length}/${bubbles.length}`);
    const messageId = logMessage(
      chatId,
      row.character_id,
      "assistant",
      sent.join("\n"),
      kstStamp(),
      {
        kind: "reply",
        promised: true,
        ...(reply.replyMeta ?? {}),
        ...(sent.length < bubbles.length
          ? { partial: `${sent.length}/${bubbles.length}` }
          : {}),
      },
    );
    if (signals.note)
      saveTodayNote(row.character_id, signals.note, messageId);
    setRecoveryMark(chatId, turn.at);
    trace("replied", reply.callId ? `답장 #${reply.callId}` : undefined);
    if (signals.promise) {
      const kept = keepPromise(
        chatId,
        row.character_id,
        turn.at,
        signals.promise,
        reply.callId,
        row.id,
      );
      reply.attach({
        promise: kept
          ? { text: signals.promise, ...kept }
          : { text: signals.promise, dropped: "각본에 남은 블록이 없음" },
      });
    }
    console.log(
      `[promise] 약속 답장 chat=${chatId} @ ${activity} bubbles=${bubbles.length}`,
    );
    return;
  }

  // ④ 온 말이 없다 — 약속대로 먼저 연락한다.
  if (!last || last.role !== "assistant") return;
  if (!acquireProactive(chatId))
    throw new Error("선톡 자리가 차 있음 — 잠시 뒤 다시");
  try {
    const draftMeta: CallMeta = {
      purpose: "promise",
      characterId: row.character_id,
      chatId,
    };
    const draft = await chatJson<{ send: boolean; text?: string }>(
      buildSystemBlocks(row.character_id, chatId, {
        recent: PROACTIVE_RECENT_LINES,
        userMemories: PROACTIVE_USER_MEMORY_LINES,
        situation: promiseSituation(promise, activity, false),
      }),
      "위 상황 문단대로 문안을 만들어.",
      400,
      config.model,
      draftMeta,
    );
    // 문안 호출 행에 어느 약속을 지키는 자리였는지 남긴다 — 문안 게시가 머리에 적는다.
    if (draftMeta.callId)
      setCallContext(draftMeta.callId, {
        promised: { promise, activity, blockStart: meta.blockStart ?? null },
      });
    const draftLabel = draftMeta.callId
      ? `문안 #${draftMeta.callId}`
      : undefined;
    // 발송 직전 재확인 — 모델을 기다리는 사이 유저가 답했거나 다른 경로가 보냈으면 접는다.
    if (!draft.send || !draft.text) {
      console.log(`[promise] 약속 연락 접음 (chat=${chatId}): ${promise}`);
      trace(
        "skipped",
        `모델이 보내지 않기로 했다${draftLabel ? ` (${draftLabel})` : ""}`,
        draftMeta.callId,
      );
    } else if (
      lastMessage(chatId, row.character_id)?.sent_at !== last.sent_at
    ) {
      console.log(
        `[promise] 약속 연락 접음 — 문안을 만드는 사이 마지막 메시지가 바뀌었다 (chat=${chatId})`,
      );
      trace(
        "skipped",
        `문안을 만드는 사이 마지막 메시지가 바뀌었다${draftLabel ? ` (${draftLabel})` : ""}`,
        draftMeta.callId,
      );
    } else {
      // 근거 줄이 어느 약속인지 적을 수 있게 기록 행 번호를 함께 남긴다(설계 원본 §9).
      await sendProactive(chatId, row.character_id, draft.text, "promise", {
        promise,
        promise_row: row.id,
      });
      console.log(`[promise] 약속 연락 @ ${activity} → ${chatId}`);
      trace("sent", draftLabel, draftMeta.callId);
    }
  } finally {
    releaseProactive(chatId);
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
    if (isPickStep(ob.step)) {
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
  logMessage(chatId, character.id, "user", ctx.message.text, kstStamp());
  // 만들어 두고 기다리던 답장이 있으면 버린다 — 유저가 말을 더 보탰으니 내용도 텀도 다시 정한다.
  const dropped = dropPendingReplies(chatId);
  if (dropped)
    console.log(
      `[pending] 유저 추가 발화로 ${dropped}건 폐기 (chat=${chatId})`,
    );
  // 여기서 기다리는 건 유저 말이 다 도착할 때까지의 시간뿐이다(20~40초).
  // 각본상 자리를 비운 만큼의 텀은 답장을 만든 뒤 pending_replies가 맡는다.
  const waitMs = computeWait(chatId, character.id);
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
  for (const c of getActiveCharacters()) {
    const last = lastMessage(c.chat_id, c.id);
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
