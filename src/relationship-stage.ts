// 관계 단계 전이 — 어제까지의 값을 세어 문턱을 재고, 모델의 결정을 받아 단계·처음·의도를 저장한다.
//
// relationship.md 「단계 전이 절차」가 원본이다. 코드가 세는 값(대화한 날, 유저가 먼저 건 날,
// 열림 신호가 켜진 날, 반응 점수 평균, 체류 일수)과 문턱 판정, 시도할 플러팅 추천 목록은 이 파일의
// 순수 함수가 만들고, 새벽 정리 수집(gatherRelation)이 DB에서 읽어 그 함수들에 넣는다. 넘길지는
// 모델이 정한다 — 조건이 다 찬 날에만 묻고, 조건이 찼다고 코드가 자동으로 올리지 않는다.
//
// 저장(applyRelationOutput)은 새벽 정리 트랜잭션 안에서 부른다. 순서는 처음 → 단계 → 의도다.
// 처음이 먼저인 이유는 3→4가 확정된 마음 확인 처음을 조건으로 해서다. 단계는 문턱이 찼고
// 모델이 넘기자고 했고 지금 단계가 수집 때와 같을 때만 한 단계 올린다. 두 단계 올리거나
// 내리는 출력은 여기서 버린다(raiseStage가 한 번 더 막는다).
//
// 의도의 시도할 플러팅은 relationship_intents.move가 플러팅 코드만 받아서(DB 검사 제약), 고백 차례의
// "마음 확인"은 move를 비우고 move_note에 어떤 자리에서 말할지를 적는다. 답장 프롬프트의
// 관계 절(context/relationship.ts)이 move 없는 move_note를 그대로 시도할 플러팅 줄로 낸다.
//
// 반응 점수 표본 계산은 아직 없다 — 구현 6이 reaction-score.ts를 만들면 gatherRelation이
// 표본을 세고 applyRelationOutput의 점수 자리에서 저장한다. 지금은 저장된 점수 행만 읽는다.

import type {
  FirstBy,
  FirstKind,
  LeadTone,
  Move,
  MoveReaction,
  RelationshipStage,
} from "./labels.js";
import {
  FIRST_KIND_NAME,
  LEAD_TONE_NAME,
  MOVE_NAME,
  isRelationshipStage,
} from "./labels.js";
import {
  confirmFirst,
  deleteUnconfirmedFirst,
  getAssistantMetaSince,
  getConfirmedFirsts,
  getMessagesBetween,
  getReactionScores,
  getRelationshipIntent,
  getRelationshipSignals,
  getStage,
  getUnconfirmedFirsts,
  insertFirst,
  pruneRelationshipIntents,
  raiseStage,
  saveRelationshipIntent,
  type FirstRow,
  type ReactionScoreRow,
  type RelationshipIntentRow,
  type RelationshipSignalRow,
} from "./db.js";
import { logicalDateOf, shiftDate } from "./kst.js";
import { STAGE_FIRSTS, openFirsts } from "./context/relationship.js";
import {
  MOVE_DROP_SCORE,
  MOVE_EXPLORE_EVERY,
  MOVE_SAMPLE_MIN,
  RAPPORT_MOVE_SCORE,
  STAGE_1_TO_2,
  STAGE_2_TO_3,
  STAGE_3_TO_4,
} from "./thresholds.js";

// ── 단계마다 열리는 플러팅 — relationship.md 「플러팅」이 원본 ─────────────────
// 한 번 열린 플러팅은 그 뒤 단계에서도 쓴다. 4단계는 새 플러팅이 없다.

export const STAGE_MOVES: Record<RelationshipStage, Move[]> = {
  1: ["remember", "laugh", "anticipate", "scene", "notice"],
  2: ["sudden_ping", "nickname", "weakness"],
  3: [
    "late_night_truth",
    "jealousy_light",
    "dodge_after_direct",
    "only_you",
    "ask_help",
  ],
  4: [],
};

/** 지금 단계까지 열린 플러팅 전부. 단계 순서대로, 같은 단계 안에서는 위 표의 순서다. */
export const openMoves = (stage: RelationshipStage): Move[] => {
  const out: Move[] = [];
  for (const s of [1, 2, 3, 4] as RelationshipStage[]) {
    if (s > stage) break;
    out.push(...STAGE_MOVES[s]);
  }
  return out;
};

