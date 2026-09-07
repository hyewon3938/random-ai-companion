// 연락 약속이 그 뒤 어떻게 됐는지가 게시함에 쌓이는지 검사한다 — 모델도 텔레그램도 부르지 않는다.
//
// 약속을 한 답장의 호출 번호를 받으면 그 답장 스레드에 달리는지, 약속 시각의 문안 호출 번호도
// 받으면 두 스레드에 다 달리는지, 번호가 하나도 없으면 독립 행으로 쌓이는지, 같은 행의 같은
// 단계는 한 번만 쌓이는지 본다. 새 약속이 앞 약속을 거둘 때(pending.ts의 dropPromiseRows)도
// 거둔 행마다 그 답장 스레드에 남는지 함께 본다.
//
// DB는 임시 파일로 새로 만들고 슬랙 토큰은 가짜다 — 게시함에 쌓기까지만 보므로 밖으로
// 나가는 것은 없다.
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
process.env.SLACK_BOT_TOKEN = "test-slack-token";
process.env.SLACK_TRACE_CHANNEL = "C_TEST";

// DB 경로와 슬랙 값을 정한 뒤에 읽어야 임시 파일로 열리고 트레이스가 켜진다.
const { tracePromise } = await import("../src/reply-trace.js");
const { db, insertPendingReply } = await import("../src/db.js");
const { dropPromiseRows } = await import("../src/pending.js");
const { createFixtureCharacter } = await import(
  "../src/eval/fixture-character.js"
);

const characterId = createFixtureCharacter("chat-promise-trace");

interface EventRow {
  kind: string;
  parent_key: string | null;
  dedupe_key: string | null;
  text: string;
}

const eventsAfter = (id: number): EventRow[] =>
  db
    .prepare(
      `SELECT kind, parent_key, dedupe_key, text FROM trace_events WHERE id > ? ORDER BY id`,
    )
    .all(id) as EventRow[];

const lastId = (): number =>
  (db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM trace_events`).get() as {
    id: number;
  }).id;

test("약속을 한 답장의 호출 번호를 받으면 그 답장 스레드에 단다", () => {
  const from = lastId();
  tracePromise({
    characterId,
    rowId: 31,
    stage: "sent",
    promise: "통화 끝나고 다시 연락",
    callId: 410,
    draftCallId: null,
    detail: "문안 #412",
  });
  const rows = eventsAfter(from);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "promise_sent");
  assert.equal(rows[0].parent_key, "call:410");
  assert.equal(rows[0].dedupe_key, "promise:31:sent:410");
  assert.ok(rows[0].text.includes("*약속* 약속대로 먼저 연락함"));
  assert.ok(rows[0].text.includes("— 문안 #412"));
  assert.ok(rows[0].text.includes("> 통화 끝나고 다시 연락"));
});

test("문안 호출 번호도 있으면 답장 스레드와 문안 스레드에 다 단다", () => {
  const from = lastId();
  tracePromise({
    characterId,
    rowId: 32,
    stage: "skipped",
    promise: "저녁 먹고 연락",
    callId: 420,
    draftCallId: 425,
    detail: "모델이 보내지 않기로 했다",
  });
  const rows = eventsAfter(from);
  assert.deepEqual(
    rows.map((r) => r.parent_key),
    ["call:420", "call:425"],
  );
  assert.ok(rows.every((r) => r.kind === "promise_skipped"));
  assert.ok(rows[0].text.includes(":mute: *약속* 약속 연락 접음"));
});

test("호출 번호가 하나도 없으면 독립 행으로 쌓이고, 같은 단계는 한 번만 쌓인다", () => {
  const from = lastId();
  const p = {
    characterId,
    rowId: 33,
    stage: "gave_up" as const,
    promise: "끝나고 연락",
    detail: "sendMessage 실패(4회)",
  };
  tracePromise(p);
  tracePromise(p);
  const rows = eventsAfter(from);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].parent_key, null);
  assert.equal(rows[0].dedupe_key, "promise:33:gave_up");
  assert.ok(rows[0].text.includes(":x: *약속* 약속 연락 포기"));
});

test("새 약속이 앞 약속을 거두면 거둔 행마다 그 답장 스레드에 남는다", () => {
  const chat = "chat-promise-trace-drop";
  const meta = {
    activity: "통화",
    blockStart: "13:00",
    blockEnd: "14:00",
    promise: "통화 끝나고 다시 연락",
    callId: 430,
  };
  const rowId = insertPendingReply({
    chatId: chat,
    characterId,
    userMsgAt: "2026-09-07 13:20:00",
    bubbles: [],
    noteToSave: null,
    sendAt: "2026-09-07 14:00:30",
    kind: "promise",
    metaJson: JSON.stringify(meta),
    createdAt: "2026-09-07 13:20:00",
  });
  const from = lastId();
  assert.equal(dropPromiseRows(chat), 1);
  const rows = eventsAfter(from);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "promise_dropped");
  assert.equal(rows[0].parent_key, "call:430");
  assert.equal(rows[0].dedupe_key, `promise:${rowId}:dropped:430`);
  assert.ok(rows[0].text.startsWith(":wastebasket: *약속* 약속 거둠 · "));
  assert.ok(rows[0].text.includes(" — 새 약속으로 갈아 끼운다\n"));
  assert.ok(rows[0].text.includes("> 통화 끝나고 다시 연락"));
  // 거둘 행이 없으면 아무것도 쌓지 않는다
  assert.equal(dropPromiseRows(chat), 0);
  assert.equal(eventsAfter(from).length, 1);
});

test("지금 울리고 있는 약속 행은 그 핸들러가 새로 거는 약속에 거둬지지 않는다", () => {
  const chat = "chat-promise-trace-except";
  const insert = (): number =>
    insertPendingReply({
      chatId: chat,
      characterId,
      userMsgAt: "2026-09-07 13:20:00",
      bubbles: [],
      noteToSave: null,
      sendAt: "2026-09-07 14:00:30",
      kind: "promise",
      metaJson: JSON.stringify({ promise: "통화 끝나고 연락", callId: 440 }),
      createdAt: "2026-09-07 13:20:00",
    });
  const firing = insert();
  const from = lastId();
  assert.equal(dropPromiseRows(chat, undefined, firing), 0);
  assert.equal(eventsAfter(from).length, 0);
  assert.equal(
    (db.prepare(`SELECT status FROM pending_replies WHERE id = ?`).get(firing) as {
      status: string;
    }).status,
    "waiting",
  );
  // 같은 대화의 다른 약속 행은 그대로 거둔다
  const other = insert();
  assert.equal(dropPromiseRows(chat, undefined, firing), 1);
  assert.equal(eventsAfter(from).length, 1);
  assert.equal(eventsAfter(from)[0].dedupe_key, `promise:${other}:dropped:440`);
});
