// 예약 발송과 대기 중인 답장 표의 저장 함수.
//
// 예약 발송은 새벽 정리가 준비한 선톡 문안을 창 안에서 내보내는 행이고, 대기 중인 답장은
// 답장을 만들어 두고 정한 시각까지 들고 있는 행이다. 발송 실패 기록도 여기다.

import { db } from "./connection.js";
import { getKstNow, kstDateString } from "../kst.js";

// 선톡: 밤 정리가 근거 있을 때만 하루 1통 문안을 준비해두고, 디스패처가 창 안에서 발송한다
export interface ScheduledSendRow {
  id: number;
  character_id: number;
  chat_id: string;
  date: string;
  window_start: string;
  window_end: string;
  text: string;
  kind: string; // morning | checkin
  attempts: number;
}

export const insertScheduledSend = (
  characterId: number,
  chatId: string,
  date: string,
  windowStart: string,
  windowEnd: string,
  text: string,
  now: string,
  kind: "morning" | "checkin" = "morning",
): void => {
  const dup = db
    .prepare(
      `SELECT 1 FROM scheduled_messages WHERE character_id = ? AND date = ? LIMIT 1`,
    )
    .get(characterId, date);
  if (dup) return; // 하루 1통
  db.prepare(
    `INSERT INTO scheduled_messages (character_id, chat_id, date, window_start, window_end, text, created_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(characterId, chatId, date, windowStart, windowEnd, text, now, kind);
};

export const getPendingSends = (date: string): ScheduledSendRow[] =>
  db
    .prepare(
      `SELECT id, character_id, chat_id, date, window_start, window_end, text, kind, attempts FROM scheduled_messages WHERE status = 'pending' AND date = ?`,
    )
    .all(date) as ScheduledSendRow[];

export const markScheduledSend = (
  id: number,
  status: "sent" | "skipped",
  skipReason: string | null,
  sentAt: string | null,
): void => {
  db.prepare(
    `UPDATE scheduled_messages SET status = ?, skip_reason = ?, sent_at = ? WHERE id = ?`,
  ).run(status, skipReason, sentAt, id);
};

// 전송 실패를 행에 남긴다 — 로그를 뒤지지 않고도 "몇 번 시도했고 왜 못 갔는지"가 보이게.
// (정상 스킵과 네트워크 실패가 똑같이 '발송 창 지남'으로 뭉뚱그려지던 걸 가르는 근거)
export const recordSendAttempt = (id: number, error: string): void => {
  db.prepare(
    `UPDATE scheduled_messages SET attempts = attempts + 1, last_error = ? WHERE id = ?`,
  ).run(error.slice(0, 300), id);
};

// scheduled_messages 밖의 선톡(팔로업·자리비움 예고) 전송 실패 흔적. 이 메시지들은 순간에 묶여 있어
// 유예·재시도가 없다 — 대신 실패했다는 사실만은 콘솔이 아니라 DB에 남겨 사후 추적이 되게 한다.
export const recordSendFailure = (
  chatId: string,
  characterId: number,
  kind: "away" | "catchup" | "goodnight" | "mend",
  error: string,
): void => {
  const failedAt = `${kstDateString()} ${getKstNow().toISOString().slice(11, 19)}`;
  db.prepare(
    `INSERT INTO send_failures (chat_id, character_id, kind, error, failed_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(chatId, characterId, kind, error.slice(0, 300), failedAt);
};

// ── 대기 중인 답장 ────────────────────────────────────────────────────────
// 답장을 미리 만들어 두고 정한 시각에 보낸다. 몇 시간짜리 대기가 생기므로 행으로 남겨
// 프로세스가 다시 떠도 이어간다.

export interface PendingReplyRow {
  id: number;
  chat_id: string;
  character_id: number;
  user_msg_at: string;
  bubbles_json: string;
  note_to_save: string | null;
  send_at: string;
  kind: string;
  meta_json: string | null;
  /** 이 답장을 만든 모델 호출 번호. 트레이스에서 발송 결과를 그 답장 아래에 단다. */
  call_id: number | null;
  attempts: number;
  created_at: string;
}

export const insertPendingReply = (p: {
  chatId: string;
  characterId: number;
  userMsgAt: string;
  bubbles: string[];
  noteToSave: string | null;
  sendAt: string;
  kind: string;
  metaJson?: string | null;
  callId?: number | null;
  createdAt: string;
}): number =>
  Number(
    db
      .prepare(
        `INSERT INTO pending_replies
           (chat_id, character_id, user_msg_at, bubbles_json, note_to_save, send_at, kind, meta_json, call_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.chatId,
        p.characterId,
        p.userMsgAt,
        JSON.stringify(p.bubbles),
        p.noteToSave,
        p.sendAt,
        p.kind,
        p.metaJson ?? null,
        p.callId ?? null,
        p.createdAt,
      ).lastInsertRowid,
  );

export const getWaitingPendingReplies = (): PendingReplyRow[] =>
  db
    .prepare(
      `SELECT id, chat_id, character_id, user_msg_at, bubbles_json, note_to_save, send_at, kind, meta_json, call_id, attempts, created_at
         FROM pending_replies WHERE status = 'waiting' ORDER BY send_at`,
    )
    .all() as PendingReplyRow[];

/** 걸어 둔 행 하나를 지금 값으로 다시 읽는다. 타이머는 걸 때의 값을 들고 있는데, 그 사이
 *  promoteWakeRow가 종류를 바꿔 놓았을 수 있어 울릴 때 한 번 더 확인한다. */
export const getPendingReply = (id: number): PendingReplyRow | null =>
  (db
    .prepare(
      `SELECT id, chat_id, character_id, user_msg_at, bubbles_json, note_to_save, send_at, kind, meta_json, call_id, attempts, created_at
         FROM pending_replies WHERE id = ? AND status = 'waiting'`,
    )
    .get(id) as PendingReplyRow | undefined) ?? null;

// 유저가 답을 기다리는 중인가 — 선톡 틱이 이 값을 보고 물러난다. kind='return'은 빼고 센다.
// 그 행은 답할 말이 없는 구간 경계 알림이라, 세면 불가 구간 내내 모든 선톡이 멈춰 연속 불가
// 구간의 다음 예고와 아침·점심 선톡이 발송 창을 놓친다.
export const hasWaitingPendingReply = (chatId: string): boolean =>
  !!db
    .prepare(
      `SELECT 1 FROM pending_replies WHERE chat_id = ? AND status = 'waiting' AND kind <> 'return' LIMIT 1`,
    )
    .get(chatId);

/** 이 구간이 끝나는 시각에 울릴 행이 이미 걸려 있는가. 두 종류를 함께 센다 — 한 구간에 행은
 *  하나이고, 유저가 말을 걸면 새로 만드는 대신 promoteWakeRow가 그 행의 종류를 바꾼다. */
export const hasWaitingWakeRow = (chatId: string): boolean =>
  !!db
    .prepare(
      `SELECT 1 FROM pending_replies WHERE chat_id = ? AND status = 'waiting' AND kind IN ('wake','return') LIMIT 1`,
    )
    .get(chatId);

/** 걸려 있던 'return' 행을 'wake'로 올린다 — 그 구간에 유저가 말을 걸어 답할 말이 생겼다.
 *  기다린 시간을 재는 기준이 되도록 그 첫 메시지 시각도 함께 적는다. 이미 'wake'인 행은
 *  그대로 둔다(먼저 온 메시지가 기준이다). 바꾼 행 수를 돌려준다. */
export const promoteWakeRow = (chatId: string, userMsgAt: string): number =>
  db
    .prepare(
      `UPDATE pending_replies SET kind = 'wake', user_msg_at = ?
         WHERE chat_id = ? AND status = 'waiting' AND kind = 'return'`,
    )
    .run(userMsgAt, chatId).changes;

/** 버린 대기 행 — 트레이스가 그 답장 스레드에 폐기 사실을 달 수 있게 호출 번호까지 준다. */
export interface SupersededRow {
  id: number;
  call_id: number | null;
}

// 유저가 대기 중에 말을 더 걸면 만들어 둔 답장을 버린다 — 그 사이 대화가 바뀌었기 때문.
// 깨우기 표시는 답장이 아니라 남긴다 — 메시지가 더 쌓여도 구간 끝에 한 번 깨는 건 같다.
// 조건은 버릴 값이 아니라 남길 값으로 적는다. 'wake가 아닌 것 전부'로 적으면 나중에 종류가
// 늘 때마다 여기가 조용히 그 행까지 버린다.
export const supersedePendingReplies = (chatId: string): SupersededRow[] => {
  const rows = db
    .prepare(
      `SELECT id, call_id FROM pending_replies WHERE chat_id = ? AND status = 'waiting' AND kind IN ('reply','recover')`,
    )
    .all(chatId) as SupersededRow[];
  if (rows.length)
    db.prepare(
      `UPDATE pending_replies SET status = 'superseded' WHERE chat_id = ? AND status = 'waiting' AND kind IN ('reply','recover')`,
    ).run(chatId);
  return rows;
};

// 깨우기 표시를 거둔다 — 불가 구간이 아닌 길로 답장이 나가게 됐을 때(붙잡힘 등).
export const supersedeWakeRows = (chatId: string): SupersededRow[] => {
  const rows = db
    .prepare(
      `SELECT id, call_id FROM pending_replies WHERE chat_id = ? AND status = 'waiting' AND kind IN ('wake','return')`,
    )
    .all(chatId) as SupersededRow[];
  if (rows.length)
    db.prepare(
      `UPDATE pending_replies SET status = 'superseded' WHERE chat_id = ? AND status = 'waiting' AND kind IN ('wake','return')`,
    ).run(chatId);
  return rows;
};

export const markPendingReply = (
  id: number,
  status: "sent" | "failed" | "superseded",
  sentAt: string | null,
  error?: string | null,
): void => {
  db.prepare(
    `UPDATE pending_replies SET status = ?, sent_at = ?, last_error = coalesce(?, last_error) WHERE id = ?`,
  ).run(status, sentAt, error ?? null, id);
};

export const bumpPendingAttempt = (id: number, error: string): void => {
  db.prepare(
    `UPDATE pending_replies SET attempts = attempts + 1, last_error = ? WHERE id = ?`,
  ).run(error, id);
};