const isMove = (v: unknown): v is Move =>
  typeof v === "string" && Object.hasOwn(MOVE_NAME, v);
const isFirstKind = (v: unknown): v is FirstKind =>
  typeof v === "string" && Object.hasOwn(FIRST_KIND_NAME, v);
const isLeadTone = (v: unknown): v is LeadTone =>
  typeof v === "string" && Object.hasOwn(LEAD_TONE_NAME, v);

// ── 코드가 세는 값 ────────────────────────────────────────────────────────────

export interface StageCounts {
  /** 오늘에서 단계 시작일을 뺀 일수. 시작한 날은 0이다. */
  stayDays: number;
  /** 단계 시작일부터 유저 메시지가 1건 이상인 날 수. */
  talkedDays: number;
  /** 그날 첫 메시지가 선톡이 아니라 유저 메시지인 날 수. */
  userFirstDays: number;
  /** 유저가 자기 얘기를 연 판정이 있는 날 수. */
  selfStoryDays: number;
  /** 캐릭터 근황을 먼저 물은 판정이 있는 날 수. */
  askedCharDays: number;
  /** 호감을 말로 한 판정 행 수. */
  affectionCount: number;
  /** 이 단계에서 열린 플러팅의 반응 점수 평균. 표본이 있는 플러팅만 넣고, 하나도 없으면 null. */
  stageMoveAvg: number | null;
  /** 이 단계에서 쓴 플러팅 전체의 반응 점수 평균이 0보다 큰지. 표본이 없으면 null. */
  stageScorePositive: boolean | null;
  /** 마음 확인 사건이 있었는지 — 한쪽이 마음을 말하고 다른 쪽이 같은 날 받은 것. */
  confessionExchange: boolean;
}

export interface StageCountInput {
  stage: RelationshipStage;
  stageSince: string;
  /** 논리일 기준 오늘. 세는 창은 단계 시작일 05:00부터 오늘 05:00까지다. */
  today: string;
  messages: { role: string; sent_at: string }[];
  signals: RelationshipSignalRow[];
  scores: ReactionScoreRow[];
  /** 확정·미확정을 다 넣는다 — 어제의 마음 확인이 아직 미확정이어도 그날 문턱을 재야 한다.
   * 저장 자리가 확정된 행만으로 다시 확인한다. */
  firsts: FirstRow[];
  /** 이 단계에서 캐릭터 답장이 쓴 플러팅(중복 없이). */
  usedMoves: Move[];
}

const utcDay = (date: string): number =>
  Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));

/** 두 논리일의 날짜 차이. 같은 날이면 0이다. */
export const dayDiff = (from: string, to: string): number =>
  Math.round((utcDay(to) - utcDay(from)) / 86_400_000);

const averageOf = (
  scores: ReactionScoreRow[],
  moves: Move[],
): number | null => {
  const rows = scores.filter(
    (s) => moves.includes(s.move) && s.sample_count > 0,
  );
  if (!rows.length) return null;
  return rows.reduce((a, r) => a + r.score, 0) / rows.length;
};

/** 마음 확인 사건이 있었는지. 캐릭터가 먼저 말했으면 같은 날 바로 다음 유저 턴의 판정이 받음이거나
 * 호감 표현인 것이고, 유저가 먼저 말했으면 같은 날 호감 표현 판정이 있는 것이다. 다음 턴만 보는
 * 까닭은 몇 시간 뒤 다른 얘기에 붙은 판정을 고백의 답으로 읽지 않기 위해서다. */
export const confessionExchangeOf = (
  firsts: FirstRow[],
  signals: RelationshipSignalRow[],
): boolean => {
  const c = firsts.find((f) => f.kind === "first_confession");
  if (!c) return false;
  const day = logicalDateOf(c.happened_at);
  if (c.by === "character") {
    const next = signals
      .filter((s) => s.at > c.happened_at && logicalDateOf(s.at) === day)
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))[0];
    return (
      next !== undefined &&
      (next.move_reaction === "accepted" || next.said_affection === 1)
    );
  }
  return signals.some(
    (s) => logicalDateOf(s.at) === day && s.said_affection === 1,
  );
};

