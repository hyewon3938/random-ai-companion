// 주간 관계 요약 게시 — 지난주 월~일의 단계·처음·플러팅 반응·대화 계획과 유저 반응 값을 슬랙에 한 건 올린다.
//
// 월요일 10~23시에 매시 크론이 부른다(index.ts). 지난주는 논리일(새벽 5시 경계)로 월요일부터
// 일요일까지이고, 일요일 몫 새벽 정리가 월요일 05:40에 끝난 뒤라 저장된 점수에 그 주 표본이 다
// 얹혀 있다. 매시 부르는 것은 배포·재시작으로 한 시각을 놓쳐도 그날 안에 쌓으려는 것이고, 같은 주
// 두 번째 행은 트레이스 표의 중복 키(relationship_weekly:<캐릭터 번호>:<주 시작일>)가 막는다.
// 중복 키는 행이 있는지만 보고 게시 상태는 보지 않아서, 슬랙 게시가 실패해 행이 failed가 된 주는
// 다시 쌓지 않고 그 주 요약이 빠진다. 월요일 10~23시 내내 봇이 꺼져 있던 주도 따라잡지 않는다.
// 주마다 따로 적어 두는 표나 설정 행은 없다.
//
// 모델은 부르지 않고 DB 값만 모은다. 반응 점수는 이력을 남기지 않아서, 그 주 변화는 새벽 정리와
// 같은 규칙(reaction-score.ts collectReactionSamples)으로 날마다 표본을 다시 세어 플러팅별 횟수와
// 평균을 적고 지금 저장된 점수를 옆에 둔다. 다시 센 값은 새벽 정리가 저장할 때 센 값과 드물게
// 다를 수 있다(그 파일 머리 주석).
//
// 대화 계획 줄은 새벽 정리가 날마다 저장한 계획 줄과 그날 캐릭터가 한 말의 발송 기록(intent_line·
// intent_lines·move)을 견준다. 의도 표를 다음 새벽 정리가 지우지 않고 30일 두는 이유가 이
// 비교다(relationship.md 4절). 오늘 쓴 줄을 세는 규칙은 선톡 정책의 usedIntentLines와 같다.
//
// 유저 반응 줄은 time-and-memory.md 「채점표」 10번의 재료다. 유저가 말한 날, 선톡에 답이 온 수,
// 캐릭터 말 뒤 6시간 안에 다시 말한 턴의 간격 중앙값을 적는다. 선톡은 틈새 한 줄을 빼고 세고,
// 답은 같은 논리일 6시간 안에 온 유저 말이다 — 반응 점수 표본과 같은 창이다.

import {
  getActiveCharacters,
  getConfirmedFirsts,
  getMessageRowsBetween,
  getReactionScores,
  getRelationshipIntent,
  getStage,
  getUnconfirmedFirsts,
  hasTraceEvent,
  type CharacterRow,
} from "../db.js";
import {
  baselineOf,
  collectReactionSamples,
  gapMs,
  userTurnsOf,
} from "../reaction-score.js";
import {
  FIRST_KIND_NAME,
  INTENT_LINE_NAME,
  MOVE_NAME,
  RELATIONSHIP_STAGE_NAME,
  isRelationshipStage,
  type IntentLine,
  type Move,
} from "../labels.js";
import { intentLines } from "../prompts/nightly.js";
import { kstLogicalDate, logicalDateOf, shiftDate } from "../kst.js";
import { REACTION_REPLY_WINDOW_MS } from "../thresholds.js";
import { recordTraceEvent, traceEnabled } from "../trace.js";
import { firstLabel, signed } from "../nightly-trace.js";
import { dateLabel, esc } from "./format.js";

const dayStart = (date: string): string => `${date} 05:00:00`;

/** 지난주 월요일(논리일). today가 무슨 요일이든 today가 든 주의 월요일에서 7일 앞이다. */
export const lastWeekStart = (today: string): string => {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  return shiftDate(today, -((dow + 6) % 7) - 7);
};

/** 간격을 사람이 읽는 길이로. 1분이 안 되면 초로 적는다. */
export const durationLabel = (ms: number): string => {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}초`;
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}분`;
  return `${Math.floor(min / 60)}시간${min % 60 ? ` ${min % 60}분` : ""}`;
};

type MessageRow = ReturnType<typeof getMessageRowsBetween>[number];

