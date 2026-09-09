// 답장 텀을 정하는 자리 — 두 태그 표 한 장.
//
// 하루 각본의 블록마다 붙은 두 태그(답장 여건 × 활동 성격)만 보고 텀을 정한다. 일정 종류마다
// 예외를 두면 종류가 늘수록 분기가 늘어서, 표 한 장으로만 정한다.
//   즉답     — 0~2분, 짧은 쪽으로 몰린다
//   틈틈이   — 개인 20초~2.5분 / 사회 30초~4분 / 공적 1~8분
//   불가     — 그 일정이 끝날 때 + 0~1분 지터
// 예외 둘 — 자는 중이면 첫 연락은 틈틈이·개인 칸이고 깬 뒤로는 즉답, 이미 붙잡혀 접힌 일정이면 즉답.
//
// 불가면 지금 답장을 만들지 않고 TimingDecision.gather로 넘겨 구간 끝 몰아 답장에 맡긴다.
// 개인·사회 불가에 온 메시지는 붙잡기 판정 한 콜(16토큰)로 갈라, 붙잡혔으면 개인은 취소·
// 사회는 미룸을 day_actuals에 적는다. 공적은 못 접는다. 상한은 없다. 판정에는 지금 하는 일,
// 상대가 그 일정을 아는지, 내 답이 없는 채로 이어 보낸 말과 그 수·기다린 시간을 넣는다.
//
// 텀이 나온 경위는 TimingTrace로 남겨 판단 근거에 적는다.

