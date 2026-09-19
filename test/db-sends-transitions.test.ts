// 연락 예약 표(outbox)의 넣기·닫기·대기 판정과 발송 실패 기록이 규칙대로 도는지 검사한다.
//
// 고유 제약은 기다리는 행에만 걸린다 — 같은 키의 대기 행은 하나뿐이고, 닫힌 행과 같은 키로는 새
// 행을 넣을 수 있다. 행을 닫는 함수는 대기 행만 바꿔서 먼저 적힌 결과가 남고, 실제로 말이 나간
// 뒤 적는 보냄 표시만 폐기로 먼저 닫힌 행을 덮는다. 종류마다 다른 함수가 거두므로(답장은 유저가
// 말을 더 걸면, 구간 끝은 불가 구간 밖 길로 답이 나갈 때, 약속은 새 약속이 걸릴 때) 서로 남의
// 종류를 건드리지 않는지도 못 박는다. 유저가 답을 기다리는지(isWaiting)는 대기 답장과 첫 발화
// 시각이 적힌 구간 끝 행만 센다(outgoing.md 「구간 끝 행의 종류별 값」).
//
// DB는 임시 파일로 새로 만든다. 모델도 텔레그램도 부르지 않아 값이 안 든다.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

// DB 경로를 정한 뒤에 읽어야 임시 파일로 열린다 — 정적 import는 이 줄들보다 먼저 돈다.
const {
  db,
  bumpOutboxAttempt,
  closeOutboxRow,
  closeWaitingRowsOf,
  getPendingSends,
  getWaitingOutboxRow,
  getWaitingOutboxRows,
  hasPendingSendOn,
  hasScheduledSendOn,
  hasWaitingReply,
  insertOutboxRow,
  insertOutboxRowByRowKey,
  insertScheduledSend,
  markOutboxDelivered,
  markOutboxLocked,
  outboxKey,
  promoteWakeRow,
  recordSendFailure,
  replaceWaitingRow,
} = await import("../src/db.js");
const { createFixtureCharacter } =
  await import("../src/eval/fixture-character.js");

const AT = "2026-09-07 13:20:00";
const SEND_AT = "2026-09-07 14:00:30";
const characterId = createFixtureCharacter("chat-sends");

type Kind = "reply" | "block_end" | "promise";

let seq = 0;
const insert = (
  chatId: string,
  kind: Kind,
  opts: {
    sendAt?: string;
    callId?: number;
    key?: string;
    payload?: object;
  } = {},
): number => {
  const id = insertOutboxRow({
    kind,
    chatId,
    characterId,
    dedupeKey: opts.key ?? `test:${++seq}`,
    sendAt: opts.sendAt ?? SEND_AT,
    payload: opts.payload ?? {},
    callId: opts.callId ?? null,
    createdAt: AT,
  });
  assert.ok(id !== null, "테스트 행이 들어가야 한다");
  return id;
};

interface RawRow {
  status: string;
  reason: string | null;
  detail: string | null;
  kind: string;
  dedupe_key: string;
  payload_json: string;
  attempts: number;
  sent_at: string | null;
  expires_at: string | null;
}

const rowOf = (id: number): RawRow =>
  db
    .prepare(
      `SELECT status, reason, detail, kind, dedupe_key, payload_json, attempts, sent_at, expires_at
         FROM outbox WHERE id = ?`,
    )
    .get(id) as RawRow;

const payloadOf = (id: number): Record<string, unknown> =>
  JSON.parse(rowOf(id).payload_json) as Record<string, unknown>;

after(() => db.close());

// ── 고유 제약 ─────────────────────────────────────────────────────────────

test("같은 대화·종류·키의 대기 행은 하나만 들어간다", () => {
  const chat = "chat-unique";
  const first = insert(chat, "reply", { key: outboxKey.reply(AT) });
  const dup = insertOutboxRow({
    kind: "reply",
    chatId: chat,
    characterId,
    dedupeKey: outboxKey.reply(AT),
    sendAt: SEND_AT,
    payload: {},
    createdAt: AT,
  });
  assert.equal(dup, null);
  // 종류가 다르거나 대화가 다르면 같은 키도 들어간다.
  insert(chat, "promise", { key: outboxKey.reply(AT) });
  insert("chat-unique-other", "reply", { key: outboxKey.reply(AT) });
  assert.equal(rowOf(first).status, "waiting");
});

