// 연락 예약 표(outbox)와 발송 실패 기록의 저장 함수.
//
// 캐릭터가 보낼 연락 한 건이 outbox의 한 행이다(outgoing.md 「연락 예약 표」, 이슈 #476). 만들어
// 둔 답장(reply), 불가 구간 끝에 울릴 표시(block_end), 연락 약속(promise), 새벽 정리가 준비한
// 아침·안부 문안(morning·checkin)이 같은 표에 들어가고, 종류마다 다른 값은 payload_json에 둔다.
// 캐릭터를 끝낼 때 걸린 행을 거두는 함수도 여기 둔다.
//
// 행을 닫는 함수는 WHERE status = 'waiting'을 조건으로 건다. 핸들러가 도는 사이 다른 경로가
// 같은 행을 먼저 닫았으면 뒤에 온 쪽은 아무것도 바꾸지 않는다 — 먼저 적힌 결과가 남는다. 하나
// 예외는 실제로 말이 나간 뒤 적는 markOutboxDelivered다. 나간 말은 폐기로 먼저 닫힌 행도 덮는다.
//
// 거두거나 걸려 있는 행을 읽는 함수는 행 번호와 payload까지 함께 준다 — 슬랙 게시가 어느 행의
// 어느 구간인지 적어야 밖에서 표시 하나를 따라갈 수 있다(이슈 #379).

import {
  db,
  outboxKey,
  type OutboxKind,
  type OutboxReason,
  type OutboxStatus,
} from "./connection.js";
import { getKstNow, kstDateString, sendDeadline } from "../kst.js";

// ── 행과 종류별 값 ────────────────────────────────────────────────────────

/** outbox 한 행에서 발송 쪽이 읽는 값. 상태·사유·상세는 닫을 때 적기만 하므로 빼 둔다. */
export interface OutboxRow {
  id: number;
  kind: OutboxKind;
  chat_id: string;
  character_id: number;
  dedupe_key: string;
  send_at: string;
  expires_at: string | null;
  payload_json: string;
  /** 이 연락을 만든 모델 호출 번호. 약속 행은 약속을 말한 답장의 호출 번호다. */
  call_id: number | null;
  attempts: number;
  created_at: string;
}

const ROW_COLUMNS = `id, kind, chat_id, character_id, dedupe_key, send_at, expires_at,
  payload_json, call_id, attempts, created_at`;

/** payload의 한 칸을 읽는 SQL 조각. 깨진 행 하나 때문에 조회 전체가 던지지 않게 NULL로 읽는다. */
const field = (path: string): string =>
  `(CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '${path}') END)`;

/** 선톡 잠금이 다른 연락에 잡혀 못 보낸 첫 시각. 두 핸들러 종류가 함께 쓴다. */
interface LockMark {
  lockSince?: string;
}

/** 만들어 둔 답장. 복구 답장도 같은 종류이고 recover로 가른다. */
export interface ReplyPayload {
  /** 답하는 묶음의 마지막 유저 메시지 시각. 키와 복구 표시 비교가 이 값을 쓴다. */
  userMsgAt: string;
  bubbles: string[];
  /** 보낸 뒤 오늘 메모로 옮길 줄. */
  notes?: string[];
  recover?: true;
  /** 답장 신호에서 나온 관계 값(move·told_plan). 발송할 때 대화 기록 행의 meta_json에 옮긴다. */
  replyMeta?: Record<string, unknown>;
}

/** 불가 구간이 끝나는 시각에 울릴 표시. userFirstAt이 있으면 그 구간에 유저가 말을 걸었다. */
export interface BlockEndPayload extends LockMark {
  activity: string;
  blockStart: string;
  blockEnd: string;
  userFirstAt?: string;
  /** 복귀 인사·사이 예고 문안을 만든 호출 번호. 안 보내기로 한 문안도 적는다. */
  draftCallId?: number;
}

/** 캐릭터가 답장에서 한 연락 약속. */
export interface PromisePayload extends LockMark {
  activity: string;
  blockStart: string;
  blockEnd: string;
  promise: string;
  /** 약속을 말한 답장이 답하던 유저 메시지 시각. 약속을 다시 걸 때 그대로 잇는다. */
  userMsgAt: string;
  /** 약속 연락 문안을 만든 호출 번호. 안 보내기로 한 문안도 적는다. */
  draftCallId?: number;
}