const metaOf = (json: string | null): Record<string, unknown> | null => {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

// 선톡으로 세는 캐릭터 말인지. 틈새 한 줄은 유저 말에 붙는 짧은 알림이라 선톡 하루 수에도 안 넣고
// 여기서도 뺀다.
const isCountedProactive = (json: string | null): boolean => {
  const m = metaOf(json);
  return m !== null && m.proactive === true && m.kind !== "glance";
};

const isIntentLine = (v: unknown): v is IntentLine =>
  typeof v === "string" && Object.hasOwn(INTENT_LINE_NAME, v);

// 캐릭터 말 한 통이 쓴 의도 줄. 플러팅을 뒀으면 시도할 플러팅 줄을 쓴 것으로 본다.
const usedLinesOf = (json: string | null): IntentLine[] => {
  const m = metaOf(json);
  if (!m) return [];
  return [
    ...(isIntentLine(m.intent_line) ? [m.intent_line] : []),
    ...(Array.isArray(m.intent_lines) ? m.intent_lines.filter(isIntentLine) : []),
    ...(typeof m.move === "string" && m.move ? (["move"] as const) : []),
  ];
};

// 그 주에 캐릭터가 있던 날(만든 날부터).
const weekDays = (c: CharacterRow, weekStart: string): string[] => {
  const startDate = logicalDateOf(c.created_at);
  return Array.from({ length: 7 }, (_, i) => shiftDate(weekStart, i)).filter(
    (d) => d >= startDate,
  );
};

const stageLine = (c: CharacterRow, weekStart: string, weekEnd: string): string => {
  const row = getStage(c.id);
  const no = row && isRelationshipStage(row.stage_no) ? row.stage_no : 1;
  const since = row?.stage_since ?? logicalDateOf(c.created_at);
  // 새벽 정리는 단계를 올린 날(정리를 돈 논리일)을 시작일로 적는다. 그 주 화요일부터 다음 주 월요일
  // 새벽 정리까지가 그 주 대화로 판정한 것이다.
  const raised = no > 1 && since > weekStart && since <= weekEnd;
  const started = logicalDateOf(c.created_at) >= weekStart;
  return [
    `단계: ${no}단계 ${RELATIONSHIP_STAGE_NAME[no]} · ${dateLabel(since)}부터`,
    ...(raised ? [`이번 주에 ${no}단계로 넘어갔다`] : []),
    ...(started ? [`이번 주에 시작한 캐릭터`] : []),
  ].join(" · ");
};

const firstLines = (c: CharacterRow, from: string, to: string): string[] => {
  const confirmed = getConfirmedFirsts(c.id);
  const inWeek = [...confirmed, ...getUnconfirmedFirsts(c.id)]
    .filter((r) => r.happened_at >= from && r.happened_at < to)
    .sort((a, b) => (a.happened_at < b.happened_at ? -1 : 1));
  const total = `확정 누적 ${confirmed.length}/${Object.keys(FIRST_KIND_NAME).length}`;
  if (!inWeek.length) return [`처음: 이번 주 없음 · ${total}`];
  return [
    `처음: 이번 주 ${inWeek.length}개 · ${total}`,
    ...inWeek.map(
      (r) => `> ${esc(firstLabel(r))} · ${r.confirmed ? "확정" : "미확정"}`,
    ),
  ];
};

const moveLines = (c: CharacterRow, weekStart: string): string[] => {
  const samples = Array.from({ length: 7 }, (_, i) => shiftDate(weekStart, i)).flatMap(
    (d) => collectReactionSamples(c.chat_id, c.id, d),
  );
  if (!samples.length) return ["플러팅 반응: 이번 주 쓴 플러팅 없음"];
  const byMove = new Map<Move, number[]>();
  for (const s of samples) byMove.set(s.move, [...(byMove.get(s.move) ?? []), s.value]);
  const scores = new Map(getReactionScores(c.chat_id).map((r) => [r.move, r]));
  const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const rows = [...byMove]
    .map(([move, values]) => ({ move, n: values.length, avg: avg(values) }))
    .sort((a, b) => b.n - a.n || b.avg - a.avg);
  return [
    `플러팅 반응: 이번 주 표본 ${samples.length}개 (새벽 정리 규칙으로 다시 셈)`,
    ...rows.map(({ move, n, avg: a }) => {
      const now = scores.get(move);
      return `> ${MOVE_NAME[move]} ${n}회 · 표본 평균 ${signed(a)} · 지금 점수 ${
        now ? `${signed(now.score)} (누적 표본 ${now.sample_count})` : "없음"
      }`;
    }),
  ];
};

const planLine = (
  c: CharacterRow,
  weekStart: string,
  rows: MessageRow[],
): string => {
  const days = weekDays(c, weekStart);
  let planDays = 0;
  let planned = 0;
  let used = 0;
  for (const d of days) {
    const lines = intentLines(getRelationshipIntent(c.id, d)).map(([k]) => k);
    if (!lines.length) continue;
    planDays += 1;
    planned += lines.length;
    const done = new Set(
      rows
        .filter((r) => r.role === "assistant" && logicalDateOf(r.sent_at) === d)
        .flatMap((r) => usedLinesOf(r.meta_json)),
    );
    used += lines.filter((l) => done.has(l)).length;
  }
  if (!planDays) return "대화 계획: 이번 주 저장된 계획 없음";
  return `대화 계획: 계획이 있던 날 ${planDays}/${days.length}일 · 계획한 줄 ${planned}개 중 그날 쓴 줄 ${used}개`;
};

const returnLine = (
  c: CharacterRow,
  weekStart: string,
  rows: MessageRow[],
): string => {
  const days = weekDays(c, weekStart).length;
  const talked = new Set(
    rows.filter((r) => r.role === "user").map((r) => logicalDateOf(r.sent_at)),
  ).size;
  const within = (a: string, b: string): boolean =>
    logicalDateOf(a) === logicalDateOf(b) && gapMs(a, b) <= REACTION_REPLY_WINDOW_MS;
  const proactive = rows.filter(
    (r) => r.role === "assistant" && isCountedProactive(r.meta_json),
  );
  const answered = proactive.filter((p) => {
    const reply = rows.find((r) => r.role === "user" && r.id > p.id);
    return reply !== undefined && within(p.sent_at, reply.sent_at);
  }).length;
  // 창 길이는 반응 점수 표본과 같은 기준값에서 읽는다 — 기준값을 바꾸면 문구도 같이 바뀐다.
  const turnLabel = `캐릭터 말 뒤 ${durationLabel(REACTION_REPLY_WINDOW_MS)} 안에 다시 말한 턴`;
  const base = baselineOf(userTurnsOf(rows));
  const turns =
    base.gapMedianMs === null
      ? `${turnLabel} 없음`
      : `${turnLabel} ${base.turns}건, 간격 중앙값 ${durationLabel(base.gapMedianMs)}`;
  return `유저 반응: 말한 날 ${talked}/${days}일 · 선톡 ${proactive.length}통 중 답 ${answered}통 · ${turns}`;
};

/** 캐릭터 하나의 한 주 요약 본문. weekStart는 그 주 월요일(논리일)이다. */
export const weeklyRelationshipText = (
  c: CharacterRow,
  weekStart: string,
): string => {
  const weekEnd = shiftDate(weekStart, 7);
  const from = dayStart(weekStart);
  const to = dayStart(weekEnd);
  const rows = getMessageRowsBetween(c.chat_id, c.id, from, to);
  return [
    `:calendar: *주간 관계 요약* ${dateLabel(weekStart)}~${dateLabel(shiftDate(weekStart, 6))} · 캐릭터 #${c.id}`,
    stageLine(c, weekStart, weekEnd),
    ...firstLines(c, from, to),
    ...moveLines(c, weekStart),
    planLine(c, weekStart, rows),
    returnLine(c, weekStart, rows),
  ].join("\n");
};

/** 살아 있는 캐릭터마다 지난주 요약을 트레이스 표에 한 건 쌓는다. 슬랙으로 내보내는 일은 1분
 * 틱(trace.ts)이 맡는다. 그 주가 끝난 뒤에 만든 캐릭터는 요약할 주가 없어 건너뛴다. */
export const postWeeklyRelationship = (
  today: string = kstLogicalDate(),
): void => {
  if (!traceEnabled()) return;
  const weekStart = lastWeekStart(today);
  const weekEnd = shiftDate(weekStart, 7);
  for (const c of getActiveCharacters()) {
    if (logicalDateOf(c.created_at) >= weekEnd) continue;
    const dedupeKey = `relationship_weekly:${c.id}:${weekStart}`;
    if (hasTraceEvent(dedupeKey)) continue;
    // 한 캐릭터의 요약을 만들다 실패해도 뒤 캐릭터는 쌓는다.
    try {
      recordTraceEvent({
        characterId: c.id,
        kind: "relationship_weekly",
        dedupeKey,
        text: weeklyRelationshipText(c, weekStart),
      });
    } catch (err) {
      console.error(`[trace] 주간 관계 요약 준비 실패 #${c.id}:`, err);
    }
  }
};
