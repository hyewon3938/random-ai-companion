// 아침 각본 게시 — 새벽 정리가 만든 오늘 각본을 아침에 슬랙 스레드로 올린다.
//
// 1분 틱이 부른다. 오늘 각본이 있으면 각본 한 장과 생성 프롬프트를 스레드로 쌓고, 없으면
// 무응답 관계인지 새벽 정리가 안 돈 것인지 가려 한 줄만 남긴다. 게시함 키로 하루에 한 번만
// 쌓이고, 슬랙으로 내보내는 일은 trace.ts의 틱이 맡는다.

import {
  db,
  getActiveCharacters,
  getDayPlan,
  getDayPlanMadeBy,
  getDaySeed,
  hasTraceEvent,
  type CharacterRow,
  type DaySeed,
} from "../db.js";
import {
  blockCategory,
  buildPlanPrompt,
  isSleeping,
  PLAN_SYSTEM,
  type DayPlan,
  type PlanBlock,
} from "../day-plan.js";
import {
  ACTIVITY_CATEGORY_NAME,
  RESPONSIVENESS_NAME,
  toResponsiveness,
} from "../labels.js";
import { getKstNow, kstLogicalDate, clockLabel } from "../kst.js";
import { silenceState } from "../proactive-policy.js";
import { recordTraceChunks, recordTraceEvent, traceEnabled } from "../trace.js";
import { dateLabel, esc } from "./format.js";

// 새벽 정리(05:40)가 끝난 뒤인 이 시각(KST)부터, 오늘 각본이 보이면 게시한다.
const PLAN_POST_HOUR = 7;
// 평상 관계인데 이 시각까지 각본이 없으면 경고 한 줄을 올린다.
const PLAN_WARN_HOUR = 12;

// 답장 텀 표(reply-timing.ts)를 사람이 읽는 범위로 옮긴 것. 표의 값이 바뀌면 여기도 맞춘다.
const timingRange = (b: PlanBlock): string => {
  if (isSleeping(b)) return "자다 깨면 바로";
  const resp = toResponsiveness(b.responsiveness) ?? "instant";
  if (resp === "instant") return "0초~2분";
  if (resp === "unavailable") return `${b.end} 끝난 뒤 1분 안`;
  const cat = blockCategory(b);
  return cat === "personal"
    ? "20초~2분 30초"
    : cat === "social"
      ? "30초~4분"
      : "1~8분";
};

// 각본은 코드 블록 안에 올려 읽는다. 활동 문장 길이가 제각각이라 열을 맞추지 않고,
// 태그를 활동 앞뒤로 나눠 붙여 시각 다음에 성격이 먼저 보이게 한다.
// 각본 한 줄: 시각 (활동 성격) 활동 [답장 여건] 답장 텀
export const blockLine = (b: PlanBlock): string => {
  const resp = toResponsiveness(b.responsiveness) ?? "instant";
  const category = ACTIVITY_CATEGORY_NAME[blockCategory(b)];
  // 당일에 닥치는 일은 활동 앞에 별표 두 개로 표시하고 각본 아래에 뜻을 한 줄 붙인다.
  const activity = `${b.advance_known ? "" : "**"}${b.activity}`;
  return `${clockLabel(b.start)}~${clockLabel(b.end)} (${category}) ${esc(activity)} [${RESPONSIVENESS_NAME[resp]}] ${timingRange(b)}`;
};

const seedText = (seed: DaySeed | undefined): string =>
  seed
    ? `기력 ${seed.energy} · 기상 ${seed.wake_hint} · 기분 ${seed.mood}${seed.reason ? ` (${seed.reason})` : ""}`
    : "없음";

// 각본 생성 프롬프트는 고정 지시문 사이에 DB 값이 들어가는 한 장짜리 틀이라, 규칙이 시작하는
// 자리에서 잘라 그날 데이터와 매일 같은 규칙을 따로 올린다(day-plan.ts planPrompt와 짝).
const RULE_MARK = "[컨디션→기상→활동을 하나로 잇기]";