/** 새벽 정리가 준비한 아침·안부 문안. */
export interface ScheduledPayload {
  date: string;
  windowStart: string;
  windowEnd: string;
  text: string;
  /** v16 이전 scheduled_messages의 행 번호. 옮겨 온 행만 갖는다. */
  legacyId?: number;
}

/** 행의 종류별 값을 읽는다. 깨졌거나 객체가 아니면 빈 값을 준다 — 읽는 쪽이 칸마다 기본값을 둔다. */
export const parsePayload = <T extends object>(
  row: Pick<OutboxRow, "payload_json">,
): Partial<T> => {
  try {
    const v: unknown = JSON.parse(row.payload_json);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Partial<T>)
      : {};
  } catch {
    return {};
  }
};

// ── 넣고 닫기 ─────────────────────────────────────────────────────────────

/**
 * 행 하나를 넣는다. 같은 대화·종류·키의 대기 행이 이미 있으면 넣지 않고 null을 준다.
 *
 * INSERT OR IGNORE를 쓰지 않고 충돌 대상을 적는 까닭은 CHECK 위반까지 조용히 삼키지 않기
 * 위해서다 — 종류·상태 이름을 잘못 적은 행은 여기서 던져야 바로 드러난다.
 */
export const insertOutboxRow = (p: {
  kind: OutboxKind;
  chatId: string;
  characterId: number;
  dedupeKey: string;
  sendAt: string;
  expiresAt?: string | null;
  payload: object;
  callId?: number | null;
  createdAt: string;
}): number | null => {
  const r = db
    .prepare(
      `INSERT INTO outbox
         (kind, chat_id, character_id, dedupe_key, send_at, expires_at, payload_json, call_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (chat_id, kind, dedupe_key) WHERE status = 'waiting' DO NOTHING`,
    )
    .run(
      p.kind,
      p.chatId,
      p.characterId,
      p.dedupeKey,
      p.sendAt,
      p.expiresAt ?? null,
      JSON.stringify(p.payload),
      p.callId ?? null,
      p.createdAt,
    );
  return r.changes ? Number(r.lastInsertRowid) : null;
};

/**
 * 키를 지을 값이 없는 행을 넣는다. 번호가 정해져야 키(row<번호>)를 지을 수 있어서, 겹치지 않는
 * 임시 키로 넣고 같은 트랜잭션 안에서 바꾼다.
 */
export const insertOutboxRowByRowKey = (
  p: Omit<Parameters<typeof insertOutboxRow>[0], "dedupeKey">,
): number =>
  db.transaction((): number => {
    const id = insertOutboxRow({
      ...p,
      dedupeKey: `row-pending:${p.createdAt}:${Math.random()}`,
    });
    if (id === null) throw new Error("[outbox] 임시 키가 겹쳤다");
    db.prepare(`UPDATE outbox SET dedupe_key = ? WHERE id = ?`).run(
      outboxKey.row(id),
      id,
    );
    return id;
  })();

/**
 * 대기 행 하나를 닫는다. 이미 닫힌 행이면 아무것도 바꾸지 않고 false를 준다.
 *
 * patch는 종류별 값에 덧붙일 칸이다(약속 문안의 호출 번호 같은 것). 선톡 잠금 표시는 닫을 때
 * 지운다 — 끝난 행에 남아 있으면 읽는 쪽이 아직 잠금을 기다리는 행으로 오해한다.
 */
export const closeOutboxRow = (
  id: number,
  status: Exclude<OutboxStatus, "waiting">,
  reason: OutboxReason | null,
  detail: string | null,
  sentAt: string | null,
  patch?: Record<string, unknown>,
): boolean =>
  db
    .prepare(
      `UPDATE outbox
          SET status = ?, reason = ?, detail = ?, sent_at = ?,
              payload_json = CASE WHEN json_valid(payload_json)
                THEN json_remove(json_patch(payload_json, ?), '$.lockSince')
                ELSE payload_json END
        WHERE id = ? AND status = 'waiting'`,
    )
    .run(
      status,
      reason,
      detail === null ? null : detail.slice(0, 300),
      sentAt,
      JSON.stringify(patch ?? {}),
      id,
    ).changes > 0;

