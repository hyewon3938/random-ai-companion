// 게시함 표의 저장 함수와 보관 기간.
//
// 슬랙에 올릴 글을 쌓아 두는 trace_events 표다. 행을 넣고 상태를 옮기고 무엇을 남기고
// 지우는지는 표의 규칙이라 여기 두고, 무엇을 올릴지와 슬랙에 보내는 일은 trace.ts가 한다.

import { db } from "./connection.js";
import { getKstNow, kstDateString } from "../kst.js";

// 게시함 보관 기간. 지나면 행을 통째로 지운다 — 이미 올라간 글은 슬랙이 들고 있고, 이 표는
// 무엇을 올릴지 쌓아 두는 자리라 올리고 난 뒤에는 같은 글을 두 번 올리지 않게 막는 몫만 남는다.
// 그 몫(dedupe_key)이 필요한 기간은 게시 자리마다 길어야 하루다 — 아침 각본 알림은 오늘 날짜만
// 보고, 프롬프트 고정 두 덩이는 논리일마다 키가 갈리고, 호출 게시는 llm_calls.traced 표시와
// 3시간 상한이 막고, 새벽 정리는 그 날짜 일기가 있으면 게시까지 건너뛴다. 하루치를 지워 다시
// 보내는 tools/retrace.ts가 그보다 뒤 날짜를 볼 수 있어, 여유를 크게 두고 30일로 잡았다.
export const TRACE_EVENT_RETENTION_DAYS = 30;

// 기간이 지나도 남기는 행. 하나라도 참이면 지우지 않는다 — 뺄 행이 생기면 여기에 한 줄 더한다.
// 조건은 NULL을 내지 않게 쓴다. NOT (거짓 OR NULL)은 NULL이라 그 행이 조용히 안 지워진다.
const TRACE_EVENT_KEEP = [
  // 아직 슬랙에 못 올라간 행. 여기서 지우면 영영 못 올린다.
  `status = 'pending'`,
  // 아직 못 올라간 자식이 매달린 부모. 부모를 먼저 지우면 자식이 스레드를 잃고 접힌다.
  `(thread_key IS NOT NULL
        AND thread_key IN (SELECT parent_key FROM trace_events
                            WHERE status = 'pending' AND parent_key IS NOT NULL))`,
];

/**
 * 보관 기간이 지난 게시 행을 지운다. 올리지 못한 failed·skipped도 함께 지운다 — 슬랙 설정이
 * 잘못된 채로 오래 두면 모든 행이 failed가 되므로, 이것만 빼 두면 표가 다시 끝없이 커진다.
 * 무엇이 왜 실패했는지는 게시를 포기하는 자리에서 로그로 남는다.
 */
export const pruneTraceEvents = (
  days: number = TRACE_EVENT_RETENTION_DAYS,
): number => {
  const cutoff = kstDateString(
    new Date(getKstNow().getTime() - days * 86400000),
  );
  return db
    .prepare(
      `DELETE FROM trace_events
        WHERE created_at < ?
          AND NOT (${TRACE_EVENT_KEEP.join(" OR ")})`,
    )
    .run(cutoff).changes;
};

// ── 행 넣기와 상태 옮기기 ────────────────────────────────────────────────

export interface TraceEventInsert {
  characterId: number | null;
  kind: string;
  dedupeKey: string | null;
  threadKey: string | null;
  parentKey: string | null;
  text: string;
  createdAt: string;
}

// 같은 dedupe_key가 이미 있으면 조용히 건너뛴다(재게시 방지).
export const insertTraceEvent = (e: TraceEventInsert): void => {
  db.prepare(
    `INSERT OR IGNORE INTO trace_events
       (character_id, kind, dedupe_key, thread_key, parent_key, text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.characterId,
    e.kind,
    e.dedupeKey,
    e.threadKey,
    e.parentKey,
    e.text,
    e.createdAt,
  );
};

export const hasTraceEvent = (dedupeKey: string): boolean =>
  Boolean(
    db.prepare(`SELECT 1 FROM trace_events WHERE dedupe_key = ?`).get(dedupeKey),
  );

export interface PendingTraceRow {
  id: number;
  kind: string;
  parent_key: string | null;
  text: string;
  attempts: number;
  created_at: string;
}

export const pendingTraceEvents = (limit: number): PendingTraceRow[] =>
  db
    .prepare(
      `SELECT id, kind, parent_key, text, attempts, created_at
         FROM trace_events WHERE status = 'pending' ORDER BY id LIMIT ?`,
    )
    .all(limit) as PendingTraceRow[];

/** 스레드 부모 행의 상태와 슬랙 ts. 같은 thread_key가 여럿이면 마지막 것. */
export const traceParentOf = (
  threadKey: string,
): { status: string; slack_ts: string | null } | undefined =>
  db
    .prepare(
      `SELECT status, slack_ts FROM trace_events
        WHERE thread_key = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(threadKey) as { status: string; slack_ts: string | null } | undefined;

export const markTraceEventSent = (id: number, slackTs: string): void => {
  db.prepare(
    `UPDATE trace_events
        SET status = 'sent', slack_ts = ?, attempts = attempts + 1, last_error = NULL
      WHERE id = ?`,
  ).run(slackTs, id);
};

export const setTraceEventFailure = (
  id: number,
  status: "pending" | "failed",
  attempts: number,
  error: string,
): void => {
  db.prepare(
    `UPDATE trace_events SET status = ?, attempts = ?, last_error = ? WHERE id = ?`,
  ).run(status, attempts, error, id);
};

export const skipTraceEvent = (id: number, reason: string): void => {
  db.prepare(
    `UPDATE trace_events SET status = 'skipped', last_error = ? WHERE id = ?`,
  ).run(reason, id);
};

// ── 슬랙 ts로 되짚기 ───────────────────────────────────────────────────
// 사람이 채널에 남긴 표시를 어느 글에 붙일지 찾는 자리(feedback.ts)가 쓴다.

export const traceEventBySlackTs = (
  slackTs: string,
):
  | {
      character_id: number | null;
      kind: string;
      dedupe_key: string | null;
      thread_key: string | null;
    }
  | undefined =>
  db
    .prepare(
      `SELECT character_id, kind, dedupe_key, thread_key FROM trace_events
        WHERE slack_ts = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(slackTs) as
    | {
        character_id: number | null;
        kind: string;
        dedupe_key: string | null;
        thread_key: string | null;
      }
    | undefined;

/** 우리가 그 스레드에 올린 자식 수. */
export const countSentChildren = (threadKey: string): number =>
  db
    .prepare(
      `SELECT COUNT(*) FROM trace_events
        WHERE parent_key = ? AND status = 'sent'`,
    )
    .pluck()
    .get(threadKey) as number;
