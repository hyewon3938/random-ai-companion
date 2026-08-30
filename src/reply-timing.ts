import { currentBlock } from "./context.js";
import { blockCategory, type PlanBlock } from "./day-plan.js";
import {
  recordDayActual,
  getDayActuals,
  setCallContext,
  getScheduleById,
} from "./db.js";
import { chat, type CallMeta } from "./llm.js";
import { config } from "./config.js";
import {
  toResponsiveness,
  HOLD_OUTCOME,
  isHoldOutcome,
  WOKE_OUTCOME,
  type Responsiveness,
  type ActivityCategory,
  type BlockSource,
} from "./labels.js";
import {
  INSTANT_MIN_MS,
  INSTANT_MAX_MS,
  INTERMITTENT_PERSONAL_MIN_MS,
  INTERMITTENT_PERSONAL_MAX_MS,
  INTERMITTENT_SOCIAL_MIN_MS,
  INTERMITTENT_SOCIAL_MAX_MS,
  INTERMITTENT_OFFICIAL_MIN_MS,
  INTERMITTENT_OFFICIAL_MAX_MS,
  BLOCK_END_JITTER_MS,
  SLEEP_WAKE_MIN_MS,
  SLEEP_WAKE_MAX_MS,
} from "./thresholds.js";
import {
  getKstNow,
  kstDateString,
  kstLogicalDate,
  kstLogicalClock,
} from "./kst.js";

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
// 표를 타지 않는 예외가 둘이다. 자는 시간에 온 연락은 진동에 깨서 폰을 볼 때까지 3~25분이
// 걸리고, 한 번 깬 뒤로는 즉답 값을 쓴다. 이미 붙잡혀 일정을 접어 둔 상태에서도 즉답이다.
//
// 숫자는 thresholds.ts가 갖는다. 유저 말이 다 도착할 때까지 기다리는 20~40초는 답장 텀에
// 넣지 않는다(bot.ts의 도착 대기).

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
 * 이 잠 블록에서 이미 깨서 답한 적이 있는가.
 * 자는 시간에 온 첫 연락에만 오늘 실제 기록을 남기므로, 그 기록이 곧 깨어 있다는 표시가 된다.
 */
const wokeInBlock = (characterId: number, blockStart: string): boolean =>
  getDayActuals(characterId, kstLogicalDate()).some(
    (a) => a.block_start === blockStart && a.outcome === WOKE_OUTCOME,
  );

/**
 * 유저가 붙잡아서 지금 하던 일을 취소했거나 미룬 상태인가.
 * 그 일이 끝날 시각까지만 유효하다 — 오늘 실제 기록에 그 일의 시작 시각으로 남기므로,
 * 다음 일로 넘어가면 현재 일의 시작 시각이 달라져 저절로 풀린다.
 */
export const isHeldNow = (characterId: number): boolean => {
  const b = currentBlock(characterId);
  if (!b) return false;
  // 각본과 실제 기록은 새벽 5시로 갈린 하루 단위다 — 자정을 넘겨도 같은 날로 읽는다.
  return getDayActuals(characterId, kstLogicalDate()).some(
    (a) => a.block_start === b.start && isHoldOutcome(a.outcome),
  );
};

const untilBlockEndMs = (b: PlanBlock): number =>
  Math.max(0, toMin(b.end) - toMin(kstLogicalClock())) * 60_000 +
  rand(0, BLOCK_END_JITTER_MS);

const tableDelay = (resp: Responsiveness, cat: ActivityCategory): number => {
  if (resp === "instant") return skewLow(INSTANT_MIN_MS, INSTANT_MAX_MS);
  if (cat === "personal")
    return rand(INTERMITTENT_PERSONAL_MIN_MS, INTERMITTENT_PERSONAL_MAX_MS);
  if (cat === "social")
    return skewLow(INTERMITTENT_SOCIAL_MIN_MS, INTERMITTENT_SOCIAL_MAX_MS);
  return skewLow(INTERMITTENT_OFFICIAL_MIN_MS, INTERMITTENT_OFFICIAL_MAX_MS);
};

// 붙잡는 말인지만 가른다. 지금 하는 일 한 줄과 유저의 마지막 말만 주고 한 낱말을 받는다 —
// 답장을 만들기 전에 먼저 도는 판정이라 짧아야 한다.
const HOLD_SYSTEM = `너는 메신저 대화를 읽고 한 가지만 판정한다.
상대가 지금 하던 일을 멈추고 대화에 붙어 있어 주길 바라는 말이면 "붙잡음",
답을 나중에 받아도 되는 평범한 말이면 "아님"이라고만 답한다. 다른 말은 하지 않는다.`;