test("닫힌 행과 같은 키로는 새 대기 행을 넣을 수 있다", () => {
  const chat = "chat-unique-closed";
  const key = outboxKey.blockEnd("14:00");
  const first = insert(chat, "block_end", { key });
  closeOutboxRow(first, "skipped", "already_done", null, null);
  const second = insert(chat, "block_end", { key });
  assert.notEqual(second, first);
  assert.equal(rowOf(second).status, "waiting");
});

test("목록 밖 종류·사유는 넣을 때 던진다", () => {
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO outbox (kind, chat_id, character_id, dedupe_key, send_at, created_at)
         VALUES ('wake', 'chat-check', ?, 'k', ?, ?)`,
      )
      .run(characterId, SEND_AT, AT),
  );
  const id = insert("chat-check", "reply");
  assert.throws(() =>
    closeOutboxRow(id, "skipped", "superseded" as never, null, null),
  );
});

test("키를 지을 값이 없는 행은 row<번호>를 키로 받는다", () => {
  const id = insertOutboxRowByRowKey({
    kind: "promise",
    chatId: "chat-rowkey",
    characterId,
    sendAt: SEND_AT,
    payload: { promise: "끝나고 연락할게" },
    createdAt: AT,
  });
  assert.equal(rowOf(id).dedupe_key, outboxKey.row(id));
});

// ── 닫기 ──────────────────────────────────────────────────────────────────

test("먼저 닫힌 결과가 남는다 — 두 번째 닫기는 아무것도 바꾸지 않는다", () => {
  const id = insert("chat-close-once", "reply");
  assert.equal(
    closeOutboxRow(id, "dropped", "user_followup", "다시 만든다", null),
    true,
  );
  assert.equal(
    closeOutboxRow(id, "failed", "retries_exhausted", "포기", null),
    false,
  );
  const row = rowOf(id);
  assert.equal(row.status, "dropped");
  assert.equal(row.reason, "user_followup");
  assert.equal(row.detail, "다시 만든다");
  assert.equal(getWaitingOutboxRow(id), null);
});

test("닫을 때 상세를 300자로 자르고 덧붙일 칸을 합치며 잠금 표시를 지운다", () => {
  const id = insert("chat-close-patch", "promise", {
    payload: { promise: "저녁에 연락할게", lockSince: AT },
  });
  closeOutboxRow(id, "skipped", "model_declined", "x".repeat(400), null, {
    draftCallId: 77,
  });
  const row = rowOf(id);
  assert.equal(row.detail?.length, 300);
  const p = payloadOf(id);
  assert.equal(p.draftCallId, 77);
  assert.equal(p.promise, "저녁에 연락할게");
  assert.equal("lockSince" in p, false);
});

test("말이 나간 뒤 적는 보냄 표시는 폐기로 먼저 닫힌 행도 덮고 사유를 비운다", () => {
  const id = insert("chat-delivered", "reply");
  closeOutboxRow(id, "dropped", "user_followup", "다시 만든다", null);
  assert.equal(
    markOutboxDelivered(id, "partial", "말풍선 1/2", "2026-09-07 14:00:31"),
    true,
  );
  let row = rowOf(id);
  assert.equal(row.status, "partial");
  assert.equal(row.reason, null);
  assert.equal(row.detail, "말풍선 1/2");
  assert.equal(row.sent_at, "2026-09-07 14:00:31");
  // 이미 보냄으로 닫힌 행은 다시 덮지 않는다.
  assert.equal(
    markOutboxDelivered(id, "sent", null, "2026-09-07 14:05:00"),
    false,
  );
  row = rowOf(id);
  assert.equal(row.status, "partial");
  assert.equal(row.sent_at, "2026-09-07 14:00:31");
});

test("자기 행을 닫고 같은 키로 새 행을 넣는 일을 한 번에 한다", () => {
  const chat = "chat-replace";
  const key = outboxKey.promise(501);
  const own = insert(chat, "promise", { key, callId: 501 });
  const next = replaceWaitingRow(own, "다음 블록 끝으로 다시 건다", () =>
    insert(chat, "promise", { key, callId: 501 }),
  );
  assert.ok(next !== null && next !== own);
  const old = rowOf(own);
  assert.equal(old.status, "skipped");
  assert.equal(old.reason, "rescheduled");
  assert.equal(old.detail, "다음 블록 끝으로 다시 건다");
  assert.equal(rowOf(next).status, "waiting");
});

test("새 행을 못 넣으면 자기 행을 닫은 것까지 되돌린다", () => {
  const own = insert("chat-replace-none", "block_end");
  assert.equal(
    replaceWaitingRow(own, "다시 건다", () => null),
    null,
  );
  const row = rowOf(own);
  assert.equal(row.status, "waiting");
  assert.equal(row.reason, null);
  assert.equal(row.detail, null);
});

test("이미 닫힌 행이면 새 행을 넣지 않는다", () => {
  const own = insert("chat-replace-closed", "promise");
  closeOutboxRow(own, "dropped", "replaced_promise", null, null);
  let called = false;
  assert.equal(
    replaceWaitingRow(own, "다시 건다", () => {
      called = true;
      return 1;
    }),
    null,
  );
  assert.equal(called, false);
  assert.equal(rowOf(own).status, "dropped");
});

// ── 재시도와 잠금 충돌 ────────────────────────────────────────────────────

test("재시도마다 시도 횟수가 하나씩 오르고 마지막 오류가 상세에 남는다", () => {
  const id = insert("chat-bump", "reply");
  assert.equal(rowOf(id).attempts, 0);
  bumpOutboxAttempt(id, "첫 실패");
  bumpOutboxAttempt(id, "y".repeat(400));
  const row = rowOf(id);
  assert.equal(row.attempts, 2);
  assert.equal(row.detail?.length, 300);
  assert.equal(row.status, "waiting");
});

test("잠금 충돌은 시도로 세지 않고 처음 막힌 시각만 남긴다", () => {
  const id = insert("chat-locked", "block_end");
  const t1 = "2026-09-07 14:00:00";
  const t2 = "2026-09-07 14:02:00";
  assert.equal(markOutboxLocked(id, t1, "선톡 자리가 차 있음"), t1);
  assert.equal(markOutboxLocked(id, t2, "선톡 자리가 차 있음"), t1);
  const row = rowOf(id);
  assert.equal(row.attempts, 0);
  assert.equal(row.detail, "선톡 자리가 차 있음");
  assert.equal(payloadOf(id).lockSince, t1);
  // 잠금을 넘어 실제 시도에서 실패하면 충돌이 끊긴 것이라 표시를 지운다.
  bumpOutboxAttempt(id, "네트워크 끊김");
  assert.equal("lockSince" in payloadOf(id), false);
});

// ── 구간 끝 행에 첫 발화 시각 적기 ────────────────────────────────────────

test("걸려 있던 구간 끝 행에 첫 발화 시각을 적고 다른 종류는 건드리지 않는다", () => {
  const chat = "chat-promote";
  const end = insert(chat, "block_end", {
    payload: { activity: "회의", blockStart: "13:00", blockEnd: "15:00" },
  });
  const promise = insert(chat, "promise", { payload: { promise: "p" } });
  const at = "2026-09-07 13:40:00";
  assert.equal(promoteWakeRow(chat, at), 1);
  assert.equal(payloadOf(end).userFirstAt, at);
  assert.equal(payloadOf(end).activity, "회의");
  assert.equal("userFirstAt" in payloadOf(promise), false);
});

test("이미 첫 발화 시각이 적힌 행은 먼저 온 메시지 시각을 지킨다", () => {
  const chat = "chat-promote-keep";
  const end = insert(chat, "block_end", { payload: { userFirstAt: AT } });
  assert.equal(promoteWakeRow(chat, "2026-09-07 13:50:00"), 0);
  assert.equal(payloadOf(end).userFirstAt, AT);
});

test("이미 닫힌 구간 끝 행에는 적지 않는다", () => {
  const chat = "chat-promote-done";
  const end = insert(chat, "block_end");
  closeOutboxRow(end, "dropped", "yielded", null, null);
  assert.equal(promoteWakeRow(chat, "2026-09-07 13:50:00"), 0);
  assert.equal("userFirstAt" in payloadOf(end), false);
});

// ── 종류별로 거두기 ───────────────────────────────────────────────────────

test("한 종류만 거두고 다른 종류와 다른 대화방의 행은 남긴다", () => {
  const chat = "chat-close-kind";
  const reply = insert(chat, "reply", { callId: 11 });
  const end = insert(chat, "block_end");
  const promise = insert(chat, "promise");
  const other = insert("chat-close-kind-b", "reply");
  const closed = closeWaitingRowsOf(
    chat,
    "reply",
    "dropped",
    "user_followup",
    "다시 만든다",
  );
  assert.deepEqual(
    closed.map((r) => r.id),
    [reply],
  );
  assert.equal(closed[0]?.call_id, 11);
  assert.equal(rowOf(reply).status, "dropped");
  assert.equal(rowOf(reply).reason, "user_followup");
  assert.equal(rowOf(end).status, "waiting");
  assert.equal(rowOf(promise).status, "waiting");
  assert.equal(rowOf(other).status, "waiting");
  assert.deepEqual(
    closeWaitingRowsOf(chat, "reply", "dropped", "user_followup", null),
    [],
  );
});

test("지금 울리는 행은 빼고 나머지만 거둔다", () => {
  const chat = "chat-close-except";
  const ringing = insert(chat, "promise");
  const older = insert(chat, "promise");
  const closed = closeWaitingRowsOf(
    chat,
    "promise",
    "dropped",
    "replaced_promise",
    null,
    ringing,
  );
  assert.deepEqual(
    closed.map((r) => r.id),
    [older],
  );
  assert.equal(closed[0]?.character_id, characterId);
  assert.equal(rowOf(ringing).status, "waiting");
});

// ── 대기 판정과 목록 ──────────────────────────────────────────────────────

test("유저가 답을 기다리는지는 대기 답장과 첫 발화가 적힌 구간 끝 행만 센다", () => {
  const onlyEnd = "chat-waiting-end";
  insert(onlyEnd, "block_end");
  assert.equal(hasWaitingReply(onlyEnd), false);
  promoteWakeRow(onlyEnd, AT);
  assert.equal(hasWaitingReply(onlyEnd), true);

  const onlyPromise = "chat-waiting-promise";
  insert(onlyPromise, "promise");
  assert.equal(hasWaitingReply(onlyPromise), false);

  const reply = "chat-waiting-reply";
  const id = insert(reply, "reply");
  assert.equal(hasWaitingReply(reply), true);
  markOutboxDelivered(id, "sent", null, SEND_AT);
  assert.equal(hasWaitingReply(reply), false);
});

test("대기 목록은 대기 행만 보낼 시각 순으로 주고 종류로 거를 수 있다", () => {
  const chat = "chat-waiting-list";
  const late = insert(chat, "reply", { sendAt: "2026-09-07 15:00:00" });
  const early = insert(chat, "block_end", { sendAt: "2026-09-07 14:10:00" });
  const done = insert(chat, "reply", { sendAt: "2026-09-07 14:00:00" });
  markOutboxDelivered(done, "sent", null, "2026-09-07 14:00:01");
  const ids = getWaitingOutboxRows()
    .filter((r) => r.chat_id === chat)
    .map((r) => r.id);
  assert.deepEqual(ids, [early, late]);
  const replies = getWaitingOutboxRows(["reply"])
    .filter((r) => r.chat_id === chat)
    .map((r) => r.id);
  assert.deepEqual(replies, [late]);
});

// ── 아침·안부 문안 ────────────────────────────────────────────────────────

test("아침 문안은 하루 한 통이고 마감을 만료 시각으로 적는다", () => {
  const date = "2026-09-08";
  insertScheduledSend(characterId, "chat-sends", date, "08:00", "09:00", "좋은 아침", AT);
  insertScheduledSend(characterId, "chat-sends", date, "20:00", "21:00", "잘 자", AT, "checkin");
  const rows = getPendingSends(date).filter((r) => r.character_id === characterId);
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.kind, "morning");
  assert.equal(r.window_start, "08:00");
  assert.equal(r.window_end, "09:00");
  assert.equal(r.text, "좋은 아침");
  assert.equal(r.send_at, `${date} 08:00:00`);
  assert.equal(r.dedupe_key, outboxKey.morning(date));
  // 창 끝 + 유예 90분 = 10:30
  assert.equal(r.expires_at, `${date} 10:30:00`);
  assert.equal(hasScheduledSendOn(characterId, date), true);
  assert.equal(hasPendingSendOn(characterId, date), true);
  markOutboxDelivered(r.id, "sent", null, `${date} 08:10:00`);
  assert.equal(hasPendingSendOn(characterId, date), false);
  assert.equal(hasScheduledSendOn(characterId, date), true);
  assert.equal(getPendingSends(date).length, 0);
});

// ── 순간에 묶인 선톡의 실패 기록 ──────────────────────────────────────────

test("순간에 묶인 선톡의 발송 실패는 오류 문구를 300자로 잘라 남긴다", () => {
  const chat = "chat-send-failure";
  recordSendFailure(chat, characterId, "catchup", "x".repeat(400));
  recordSendFailure(chat, characterId, "away", "짧은 오류");
  const rows = db
    .prepare(
      `SELECT kind, error, failed_at FROM send_failures WHERE chat_id = ? ORDER BY id`,
    )
    .all(chat) as { kind: string; error: string; failed_at: string }[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.kind, "catchup");
  assert.equal(rows[0]?.error.length, 300);
  assert.equal(rows[1]?.error, "짧은 오류");
  assert.match(
    rows[1]?.failed_at ?? "",
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
  );
});
