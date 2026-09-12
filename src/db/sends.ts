// 예약 발송과 대기 중인 답장 표의 저장 함수.
//
// 예약 발송은 새벽 정리가 준비한 선톡 문안을 창 안에서 내보내는 행이고, 대기 중인 답장은
// 답장을 만들어 두고 정한 시각까지 들고 있는 행이다. 발송 실패 기록도 여기다. 캐릭터를
// 끝낼 때 두 표에 걸린 행을 함께 거두는 함수도 여기 둔다.
//
// 거두거나 걸려 있는 행을 읽는 함수는 행 번호와 meta까지 함께 준다 — 슬랙 게시가 어느 행의
// 어느 구간인지 적어야 밖에서 표시 하나를 따라갈 수 있다(이슈 #379).

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

export const hasScheduledSendOn = (
  characterId: number,
  date: string,
): boolean =>
  !!db
    .prepare(
      `SELECT 1 FROM scheduled_messages WHERE character_id = ? AND date = ? LIMIT 1`,
    )
    .get(characterId, date);

/** 오늘 준비해 둔 선톡이 아직 안 나갔는가 — 낮 근황 선톡이 이 값을 보고 기다린다. 어제
 *  대화가 끊긴 채 아침을 맞으면 근황의 네 시간 침묵 조건이 아침 문안의 발송 창보다 먼저
 *  차서, 이 검사가 없으면 아침 인사보다 근황이 앞질러 나간다(이슈 #314). */
export const hasPendingSendOn = (characterId: number, date: string): boolean =>
  !!db
    .prepare(
      `SELECT 1 FROM scheduled_messages WHERE character_id = ? AND date = ? AND status = 'pending' LIMIT 1`,
    )
    .get(characterId, date);

// 그날 미리 만들어 둔 선톡 문안 전부. 새벽 정리 게시가 스레드에 붙인다.
export const getScheduledSendsOn = (
  characterId: number,
  date: string,
): { window_start: string; window_end: string; text: string; kind: string }[] =>
  db
    .prepare(
      `SELECT window_start, window_end, text, kind FROM scheduled_messages
        WHERE character_id = ? AND date = ? ORDER BY id`,
    )
    .all(characterId, date) as {
    window_start: string;
    window_end: string;
    text: string;
    kind: string;
  }[];

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

