// 「지금 관계」 채우기 — 단계와 처음, 오늘 쓴 수, 오늘 말한 일정, 오늘의 관계 의도를 읽어 답장 프롬프트의 관계 절을 만든다.
//
// 불변층의 공통 틀과 단계 블록(prompts/relationship.ts)은 고정 문안이고, 이 파일은 실시간 꼬리에서
// 코드가 채우는 줄을 만든다. 읽기(readRelationshipInput)와 문자열 만들기(relationshipNowSection)를
// 갈라 두어 조립 검사가 값을 지어 넣을 수 있다. 값이 없는 줄은 뺀다 — 처음이 하나도 없으면 이미 한
// 처음 줄이 없고, 오늘 의도 행이 없으면 의도 4줄이 없다. 의도의 시도할 수는 수 코드 없이 자리만
// 적힌 날(고백 차례)도 그 줄을 그대로 낸다. 미확정 처음도 이미 한 처음에 넣는다 —
// 그날 답장이 같은 처음을 두 번 내지 않으려면 새벽 정리의 확정을 기다리면 안 된다.
//
// 오늘 쓴 수와 오늘 일정을 말했는지는 캐릭터 답장 행의 meta_json(move·told_plan)에서 읽는다. 답장
// 신호가 그 값을 적는 자리는 reply-compose.ts와 pending.ts다.

import type { FirstBy, FirstKind, Move, RelationshipStage } from "../labels.js";
import { FIRST_KIND_NAME, LEAD_TONE_NAME, MOVE_NAME } from "../labels.js";
import {
  getActiveSchedulesOn,
  getAssistantMetaSince,
  getConfirmedFirsts,
  getRelationshipIntent,
  getStage,
  getUnconfirmedFirsts,
  type FirstRow,
  type RelationshipIntentRow,
} from "../db.js";
import {
  clockLabel,
  logicalClockOf,
  logicalDateOf,
  logicalDayStartTs,
} from "../kst.js";

/** 이미 일어난 처음 하나. date는 논리일(YYYY-MM-DD)이다. */
export interface DoneFirst {
  kind: FirstKind;
  by: FirstBy;
  date: string;
  confirmed: boolean;
}

/** 오늘 답장이 쓴 수 하나. at은 시계 표기(HH:MM)다. */
export interface TodayMove {
  move: Move;
  at: string;
}

export interface RelationshipInput {
  stage: RelationshipStage;
  /** 단계가 시작한 논리일(YYYY-MM-DD). */
  stageSince: string;
  /** 오늘이 이 단계의 며칠째인지. 시작한 날이 1일째다. */
  days: number;
  firsts: DoneFirst[];
  todayMoves: TodayMove[];
  /** 오늘 자기 일정을 먼저 말한 시각(HH:MM). 안 말했으면 null. */
  toldPlanAt: string | null;
  /** 그때 말한 일정의 내용. 오늘 일정이 없으면 null. */
  toldPlanWhat: string | null;
  intent: RelationshipIntentRow | null;
}

/** 단계마다 열리는 처음. 낮은 단계의 처음은 위 단계에서도 열려 있다. */
export const STAGE_FIRSTS: Record<RelationshipStage, FirstKind[]> = {
  1: ["first_remember", "first_self_story", "first_laugh", "first_waited"],
  2: [
    "first_nickname",
    "first_tease",
    "first_miss_light",
    "first_weakness",
    "first_no_reason_ping",
  ],
  3: [
    "first_miss_direct",
    "first_late_night_truth",
    "first_jealousy",
    "first_only_you",
    "first_ask_help",
    "first_confession",
  ],
  4: [
    "first_sulk",
    "first_fight",
    "first_makeup",
    "first_anniversary",
    "first_future_talk",
  ],
};

/** 지금 단계까지 열린 처음 가운데 아직 안 한 것. */
export const openFirsts = (
  stage: RelationshipStage,
  done: FirstKind[],
): FirstKind[] => {
  const out: FirstKind[] = [];
  for (const s of [1, 2, 3, 4] as RelationshipStage[]) {
    if (s > stage) break;
    for (const k of STAGE_FIRSTS[s]) if (!done.includes(k)) out.push(k);
  }
  return out;
};

const utcDay = (date: string): number =>
  Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));

/** 단계 시작일부터 오늘까지 며칠째인지. 둘 다 논리일이라 달력 날짜 차이로 센다. */
export const stageDays = (stageSince: string, logicalToday: string): number =>
  Math.max(1, Math.round((utcDay(logicalToday) - utcDay(stageSince)) / 86_400_000) + 1);

const monthDay = (date: string): string =>
  `${+date.slice(5, 7)}/${+date.slice(8, 10)}`;