// 판정에 얹을 한 줄 — 상대가 이 일정을 아는가. 알고 보낸 말과 모르고 보낸 말은 무게가 다르다.
// 각본에는 이 값이 없으므로 블록의 출처를 따라 원본 일정을 읽는다. 출처가 없는 블록(잠·식사·
// 그날 갑자기 생긴 일)이나 필드가 없는 옛 각본, 원본이 지워진 경우에는 줄 없이 판정한다.
const knowsLine = (
  characterId: number,
  block: TimingTrace["block"],
): string | null => {
  if (block?.source !== "schedule" || typeof block.source_id !== "number")
    return null;
  try {
    const row = getScheduleById(characterId, block.source_id);
    if (!row) return null;
    // waiting은 아직 말하지 않고 꺼낼 자리를 기다리는 것 — 상대는 모르는 쪽이다.
    return row.user_knows === "known"
      ? "상대는 내게 이 일정이 있다는 걸 안다."
      : "상대는 내게 이 일정이 있다는 걸 모른다.";
  } catch {
    // 원본을 못 읽으면 줄만 빼고 판정한다 — 판정 자체를 막지 않는다.
    return null;
  }
};

const askHold = async (
  characterId: number,
  block: TimingTrace["block"],
  userText: string,
): Promise<{ held: boolean; failed: boolean; callId: number | null }> => {
  const activity = block?.activity ?? "하던 일";
  const prompt = [
    `내가 지금 하는 일: ${activity}`,
    knowsLine(characterId, block),
    `상대가 방금 보낸 말: ${userText}`,
  ]
    .filter(Boolean)
    .join("\n");
  const meta: CallMeta = { purpose: "hold", characterId };
  try {
    const out = await chat(
      HOLD_SYSTEM,
      [{ role: "user", content: prompt }],
      16,
      config.model,
      meta,
      // 생각 과정을 켜면 상한 16토큰을 거기서 다 쓰고 답이 비어 돌아온다.
      { think: false },
    );
    // 빈 답은 "안 붙잡음"이 아니라 판정을 못 받은 것이다. 일정을 그대로 두는 결과는 같아도
    // 갈라 적어야 판정이 조용히 한쪽으로 기우는 것을 트레이스에서 볼 수 있다.
    const failed = !out.trim();
    if (failed) console.warn("[timing] 붙잡기 판정 빈 답 — 일정을 그대로 둔다");
    const held = out.includes("붙잡");
    // 이 판정이 어떤 일정을 두고 나온 것인지 판정 호출 기록에도 남긴다 — 트레이스가
    // 판정만 따로 올릴 때 무엇을 보고 판정했는지 알 수 있게. 기록 실패는 판정을 막지 않는다.
    if (meta.callId)
      try {
        setCallContext(meta.callId, { hold: { block, held, failed } });
      } catch {
        /* 판정은 그대로 쓴다 */
      }
    return { held, failed, callId: meta.callId ?? null };
  } catch (e) {
    // 판정이 실패하면 일정을 그대로 둔다 — 없던 취소를 만들지 않는 쪽이 안전하다.
    console.warn("[timing] 붙잡기 판정 호출 실패 — 일정을 그대로 둔다:", e);
    return { held: false, failed: true, callId: meta.callId ?? null };
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
    /** 이 블록을 펼친 원본 — 붙잡기 판정이 여기를 따라 원본 일정을 읽는다. */
    source?: BlockSource;
    source_id?: number;
    /** 각본에 이 시각 블록이 없어 코드가 잠으로 메운 자리인가. */
    fallback?: boolean;
  } | null;
  /** 자는 시간이면 이번 연락에 깬 것인가, 아까 깨서 이미 폰을 보고 있었는가. */
  justWoke?: boolean;
  /** 붙잡기 판정을 물었는가, 물었다면 붙잡혔는가. */
  asked: boolean;
  heldJudged?: boolean;
  /** 물었는데 답을 못 받았는가 — 빈 답이거나 호출이 실패한 경우다. 일정은 그대로 둔다. */
  holdFailed?: boolean;
  /** 판정을 물었으면 그 모델 호출 번호 — 답장 기록에서 판정 호출로 건너갈 수 있게. */
  holdCallId?: number | null;
}

