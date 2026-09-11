// 대기 중인 답장 행(pending_replies)의 종류별 상태 전이와 발송 실패 기록이 규칙대로 도는지 검사한다.
//
// 종류마다 다른 함수가 거둔다 — 답장(reply·recover)은 유저가 말을 더 걸면, 깨우기(wake·return)는
// 불가 구간 밖 길로 답이 나갈 때, 약속(promise)은 새 약속이 걸릴 때. 서로 남의 종류를 건드리면
// 선톡·붙잡기·약속 논리가 한꺼번에 틀어지므로 함수마다 무엇을 남기는지 못 박는다. 발송 실패는
// 오류 문구 상한과 시도 횟수를 본다.
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
  bumpPendingAttempt,
  getPendingReply,
  getWaitingPendingReplies,
  hasWaitingPendingReply,
  insertPendingReply,
  insertScheduledSend,
  markPendingReply,
  promoteWakeRow,
  recordSendAttempt,
  recordSendFailure,
  supersedePendingReplies,
  supersedePromiseRows,
  supersedeWakeRows,
} = await import("../src/db.js");
const { createFixtureCharacter } =
  await import("../src/eval/fixture-character.js");

const AT = "2026-09-07 13:20:00";
const SEND_AT = "2026-09-07 14:00:30";
const characterId = createFixtureCharacter("chat-sends");

const insert = (
  chatId: string,
  kind: string,
  opts: { sendAt?: string; callId?: number } = {},
): number =>
  insertPendingReply({
    chatId,
    characterId,
    userMsgAt: AT,
    bubbles: ["안녕"],
    notesToSave: [],
    sendAt: opts.sendAt ?? SEND_AT,
    kind,
    callId: opts.callId ?? null,
    createdAt: AT,
  });

interface RawRow {
  status: string;
  kind: string;
  user_msg_at: string;
  attempts: number;
  last_error: string | null;
  sent_at: string | null;
}

const rowOf = (id: number): RawRow =>
  db
    .prepare(
      `SELECT status, kind, user_msg_at, attempts, last_error, sent_at
         FROM pending_replies WHERE id = ?`,
    )
    .get(id) as RawRow;

after(() => db.close());

// ── promoteWakeRow ────────────────────────────────────────────────────────

test("걸려 있던 return 행만 wake로 올리고 그 첫 메시지 시각을 적는다", () => {
  const chat = "chat-promote";
  const ret = insert(chat, "return");
  const reply = insert(chat, "reply");
  const promise = insert(chat, "promise");
  const at = "2026-09-07 13:40:00";
  assert.equal(promoteWakeRow(chat, at), 1);
  assert.equal(rowOf(ret).kind, "wake");
  assert.equal(rowOf(ret).user_msg_at, at);
  assert.equal(rowOf(reply).kind, "reply");
  assert.equal(rowOf(promise).kind, "promise");
});

test("이미 wake인 행은 그대로 두고 먼저 온 메시지 시각을 지킨다", () => {
  const chat = "chat-promote-keep";
  const wake = insert(chat, "wake");
  assert.equal(promoteWakeRow(chat, "2026-09-07 13:50:00"), 0);
  assert.equal(rowOf(wake).kind, "wake");
  assert.equal(rowOf(wake).user_msg_at, AT);
});

test("이미 거둔 return 행은 올리지 않는다", () => {
  const chat = "chat-promote-done";
  const ret = insert(chat, "return");
  markPendingReply(ret, "superseded", null);
  assert.equal(promoteWakeRow(chat, "2026-09-07 13:50:00"), 0);
  assert.equal(rowOf(ret).kind, "return");
});

// ── supersede* ────────────────────────────────────────────────────────────

test("유저가 말을 더 걸면 reply·recover만 버리고 wake·return·promise는 남긴다", () => {
  const chat = "chat-supersede-reply";
  const reply = insert(chat, "reply", { callId: 11 });
  const recover = insert(chat, "recover");
  const wake = insert(chat, "wake");
  const ret = insert(chat, "return");
  const promise = insert(chat, "promise");
  const dropped = supersedePendingReplies(chat);
  assert.deepEqual(
    dropped.map((r) => r.id).sort((a, b) => a - b),
    [reply, recover],
  );
  assert.equal(dropped.find((r) => r.id === reply)?.call_id, 11);
  assert.equal(rowOf(reply).status, "superseded");
  assert.equal(rowOf(recover).status, "superseded");
  assert.equal(rowOf(wake).status, "waiting");
  assert.equal(rowOf(ret).status, "waiting");
  assert.equal(rowOf(promise).status, "waiting");
  assert.deepEqual(supersedePendingReplies(chat), []);
});

test("깨우기 표시를 거둘 때는 wake·return만 버리고 reply·promise는 남긴다", () => {
  const chat = "chat-supersede-wake";
  const wake = insert(chat, "wake");
  const ret = insert(chat, "return");
  const reply = insert(chat, "reply");
  const promise = insert(chat, "promise");
  const dropped = supersedeWakeRows(chat);
  assert.deepEqual(
    dropped.map((r) => r.id).sort((a, b) => a - b),
    [wake, ret],
  );
  assert.equal(rowOf(wake).status, "superseded");
  assert.equal(rowOf(ret).status, "superseded");
  assert.equal(rowOf(reply).status, "waiting");
  assert.equal(rowOf(promise).status, "waiting");
});