export const promptSections = (prompt: string): { label: string; body: string }[] => {
  const at = prompt.indexOf(RULE_MARK);
  if (at < 0) return [{ label: "각본 생성 프롬프트", body: prompt }];
  return [
    {
      label:
        "각본 생성 프롬프트 1 — 시스템 문장과 오늘 데이터 (게시 시점에 같은 DB 데이터로 다시 조립한 것)",
      body: prompt.slice(0, at).trimEnd(),
    },
    {
      label: "각본 생성 프롬프트 2 — 고정 규칙 (매일 같음)",
      body: prompt.slice(at),
    },
  ];
};


const enqueuePlanPost = (c: CharacterRow, date: string, raw: string): void => {
  const madeBy = getDayPlanMadeBy(c.id, date) ?? "nightly";
  const dedupeKey = `day_plan:${c.id}:${date}:${madeBy}`;
  if (hasTraceEvent(dedupeKey)) return;

  let plan: DayPlan;
  try {
    plan = JSON.parse(raw) as DayPlan;
  } catch {
    return;
  }

  // 임시 각본을 이미 올린 날 nightly가 다시 보이면 = 새벽 정리가 정식 각본으로 교체한 것
  const replaced =
    madeBy === "nightly" && hasTraceEvent(`day_plan:${c.id}:${date}:ondemand`);
  const madeByLabel =
    madeBy === "ondemand"
      ? "대화 중 임시 생성"
      : replaced
        ? "새벽 정리 생성 (임시 각본 교체)"
        : "새벽 정리 생성";

  const seed = getDaySeed(c.id, date);
  const surprise = plan.blocks.some((b) => !b.advance_known);
  const head = [
    `:spiral_calendar_pad: *${dateLabel(date)} 하루 각본* — ${madeByLabel}`,
    `컨디션 시드: ${esc(seedText(seed))}`,
    "```",
    ...plan.blocks.map(blockLine),
    "```",
    ...(surprise ? ["`**` 당일에 닥치는 일"] : []),
  ].join("\n");

  // 생성 프롬프트는 지금 같은 DB 데이터로 다시 조립한다. 각본을 만든 뒤 게시할 때까지
  // 그 데이터(일기·아크·일정·시드)를 고치는 곳이 새벽 정리뿐이라 조립 결과가 같다.
  let prompt: string;
  try {
    prompt = `${PLAN_SYSTEM}\n\n${buildPlanPrompt(c.id, date)}`;
  } catch (err) {
    prompt = `(프롬프트 조립 실패: ${String(err)})`;
  }
  const sections = promptSections(prompt);

  db.transaction(() => {
    recordTraceEvent({
      characterId: c.id,
      kind: "day_plan",
      text: head,
      dedupeKey,
      threadKey: dedupeKey,
    });
    for (const s of sections)
      recordTraceChunks(c.id, dedupeKey, "day_plan_prompt", s.label, esc(s.body), true);
  })();
};

const enqueueNoPlanNote = (
  c: CharacterRow,
  date: string,
  hour: number,
): void => {
  const silence = silenceState(c.chat_id, c.id);
  if (silence.tier !== "normal") {
    const dedupeKey = `day_plan:${c.id}:${date}:quiet`;
    if (hasTraceEvent(dedupeKey)) return;
    recordTraceEvent({
      characterId: c.id,
      kind: "day_plan_quiet",
      dedupeKey,
      text: `:zzz: ${dateLabel(date)} 오늘 각본 없음 — 무응답 ${silence.days}일째라 새벽 정리가 일기·시드만 만들었다. 유저가 말을 걸면 임시 각본을 만든다.`,
    });
  } else if (hour >= PLAN_WARN_HOUR) {
    const dedupeKey = `day_plan:${c.id}:${date}:missing`;
    if (hasTraceEvent(dedupeKey)) return;
    recordTraceEvent({
      characterId: c.id,
      kind: "day_plan_missing",
      dedupeKey,
      text: `:warning: ${dateLabel(date)} 정오까지 오늘 각본이 없다 — 새벽 정리가 실행되지 않았을 수 있다. 유저가 말을 걸면 임시 각본으로 시작한다.`,
    });
  }
};


export const enqueueMorningPlans = (): void => {
  if (!traceEnabled()) return;
  const hour = getKstNow().getUTCHours();
  if (hour < PLAN_POST_HOUR) return;
  const date = kstLogicalDate();
  for (const c of getActiveCharacters()) {
    const raw = getDayPlan(c.id, date);
    if (raw) enqueuePlanPost(c, date, raw);
    else enqueueNoPlanNote(c, date, hour);
  }
};
