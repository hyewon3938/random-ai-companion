import { currentBlock } from "./context.js";
import { blockCategory, type PlanBlock } from "./day-plan.js";
import { recordDayActual, getDayActuals } from "./db.js";
import { chat } from "./llm.js";
import { config } from "./config.js";
import {
  toResponsiveness,
  HOLD_OUTCOME,
  isHoldOutcome,
  type Responsiveness,
  type ActivityCategory,
} from "./labels.js";
import { getKstNow, kstClock, kstDateString } from "./kst.js";

// 답장 텀 — 유저 메시지가 다 도착한 뒤 답장이 나가기까지의 시간.
//
// 텀은 지금 하는 일의 두 태그(답장 여건 × 활동 성격)에서만 나온다. 일정 종류마다 예외를 두면
// 일정이 늘수록 분기가 늘어나므로, 표 한 장과 예외 둘로 끝낸다. 이 파일 밖에서는 텀 숫자를
// 갖지 않는다.
//
//   답장 여건 | 개인            | 사회               | 공적
//   즉답      | 0~2분, 짧은 쪽에 몰림                (셋 다 같음)
//   틈틈이    | 20초~2분 30초   | 30초~4분, 짧은 쪽  | 1~8분, 짧은 쪽
//   불가      | 일정이 끝날 때. 붙잡는 말이면 20초~2분 30초 | (개인과 같음) | 일정이 끝날 때
//
// 유저 말이 다 도착할 때까지 기다리는 20~40초는 답장 텀에 넣지 않는다(bot.ts의 도착 대기).

const INSTANT_MAX_MS = 120_000;
const NUDGE_MIN_MS = 20_000; // 틈틈이 개인, 그리고 붙잡힌 불가
const NUDGE_MAX_MS = 150_000;
const SOCIAL_MIN_MS = 30_000;
const SOCIAL_MAX_MS = 240_000;
const OFFICIAL_MIN_MS = 60_000;
const OFFICIAL_MAX_MS = 480_000;
// 일정이 끝날 때 답한다 — 끝나자마자 초 단위로 맞춰 답하면 기다린 티가 나므로 1분까지 흩뜨린다.
const END_JITTER_MS = 60_000;

const rand = (min: number, max: number): number =>
  min + Math.floor(Math.random() * (max - min + 1));

/** 짧은 쪽에 몰리게. 같은 구간이라도 대부분은 앞쪽에서 나온다. */
const skewLow = (min: number, max: number): number =>
  min + Math.floor(Math.random() ** 2 * (max - min));

const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

const stamp = (): string =>
  `${kstDateString()} ${getKstNow().toISOString().slice(11, 19)}`;

// '취침 준비'는 아직 깨어 있는 것. 실제로 깊이 자는 시간만 잠으로 본다.
export const isSleeping = (b: {
  activity: string;
  responsiveness: string;
}): boolean =>
  toResponsiveness(b.responsiveness) === "unavailable" &&
  /잠|수면|숙면/.test(b.activity) &&
  !/준비/.test(b.activity);

/**
 * 유저가 붙잡아서 지금 하던 일을 취소했거나 미룬 상태인가.
 * 그 일이 끝날 시각까지만 유효하다 — 오늘 실제 기록에 그 일의 시작 시각으로 남기므로,
 * 다음 일로 넘어가면 현재 일의 시작 시각이 달라져 저절로 풀린다.
 */
export const isHeldNow = (characterId: number): boolean => {
  const b = currentBlock(characterId);
  if (!b) return false;
  return getDayActuals(characterId, kstDateString()).some(
    (a) => a.block_start === b.start && isHoldOutcome(a.outcome),
  );
};

const untilBlockEndMs = (b: PlanBlock): number =>
  Math.max(0, toMin(b.end) - toMin(kstClock())) * 60_000 +
  rand(0, END_JITTER_MS);

const tableDelay = (resp: Responsiveness, cat: ActivityCategory): number => {
  if (resp === "instant") return skewLow(0, INSTANT_MAX_MS);
  if (cat === "personal") return rand(NUDGE_MIN_MS, NUDGE_MAX_MS);
  if (cat === "social") return skewLow(SOCIAL_MIN_MS, SOCIAL_MAX_MS);
  return skewLow(OFFICIAL_MIN_MS, OFFICIAL_MAX_MS);
};

// 붙잡는 말인지만 가른다. 지금 하는 일 한 줄과 유저의 마지막 말만 주고 한 낱말을 받는다 —
// 답장을 만들기 전에 먼저 도는 판정이라 짧아야 한다.
const HOLD_SYSTEM = `너는 메신저 대화를 읽고 한 가지만 판정한다.
상대가 지금 하던 일을 멈추고 대화에 붙어 있어 주길 바라는 말이면 "붙잡음",
답을 나중에 받아도 되는 평범한 말이면 "아님"이라고만 답한다. 다른 말은 하지 않는다.`;