/**
 * 실제로 나간 연락을 보냄·부분 발송으로 닫는다. 바뀌었으면 true.
 *
 * closeOutboxRow와 달리 대기가 아닌 행도 덮는다 — 말풍선이 나가는 사이 유저가 말을 더 보내거나
 * 캐릭터를 끝내는 도구가 행을 폐기로 먼저 닫을 수 있는데, 말이 이미 나갔으면 그 사실이 남아야
 * 한다. 이미 보냄·부분 발송으로 닫힌 행만 그대로 둔다. 사유는 비운다 — 폐기로 먼저 닫혔던
 * 사유는 이제 맞지 않는다.
 */
export const markOutboxDelivered = (
  id: number,
  status: "sent" | "partial",
  detail: string | null,
  sentAt: string,
  patch?: Record<string, unknown>,
): boolean =>
  db
    .prepare(
      `UPDATE outbox
          SET status = ?, reason = NULL, detail = ?, sent_at = ?,
              payload_json = CASE WHEN json_valid(payload_json)
                THEN json_remove(json_patch(payload_json, ?), '$.lockSince')
                ELSE payload_json END
        WHERE id = ? AND status NOT IN ('sent', 'partial')`,
    )
    .run(
      status,
      detail === null ? null : detail.slice(0, 300),
      sentAt,
      JSON.stringify(patch ?? {}),
      id,
    ).changes > 0;

class NothingInserted extends Error {}

/**
 * 자기 행을 닫고 그 자리를 이을 새 행을 넣는 일을 한 트랜잭션으로 묶는다. 약속을 다음 블록으로
 * 다시 잡거나 구간 끝 표시를 다음 구간에 다시 거는 핸들러가 쓴다.
 *
 * 고유 제약이 대기 행에만 걸려 있어서, 자기 행을 먼저 닫아야 같은 키로 새 행을 넣을 수 있다.
 * insert가 null을 주면(걸 자리가 없거나 같은 키의 대기 행이 이미 있으면) 닫은 것까지 되돌리고
 * null을 준다 — 자기 행은 대기로 남고, 어떻게 닫을지는 부른 쪽이 정한다.
 */
export const replaceWaitingRow = <T>(
  id: number,
  detail: string | null,
  insert: () => T | null,
): T | null => {
  try {
    return db.transaction((): T => {
      if (!closeOutboxRow(id, "skipped", "rescheduled", detail, null))
        throw new NothingInserted();
      const next = insert();
      if (next === null) throw new NothingInserted();
      return next;
    })();
  } catch (e) {
    if (e instanceof NothingInserted) return null;
    throw e;
  }
};

/** 재시도할 실패를 적는다. 선톡 잠금 표시도 지운다 — 잠금은 넘어섰으니 충돌이 끊긴 것이다. */
export const bumpOutboxAttempt = (id: number, detail: string): void => {
  db.prepare(
    `UPDATE outbox
        SET attempts = attempts + 1, detail = ?,
            payload_json = CASE WHEN json_valid(payload_json)
              THEN json_remove(payload_json, '$.lockSince') ELSE payload_json END
      WHERE id = ? AND status = 'waiting'`,
  ).run(detail.slice(0, 300), id);
};

/**
 * 선톡 잠금에 막혀 못 보낸 것을 적는다. 시도 횟수는 올리지 않고, 처음 막힌 시각만 남긴다 —
 * 이미 적혀 있으면 그대로 둬서 충돌이 얼마나 이어졌는지 잰다. 적힌 첫 시각을 돌려준다.
 */