// scheduled_messages 밖의 선톡(팔로업·자리비움 예고·틈새 한 줄) 전송 실패 흔적. 종류를 더하면
// db/connection.ts의 send_failures CHECK와 rebuildSendFailures도 같이 고친다. 이 메시지들은 순간에 묶여 있어
// 유예·재시도가 없다 — 대신 실패했다는 사실만은 콘솔이 아니라 DB에 남겨 사후 추적이 되게 한다.
export const recordSendFailure = (
  chatId: string,
  characterId: number,
  kind:
    | "away"
    | "catchup"
    | "goodnight"
    | "mend"
    | "care"
    | "lunch"
    | "glance"
    | "intent",
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

// 오늘 메모는 답장 한 통에 여러 건이 달릴 수 있다(이슈 #399). 컬럼은 그대로 한 칸이고 줄바꿈으로
// 잇는다 — 답을 읽는 자리(reply-signal.ts의 asLines)가 메모 한 건 안의 줄바꿈으로도 이미 나눠
// 담아서, 여기 들어오는 값에는 그 글자가 남지 않는다. 컬럼을 늘리지 않는 덕에 이 판을 올릴 때
// 이미 걸려 있는 행도 그대로 읽힌다 — 옛 판이 줄바꿈째 적어 둔 한 칸은 여러 건으로 갈리는데,
// 그쪽이 지금 규칙대로 적은 모양이라 손해가 없다.
export const encodeNotes = (notes: string[]): string | null =>
  notes.length ? notes.join("\n") : null;

export const decodeNotes = (v: string | null): string[] =>
  v ? v.split("\n").filter(Boolean) : [];

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
  notesToSave: string[];
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
        encodeNotes(p.notesToSave),
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

// 유저가 답을 기다리는 중인가 — 선톡 틱이 이 값을 보고 물러난다. kind='return'과 'promise'는
// 빼고 센다. 'return'은 답할 말이 없는 구간 경계 알림이라, 세면 불가 구간 내내 모든 선톡이
// 멈춰 연속 불가 구간의 다음 예고와 아침·점심 선톡이 발송 창을 놓친다. 'promise'는 캐릭터가
// 먼저 하겠다고 한 연락이라 유저가 답을 기다리는 상태가 아니다.
export const hasWaitingPendingReply = (chatId: string): boolean =>
  !!db
    .prepare(
      `SELECT 1 FROM pending_replies WHERE chat_id = ? AND status = 'waiting' AND kind NOT IN ('return','promise') LIMIT 1`,
    )
    .get(chatId);

/** 이 구간이 끝나는 시각에 울릴 행이 이미 걸려 있는가. 두 종류를 함께 센다 — 한 구간에 행은
 *  하나이고, 유저가 말을 걸면 새로 만드는 대신 promoteWakeRow가 그 행의 종류를 바꾼다.
 *  exceptRowId는 지금 울리고 있는 행이다 — 그 핸들러 안에서 다음 구간의 행을 걸 때는 그 행을
 *  빼고 센다(울린 행은 핸들러가 끝나야 sent로 닫힌다). */
export const hasWaitingWakeRow = (
  chatId: string,
  exceptRowId?: number,
): boolean =>
  !!db
    .prepare(
      `SELECT 1 FROM pending_replies WHERE chat_id = ? AND status = 'waiting' AND kind IN ('wake','return') AND id != ? LIMIT 1`,
    )
    .get(chatId, exceptRowId ?? -1);

/** 연락 약속이 걸려 있는가. 약속 행이 있으면 그 시각에 약속 핸들러가 먼저 말을 걸므로 구간 끝
 *  표시를 따로 걸지 않는다 — 같은 자리에 두 행이 울리면 하나는 헛돈다. */
export const hasWaitingPromiseRow = (chatId: string): boolean =>
  !!db
    .prepare(
      `SELECT 1 FROM pending_replies WHERE chat_id = ? AND status = 'waiting' AND kind = 'promise' LIMIT 1`,
    )
    .get(chatId);

/** 대기 중인 구간 끝 표시 하나. 트레이스가 어느 행의 어느 구간인지 적을 수 있게 활동까지 준다. */
export interface WaitingWakeRow {
  id: number;
  kind: string;
  meta_json: string | null;
}

/** 대기 중인 구간 끝 표시를 돌려준다(없으면 null). exceptId는 지금 울리고 있는 행 — 핸들러가
 *  도는 동안은 아직 waiting이라 스스로를 세지 않게 뺀다. */
export const waitingWakeRow = (
  chatId: string,
  exceptId = 0,
): WaitingWakeRow | null =>
  (db
    .prepare(
      `SELECT id, kind, meta_json FROM pending_replies
         WHERE chat_id = ? AND status = 'waiting' AND kind IN ('wake','return') AND id != ?
         LIMIT 1`,
    )
    .get(chatId, exceptId) as WaitingWakeRow | undefined) ?? null;

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
/** 거둔 깨우기 행 — 트레이스가 어느 구간의 표시를 거뒀는지 meta에서 꺼내 쓴다. */
export interface SupersededWakeRow extends SupersededRow {
  character_id: number;
  meta_json: string | null;
}

export const supersedeWakeRows = (chatId: string): SupersededWakeRow[] => {
  const rows = db
    .prepare(
      `SELECT id, call_id, character_id, meta_json FROM pending_replies WHERE chat_id = ? AND status = 'waiting' AND kind IN ('wake','return')`,
    )
    .all(chatId) as SupersededWakeRow[];
  if (rows.length)
    db.prepare(
      `UPDATE pending_replies SET status = 'superseded' WHERE chat_id = ? AND status = 'waiting' AND kind IN ('wake','return')`,
    ).run(chatId);
  return rows;
};

// 걸어 둔 연락 약속을 거둔다 — 같은 대화에서 새 약속이 생겨 앞 약속을 갈아 끼울 때. 약속은
// 한 대화에 하나만 걸린다(이슈 #308).
/** 거둔 약속 행 — 트레이스가 약속 문장과 그 답장 호출 번호를 meta에서 꺼내 쓴다. */
export interface SupersededPromiseRow extends SupersededRow {
  character_id: number;
  meta_json: string | null;
}

export const supersedePromiseRows = (
  chatId: string,
  exceptId = 0,
): SupersededPromiseRow[] => {
  // exceptId는 지금 울리고 있는 약속 행 — 핸들러가 도는 동안은 아직 waiting이라, 그 행이
  // 스스로 건 새 약속에 거둬지지 않게 뺀다.
  const rows = db
    .prepare(
      `SELECT id, call_id, character_id, meta_json FROM pending_replies WHERE chat_id = ? AND status = 'waiting' AND kind = 'promise' AND id != ?`,
    )
    .all(chatId, exceptId) as SupersededPromiseRow[];
  if (rows.length)
    db.prepare(
      `UPDATE pending_replies SET status = 'superseded' WHERE chat_id = ? AND status = 'waiting' AND kind = 'promise' AND id != ?`,
    ).run(chatId, exceptId);
  return rows;
};

// ── 캐릭터를 끝낼 때 거두는 행 ─────────────────────────────────────────
//
// 발송 틱은 대기 행을 캐릭터 상태와 무관하게 집는다. 캐릭터를 끝내면서 걸린 행을 남겨 두면
// 끝난 캐릭터의 답장과 선톡이 그대로 나가므로, 종료 도구가 상태를 바꾸기 전에 먼저 거둔다.
// 세는 함수는 그 도구가 무엇이 거둬질지 먼저 보여주는 데 쓴다.

export const waitingPendingReplyCount = (characterId: number): number =>
  (
    db
      .prepare(
        `SELECT count(*) c FROM pending_replies WHERE character_id = ? AND status = 'waiting'`,
      )
      .get(characterId) as { c: number }
  ).c;

/** 이 캐릭터로 걸려 있던 대기 행을 종류를 가리지 않고 전부 거둔다. 거둔 행 수를 돌려준다. */
export const supersedeCharacterPendingReplies = (characterId: number): number =>
  db
    .prepare(
      `UPDATE pending_replies SET status = 'superseded' WHERE character_id = ? AND status = 'waiting'`,
    )
    .run(characterId).changes;

export const pendingScheduledSendCount = (characterId: number): number =>
  (
    db
      .prepare(
        `SELECT count(*) c FROM scheduled_messages WHERE character_id = ? AND status = 'pending'`,
      )
      .get(characterId) as { c: number }
  ).c;

/** 아직 안 나간 예약 선톡을 폐기한다. 왜 폐기했는지는 행에 남긴다. */
export const skipCharacterScheduledSends = (
  characterId: number,
  reason: string,
): number =>
  db
    .prepare(
      `UPDATE scheduled_messages SET status = 'skipped', skip_reason = ? WHERE character_id = ? AND status = 'pending'`,
    )
    .run(reason, characterId).changes;

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
