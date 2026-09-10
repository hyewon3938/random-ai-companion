// 몰아 답장 표시와 답장이 멈춘 자리가 게시함에 쌓이는지 검사한다 — 모델도 텔레그램도 부르지 않는다.
//
// 불가 구간에 온 메시지는 답장을 만들지 않고 구간 끝에 울릴 표시만 걸어 두는데, 그 표시가
// 걸리고 거둬지고 울린 뒤 답장 없이 끝나는 자리가 전부 콘솔에만 남아 있었다(이슈 #379).
// 여기서는 자리마다 행이 쌓이는지, 같은 행의 같은 자리는 한 번만 쌓이는지, 행 번호를 모르는
// 자리는 블록 단위로 갈리는지, 자정 뒤 표기(24:xx)가 00:xx로 나오는지 본다. 표시를 거두는
// dropWakeRows가 wake·return 행마다 남기고 promise 행은 건드리지 않는 것, 예외로 끝난 자리가
// 대화·단계·분 단위로 갈려 쌓이는 것도 함께 본다.
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
const { traceWake, traceReplyFault } = await import("../src/reply-trace.js");
const { db, insertPendingReply, waitingWakeRow } = await import("../src/db.js");
const { dropWakeRows } = await import("../src/pending.js");
const { kstLogicalDate } = await import("../src/kst.js");
const { createFixtureCharacter } = await import(
  "../src/eval/fixture-character.js"
);

