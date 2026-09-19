// 답장에서 한 연락 약속을 거는 연락 행(kind='promise')이 다른 행과 다르게 사는지 검사한다.
//
// 약속 행은 유저가 기다리는 답장이 아니라 캐릭터가 하기로 한 연락이다. 그래서 답장 대기로
// 세지 않고(선톡과 복구가 막히면 안 된다), 유저가 말을 더 보내도 버려지지 않고, 새 약속이
// 오면 앞 약속만 거둔다. 새로 만든 DB에 그 종류가 들어가는지도 여기서 본다.
//
// DB는 임시 파일로 새로 만든다. 모델도 텔레그램도 부르지 않아 값이 안 든다.
import assert from "node:assert/strict";
import { test } from "node:test";
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
  getWaitingOutboxRow,
  hasWaitingReply,
  hasWaitingWakeRow,
  insertOutboxRow,
} = await import("../src/db.js");
const { createFixtureCharacter } = await import(
  "../src/eval/fixture-character.js"
);
const { dropPendingReplies, dropPromiseRows, isWaiting, schedulePromiseRow } =
  await import("../src/pending.js");

const AT = "2026-09-07 13:20:00";
const BLOCK = { activity: "통화", blockStart: "13:00", blockEnd: "14:00" };
const PROMISE = "통화 끝나고 다시 연락";
const characterId = createFixtureCharacter("chat-promise");

let seq = 0;
const insert = (chatId: string, kind: "reply" | "promise"): number => {
  const id = insertOutboxRow({
    kind,
    chatId,
    characterId,
    dedupeKey: `test:${++seq}`,
    sendAt: "2026-09-07 14:00:30",
    payload:
      kind === "promise"
        ? { ...BLOCK, promise: PROMISE, userMsgAt: AT }
        : { userMsgAt: AT, bubbles: [] },
    createdAt: AT,
  });
  assert.ok(id !== null);
  return id;
};

const stateOf = (id: number): { status: string; reason: string | null } =>
  db.prepare(`SELECT status, reason FROM outbox WHERE id = ?`).get(id) as {
    status: string;
    reason: string | null;
  };

test("새로 만든 DB에 약속 행이 들어간다", () => {
  const id = insert("chat-promise", "promise");
  assert.equal(getWaitingOutboxRow(id)?.kind, "promise");
});

test("약속 행은 답장 대기로도 구간 끝 행으로도 세지 않는다", () => {
  const chat = "chat-promise-count";
  insert(chat, "promise");
  assert.equal(hasWaitingReply(chat), false);
  assert.equal(hasWaitingWakeRow(chat), false);
  assert.equal(isWaiting(chat), false);
});

test("유저가 말을 더 보내 답장을 버려도 약속 행은 남는다", () => {
  const chat = "chat-promise-keep";
  const reply = insert(chat, "reply");
  const promise = insert(chat, "promise");
  assert.equal(dropPendingReplies(chat), 1);
  assert.deepEqual(stateOf(reply), {
    status: "dropped",
    reason: "user_followup",
  });
  assert.deepEqual(stateOf(promise), { status: "waiting", reason: null });
});

test("새 약속을 걸 때는 앞 약속만 거두고 답장은 그대로 둔다", () => {
  const chat = "chat-promise-swap";
  const promise = insert(chat, "promise");
  const reply = insert(chat, "reply");
  assert.equal(dropPromiseRows(chat), 1);
  assert.deepEqual(stateOf(promise), {
    status: "dropped",
    reason: "replaced_promise",
  });
  assert.deepEqual(stateOf(reply), { status: "waiting", reason: null });
  assert.equal(dropPromiseRows(chat), 0);
});

test("약속 행을 걸면 약속 문장이 종류별 값에 남고 키는 답장 호출 번호로 정한다", () => {
  const chat = "chat-promise-schedule";
  const armed = schedulePromiseRow({
    chatId: chat,
    characterId,
    userMsgAt: AT,
    waitMs: 60 * 60_000,
    block: BLOCK,
    promise: PROMISE,
    callId: 42,
  });
  assert.ok(armed);
  const row = getWaitingOutboxRow(armed.id);
  assert.equal(row?.kind, "promise");
  assert.equal(row?.send_at, armed.sendAt);
  assert.equal(row?.dedupe_key, "약속:42");
  assert.equal(row?.call_id, 42);
  assert.equal(
    (JSON.parse(row?.payload_json ?? "{}") as { promise?: string }).promise,
    PROMISE,
  );
  // 같은 답장의 약속을 또 걸면 키가 겹쳐 넣지 않는다
  assert.equal(
    schedulePromiseRow({
      chatId: chat,
      characterId,
      userMsgAt: AT,
      waitMs: 60 * 60_000,
      block: BLOCK,
      promise: PROMISE,
      callId: 42,
    }),
    null,
  );
  // 걸어 둔 타이머를 거둬야 검사 프로세스가 끝난다
  assert.equal(dropPromiseRows(chat), 1);
});

test("답장 호출 번호가 없는 약속은 행 번호를 키로 쓴다", () => {
  const chat = "chat-promise-nocall";
  const armed = schedulePromiseRow({
    chatId: chat,
    characterId,
    userMsgAt: AT,
    waitMs: 60 * 60_000,
    block: BLOCK,
    promise: PROMISE,
    callId: null,
  });
  assert.ok(armed);
  assert.equal(getWaitingOutboxRow(armed.id)?.dedupe_key, `row${armed.id}`);
  assert.equal(dropPromiseRows(chat), 1);
});