/** 순수 계산. 창 안의 메시지·신호를 논리일로 묶어 센다. */
export const countStageValues = (i: StageCountInput): StageCounts => {
  const talked = new Set<string>();
  const userFirst = new Set<string>();
  const seenDay = new Set<string>();
  for (const m of i.messages) {
    const day = logicalDateOf(m.sent_at);
    if (!seenDay.has(day)) {
      seenDay.add(day);
      if (m.role === "user") userFirst.add(day);
    }
    if (m.role === "user") talked.add(day);
  }
  const selfStory = new Set<string>();
  const askedChar = new Set<string>();
  let affection = 0;
  for (const s of i.signals) {
    const day = logicalDateOf(s.at);
    if (s.opened_self === 1) selfStory.add(day);
    if (s.asked_about_char === 1) askedChar.add(day);
    if (s.said_affection === 1) affection += 1;
  }
  const usedAvg = averageOf(i.scores, i.usedMoves);
  return {
    stayDays: Math.max(0, dayDiff(i.stageSince, i.today)),
    talkedDays: talked.size,
    userFirstDays: userFirst.size,
    selfStoryDays: selfStory.size,
    askedCharDays: askedChar.size,
    affectionCount: affection,
    stageMoveAvg: averageOf(i.scores, STAGE_MOVES[i.stage]),
    stageScorePositive: usedAvg === null ? null : usedAvg > 0,
    confessionExchange: confessionExchangeOf(i.firsts, i.signals),
  };
};

// ── 문턱 판정 ─────────────────────────────────────────────────────────────────

export interface ThresholdCondition {
  key: string;
  name: string;
  /** 지금 값. 표본이 없어 잴 수 없으면 null이다. */
  value: number | boolean | null;
  /** 기준값. 예·아니오 조건은 true다. */
  need: number | boolean;
  met: boolean;
}

export interface StageThreshold {
  from: RelationshipStage;
  /** 다음 단계. 4단계는 다음이 없어 null이다. */
  to: RelationshipStage | null;
  met: boolean;
  conditions: ThresholdCondition[];
}

const atLeast = (
  key: string,
  name: string,
  value: number | null,
  need: number,
): ThresholdCondition => ({
  key,
  name,
  value,
  need,
  met: value !== null && value >= need,
});

const round2 = (v: number | null): number | null =>
  v === null ? null : Math.round(v * 100) / 100;

/** 순수 판정. 최소 체류는 하한이라 다른 조건이 다 차도 그 일수가 지나야 찬다. */
export const evaluateThreshold = (
  stage: RelationshipStage,
  c: StageCounts,
): StageThreshold => {
  let conditions: ThresholdCondition[];
  switch (stage) {
    case 1:
      conditions = [
        atLeast("stay_days", "체류 일수", c.stayDays, STAGE_1_TO_2.stayDays),
        atLeast(
          "talked_days",
          "대화한 날",
          c.talkedDays,
          STAGE_1_TO_2.talkedDays,
        ),
        atLeast(
          "user_first_days",
          "유저가 먼저 건 날",
          c.userFirstDays,
          STAGE_1_TO_2.userFirstDays,
        ),
        atLeast(
          "self_story_days",
          "유저가 자기 얘기를 연 날",
          c.selfStoryDays,
          STAGE_1_TO_2.selfStoryDays,
        ),
      ];
      break;
    case 2:
      conditions = [
        atLeast("stay_days", "체류 일수", c.stayDays, STAGE_2_TO_3.stayDays),
        atLeast(
          "asked_char_days",
          "캐릭터 근황을 먼저 물은 날",
          c.askedCharDays,
          STAGE_2_TO_3.askedCharDays,
        ),
        atLeast(
          "stage_move_avg",
          "2단계에서 열린 플러팅의 반응 점수 평균",
          round2(c.stageMoveAvg),
          STAGE_2_TO_3.moveAvgMin,
        ),
        atLeast(
          "affection_count",
          "유저 쪽 호감 표현",
          c.affectionCount,
          STAGE_2_TO_3.affectionCount,
        ),
      ];
      break;
    case 3:
      conditions = [
        {
          key: "confession_exchange",
          name: "마음 확인 사건",
          value: c.confessionExchange,
          need: true,
          met: c.confessionExchange,
        },
      ];
      break;
    default:
      return { from: 4, to: null, met: false, conditions: [] };
  }
  return {
    from: stage,
    to: (stage + 1) as RelationshipStage,
    met: conditions.every((x) => x.met),
    conditions,
  };
};