const characterId = createFixtureCharacter("chat-wake-trace");

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
  (
    db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM trace_events`).get() as {
      id: number;
    }
  ).id;

const insertWake = (p: {
  chatId: string;
  kind: "wake" | "return" | "promise";
  activity?: string;
}): number =>
  insertPendingReply({
    chatId: p.chatId,
    characterId,
    userMsgAt: "2026-09-10 21:38:00",
    bubbles: [],
    noteToSave: null,
    sendAt: "2026-09-10 22:05:30",
    kind: p.kind,
    metaJson: JSON.stringify({
      activity: p.activity ?? "차로 퇴근",
      blockStart: "21:40",
      blockEnd: "22:05",
      ...(p.kind === "promise" ? { promise: "집 가서 연락" } : {}),
    }),
    createdAt: "2026-09-10 21:38:00",
  });

test("표시를 건 자리는 행 번호로 갈려 쌓이고 같은 자리는 한 번만 쌓인다", () => {
  const from = lastId();
  const p = {
    characterId,
    rowId: 51,
    stage: "armed" as const,
    activity: "차로 퇴근",
    block: { start: "21:40", end: "22:05" },
    detail: "22:05에 깨어나 쌓인 말에 몰아 답한다",
  };
  traceWake(p);
  traceWake(p);
  const rows = eventsAfter(from);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "wake_armed");
  assert.equal(rows[0].parent_key, null);
  assert.equal(rows[0].dedupe_key, `wake:${characterId}:51:armed`);
  assert.ok(
    rows[0].text.startsWith(":alarm_clock: *몰아 답장* 구간 끝에 울릴 표시를 걺 · "),
  );
  assert.ok(rows[0].text.includes("— 22:05에 깨어나 쌓인 말에 몰아 답한다\n"));
  assert.ok(rows[0].text.includes("21:40~22:05 차로 퇴근"));
});

test("같은 행이라도 자리가 다르면 따로 쌓인다", () => {
  const from = lastId();
  for (const stage of ["merged", "promoted", "yielded", "no_turn"] as const)
    traceWake({ characterId, rowId: 51, stage, activity: "차로 퇴근" });
  assert.deepEqual(
    eventsAfter(from).map((r) => r.kind),
    ["wake_merged", "wake_promoted", "wake_yielded", "wake_no_turn"],
  );
});

test("행 번호를 모르면 오늘 논리일의 블록 시작 시각으로 갈린다", () => {
  const from = lastId();
  traceWake({ characterId, stage: "armed", activity: "회의", block: { start: "14:00" } });
  traceWake({ characterId, stage: "armed", activity: "회의", block: { start: "14:00" } });
  traceWake({ characterId, stage: "armed", activity: "이동", block: { start: "16:00" } });
  const rows = eventsAfter(from);
  assert.deepEqual(
    rows.map((r) => r.dedupe_key),
    [
      `wake:${characterId}:${kstLogicalDate()}:14:00:armed`,
      `wake:${characterId}:${kstLogicalDate()}:16:00:armed`,
    ],
  );
  assert.ok(rows[0].text.includes("14:00 회의"));
});

test("자정 뒤 각본 표기는 벽시계 표기로 바꿔 적고 블록을 모르면 활동만 적는다", () => {
  const from = lastId();
  traceWake({
    characterId,
    rowId: 52,
    stage: "gave_up",
    activity: "잠",
    block: { start: "25:00", end: "26:30" },
    detail: "sendMessage 실패(4회)",
  });
  traceWake({ characterId, rowId: 53, stage: "busy", activity: "하던 일" });
  const rows = eventsAfter(from);
  assert.ok(rows[0].text.includes("01:00~02:30 잠"));
  assert.ok(rows[1].text.endsWith("\n하던 일"));
});

test("표시를 거두면 거둔 행마다 쌓이고 약속 행은 건드리지 않는다", () => {
  const chat = "chat-wake-trace-drop";
  const wake = insertWake({ chatId: chat, kind: "wake" });
  const ret = insertWake({ chatId: chat, kind: "return", activity: "회의" });
  const promise = insertWake({ chatId: chat, kind: "promise" });
  const from = lastId();
  assert.equal(dropWakeRows(chat, "지금 답장이 대신한다"), 2);
  const rows = eventsAfter(from);
  assert.deepEqual(
    rows.map((r) => r.dedupe_key),
    [
      `wake:${characterId}:${wake}:dropped`,
      `wake:${characterId}:${ret}:dropped`,
    ],
  );
  assert.ok(rows[0].kind === "wake_dropped");
  assert.ok(rows[0].text.includes("— 지금 답장이 대신한다\n"));
  assert.ok(rows[1].text.includes("21:40~22:05 회의"));
  assert.equal(
    (
      db.prepare(`SELECT status FROM pending_replies WHERE id = ?`).get(
        promise,
      ) as { status: string }
    ).status,
    "waiting",
  );
  // 거둘 행이 없으면 아무것도 쌓지 않는다
  assert.equal(dropWakeRows(chat), 0);
  assert.equal(eventsAfter(from).length, 2);
});

test("걸려 있는 표시를 행 번호와 함께 돌려주고 울리는 행은 빼고 센다", () => {
  const chat = "chat-wake-trace-waiting";
  assert.equal(waitingWakeRow(chat), null);
  const ret = insertWake({ chatId: chat, kind: "return" });
  const found = waitingWakeRow(chat);
  assert.equal(found?.id, ret);
  assert.equal(found?.kind, "return");
  assert.ok(found?.meta_json?.includes("차로 퇴근"));
  assert.equal(waitingWakeRow(chat, ret), null);
});

test("답장이 멈춘 자리는 대화·단계·분으로 갈려 쌓인다", () => {
  const from = lastId();
  const p = {
    characterId,
    chatId: "chat-fault",
    stage: "respond" as const,
    detail: "TypeError: cannot read x",
  };
  traceReplyFault(p);
  traceReplyFault(p);
  traceReplyFault({ ...p, stage: "recover" });
  traceReplyFault({ ...p, chatId: "chat-fault-2" });
  const rows = eventsAfter(from);
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["reply_fault_respond", "reply_fault_recover", "reply_fault_respond"],
  );
  assert.ok(
    rows[0].text.startsWith(":rotating_light: *답장 멈춤* 답장을 만들다 멈춤 · "),
  );
  assert.ok(rows[0].text.endsWith("\nTypeError: cannot read x"));
  assert.ok(rows[0].dedupe_key?.startsWith("reply_fault:chat-fault:respond:"));
  assert.ok(rows[2].dedupe_key?.startsWith("reply_fault:chat-fault-2:respond:"));
});