export interface TimingDecision {
  /** 답장이 나가기까지 기다릴 시간. */
  waitMs: number;
  /** 유저가 붙잡아 일정을 접었으면 무엇을 어떻게 했는지. 오늘 실제 기록에 이미 적혀 있다. */
  held: { outcome: string; activity: string } | null;
  /**
   * 답장 불가 구간이라 지금 만들지 않고 구간 끝에 몰아 답해야 하면 그 구간 정보.
   * 이 값이 있으면 waitMs는 구간이 끝나는 시각까지의 시간이다 — 답장을 만드는 대신
   * 깨우기 표시(pending의 wake 행)를 걸고, 구간 끝에 쌓인 메시지를 읽어 한 번에 답한다.
   */
  gather: { activity: string; blockStart: string; blockEnd: string } | null;
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
      gather: null,
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
    source: b.source,
    source_id: b.source_id,
    fallback: b.fallback,
  };

  // 예외 둘 — 표를 따르지 않는다.
  if (isSleeping(b)) {
    // 자는 시간에 온 연락. 각본에는 자는 것으로 되어 있던 시간이라 오늘 실제 기록에 남겨,
    // 그날 새벽 정리가 일기와 다음 날 각본에 함께 놓고 본다. 같은 잠 블록에서는 한 번만
    // 남기고, 그 기록이 곧 깨어 있다는 표시가 되어 다음 연락부터는 즉답 값으로 답한다.
    const awake = wokeInBlock(characterId, b.start);
    if (!awake)
      recordDayActual(
        characterId,
        kstLogicalDate(),
        b.start,
        b.activity,
        WOKE_OUTCOME,
        "자는데 연락이 와서",
        stamp(),
      );
    return {
      waitMs: awake
        ? skewLow(INSTANT_MIN_MS, INSTANT_MAX_MS)
        : rand(SLEEP_WAKE_MIN_MS, SLEEP_WAKE_MAX_MS),
      held: null,
      gather: null,
      trace: {
        path: "sleeping",
        block: seen,
        asked: false,
        justWoke: !awake,
      },
    };
  }
  if (isHeldNow(characterId))
    return {
      waitMs: 0,
      held: null,
      gather: null,
      trace: { path: "already_held", block: seen, asked: false },
    };

  if (resp !== "unavailable")
    return {
      waitMs: tableDelay(resp, cat),
      held: null,
      gather: null,
      trace: { path: "table", block: seen, asked: false },
    };

  // 답장 불가 — 지금 답장을 만들지 않는다. 구간이 끝날 때 깨어 몰아 답한다.
  const gather = {
    activity: b.activity,
    blockStart: b.start,
    blockEnd: b.end,
  };
  if (cat === "official")
    return {
      waitMs: untilBlockEndMs(b),
      held: null,
      gather,
      trace: { path: "until_end", block: seen, asked: false },
    };
  const judged = await askHold(characterId, seen, userText);
  if (!judged.held)
    return {
      waitMs: untilBlockEndMs(b),
      held: null,
      gather,
      trace: {
        path: "until_end",
        block: seen,
        asked: true,
        heldJudged: false,
        holdFailed: judged.failed,
        holdCallId: judged.callId,
      },
    };

  // 붙잡혔다 — 개인 일정은 취소하고, 사회 일정은 만나기로 한 상대에게 양해를 구해 미룬다.
  const outcome =
    cat === "personal" ? HOLD_OUTCOME.cancelled : HOLD_OUTCOME.deferred;
  recordDayActual(
    characterId,
    kstLogicalDate(),
    b.start,
    b.activity,
    outcome,
    "유저가 붙잡아서",
    stamp(),
  );
  return {
    waitMs: rand(INTERMITTENT_PERSONAL_MIN_MS, INTERMITTENT_PERSONAL_MAX_MS),
    held: { outcome, activity: b.activity },
    gather: null,
    trace: {
      path: "held",
      block: seen,
      asked: true,
      heldJudged: true,
      holdCallId: judged.callId,
    },
  };
};

/**
 * 모델이 답장에 stay 신호를 실었을 때 — 붙잡기 판정을 거치지 않고 스스로 일정을 접기로 한 경우다.
 * 판정이 이미 접어 둔 블록이면 그대로 두고, 공적 일정은 접지 못하므로 넘어간다.
 */
export const recordHold = (
  characterId: number,
): { blockStart: string; activity: string; outcome: string } | null => {
  const b = currentBlock(characterId);
  if (!b) return null;
  const cat = blockCategory(b);
  if (cat === "official") return null;
  if (isHeldNow(characterId)) return null;
  const outcome =
    cat === "personal" ? HOLD_OUTCOME.cancelled : HOLD_OUTCOME.deferred;
  recordDayActual(
    characterId,
    kstLogicalDate(),
    b.start,
    b.activity,
    outcome,
    "유저가 붙잡아서",
    stamp(),
  );
  console.log(`[hold] ${b.activity} → ${outcome} (답장 표시)`);
  return { blockStart: b.start, activity: b.activity, outcome };
};