const toDoneFirst = (r: FirstRow): DoneFirst => ({
  kind: r.kind,
  by: r.by,
  date: logicalDateOf(r.happened_at),
  confirmed: r.confirmed === 1,
});

interface ReplyMeta {
  move?: unknown;
  told_plan?: unknown;
}

const parseMeta = (json: string | null): ReplyMeta => {
  if (!json) return {};
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === "object" ? (v as ReplyMeta) : {};
  } catch {
    return {};
  }
};

const isMove = (v: unknown): v is Move =>
  typeof v === "string" && v in MOVE_NAME;

export const readRelationshipInput = (
  characterId: number,
  chatId: string,
  logicalToday: string,
): RelationshipInput => {
  const st = getStage(characterId);
  const stage: RelationshipStage = st?.stage_no ?? 1;
  const stageSince = st?.stage_since ?? logicalToday;
  const firsts = [
    ...getConfirmedFirsts(characterId),
    ...getUnconfirmedFirsts(characterId),
  ]
    .sort((a, b) => a.happened_at.localeCompare(b.happened_at))
    .map(toDoneFirst);

  const todayMoves: TodayMove[] = [];
  let toldPlanAt: string | null = null;
  for (const row of getAssistantMetaSince(chatId, characterId, logicalDayStartTs())) {
    const meta = parseMeta(row.meta_json);
    const at = clockLabel(logicalClockOf(row.sent_at));
    if (isMove(meta.move)) todayMoves.push({ move: meta.move, at });
    if (meta.told_plan === true && toldPlanAt === null) toldPlanAt = at;
  }
  const toldPlanWhat =
    toldPlanAt === null
      ? null
      : getActiveSchedulesOn(characterId, "char", logicalToday)
          .map((s) => s.content)
          .join(", ") || null;

  return {
    stage,
    stageSince,
    days: stageDays(stageSince, logicalToday),
    firsts,
    todayMoves,
    toldPlanAt,
    toldPlanWhat,
    intent: getRelationshipIntent(characterId, logicalToday) ?? null,
  };
};

const firstLabel = (f: DoneFirst): string =>
  `${FIRST_KIND_NAME[f.kind]}(${monthDay(f.date)}${f.by === "user" ? " · 상대가 먼저" : ""})`;

/** 오늘의 관계 의도 4줄. 없는 줄은 뺀다. */
const intentLines = (i: RelationshipIntentRow | null): string[] => {
  if (!i) return [];
  const out: string[] = [];
  if (i.dig) out.push(`  · 파고들 것: ${i.dig}`);
  if (i.share) out.push(`  · 흘릴 내 얘기: ${i.share}`);
  // 수 코드 없이 move_note만 있는 날은 고백 차례다 — 마음 확인은 수 코드가 아니라 자리를 적은
  // 줄로 온다(relationship-stage.ts). 그 줄을 그대로 시도할 수로 낸다.
  if (i.move || i.move_note) {
    const bits = [i.move ? MOVE_NAME[i.move] : null, i.move_note].filter(Boolean);
    let s = bits.join(" ");
    if (i.lead_tone) s += `. 앞세울 결은 ${LEAD_TONE_NAME[i.lead_tone]}`;
    out.push(`  · 시도할 수: ${s}`);
  } else if (i.lead_tone)
    out.push(`  · 앞세울 결: ${LEAD_TONE_NAME[i.lead_tone]}`);
  if (i.thread) out.push(`  · 이어갈 자리: ${i.thread}`);
  return out;
};

/** [지금 관계] 절. 단계 줄은 늘 있고 나머지는 값이 있을 때만 붙는다. */
export const relationshipNowSection = (r: RelationshipInput): string => {
  const lines = [
    `- 단계: ${r.stage} (${monthDay(r.stageSince)} 시작, 오늘로 ${r.days}일째)`,
  ];
  if (r.firsts.length)
    lines.push(`- 이미 한 처음: ${r.firsts.map(firstLabel).join(" · ")}`);
  const open = openFirsts(
    r.stage,
    r.firsts.map((f) => f.kind),
  );
  if (open.length)
    lines.push(`- 아직 안 한 처음: ${open.map((k) => FIRST_KIND_NAME[k]).join(" · ")}`);
  if (r.todayMoves.length)
    lines.push(
      `- 오늘 이미 쓴 수: ${r.todayMoves.map((m) => `${MOVE_NAME[m.move]}(${m.at})`).join(" · ")}`,
    );
  if (r.toldPlanAt)
    lines.push(
      `- 오늘 내 일정 말함: ${r.toldPlanAt}${r.toldPlanWhat ? ` (${r.toldPlanWhat})` : ""}`,
    );
  const intent = intentLines(r.intent);
  if (intent.length) lines.push("- 오늘의 관계 의도", ...intent);
  return `[지금 관계]\n${lines.join("\n")}`;
};