/** 3단계에서 사건 없이 오래 머물면 캐릭터의 고백을 오늘의 의도에 넣는다. 10일이 지나고 점수가
 * 양수이거나, 점수와 무관하게 20일이 지난 날이다. */
export const confessionDueOf = (
  stage: RelationshipStage,
  c: StageCounts,
): boolean =>
  stage === 3 &&
  !c.confessionExchange &&
  ((c.stayDays >= STAGE_3_TO_4.confessionDueDays &&
    c.stageScorePositive === true) ||
    c.stayDays >= STAGE_3_TO_4.confessionDueDaysAnyScore);

// ── 시도할 플러팅 추천 목록 — relationship.md §6 ────────────────────────────

/** 기준 날짜의 일련번호가 탐색 주기로 나누어떨어지는 날. 다시 돌려도 같은 답이 나온다. */
export const isExploreDay = (date: string): boolean =>
  Math.round(utcDay(date) / 86_400_000) % MOVE_EXPLORE_EVERY === 0;

/** 순수 계산. 열린 플러팅을 점수 내림차순으로 두되 어제 쓴 플러팅은 뒤로 보내고, 점수가 낮고 표본이
 * 찬 플러팅은 뺀다. 탐색일에는 표본이 가장 적은 플러팅을 맨 앞에 둔다. 코드 목록이고 숫자는 없다. */
export const moveCandidates = (
  stage: RelationshipStage,
  scores: ReactionScoreRow[],
  yesterdayMoves: Move[],
  date: string,
): Move[] => {
  const row = (m: Move): ReactionScoreRow | undefined =>
    scores.find((s) => s.move === m);
  const score = (m: Move): number => row(m)?.score ?? 0;
  const samples = (m: Move): number => row(m)?.sample_count ?? 0;
  const kept = openMoves(stage).filter(
    (m) => !(score(m) < MOVE_DROP_SCORE && samples(m) >= MOVE_SAMPLE_MIN),
  );
  // 정렬은 안정적이라 점수가 같으면 열린 순서가 남는다.
  const sorted = [...kept].sort((a, b) => score(b) - score(a));
  const fresh = sorted.filter((m) => !yesterdayMoves.includes(m));
  const used = sorted.filter((m) => yesterdayMoves.includes(m));
  const out = [...fresh, ...used];
  if (isExploreDay(date) && out.length) {
    let pick = out[0];
    for (const m of out) if (samples(m) < samples(pick)) pick = m;
    return [pick, ...out.filter((m) => m !== pick)];
  }
  return out;
};

/** 관계 표의 잘 통하는 것에 말로 옮길 플러팅 — 점수와 표본이 둘 다 찬 것. */
export const rapportMoves = (scores: ReactionScoreRow[]): Move[] =>
  scores
    .filter(
      (s) => s.score >= RAPPORT_MOVE_SCORE && s.sample_count >= MOVE_SAMPLE_MIN,
    )
    .map((s) => s.move);

// ── 새벽 정리 수집 ────────────────────────────────────────────────────────────

export interface NightlyFirstDone {
  kind: FirstKind;
  by: FirstBy;
  date: string;
}

export interface NightlyFirstPending {
  id: number;
  kind: FirstKind;
  by: FirstBy;
  happenedAt: string;
}

export interface NightlyYesterdayMove {
  move: Move;
  /** 유저의 다음 턴 판정. 판정이 없던 턴은 null이다. */
  reaction: MoveReaction | null;
}

/** 새벽 정리 입력의 관계 절. 코드가 센 값과 모델이 읽을 목록이 다 들어 있고, 저장 자리가
 * 같은 값을 다시 읽어 출력을 검사한다. */