import { currentBlock } from "./context.js";
import { blockCategory, isSleeping, type PlanBlock } from "./day-plan.js";
import {
  recordDayActual,
  getDayActuals,
  setCallContext,
  getScheduleById,
  recentMessageTimes,
} from "./db.js";
import { chat, type CallMeta, type ChatTurn } from "./llm.js";
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
} from "./thresholds.js";
import {
  kstStamp,
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
// 블록의 두 태그를 그대로 읽지 않는 예외가 둘이고, 둘 다 표의 다른 칸을 빌려 쓴다. 자는 시간에
// 처음 온 연락은 폰을 집어 드는 만큼만 두고 틈틈이·개인 칸으로 답하며, 한 번 깬 뒤로는 즉답 칸을
// 쓴다. 이미 붙잡혀 일정을 접어 둔 상태에서도 즉답이다.
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

// 상대가 지금 대화를 요청하는 말인지만 가른다. 지금 하는 일 한 줄, 상대가 그 일정을 아는지, 내 답이
// 없는 채로 이어 보낸 말과 그 수·기다린 시간을 주고 한 낱말을 받는다 — 답장을 만들기 전에 먼저
// 도는 판정이라 답은 짧아야 한다. 물음표가 있다고 다 요청은 아니다. 가지 말라는 말, 곁에 있어
// 달라는 뜻이 담긴 말, 재촉, 답 없이 몇 분에 걸쳐 이어 보낸 짧은 말이 요청이고, 가벼운 질문과
// 한 번 물은 안부는 아님이다. 답장 규칙층(prompts/reply.ts의 CATEGORY_RULE)이 붙잡는 말을
// 정의한 것과 같은 결이다(#336).
const HOLD_SYSTEM = `너는 메신저 대화를 읽고 한 가지만 판정한다.
상대가 지금 나에게 대화를 요청하는 말이면 "요청", 아니면 "아님"이라고만 답한다. 다른 말은 하지 않는다.

이 판정으로 내가 하던 일을 그만두고 대화에 올지 정한다. 물음표가 있다고 요청이 되지는 않는다. 상대가 지금 나와 이야기하고 싶어 하는지를 앞뒤 맥락으로 본다.

요청으로 보는 말
- 가지 말라거나 남아 달라는 말, 계속 연락해 달라는 말
- 심심하다, 힘들다, 우울하다처럼 곁에 있어 달라는 뜻이 담긴 말
- 지금 빨리 답해 달라고 재촉하는 말
- 있는지, 자는지, 뭐 하는지 물은 뒤 내 답이 없는 채로 몇 분에 걸쳐 짧은 말을 이어 보내는 것

아님으로 보는 말
- 읽기만 하면 되는 전달, 알려 두는 말, 반응 한 마디
- 내 답이 늦어도 곤란하지 않은 물음. 무엇을 살지 고르는 것 같은 가벼운 질문은 나중에 답해도 된다
- 있는지, 뭐 하는지 한 번 물은 말. 내 일정을 아는 상대가 건넨 안부도 같다
- 한 번에 몰아 보낸 여러 통. 내용으로만 본다

예시. 이어 보낸 말은 /로 나눠 적었고 실제로는 줄마다 온다.
안 가면 안 돼? → 요청
나 너무 심심해.. → 요청
이거 지금 말해줘 빨리 → 요청
오늘 진짜 힘들었어.. → 요청
3분 동안 이어 보낸 말 3통: 자? / 뭐해 / 자나 보네 → 요청
지금 뭐해? → 아님
나 이거 살까 저거 살까? → 아님
나 이제 집 가는 중, 도착하면 연락할게 → 아님
오늘 발표 잘 끝났어 → 아님
1분 안에 이어 보낸 말 3통: 오늘 회식 있었어 / 늦게 들어감 / 먼저 자 → 아님
ㅋㅋㅋ 그렇구나 → 아님`;

/** 판정에 넘기는 이어 보내기 — 내 답이 없는 채로 상대가 보낸 메시지 수와 그 첫 통의 시각. */
export interface HoldBurst {
  n: number;
  firstAt: string;
}

/** 판정 모델을 부르는 자리. 검사에서 정해 둔 답을 돌려주는 함수로 바꿔 끼운다. */
export type HoldJudge = (
  system: string,
  turns: ChatTurn[],
  meta: CallMeta,
) => Promise<string>;

const judgeWithModel: HoldJudge = (system, turns, meta) =>
  chat(
    system,
    turns,
    16,
    config.model,
    meta,
    // 생각 과정을 켜면 상한 16토큰을 거기서 다 쓰고 답이 비어 돌아온다.
    { think: false },
  );

const parseKst = (s: string): number =>
  new Date(s.replace(" ", "T") + "+09:00").getTime();

// 첫 통부터 지금까지 — 상대가 답 없이 기다린 시간을 말로 적는다. 1분이 안 되면 한 번에 보낸 것이다.
const waitedText = (ms: number): string => {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return "1분 안에";
  if (min < 60) return `${min}분 동안`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}시간 ${m}분 동안` : `${h}시간 동안`;
};

/**
 * 판정에 주는 글. 지금 하는 일, 상대가 그 일정을 아는지, 상대가 보낸 말 순서다. 내 답이 없는 채로
 * 여러 통을 이어 보냈으면 통 수와 첫 통부터 지금까지의 시간을 앞에 적는다 — 몇 분에 걸쳐 온 짧은
 * 말은 답을 기다린다는 뜻이고, 한 번에 몰아 보낸 여러 통은 내용으로만 볼 수 있게.
 */
export const buildHoldPrompt = (input: {
  activity: string;
  knows: string | null;
  userText: string;
  burst?: HoldBurst;
  now?: number;
}): string => {
  const { burst } = input;
  const waited = burst
    ? (input.now ?? Date.now()) - parseKst(burst.firstAt)
    : NaN;
  // 첫 통 시각을 못 읽으면 한 통일 때와 같은 글로 간다 — 잘못 센 시간을 적는 것보다 낫다.
  const said =
    burst && burst.n >= 2 && Number.isFinite(waited)
      ? `상대가 내 답을 못 받은 채로 ${waitedText(waited)} 이어 보낸 말 ${burst.n}통:\n${input.userText}`
      : `상대가 방금 보낸 말: ${input.userText}`;
  return [`내가 지금 하는 일: ${input.activity}`, input.knows, said]
    .filter(Boolean)
    .join("\n");
};

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
  burst: HoldBurst | undefined,
  judge: HoldJudge,
): Promise<{ held: boolean; failed: boolean; callId: number | null }> => {
  const prompt = buildHoldPrompt({
    activity: block?.activity ?? "하던 일",
    knows: knowsLine(characterId, block),
    userText,
    burst,
  });
  const meta: CallMeta = { purpose: "hold", characterId };
  try {
    const out = await judge(
      HOLD_SYSTEM,
      [{ role: "user", content: prompt }],
      meta,
    );
    // 빈 답은 "아님"이 아니라 판정을 못 받은 것이다. 일정을 그대로 두는 결과는 같아도
    // 갈라 적어야 판정이 조용히 한쪽으로 기우는 것을 트레이스에서 볼 수 있다.
    const failed = !out.trim();
    if (failed) console.warn("[timing] 붙잡기 판정 빈 답 — 일정을 그대로 둔다");
    // 따옴표를 붙여 답해도 읽고, "요청 아님"처럼 두 낱말이 같이 오면 요청으로 세지 않는다.
    const held = /요청/.test(out) && !/아님/.test(out);
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

export interface HoldOptions {
  /** 내 답이 없는 채로 상대가 이어 보낸 메시지 수와 첫 통의 시각. 한 통이면 없어도 된다. */
  burst?: HoldBurst;
  /** 판정 모델을 부르는 함수. 검사에서 정해 둔 답을 돌려주는 함수로 바꿔 끼운다. */
  judge?: HoldJudge;
}

/**
 * 이 답장이 언제쯤 나갈지 정한다.
 * 개인·사회의 답장 불가 시간에 온 메시지일 때만 판정 모델을 한 번 부른다. 공적은 못 미루므로
 * 부르지 않고, 붙잡을 수 있는 시간에 제한을 두지 않는다.
 */
export const decideReplyTiming = async (
  characterId: number,
  userText: string,
  opts: HoldOptions = {},
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
    // 남기고, 그 기록이 곧 깨어 있다는 표시가 되어 다음 연락부터는 즉답 칸으로 답한다. 깨어나는
    // 첫 한 통도 폰을 집어 드는 만큼만 두고 틈틈이·개인 칸으로 답한다 — 밤에 찾아온 상대를
    // 몇십 분씩 기다리게 하지 않는다.
    const awake = wokeInBlock(characterId, b.start);
    if (!awake)
      recordDayActual(
        characterId,
        kstLogicalDate(),
        b.start,
        b.activity,
        WOKE_OUTCOME,
        "자는데 연락이 와서",
        kstStamp(),
      );
    return {
      waitMs: awake
        ? tableDelay("instant", "personal")
        : tableDelay("intermittent", "personal"),
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
  const judged = await askHold(
    characterId,
    seen,
    userText,
    opts.burst,
    opts.judge ?? judgeWithModel,
  );
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
    kstStamp(),
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
    kstStamp(),
  );
  console.log(`[hold] ${b.activity} → ${outcome} (답장 표시)`);
  return { blockStart: b.start, activity: b.activity, outcome };
};

// ── 유저가 이어 보내는 텀 ──────────────────────────────────────────────

// 유저가 연속으로 이어 보낸 메시지 사이의 텀(ms). 봇 응답이 끼지 않은 '이어 보내기'만 센다
// (봇 답장을 사이에 둔 건 새 턴이라 제외, 2분 넘는 텀도 새 턴으로 보고 제외).
// 텀이 길수록 = 한 번에 길게 치는 사람 = 응답 대기를 더 길게 잡아 중간에 끊지 않게 한다.
const BURST_GAP_MAX_MS = 120000;

export const userBurstGaps = (
  rows: readonly { role: string; sent_at: string }[],
): number[] => {
  const t = (s: string): number =>
    new Date(s.replace(" ", "T") + "+09:00").getTime();
  const gaps: number[] = [];
  for (let i = 1; i < rows.length; i++)
    if (rows[i].role === "user" && rows[i - 1].role === "user") {
      const g = t(rows[i].sent_at) - t(rows[i - 1].sent_at);
      if (g > 0 && g < BURST_GAP_MAX_MS) gaps.push(g);
    }
  return gaps;
};

export const recentUserGaps = (
  chatId: string,
  characterId: number,
  limit = 80,
): number[] => userBurstGaps(recentMessageTimes(chatId, characterId, limit));
