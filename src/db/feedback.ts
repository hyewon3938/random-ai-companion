// 슬랙에서 사람이 남긴 표시를 모아 두는 call_feedback 표의 저장 함수.
//
// 표시 하나가 행 하나다. 뗀 표시는 지우지 않고 removed_at을 적고, 다시 붙이면 그 값을 비운다.
// 무엇을 표시로 볼지와 슬랙을 다시 읽는 일은 feedback.ts가 한다.

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