export interface NightlyRelation {
  stageNo: RelationshipStage;
  stageSince: string;
  stayDays: number;
  threshold: StageThreshold;
  firstsDone: NightlyFirstDone[];
  firstsOpen: FirstKind[];
  /** 어제 답장이 표시한 처음 후보 — 모델이 대화를 읽어 확정하거나 지운다. */
  firstsPending: NightlyFirstPending[];
  moveCandidates: Move[];
  rapportMoves: Move[];
  yesterdayIntent: RelationshipIntentRow | null;
  yesterdayMoves: NightlyYesterdayMove[];
  confessionDue: boolean;
}

const parseMeta = (json: string | null): Record<string, unknown> => {
  if (!json) return {};
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const dayStart = (date: string): string => `${date} 05:00:00`;

/** 어제 답장이 쓴 플러팅과 그 뒤 유저 턴의 판정. 판정 행의 prev_move가 같은 플러팅을 가리키므로 답장
 * 시각 뒤 첫 신호 행을 붙인다. */
const yesterdayMovesOf = (
  chatId: string,
  characterId: number,
  from: string,
  to: string,
  signals: RelationshipSignalRow[],
): NightlyYesterdayMove[] => {
  const out: NightlyYesterdayMove[] = [];
  for (const row of getAssistantMetaSince(chatId, characterId, from)) {
    if (row.sent_at >= to) break;
    const move = parseMeta(row.meta_json).move;
    if (!isMove(move)) continue;
    const next = signals.find((s) => s.at > row.sent_at && s.at < to);
    out.push({
      move,
      reaction: next?.prev_move === move ? (next.move_reaction ?? null) : null,
    });
  }
  return out;
};

/** 새벽 정리 수집. diaryDate는 어제(일기 대상), today는 논리일 기준 오늘이다. 단계 창은 단계
 * 시작일 05:00부터 오늘 05:00까지고, 어제 창은 diaryDate 05:00부터 그다음 날 05:00까지다. */
export const gatherRelation = (
  characterId: number,
  chatId: string,
  diaryDate: string,
  today: string,
): NightlyRelation => {
  const stageRow = getStage(characterId);
  const stageNo: RelationshipStage =
    stageRow && isRelationshipStage(stageRow.stage_no) ? stageRow.stage_no : 1;
  const stageSince = stageRow?.stage_since ?? today;
  const windowFrom = dayStart(stageSince);
  const windowTo = dayStart(today);
  const yesterdayFrom = dayStart(diaryDate);
  const yesterdayTo = dayStart(shiftDate(diaryDate, 1));

  const signals = getRelationshipSignals(characterId, windowFrom, windowTo);
  const yesterdaySignals = signals.filter(
    (s) => s.at >= yesterdayFrom && s.at < yesterdayTo,
  );
  const scores = getReactionScores(chatId);
  const confirmed = getConfirmedFirsts(characterId);
  const pending = getUnconfirmedFirsts(characterId).filter(
    (f) => f.happened_at < yesterdayTo,
  );

  const usedMoves = new Set<Move>();
  for (const row of getAssistantMetaSince(chatId, characterId, windowFrom)) {
    if (row.sent_at >= windowTo) break;
    const move = parseMeta(row.meta_json).move;
    if (isMove(move)) usedMoves.add(move);
  }

  const counts = countStageValues({
    stage: stageNo,
    stageSince,
    today,
    messages: getMessagesBetween(chatId, characterId, windowFrom, windowTo),
    signals,
    scores,
    firsts: [...confirmed, ...pending],
    usedMoves: [...usedMoves],
  });
  const yesterdayMoves = yesterdayMovesOf(
    chatId,
    characterId,
    yesterdayFrom,
    yesterdayTo,
    yesterdaySignals,
  );
  const doneKinds = confirmed.map((f) => f.kind);

  return {
    stageNo,
    stageSince,
    stayDays: counts.stayDays,
    threshold: evaluateThreshold(stageNo, counts),
    firstsDone: confirmed.map((f) => ({
      kind: f.kind,
      by: f.by,
      date: logicalDateOf(f.happened_at),
    })),
    firstsOpen: openFirsts(stageNo, [
      ...doneKinds,
      ...pending.map((f) => f.kind),
    ]),
    firstsPending: pending.map((f) => ({
      id: f.id,
      kind: f.kind,
      by: f.by,
      happenedAt: f.happened_at,
    })),
    moveCandidates: moveCandidates(
      stageNo,
      scores,
      yesterdayMoves.map((m) => m.move),
      diaryDate,
    ),
    rapportMoves: rapportMoves(scores),
    yesterdayIntent: getRelationshipIntent(characterId, diaryDate) ?? null,
    yesterdayMoves,
    confessionDue: confessionDueOf(stageNo, counts),
  };
};

// ── 새벽 정리 저장 ────────────────────────────────────────────────────────────

/** 기억 정리 호출 출력의 관계 절. 어느 항목이든 없거나 null일 수 있다 — 아직 이 절을 안 만드는
 * 생성 경로가 있어서다. */
export interface RelationOutput {
  advance?: { go?: boolean; basis?: string | null } | null;
  firsts?: { kind?: string; keep?: boolean; by?: string }[] | null;
  intent?: {
    dig?: string | null;
    share?: string | null;
    move?: string | null;
    move_note?: string | null;
    lead_tone?: string | null;
    thread?: string | null;
    basis?: Record<string, string> | null;
  } | null;
}

export interface RelationApplied {
  advanced: {
    from: RelationshipStage;
    to: RelationshipStage;
    basis: string | null;
  } | null;
  /** 넘기자는 출력을 받았지만 반영하지 않은 까닭. 없으면 null. */
  advanceRejected: string | null;
  confirmed: FirstKind[];
  cancelled: FirstKind[];
  userAdded: FirstKind[];
  intentSaved: boolean;
}

export interface RelationContext {
  characterId: number;
  chatId: string;
  diaryDate: string;
  today: string;
  relation: NightlyRelation;
}

const cleanLine = (v: unknown, max = 120): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.trim().replace(/\s+/g, " ");
  return s ? s.slice(0, max) : undefined;
};

