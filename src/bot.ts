import { Bot } from "grammy";
import { inspect } from "node:util";
import { config } from "./config.js";
import { createDaepyoCharacter, type Bible } from "./character.js";
import { ensureTodayPlan, blockCategory } from "./day-plan.js";
import { buildSystemPrompt, currentBlock } from "./context.js";
import { maybeCaptureFacts } from "./capture.js";
import { chat, type ChatTurn } from "./llm.js";
import {
  db,
  getActiveCharacter,
  getAttentionUntil,
  getRecentMessages,
  getRecoveryMark,
  getRelationshipState,
  lastMessage,
  logMessage,
  recentUserGaps,
  setAttentionOverride,
  setRecoveryMark,
  type CharacterRow,
} from "./db.js";
import { getKstNow, kstClock, kstDateString } from "./kst.js";

// 캐릭터가 보내는 메시지의 종류 — 로그·플래그로 남겨 추적을 쉽게 한다
// reply=유저 메시지에 대한 답장, recover=배포로 놓친 답장 복구, morning=아침 안부(선톡), followup=침묵 팔로업(선톡)
export type SendKind =
  "reply" | "recover" | "morning" | "followup" | "presence";

export const bot = new Bot(config.telegramToken);

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

// 순간 네트워크 오류로 전송이 통째로 실패하지 않게 짧게 재시도한다(VM↔텔레그램 API 일시 단절 대비)
const sendWithRetry = async (
  chatId: string,
  text: string,
  tries = 3,
): Promise<void> => {
  for (let i = 0; i < tries; i++) {
    try {
      await bot.api.sendMessage(chatId, text);
      return;
    } catch (e) {
      // 최종 실패 시 원본 에러를 정리·마스킹해서 던진다 — 하류 로그가 깔끔하고 민감 값이 안 남게.
      if (i === tries - 1)
        throw new Error(
          `sendMessage 실패(${tries}회): ${redactToken(inspect(e, { depth: 4 }))}`,
        );
      await sleep(1500 * (i + 1));
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
const sendBubblesTo = async (chatId: string, text: string): Promise<void> => {
  for (const raw of splitBubbles(text)) {
    const bubble = fixQuestion(stripDquotes(raw));
    // 실제 치는 속도(≈5~6자/초)에 맞춘 타이핑 시간. 90ms/자는 복붙처럼 빨라서 180ms/자로 늦춤.
    const typeMs =
      clamp(bubble.length * 180, 1700, 9000) + Math.random() * 1000;
    await sleepWhileTyping(chatId, typeMs);
    await sendWithRetry(chatId, bubble);
  }
};

const rand = (min: number, max: number): number =>
  min + Math.random() * (max - min);
// 제곱 skew: 대부분 낮은 쪽에 몰리고 가끔 높은 쪽 — 사교 자리(회식·약속) 짬짬이용.
// 대개 몇 분 내에 답하되 간헐적으로 텀이 길어지는 결. 회식은 span을 더 크게 줘 평균을 늘린다.
const skewLow = (min: number, span: number): number =>
  min + Math.random() ** 2 * span;

// 물음표 보정: 질문인데 물음표가 빠진 말풍선을 고친다(LLM이 자꾸 흘려서 코드가 최종 방어선).
// 평서문 오탐이 나면 더 어색하므로 보수적으로 — 명백한 평서 종결은 건드리지 않고,
// 의문사나 확정 의문어미가 있을 때만 물음표를 붙인다.
const DECLARATIVE_END =
  /(습니다|거든요?|더라고요?|더라구요?|네요|군요|구나|ㄹ게요?|을게요?|잖아요?|라고요?|답니다|던데요?|는데요?|던걸요?|걸요?|겠어요|겠네요|겠다|더라|드라|을게|ㄹ게)$/;
const Q_ENDING =
  /(나요|인가요|은가요|까요|을까요|ㄹ까요|을래요|ㄹ래요|래요|니|냐|디)$/;
const Q_WORD =
  /(뭐|무슨|무엇|뭘|어디|언제|누구|누가|왜|어떻게|어떤|어느|얼마|몇|어때)/;
// 큰따옴표는 특유의 AI 느낌이라 발화에서 지운다(인용·강조 모두 따옴표 없이).
const stripDquotes = (s: string): string => s.replace(/[“”„‟"]/gu, "");

const fixQuestion = (bubble: string): string => {
  const t = bubble.replace(/\s+$/u, "");
  if (!t) return bubble;
  // 평서 종결 어미 뒤에 LLM이 잘못 붙인 물음표는 뗀다(자기 설명을 확인 구하듯 끝내는 패턴 방지).
  const q = t.match(/^(.*[^\s?？])[?？]+$/u);
  if (q && DECLARATIVE_END.test(q[1])) return q[1] + ".";
  if (/[?？!！~.…”"』」)\]]$/u.test(t)) return bubble; // 이미 종결부호
  if (/[ㅋㅎ]$/u.test(t)) return bubble; // 웃음으로 끝나면 그대로
  if (DECLARATIVE_END.test(t)) return bubble; // 명백한 평서
  if (Q_ENDING.test(t) || Q_WORD.test(t)) return t + "?";
  return bubble;
};

// 선제 발송(선톡): 유저 메시지 없이 캐릭터가 먼저 보낸다. 아침 안부(morning)·침묵 팔로업(followup)이 호출
export const sendProactive = async (
  chatId: string,
  characterId: number,
  text: string,
  kind: "morning" | "followup" | "presence" = "morning",
  extraMeta?: Record<string, unknown>,
): Promise<void> => {
  console.log(`[send] kind=${kind} chat=${chatId} len=${text.length}`);
  await sendBubblesTo(chatId, text);
  logMessage(chatId, characterId, "char", text, nowIso(), {
    proactive: true,
    kind,
    ...extraMeta,
  });
};

// LLM이 답장 맨 앞에 붙인 응답 속도 태그를 읽어 지연을 정하고, 태그는 떼어낸다.
// [한참후]=운동·운전 등 자리 비움, [잠시후]=근무 중 짬짬이, [즉시]=여유
const parsePresence = (reply: string): { delayMs: number; text: string } => {
  // 앞머리 대괄호는 어떤 형태든 태그로 보고 떼어낸다(유저에게 노출 방지)
  const m = reply.match(/^\s*\[([^\]\n]{1,8})\]\s*/);
  if (!m) return { delayMs: 0, text: reply.trim() };
  const tag = m[1];
  const delayMs = tag.includes("한참")
    ? rand(60000, 150000)
    : tag.includes("잠시")
      ? rand(15000, 45000)
      : 0;
  return { delayMs, text: reply.slice(m[0].length).trim() };
};

// 연속 동일 role 메시지 병합 (API는 user/assistant 교대를 기대)
const toTurns = (rows: { role: string; text: string }[]): ChatTurn[] => {
  const turns: ChatTurn[] = [];
  for (const row of rows) {
    const role = row.role === "user" ? "user" : "assistant";
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += `\n${row.text}`;
    else turns.push({ role, content: row.text });
  }
  if (turns[0]?.role === "assistant")
    turns.unshift({ role: "user", content: "(대화 시작)" });
  return turns;
};

bot.command("start", async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (getActiveCharacter(chatId)) {
    await ctx.reply("이미 연결된 상대가 있어. 그냥 말을 걸면 돼.");
    return;
  }
  await ctx.reply("누군가와 연결해줄게. 어떤 사람인지는 대화하면서 알아가.");
  await ctx.replyWithChatAction("typing");
  // PoC: 랜덤 생성 대신 고정 대표 캐릭터(정우진). 카드 온보딩·랜덤 매칭은 이후.
  const { id, bible } = createDaepyoCharacter(chatId);
  await sendBubblesTo(chatId, bible.first_greeting);
  logMessage(chatId, id, "char", bible.first_greeting, nowIso(), {
    first: true,
  });
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

// 지금 각본 블록 + 관계 나이 + 시간대로 답장 지연을 정한다.
// 핵심 원칙(서비스): '찾을 때 있어준다'가 사람다움보다 우선 — 특히 밤.
//   · 밤 대화(저녁~취침 전)는 즉답: 유저가 누워서 우진과만 대화하는 몰입 시간.
//   · 낮에도 찾으면 웬만하면 나와준다. 자리 비움은 짧게(운전·회의 등, 1시간 미만).
//   · 깊은 잠 중 연락도 무조건 즉답.
// (관계 진전도에 따른 텀 조정은 지금은 두지 않는다 — 단일 밀착 동작.)
const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
// 오늘의 특정 분(minute-of-day)을 KST 타임스탬프 문자열로 (override 만료 시각용)
const kstStampAt = (min: number): string => {
  const mm = Math.min(1439, Math.max(0, min));
  const hh = String(Math.floor(mm / 60)).padStart(2, "0");
  const m2 = String(mm % 60).padStart(2, "0");
  return `${kstDateString()} ${hh}:${m2}:00`;
};
// '취침 준비'는 아직 깨어 있는 것. 실제로 깊이 자는 블록만 잠으로 본다.
const isDeepSleep = (b: {
  activity: string;
  responsiveness: string;
}): boolean =>
  b.responsiveness === "불가" &&
  /잠|수면|숙면/.test(b.activity) &&
  !/준비/.test(b.activity);
const lastCharTs = (chatId: string): string | undefined =>
  (
    db
      .prepare(
        `SELECT ts FROM messages WHERE chat_id = ? AND role = 'char' ORDER BY id DESC LIMIT 1`,
      )
      .get(chatId) as { ts: string } | undefined
  )?.ts;
// 유저가 붙잡아 우진이 (개인·사회) 일정을 접거나 미루고 곁에 있기로 한 상태가 아직 유효한가.
const attentionActive = (chatId: string): boolean => {
  const until = getAttentionUntil(chatId);
  return (
    !!until &&
    Date.now() < new Date(until.replace(" ", "T") + "+09:00").getTime()
  );
};

const blockDelayMs = (characterId: number, chatId: string): number => {
  const b = currentBlock(characterId);
  if (!b) return 0;
  // 유저가 붙잡아 접은 상태면 각본상 불가여도 곁에 있는다(즉답).
  if (attentionActive(chatId)) return rand(0, 40_000);
  const deepSleep = isDeepSleep(b);
  const hour = Number(kstClock().slice(0, 2));
  const night = hour >= 20 || hour < 2; // 저녁~새벽 2시: 밤 대화 창
  // 밤에 대화가 이어지는 중이면(최근 캐릭터 응답이 45분 내) 아직 깨어 있는 것 — 자는 각본이어도 즉답
  const lc = lastCharTs(chatId);
  const activeChat =
    !!lc &&
    Date.now() - new Date(lc.replace(" ", "T") + "+09:00").getTime() <
      45 * 60_000;

  // 밤 대화는 가장 빠르게(몰입 대화) — 대화가 이어지는 중이거나 자는 시간이 아니면. 관계 나이 무관.
  // 그래도 로봇처럼 0초는 아니게 살짝(디바운스 위에 0~40초). 모든 게 즉답이면 리얼리티가 떨어진다.
  if (night && (activeChat || !deepSleep)) return rand(0, 40_000);
  // 낮의 여유(즉답) 블록: 곧 답하되 가끔 1~2분 텀(사람은 늘 폰만 보지 않는다)
  if (b.responsiveness === "즉답") return rand(0, 120_000);

  // 깊은 잠 중 연락 = 무조건 (거의) 즉답. 자다 깨는 척·실제로 자는 척을 안 한다 —
  // 밤에 찾을 때 늘 곁에 있는 게 더 낫다는 판단(굳이 사람처럼 잠들어 있지 않는다).
  if (deepSleep) return rand(0, 40_000);

  // 낮 시간 자리 비움
  const untilEnd = Math.max(0, toMin(b.end) - toMin(kstClock())) * 60_000;
  const category = blockCategory(b); // 개인 / 사회 / 공적
  const cancelable = category !== "공적"; // 개인·사회는 붙잡으면 조정 가능
  const sinceStart = (toMin(kstClock()) - toMin(b.start)) * 60_000;
  // 조정 가능한 불가(개인·사회)로 막 들어간 참(~12분)이면 아직 닿는다 — 유저가 붙잡으면
  // 접거나 미룰 수 있게 곧 확인한다. (회의·시험 같은 공적 불가는 여기 안 걸리고 아래로.)
  if (b.responsiveness === "불가" && cancelable && sinceStart <= 12 * 60_000) {
    return rand(20_000, 150_000);
  }
  // 짬짬이: 개인(집안일·집 여가)=곧 답(20초~2.5분) / 사회(친구·가족·병원·학원)=틈틈이(약간 뜸) /
  // 공적(업무·공적 회식)=틈틈이지만 더 뜸(대개 몇 분, 가끔 더 길게 — skew).
  if (b.responsiveness === "짬짬이") {
    if (category === "개인") return rand(20_000, 150_000);
    if (category === "사회") return skewLow(30_000, 240_000);
    return skewLow(60_000, 480_000); // 공적
  }
  // 불가(운동·운전·회의 등 손이 묶임): 그 일 끝날 때쯤, 최대 ~35분.
  return clamp(
    Math.min(untilEnd, 30 * 60_000) + rand(0, 60_000),
    120_000,
    35 * 60_000,
  );
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

const respond = async (
  chatId: string,
  kind: "reply" | "recover" = "reply",
): Promise<void> => {
  responding.add(chatId);
  try {
    const character = getActiveCharacter(chatId);
    if (!character) return;
    const bible = JSON.parse(character.bible_json) as Bible;
    // 오늘의 하루 각본이 없으면 생성(그날 첫 대화 때 한 번). 실패해도 대화는 계속
    await ensureTodayPlan(character.id, bible).catch((e) =>
      logErr("[bot] day plan error:", e),
    );
    const state = getRelationshipState(character.id);
    const system = buildSystemPrompt(character.id, bible, state, chatId);
    const turns = toTurns(getRecentMessages(chatId, 40));
    const reply = await chat(system, turns);
    // 조정 가능한(개인·사회) 자기 일정을 접거나 미루고 남기로 한 신호([남음])면 주의집중을 켠다 — 그 블록 끝까지(최소 30분) 곁에.
    if (/^\s*\[\s*남음\s*\]/.test(reply)) {
      const cur = currentBlock(character.id);
      const nowMin = toMin(kstClock());
      const endMin = cur ? toMin(cur.end) : nowMin + 45;
      setAttentionOverride(chatId, kstStampAt(Math.max(endMin, nowMin + 30)));
      console.log(
        `[attention] ${chatId} 유저 요청으로 일정 접음 (until ${cur?.end ?? "+30m"})`,
      );
    }
    // 태그는 떼어낸다(유저 비노출). 자리 비움 지연은 이제 각본 블록 기반으로 arm에서 미리 적용된다.
    let { text } = parsePresence(reply);
    // 빈 답장 방어: LLM이 태그만 뱉거나 빈 문자열을 주는 경우가 있다 → 한 번 재생성, 그래도 비면 스킵.
    // (빈 텍스트를 그대로 보내면 텔레그램이 400으로 거부해 대화가 막혔었다.)
    if (!text) text = parsePresence(await chat(system, turns)).text;
    if (!text) {
      console.warn(`[bot] empty reply — skip (chat=${chatId})`);
      return;
    }
    console.log(`[send] kind=${kind} chat=${chatId} len=${text.length}`);
    await sendBubblesTo(chatId, text); // 실패하면 여기서 throw → 아래 기록 생략 → 복구가 재시도
    // 전송에 성공한 뒤에야 '답장 책임 완료'를 기록한다(보내기 전 기록하면, 전송 실패 시 복구가
    // 이미 처리됐다고 보고 영영 재시도하지 않아 답장이 유실된다). 성공 후이므로 중복도 방지된다.
    const lu = lastMessage(chatId);
    if (lu?.role === "user") setRecoveryMark(chatId, lu.ts);
    logMessage(chatId, character.id, "char", text, nowIso(), { kind });
    // 세션 중 가벼운 사실 포착(비동기 — 답장 지연 없음). 유저 메시지가 쌓이면 밤 정리 전에 저장.
    void maybeCaptureFacts(character.id, chatId).catch((e) =>
      logErr("[capture] error:", e),
    );
  } finally {
    responding.delete(chatId);
  }
};

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
    await ctx.reply("아직 연결된 상대가 없어. /start 로 시작해줘.");
    return;
  }
  logMessage(chatId, character.id, "user", ctx.message.text, nowIso());
  // 대기 = 유저 리듬(디바운스) + 캐릭터 각본 자리비움(짬짬이 1~5분·불가 일정 끝날 때쯤).
  // 자리 비운 동안 유저가 더 보내도 재무장돼 합쳐지고, 돌아올 때쯤 한 번에 답한다.
  arm(chatId, computeWait(chatId) + blockDelayMs(character.id, chatId));
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
      (Date.now() - new Date(last.ts.replace(" ", "T") + "+09:00").getTime()) /
      60000;
    if (ageMin > 180) continue;
    if (pending.has(c.chat_id) || responding.has(c.chat_id)) continue; // 이미 처리 중
    if (getRecoveryMark(c.chat_id) === last.ts) {
      console.log(
        `[recover] 이미 답장한 메시지 — 건너뜀: ${c.chat_id} (${last.ts})`,
      );
      continue;
    }
    const prev = getRecoveryMark(c.chat_id);
    setRecoveryMark(c.chat_id, last.ts); // 보내기 전에 책임 표시(재부팅 중복 방지)
    console.log(`[recover] 놓친 답장 복구: ${c.chat_id} (마지막 ${last.ts})`);
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