export const markOutboxLocked = (
  id: number,
  now: string,
  detail: string,
): string => {
  db.prepare(
    `UPDATE outbox
        SET detail = ?,
            payload_json = CASE
              WHEN json_valid(payload_json) AND ${field("$.lockSince")} IS NULL
                THEN json_set(payload_json, '$.lockSince', ?)
              ELSE payload_json END
      WHERE id = ? AND status = 'waiting'`,
  ).run(detail.slice(0, 300), now, id);
  const row = db
    .prepare(
      `SELECT ${field("$.lockSince")} AS since FROM outbox WHERE id = ?`,
    )
    .get(id) as { since: string | null } | undefined;
  return row?.since ?? now;
};

// ── 읽기 ──────────────────────────────────────────────────────────────────

/** 기다리는 행 전부를 보낼 시각 순으로. kinds를 주면 그 종류만. */
export const getWaitingOutboxRows = (kinds?: OutboxKind[]): OutboxRow[] => {
  const rows = db
    .prepare(
      `SELECT ${ROW_COLUMNS} FROM outbox WHERE status = 'waiting' ORDER BY send_at, id`,
    )
    .all() as OutboxRow[];
  return kinds ? rows.filter((r) => kinds.includes(r.kind)) : rows;
};

/** 걸어 둔 행 하나를 지금 값으로 다시 읽는다. 대기 행이 아니면 null — 거둔 행은 울리지 않는다. */
export const getWaitingOutboxRow = (id: number): OutboxRow | null =>
  (db
    .prepare(
      `SELECT ${ROW_COLUMNS} FROM outbox WHERE id = ? AND status = 'waiting'`,
    )
    .get(id) as OutboxRow | undefined) ?? null;

/**
 * 한 대화의 한 종류 대기 행을 전부 닫고, 닫은 행을 준다. exceptId는 지금 울리고 있는 행이다 —
 * 핸들러가 도는 동안은 아직 대기라 스스로를 닫지 않게 뺀다.
 */
export const closeWaitingRowsOf = (
  chatId: string,
  kind: OutboxKind,
  status: "dropped" | "skipped",
  reason: OutboxReason,
  detail: string | null,
  exceptId = 0,
): OutboxRow[] =>
  db.transaction((): OutboxRow[] => {
    const rows = db
      .prepare(
        `SELECT ${ROW_COLUMNS} FROM outbox
          WHERE chat_id = ? AND kind = ? AND status = 'waiting' AND id != ?`,
      )
      .all(chatId, kind, exceptId) as OutboxRow[];
    return rows.filter((r) =>
      closeOutboxRow(r.id, status, reason, detail, null),
    );
  })();

// ── 대기 판정 ─────────────────────────────────────────────────────────────

/**
 * 유저가 답을 기다리는 중인가 — 선톡 틱이 이 값을 보고 물러난다(outgoing.md 「구간 끝 행의
 * 종류별 값」). 대기 답장과, 유저 첫 발화 시각이 있는 구간 끝 행만 센다. 첫 발화가 없는 구간 끝
 * 행은 답할 말이 없는 경계 알림이라, 세면 불가 구간 내내 모든 선톡이 멈춰 연속 불가 구간의 다음
 * 예고와 아침·점심 선톡이 발송 창을 놓친다. 약속은 캐릭터가 먼저 하겠다고 한 연락이라 유저가
 * 답을 기다리는 상태가 아니다.
 */
export const hasWaitingReply = (chatId: string): boolean =>
  !!db
    .prepare(
      `SELECT 1 FROM outbox
        WHERE chat_id = ? AND status = 'waiting'
          AND (kind = 'reply'
               OR (kind = 'block_end' AND ${field("$.userFirstAt")} IS NOT NULL))
        LIMIT 1`,
    )
    .get(chatId);

/** 이 구간이 끝나는 시각에 울릴 행이 이미 걸려 있는가. 한 구간에 행은 하나이고, 유저가 말을
 *  걸면 새로 만드는 대신 promoteWakeRow가 그 행에 첫 발화 시각을 적는다.
 *  exceptRowId는 지금 울리고 있는 행이다 — 그 핸들러 안에서 다음 구간의 행을 걸 때는 그 행을
 *  빼고 센다(울린 행은 핸들러가 끝나야 닫힌다). */