const askHold = async (
  characterId: number,
  activity: string,
  userText: string,
): Promise<boolean> => {
  const prompt = `내가 지금 하는 일: ${activity}\n상대가 방금 보낸 말: ${userText}`;
  try {
    const out = await chat(
      HOLD_SYSTEM,
      [{ role: "user", content: prompt }],
      16,
      config.model,
      { purpose: "hold", characterId },
    );
    return out.includes("붙잡");
  } catch {
    // 판정이 실패하면 일정을 그대로 둔다 — 없던 취소를 만들지 않는 쪽이 안전하다.
    return false;
  }
};

/** 텀이 어떻게 나왔는지 — 답장 호출 기록에 함께 남겨 이상한 텀의 출처를 되짚는다. */
export interface TimingTrace {
  /** 표의 어느 길로 나온 값인가. recover는 표를 타지 않은 복구 발송이다. */
  path:
    | "no_plan"
    | "sleeping"
    | "already_held"
    | "table"
    | "until_end"
    | "held"
    | "recover";
  block: {
    start: string;
    end: string;
    activity: string;
    responsiveness: Responsiveness;
    category: ActivityCategory;
  } | null;
  /** 붙잡기 판정을 물었는가, 물었다면 붙잡혔는가. */
  asked: boolean;
  heldJudged?: boolean;
}

export interface TimingDecision {
  /** 답장이 나가기까지 기다릴 시간. */
  waitMs: number;
  /** 유저가 붙잡아 일정을 접었으면 무엇을 어떻게 했는지. 오늘 실제 기록에 이미 적혀 있다. */
  held: { outcome: string; activity: string } | null;
  /** 이 값이 나온 경위. */
  trace: TimingTrace;
}

/**
 * 이 답장이 언제쯤 나갈지 정한다.
 * 개인·사회의 답장 불가 시간에 온 메시지일 때만 판정 모델을 한 번 부른다. 공적은 못 미루므로
 * 부르지 않고, 붙잡을 수 있는 시간에 제한을 두지 않는다.
 */
export const decideReplyTiming = async (
  characterId: number,
  userText: string,
): Promise<TimingDecision> => {
  const b = currentBlock(characterId);
  if (!b)
    return {
      waitMs: skewLow(0, INSTANT_MAX_MS),
      held: null,
      trace: { path: "no_plan", block: null, asked: false },
    };

  const resp = toResponsiveness(b.responsiveness) ?? "instant";
  const cat = blockCategory(b);
  const seen = {
    start: b.start,
    end: b.end,
    activity: b.activity,
    responsiveness: resp,
    category: cat,
  };

  // 예외 둘 — 표를 따르지 않고 바로 답한다.
  if (isSleeping(b))
    return {
      waitMs: 0,
      held: null,
      trace: { path: "sleeping", block: seen, asked: false },
    };
  if (isHeldNow(characterId))
    return {
      waitMs: 0,
      held: null,
      trace: { path: "already_held", block: seen, asked: false },
    };

  if (resp !== "unavailable")
    return {
      waitMs: tableDelay(resp, cat),
      held: null,
      trace: { path: "table", block: seen, asked: false },
    };

  // 답장 불가.
  if (cat === "official")
    return {
      waitMs: untilBlockEndMs(b),
      held: null,
      trace: { path: "until_end", block: seen, asked: false },
    };
  if (!(await askHold(characterId, b.activity, userText)))
    return {
      waitMs: untilBlockEndMs(b),
      held: null,
      trace: { path: "until_end", block: seen, asked: true, heldJudged: false },
    };

  // 붙잡혔다 — 개인 일정은 취소하고, 사회 일정은 만나기로 한 상대에게 양해를 구해 미룬다.
  const outcome =
    cat === "personal" ? HOLD_OUTCOME.cancelled : HOLD_OUTCOME.deferred;
  recordDayActual(
    characterId,
    kstDateString(),
    b.start,
    b.activity,
    outcome,
    "유저가 붙잡아서",
    stamp(),
  );
  return {
    waitMs: rand(NUDGE_MIN_MS, NUDGE_MAX_MS),
    held: { outcome, activity: b.activity },
    trace: { path: "held", block: seen, asked: true, heldJudged: true },
  };
};

/**
 * 모델이 답장에 [남음] 표시를 붙였을 때 — 붙잡기 판정을 거치지 않고 스스로 일정을 접기로 한 경우다.
 * 판정이 이미 접어 둔 블록이면 그대로 두고, 공적 일정은 접지 못하므로 넘어간다.
 */
export const recordHold = (characterId: number): void => {
  const b = currentBlock(characterId);
  if (!b) return;
  const cat = blockCategory(b);
  if (cat === "official") return;
  if (isHeldNow(characterId)) return;
  const outcome =
    cat === "personal" ? HOLD_OUTCOME.cancelled : HOLD_OUTCOME.deferred;
  recordDayActual(
    characterId,
    kstDateString(),
    b.start,
    b.activity,
    outcome,
    "유저가 붙잡아서",
    stamp(),
  );
  console.log(`[hold] ${b.activity} → ${outcome} (답장 표시)`);
};
