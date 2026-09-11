// 슬랙에서 사람이 남긴 표시를 모아 두는 call_feedback 표의 저장 함수.
//
// 표시 하나가 행 하나다. 뗀 표시는 지우지 않고 removed_at을 적고, 다시 붙이면 그 값을 비운다.
// 무엇을 표시로 볼지와 슬랙을 다시 읽는 일은 feedback.ts가 한다.
//
// 그 지적을 사람이 다뤘는지는 resolved_at·issue_no·resolution 세 칸에 따로 적는다. 슬랙에서
// 뗐다는 removed_at과 뜻이 다르다 — 뗀 것은 표시를 거둔 것이고, 처리한 것은 지적을 다룬 것이다.
// 이 세 칸은 수집 틱이 채우지 않고 tools/feedback.ts로 사람이 찍는다.

import { db } from "./connection.js";

export const getFeedbackByDedupeKey = (
  dedupeKey: string,
): { id: number; removed_at: string | null } | undefined =>
  db
    .prepare(`SELECT id, removed_at FROM call_feedback WHERE dedupe_key = ?`)
    .get(dedupeKey) as { id: number; removed_at: string | null } | undefined;

export const restoreFeedback = (id: number): void => {
  db.prepare(`UPDATE call_feedback SET removed_at = NULL WHERE id = ?`).run(id);
};

export interface FeedbackInsert {
  characterId: number | null;
  callId: number | null;
  slackTs: string;
  traceKind: string | null;
  source: "reaction" | "reply";
  kind: string | null;
  slackUser: string | null;
  text: string | null;
  replyTs: string | null;
  dedupeKey: string;
  createdAt: string;
}

export const insertFeedback = (f: FeedbackInsert): void => {
  db.prepare(
    `INSERT INTO call_feedback
       (character_id, call_id, slack_ts, trace_kind, source, kind,
        slack_user, text, reply_ts, dedupe_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    f.characterId,
    f.callId,
    f.slackTs,
    f.traceKind,
    f.source,
    f.kind,
    f.slackUser,
    f.text,
    f.replyTs,
    f.dedupeKey,
    f.createdAt,
  );
};

/** 그 글에 지금 붙어 있다고 아는 리액션 표시. */
export const activeReactionFeedback = (
  slackTs: string,
): { id: number; dedupe_key: string }[] =>
  db
    .prepare(
      `SELECT id, dedupe_key FROM call_feedback
        WHERE slack_ts = ? AND source = 'reaction' AND removed_at IS NULL`,
    )
    .all(slackTs) as { id: number; dedupe_key: string }[];

export const removeFeedback = (id: number, at: string): void => {
  db.prepare(`UPDATE call_feedback SET removed_at = ? WHERE id = ?`).run(at, id);
};

/** 그 글의 스레드에서 이미 모은 답글 수. */
export const countReplyFeedback = (slackTs: string): number =>
  db
    .prepare(
      `SELECT COUNT(*) FROM call_feedback
        WHERE slack_ts = ? AND source = 'reply'`,
    )
    .pluck()
    .get(slackTs) as number;

// ── 처리 여부 ──────────────────────────────────────────────────────────

/** 사람이 그 지적을 다뤘는지 적을 때 고르는 결과. */
export type FeedbackResolution = "fixed" | "wontfix" | "dup";

export interface FeedbackRow {
  id: number;
  call_id: number | null;
  slack_ts: string;
  trace_kind: string | null;
  source: string;
  kind: string | null;
  text: string | null;
  created_at: string;
  resolved_at: string | null;
  issue_no: number | null;
  resolution: string | null;
}

const FEEDBACK_COLUMNS = `id, call_id, slack_ts, trace_kind, source, kind, text,
          created_at, resolved_at, issue_no, resolution`;

/** 아직 처리 표시를 찍지 않은 표시 — 슬랙에서 뗀 리액션은 뺀다. */
export const openFeedback = (): FeedbackRow[] =>
  db
    .prepare(
      `SELECT ${FEEDBACK_COLUMNS} FROM call_feedback
        WHERE removed_at IS NULL AND resolved_at IS NULL
        ORDER BY created_at, id`,
    )
    .all() as FeedbackRow[];

export const feedbackByIds = (ids: number[]): FeedbackRow[] =>
  ids.length
    ? (db
        .prepare(
          `SELECT ${FEEDBACK_COLUMNS} FROM call_feedback
            WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`,
        )
        .all(...ids) as FeedbackRow[])
    : [];

/**
 * 처리 표시를 찍는다 — 이미 찍힌 행은 건드리지 않고 새로 찍은 수만 돌려준다.
 * 같은 표시를 두 번 찍어도 처음 적은 이슈 번호가 남는다.
 */
export const resolveFeedback = (
  ids: number[],
  resolution: FeedbackResolution,
  issueNo: number | null,
  at: string,
): number => {
  if (!ids.length) return 0;
  return db
    .prepare(
      `UPDATE call_feedback
          SET resolved_at = ?, resolution = ?, issue_no = ?
        WHERE id IN (${ids.map(() => "?").join(",")}) AND resolved_at IS NULL`,
    )
    .run(at, resolution, issueNo, ...ids).changes;
};

/** 처리 표시를 되돌린다 — 잘못 찍었을 때 쓴다. */
export const unresolveFeedback = (ids: number[]): number =>
  ids.length
    ? db
        .prepare(
          `UPDATE call_feedback
              SET resolved_at = NULL, resolution = NULL, issue_no = NULL
            WHERE id IN (${ids.map(() => "?").join(",")})`,
        )
        .run(...ids).changes
    : 0;