export const hasWaitingWakeRow = (
  chatId: string,
  exceptRowId?: number,
): boolean =>
  !!db
    .prepare(
      `SELECT 1 FROM outbox WHERE chat_id = ? AND status = 'waiting' AND kind = 'block_end' AND id != ? LIMIT 1`,
    )
    .get(chatId, exceptRowId ?? -1);

/** 연락 약속이 걸려 있는가. 약속 행이 있으면 그 시각에 약속 핸들러가 먼저 말을 걸므로 구간 끝
 *  표시를 따로 걸지 않는다 — 같은 자리에 두 행이 울리면 하나는 헛돈다. */
export const hasWaitingPromiseRow = (chatId: string): boolean =>
  !!db
    .prepare(
      `SELECT 1 FROM outbox WHERE chat_id = ? AND status = 'waiting' AND kind = 'promise' LIMIT 1`,
    )
    .get(chatId);

/** 대기 중인 구간 끝 표시를 돌려준다(없으면 null). exceptId는 지금 울리고 있는 행 — 핸들러가
 *  도는 동안은 아직 대기라 스스로를 세지 않게 뺀다. */
export const waitingWakeRow = (chatId: string, exceptId = 0): OutboxRow | null =>
  (db
    .prepare(
      `SELECT ${ROW_COLUMNS} FROM outbox
         WHERE chat_id = ? AND status = 'waiting' AND kind = 'block_end' AND id != ?
         LIMIT 1`,
    )
    .get(chatId, exceptId) as OutboxRow | undefined) ?? null;

/** 걸려 있던 구간 끝 행에 유저 첫 발화 시각을 적는다 — 그 구간에 유저가 말을 걸어 답할 말이
 *  생겼다. 기다린 시간을 재는 기준이 된다. 이미 적힌 행은 그대로 둔다(먼저 온 메시지가
 *  기준이다). 바꾼 행 수를 돌려준다. */
export const promoteWakeRow = (chatId: string, userMsgAt: string): number =>
  db
    .prepare(
      `UPDATE outbox SET payload_json = json_set(payload_json, '$.userFirstAt', ?)
         WHERE chat_id = ? AND status = 'waiting' AND kind = 'block_end'
           AND json_valid(payload_json) AND ${field("$.userFirstAt")} IS NULL`,
    )
    .run(userMsgAt, chatId).changes;

// ── 아침·안부 문안 ────────────────────────────────────────────────────────
// 새벽 정리가 근거 있을 때만 하루 1통 문안을 준비해 두고, 디스패처가 창 안에서 발송한다.

const SCHEDULED_KINDS = `kind IN ('morning','checkin')`;

/** 문안 행을 넣는다. 그날 이미 준비한 문안이 있으면 상태와 무관하게 넣지 않는다(하루 1통). */
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
  if (hasScheduledSendOn(characterId, date)) return; // 하루 1통
  const payload: ScheduledPayload = { date, windowStart, windowEnd, text };
  insertOutboxRow({
    kind,
    chatId,
    characterId,
    dedupeKey:
      kind === "checkin" ? outboxKey.checkin(date) : outboxKey.morning(date),
    sendAt: `${date} ${windowStart}:00`,
    expiresAt: `${date} ${sendDeadline(windowStart, windowEnd)}:00`,
    payload,
    createdAt: now,
  });
};

export const hasScheduledSendOn = (
  characterId: number,
  date: string,
): boolean =>
  !!db
    .prepare(
      `SELECT 1 FROM outbox
        WHERE character_id = ? AND ${SCHEDULED_KINDS}
          AND ${field("$.date")} = ? LIMIT 1`,
    )
    .get(characterId, date);

/** 오늘 준비해 둔 선톡이 아직 안 나갔는가 — 낮 근황 선톡이 이 값을 보고 기다린다. 어제
 *  대화가 끊긴 채 아침을 맞으면 근황의 네 시간 침묵 조건이 아침 문안의 발송 창보다 먼저
 *  차서, 이 검사가 없으면 아침 인사보다 근황이 앞질러 나간다(이슈 #314). */
export const hasPendingSendOn = (characterId: number, date: string): boolean =>
  !!db
    .prepare(
      `SELECT 1 FROM outbox
        WHERE character_id = ? AND ${SCHEDULED_KINDS} AND status = 'waiting'
          AND ${field("$.date")} = ? LIMIT 1`,
    )
    .get(characterId, date);