/** 유저가 먼저 한 처음의 시각 — 어제 마지막 유저 메시지, 없으면 어제 정오. */
const userFirstHappenedAt = (g: RelationContext): string => {
  const rows = getMessagesBetween(
    g.chatId,
    g.characterId,
    dayStart(g.diaryDate),
    dayStart(shiftDate(g.diaryDate, 1)),
  ).filter((m) => m.role === "user");
  return rows.length
    ? rows[rows.length - 1].sent_at
    : `${g.diaryDate} 12:00:00`;
};

/** 트랜잭션 안에서 부른다. 순서는 처음 → 단계 → 의도. */
export const applyRelationOutput = (
  g: RelationContext,
  out: RelationOutput | null | undefined,
  now: string,
): RelationApplied => {
  const r: RelationApplied = {
    advanced: null,
    advanceRejected: null,
    confirmed: [],
    cancelled: [],
    userAdded: [],
    intentSaved: false,
  };
  const rel = g.relation;
  // 후보 종류에 대한 출력은 by가 무엇이든 그 후보의 판정이다 — 답장이 유저 쪽으로 적어 둔
  // 후보를 모델이 by를 붙여 돌려줘도 지울 수 있게. 지우자는 출력이 하나라도 있으면 지운다.
  const pendingKinds = new Set<FirstKind>(rel.firstsPending.map((p) => p.kind));
  const judged = new Map<FirstKind, boolean>();
  for (const f of out?.firsts ?? [])
    if (f && isFirstKind(f.kind) && pendingKinds.has(f.kind))
      judged.set(f.kind, (judged.get(f.kind) ?? true) && f.keep !== false);

  // 처음 — 후보마다 모델이 지운 것만 지우고, 언급이 없는 후보는 확정한다. 답장이 표시한 처음을
  // 모델이 빠뜨렸다고 잃지 않는다. 관계 절이 통째로 없는 회차도 같다.
  for (const p of rel.firstsPending) {
    if (judged.get(p.kind) === false) {
      deleteUnconfirmedFirst(p.id);
      r.cancelled.push(p.kind);
    } else {
      confirmFirst(p.id);
      r.confirmed.push(p.kind);
    }
  }
  // 유저가 먼저 한 처음 — 아직 없는 종류만 새로 넣고 바로 확정한다. 이 단계까지 열린 종류만이고,
  // 방금 확정한 후보 종류는 이미 있는 것으로 센다.
  const doneNow = new Set<FirstKind>(
    getConfirmedFirsts(g.characterId).map((f) => f.kind),
  );
  const openNow = new Set<FirstKind>(
    ([1, 2, 3, 4] as RelationshipStage[])
      .filter((s) => s <= rel.stageNo)
      .flatMap((s) => STAGE_FIRSTS[s]),
  );
  for (const f of out?.firsts ?? []) {
    if (!f || f.by !== "user" || f.keep === false || !isFirstKind(f.kind))
      continue;
    if (doneNow.has(f.kind) || !openNow.has(f.kind)) continue;
    const id = insertFirst({
      characterId: g.characterId,
      chatId: g.chatId,
      kind: f.kind,
      by: "user",
      happenedAt: userFirstHappenedAt(g),
    });
    if (id === undefined) continue;
    confirmFirst(id);
    doneNow.add(f.kind);
    r.userAdded.push(f.kind);
  }

  // 단계 — 문턱이 찼고 모델이 넘기자고 했을 때만, 수집 때 단계에서 한 단계.
  if (out?.advance?.go === true) {
    const target = rel.threshold.to;
    const live = getStage(g.characterId);
    if (target === null) r.advanceRejected = "마지막 단계라 넘길 곳이 없음";
    else if (!rel.threshold.met)
      r.advanceRejected = "문턱이 안 찼는데 넘기자는 출력";
    else if (!live || live.stage_no !== rel.stageNo)
      r.advanceRejected = "수집 때와 단계가 달라 건너뜀";
    else if (rel.stageNo === 3 && !doneNow.has("first_confession"))
      r.advanceRejected = "마음 확인 처음이 확정되지 않아 건너뜀";
    else if (raiseStage(g.characterId, target, g.today))
      r.advanced = {
        from: rel.stageNo,
        to: target,
        basis: cleanLine(out.advance.basis) ?? null,
      };
    else r.advanceRejected = "단계 저장이 거부됨";
  }

  // 의도 — 오늘 것만 적는다. 며칠 지난 새벽 정리를 다시 돌린 경우면 그날 의도는 이미 지났다.
  const it = out?.intent;
  if (it && shiftDate(g.diaryDate, 1) === g.today) {
    // 플러팅은 코드가 고른 후보 안에서만 받는다 — 점수가 낮아 뺀 플러팅이나 이 단계에 아직 안 연 플러팅을
    // 모델이 고르면 버린다.
    const move =
      isMove(it.move) && rel.moveCandidates.includes(it.move)
        ? it.move
        : undefined;
    let moveNote = cleanLine(it.move_note);
    // 고백 차례의 "마음 확인"은 플러팅 코드가 아니라 move를 비우고 자리를 적는 줄로 남긴다. 고백
    // 차례가 아닌 날의 코드 아닌 move는 버린다.
    if (rel.confessionDue && !moveNote && !isMove(it.move))
      moveNote = cleanLine(it.move);
    const v = {
      dig: cleanLine(it.dig),
      share: cleanLine(it.share),
      move,
      moveNote,
      leadTone: isLeadTone(it.lead_tone) ? it.lead_tone : undefined,
      thread: cleanLine(it.thread),
      basisJson:
        it.basis && typeof it.basis === "object"
          ? JSON.stringify(it.basis)
          : undefined,
    };
    // 결 하나만 있어도 적는다 — 아침 선톡이 앞세울 결만 따르는 날이 있다.
    if (v.dig || v.share || v.move || v.moveNote || v.leadTone || v.thread) {
      saveRelationshipIntent(g.characterId, g.today, v, now);
      pruneRelationshipIntents();
      r.intentSaved = true;
    }
  }

  // 반응 점수 — 구현 6이 표본 계산을 만들면 여기서 saveReactionScore로 적는다.

  return r;
};