test("다른 대화방의 행은 거두지 않는다", () => {
  const mine = insert("chat-supersede-a", "reply");
  const other = insert("chat-supersede-b", "reply");
  assert.equal(supersedePendingReplies("chat-supersede-a").length, 1);
  assert.equal(rowOf(mine).status, "superseded");
  assert.equal(rowOf(other).status, "waiting");
});

test("약속을 거둘 때 지금 울리는 행은 빼고 나머지 약속만 버린다", () => {
  const chat = "chat-supersede-promise";
  const ringing = insert(chat, "promise");
  const older = insert(chat, "promise");
  const reply = insert(chat, "reply");
  const dropped = supersedePromiseRows(chat, ringing);
  assert.deepEqual(
    dropped.map((r) => r.id),
    [older],
  );
  assert.equal(dropped[0]?.character_id, characterId);
  assert.equal(rowOf(ringing).status, "waiting");
  assert.equal(rowOf(older).status, "superseded");
  assert.equal(rowOf(reply).status, "waiting");
});

test("뺄 행을 주지 않으면 대기 중인 약속을 전부 거둔다", () => {
  const chat = "chat-supersede-promise-all";
  const a = insert(chat, "promise");
  const b = insert(chat, "promise");
  assert.equal(supersedePromiseRows(chat).length, 2);
  assert.equal(rowOf(a).status, "superseded");
  assert.equal(rowOf(b).status, "superseded");
  assert.deepEqual(supersedePromiseRows(chat), []);
});

// ── 대기 여부와 목록 ──────────────────────────────────────────────────────

test("return 행만 있으면 답을 기다리는 중으로 세지 않는다", () => {
  const chat = "chat-waiting-return";
  insert(chat, "return");
  assert.equal(hasWaitingPendingReply(chat), false);
});

test("reply 행이 있으면 답을 기다리는 중이다", () => {
  const chat = "chat-waiting-reply";
  const id = insert(chat, "reply");
  assert.equal(hasWaitingPendingReply(chat), true);
  markPendingReply(id, "sent", SEND_AT);
  assert.equal(hasWaitingPendingReply(chat), false);
});

test("대기 목록은 waiting 행만 보낼 시각 순으로 준다", () => {
  const chat = "chat-waiting-list";
  const late = insert(chat, "reply", { sendAt: "2026-09-07 15:00:00" });
  const early = insert(chat, "wake", { sendAt: "2026-09-07 14:10:00" });
  const done = insert(chat, "reply", { sendAt: "2026-09-07 14:00:00" });
  markPendingReply(done, "sent", "2026-09-07 14:00:01");
  const ids = getWaitingPendingReplies()
    .filter((r) => r.chat_id === chat)
    .map((r) => r.id);
  assert.deepEqual(ids, [early, late]);
});

// ── 상태 표시와 실패 기록 ─────────────────────────────────────────────────

test("보낸 표시는 시각을 적고 오류를 안 주면 앞서 적힌 오류를 지우지 않는다", () => {
  const id = insert("chat-mark", "reply");
  bumpPendingAttempt(id, "네트워크 끊김");
  markPendingReply(id, "sent", "2026-09-07 14:00:31");
  const row = rowOf(id);
  assert.equal(row.status, "sent");
  assert.equal(row.sent_at, "2026-09-07 14:00:31");
  assert.equal(row.last_error, "네트워크 끊김");
  assert.equal(getPendingReply(id), null);
});

test("실패 표시에 오류를 주면 그 문구로 바꾼다", () => {
  const id = insert("chat-mark-fail", "reply");
  markPendingReply(id, "failed", null, "발송 포기");
  const row = rowOf(id);
  assert.equal(row.status, "failed");
  assert.equal(row.sent_at, null);
  assert.equal(row.last_error, "발송 포기");
});

test("재시도마다 시도 횟수가 하나씩 오르고 마지막 오류가 남는다", () => {
  const id = insert("chat-bump", "reply");
  assert.equal(rowOf(id).attempts, 0);
  bumpPendingAttempt(id, "첫 실패");
  bumpPendingAttempt(id, "둘째 실패");
  const row = rowOf(id);
  assert.equal(row.attempts, 2);
  assert.equal(row.last_error, "둘째 실패");
  assert.equal(row.status, "waiting");
});

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

test("예약 발송의 실패 기록은 시도 횟수를 올리고 오류 문구를 300자로 자른다", () => {
  const date = "2026-09-08";
  insertScheduledSend(
    characterId,
    "chat-sends",
    date,
    "08:00",
    "09:00",
    "좋은 아침",
    AT,
  );
  const row = db
    .prepare(
      `SELECT id FROM scheduled_messages WHERE character_id = ? AND date = ?`,
    )
    .get(characterId, date) as { id: number };
  recordSendAttempt(row.id, "y".repeat(400));
  recordSendAttempt(row.id, "두 번째");
  const after2 = db
    .prepare(
      `SELECT attempts, last_error, status FROM scheduled_messages WHERE id = ?`,
    )
    .get(row.id) as { attempts: number; last_error: string; status: string };
  assert.equal(after2.attempts, 2);
  assert.equal(after2.last_error, "두 번째");
  assert.equal(after2.status, "pending");
  // 첫 기록이 300자로 잘렸는지는 두 번째로 덮이기 전 값이 필요해 따로 한 번 더 본다.
  recordSendAttempt(row.id, "z".repeat(400));
  const after3 = db
    .prepare(`SELECT last_error FROM scheduled_messages WHERE id = ?`)
    .get(row.id) as { last_error: string };
  assert.equal(after3.last_error.length, 300);
});