// 그날 미리 만들어 둔 선톡 문안 전부. 새벽 정리 게시가 스레드에 붙인다.
export const getScheduledSendsOn = (
  characterId: number,
  date: string,
): { window_start: string; window_end: string; text: string; kind: string }[] =>
  (
    db
      .prepare(
        `SELECT kind, payload_json FROM outbox
          WHERE character_id = ? AND ${SCHEDULED_KINDS}
            AND ${field("$.date")} = ? ORDER BY id`,
      )
      .all(characterId, date) as { kind: string; payload_json: string }[]
  ).map((r) => {
    const p = parsePayload<ScheduledPayload>(r);
    return {
      window_start: p.windowStart ?? "",
      window_end: p.windowEnd ?? "",
      text: p.text ?? "",
      kind: r.kind,
    };
  });

/** 디스패처가 보는 그날의 대기 문안. 창·문안은 payload에서 꺼내 행 옆에 둔다. */
export interface ScheduledSendRow extends OutboxRow {
  kind: "morning" | "checkin";
  date: string;
  window_start: string;
  window_end: string;
  text: string;
}

export const getPendingSends = (date: string): ScheduledSendRow[] =>
  (
    db
      .prepare(
        `SELECT ${ROW_COLUMNS} FROM outbox
          WHERE status = 'waiting' AND ${SCHEDULED_KINDS}
            AND ${field("$.date")} = ? ORDER BY send_at, id`,
      )
      .all(date) as OutboxRow[]
  ).map((r) => {
    const p = parsePayload<ScheduledPayload>(r);
    return {
      ...r,
      kind: r.kind === "checkin" ? "checkin" : "morning",
      date,
      window_start: p.windowStart ?? r.send_at.slice(11, 16),
      window_end: p.windowEnd ?? p.windowStart ?? r.send_at.slice(11, 16),
      text: p.text ?? "",
    };
  });

// ── 발송 실패 기록 ────────────────────────────────────────────────────────

// outbox 밖의 선톡(팔로업·자리비움 예고·틈새 한 줄) 전송 실패 흔적. 종류를 더하면
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

// ── 캐릭터를 끝낼 때 거두는 행 ─────────────────────────────────────────
//
// 발송 틱은 대기 행을 캐릭터 상태와 무관하게 집는다. 캐릭터를 끝내면서 걸린 행을 남겨 두면
// 끝난 캐릭터의 답장과 선톡이 그대로 나가므로, 종료 도구가 상태를 바꾸기 전에 먼저 거둔다.
// 세는 함수는 그 도구가 무엇이 거둬질지 먼저 보여주는 데 쓴다. 답장 쪽(답장·구간 끝·약속)과
// 예약 문안 쪽(아침·안부)을 나눠 센다.

/** 이 캐릭터로 걸려 있는 대기 행 수. 답장 쪽과 예약 문안 쪽을 나눠 준다. */
export const waitingOutboxCounts = (
  characterId: number,
): { replies: number; scheduled: number } => {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN ${SCHEDULED_KINDS} THEN 0 ELSE 1 END), 0) AS replies,
         COALESCE(SUM(CASE WHEN ${SCHEDULED_KINDS} THEN 1 ELSE 0 END), 0) AS scheduled
         FROM outbox WHERE character_id = ? AND status = 'waiting'`,
    )
    .get(characterId) as { replies: number; scheduled: number };
  return { replies: row.replies, scheduled: row.scheduled };
};

/** 이 캐릭터로 걸려 있던 대기 행을 종류를 가리지 않고 전부 폐기한다. 거둔 수를 쪽마다 준다. */
export const dropCharacterOutbox = (
  characterId: number,
): { replies: number; scheduled: number } =>
  db.transaction(() => {
    const counts = waitingOutboxCounts(characterId);
    db.prepare(
      `UPDATE outbox SET status = 'dropped', reason = 'character_ended'
        WHERE character_id = ? AND status = 'waiting'`,
    ).run(characterId);
    return counts;
  })();
