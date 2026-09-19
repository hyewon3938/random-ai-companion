// 두 대기 표가 있던 v15 DB가 v16의 연락 행 표(outbox)로 올라가는 자리를 검사한다(#476).
//
// v16은 pending_replies·scheduled_messages를 *_legacy로 이름만 바꿔 남기고, 기다리던 행만
// outbox로 옮긴다. 봐야 할 것은 다섯이다.
//   - 옮기는 행의 범위: 대기 행만 옮기고, 보낸 행·거둔 행·실패한 행은 옛 표에만 남는다.
//   - 종류와 키: 답장·복구는 reply, 깨우기·복귀는 block_end, 약속은 promise, 예약 문안은
//     morning·checkin으로 가고, 키를 만들 값이 없거나 같은 키가 이미 기다리면 row<번호> 키를 받는다.
//   - 번호: 답장 쪽 행은 옛 번호를 그대로 쓴다(트레이스 키·피드백이 그 번호로 행을 찾는다).
//     새 번호는 두 옛 표에서 쓴 가장 큰 번호 뒤에서 시작한다.
//   - 대기 판정: isWaiting은 답장 행과 유저 첫 발화 시각이 있는 구간 끝 행만 센다.
//   - 이어받기: 기동하면 옮긴 행이 다시 걸려 울리고, 새벽 정리와 다음 아침이 새 표로 돈다.
//
// DB는 임시 파일로 새로 만들고, v15 모양은 이 파일이 손으로 세운다. 나머지 표는 기동할 때
// createSchema가 만든다. 발송과 핸들러는 가짜로 등록해 모델도 텔레그램도 부르지 않는다.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const DB_PATH = join(mkdtempSync(join(tmpdir(), "companion-test-")), "test.db");
process.env.DB_PATH = DB_PATH;
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

// v15 시절의 두 대기 표와 그 표가 가리키는 characters를 손으로 세운다. 두 표의 정의는
// connection.ts의 LEGACY_TABLES와 같다.
const seed = new Database(DB_PATH);
seed.exec(`
  CREATE TABLE characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
    genesis_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE pending_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    character_id INTEGER NOT NULL REFERENCES characters(id),
    user_msg_at TEXT NOT NULL,
    bubbles_json TEXT NOT NULL,
    note_to_save TEXT,
    send_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'reply' CHECK (kind IN ('reply','recover','wake','return','promise')),
    meta_json TEXT,
    call_id INTEGER,
    status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','sent','superseded','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT
  );
  CREATE TABLE scheduled_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER NOT NULL REFERENCES characters(id),
    chat_id TEXT NOT NULL,
    date TEXT NOT NULL,
    window_start TEXT NOT NULL,
    window_end TEXT NOT NULL,
    text TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'morning' CHECK (kind IN ('morning','checkin')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','skipped')),
    skip_reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT
  );
`);
const addCharacter = seed.prepare(
  `INSERT INTO characters (id, chat_id, status, genesis_json, created_at)
   VALUES (?, ?, 'active', '{}', '2026-09-01 10:00:00')`,
);
// 대화방마다 캐릭터 하나. 대기 판정을 방마다 따로 본다.
//   chat-1: 답장·복구 / chat-2: 깨우기 / chat-3: 복귀만 / chat-4: 약속만
for (const n of [1, 2, 3, 4]) addCharacter.run(n, `chat-${n}`);

// 기다리는 행은 전부 보낼 시각이 지나 있다 — 마지막 테스트에서 이어받자마자 울리게.
const DUE = "2026-09-19 10:30:00";
const addPending = seed.prepare(
  `INSERT INTO pending_replies
     (id, chat_id, character_id, user_msg_at, bubbles_json, note_to_save, send_at,
      kind, meta_json, call_id, status, attempts, last_error, created_at)
   VALUES (@id, @chat, @char, @at, @bubbles, @note, @sendAt,
      @kind, @meta, @callId, @status, @attempts, @error, '2026-09-19 10:00:00')`,
);
const pending = (p: {
  id: number;
  chat: number;
  kind: string;
  at: string;
  status?: string;
  bubbles?: string[];
  note?: string | null;
  meta?: Record<string, unknown> | null;
  callId?: number | null;
  attempts?: number;
  error?: string | null;
}): void => {
  addPending.run({
    id: p.id,
    chat: `chat-${p.chat}`,
    char: p.chat,
    at: p.at,
    bubbles: JSON.stringify(p.bubbles ?? []),
    note: p.note ?? null,
    sendAt: DUE,
    kind: p.kind,
    meta: p.meta ? JSON.stringify(p.meta) : null,
    callId: p.callId ?? null,
    status: p.status ?? "waiting",
    attempts: p.attempts ?? 0,
    error: p.error ?? null,
  });
};

// chat-1 — 보낸 답장과 실패한 답장은 옮기지 않는다.
pending({ id: 1, chat: 1, kind: "reply", at: "2026-09-19 09:00:00", status: "sent", bubbles: ["보냄"] });
pending({ id: 2, chat: 1, kind: "reply", at: "2026-09-19 09:10:00", status: "failed", bubbles: ["실패"] });
pending({
  id: 3,
  chat: 1,
  kind: "reply",
  at: "2026-09-19 10:00:00",
  bubbles: ["안녕", "뭐 해"],
  note: "점심은 김밥\n저녁 약속 있음",
  meta: { move: "tease" },
  callId: 70,
  attempts: 1,
  error: "network",
});
pending({ id: 5, chat: 1, kind: "recover", at: "2026-09-19 10:05:00", bubbles: ["늦었지"] });
// 같은 유저 메시지에 걸린 두 번째 대기 답장 — 키가 겹쳐 row<번호>로 간다.
pending({ id: 6, chat: 1, kind: "reply", at: "2026-09-19 10:00:00", bubbles: ["겹침"] });
// chat-2 — 깨우기 표시 둘. 하나는 구간 시작이 없어 키를 못 만든다. 거둔 행은 옮기지 않는다.
pending({
  id: 7,
  chat: 2,
  kind: "wake",
  at: "2026-09-19 10:20:00",
  meta: { activity: "회의", blockStart: "10:00", blockEnd: "11:00" },
});
pending({ id: 8, chat: 2, kind: "wake", at: "2026-09-19 10:25:00", meta: null });
pending({
  id: 12,
  chat: 2,
  kind: "wake",
  at: "2026-09-19 08:00:00",
  status: "superseded",
  meta: { activity: "출근", blockStart: "08:00", blockEnd: "09:00" },
});
// chat-3 — 복귀 표시. 유저가 아직 말을 걸지 않았다.
pending({
  id: 9,
  chat: 3,
  kind: "return",
  at: "2026-09-19 13:50:00",
  meta: { activity: "수업", blockStart: "14:00", blockEnd: "15:30" },
});
// chat-4 — 약속 둘. 하나는 약속한 답장의 호출 번호가 없다.
pending({
  id: 10,
  chat: 4,
  kind: "promise",
  at: "2026-09-19 10:10:00",
  meta: {
    activity: "회의",
    blockStart: "10:00",
    blockEnd: "11:00",
    promise: "회의 끝나고 연락할게",
    callId: 42,
  },
});
pending({
  id: 11,
  chat: 4,
  kind: "promise",
  at: "2026-09-19 10:12:00",
  meta: { activity: "회의", blockStart: "10:00", blockEnd: "11:00", promise: "이따 봐" },
});
// 가장 큰 번호는 보낸 행이다. 새 번호가 이 뒤에서 시작해야 한다.
pending({ id: 20, chat: 1, kind: "reply", at: "2026-09-18 22:00:00", status: "sent", bubbles: ["어제"] });

const addScheduled = seed.prepare(
  `INSERT INTO scheduled_messages
     (id, character_id, chat_id, date, window_start, window_end, text, kind, status,
      attempts, last_error, created_at)
   VALUES (?, 1, 'chat-1', ?, ?, ?, ?, ?, ?, ?, ?, '2026-09-20 04:00:00')`,
);
addScheduled.run(21, "2026-09-20", "07:10", "07:40", "잘 잤어?", "morning", "pending", 1, "timeout");
addScheduled.run(22, "2026-09-20", "15:00", "15:30", "오후 잘 보내고 있어?", "checkin", "pending", 0, null);
addScheduled.run(23, "2026-09-19", "07:00", "07:30", "어제 아침", "morning", "sent", 0, null);
addScheduled.run(24, "2026-09-18", "07:00", "07:30", "그제 아침", "morning", "skipped", 0, null);
// 같은 날 두 번째 아침 문안 — 키가 겹쳐 row<번호>로 간다.
addScheduled.run(25, "2026-09-20", "08:00", "08:30", "두 번째 아침", "morning", "pending", 0, null);
// 오래된 행을 지운 뒤라 이 표의 번호 카운터는 가장 큰 행 번호보다 앞서 있다.
seed.prepare(`UPDATE sqlite_sequence SET seq = 40 WHERE name = 'scheduled_messages'`).run();
seed.pragma("user_version = 15");
seed.close();

// DB 경로를 정하고 v15 모양을 세운 뒤에 읽어야 이 파일이 열린다 — 읽는 순간 마이그레이션이 돈다.
const { db, getPendingSends, getScheduledSendsOn, hasScheduledSendOn, insertScheduledSend } =
  await import("../src/db.js");
const {
  isWaiting,
  resumePendingReplies,
  setPendingSender,
  setPromiseHandler,
  setWakeHandler,
} = await import("../src/pending.js");

after(() => db.close());

interface Row {
  id: number;
  kind: string;
  chat_id: string;
  character_id: number;
  dedupe_key: string;
  send_at: string;
  expires_at: string | null;
  payload_json: string;
  call_id: number | null;
  status: string;
  reason: string | null;
  detail: string | null;
  attempts: number;
  created_at: string;
}

const outbox = (): Row[] =>
  db.prepare(`SELECT * FROM outbox ORDER BY id`).all() as Row[];
const rowOf = (id: number): Row => {
  const r = db.prepare(`SELECT * FROM outbox WHERE id = ?`).get(id) as Row | undefined;
  assert.ok(r, `outbox #${id}이 없다`);
  return r;
};
const payloadOf = (id: number): Record<string, unknown> =>
  JSON.parse(rowOf(id).payload_json) as Record<string, unknown>;
const tableExists = (name: string): boolean =>
  !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);

test("v15 DB가 v16으로 올라가고 옛 두 표는 _legacy로 남는다", () => {
  assert.equal(db.pragma("user_version", { simple: true }), 16);
  assert.equal(tableExists("pending_replies"), false);
  assert.equal(tableExists("scheduled_messages"), false);
  // 옛 표는 옮기지 않은 행까지 전부 그대로다.
  const count = (t: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  assert.equal(count("pending_replies_legacy"), 12);
  assert.equal(count("scheduled_messages_legacy"), 5);
});

test("대기 행만 옮긴다 — 답장 쪽 8건, 예약 문안 3건", () => {
  const rows = outbox();
  assert.equal(rows.length, 11);
  assert.ok(rows.every((r) => r.status === "waiting"));
  // 답장 쪽은 옛 번호를 그대로 쓴다. 보낸 행(1·20)·실패 행(2)·거둔 행(12)은 없다.
  assert.deepEqual(
    rows.filter((r) => r.id <= 40).map((r) => r.id),
    [3, 5, 6, 7, 8, 9, 10, 11],
  );
});

test("답장과 복구는 reply로 가고, 메모·복구 표시·관계 값이 종류별 값으로 옮는다", () => {
  const reply = rowOf(3);
  assert.equal(reply.kind, "reply");
  assert.equal(reply.dedupe_key, "답장:2026-09-19 10:00:00");
  assert.equal(reply.expires_at, null);
  assert.equal(reply.call_id, 70);
  assert.equal(reply.attempts, 1);
  assert.equal(reply.detail, "network");
  assert.equal(reply.send_at, DUE);
  assert.deepEqual(payloadOf(3), {
    userMsgAt: "2026-09-19 10:00:00",
    bubbles: ["안녕", "뭐 해"],
    notes: ["점심은 김밥", "저녁 약속 있음"],
    replyMeta: { move: "tease" },
  });

  const recover = rowOf(5);
  assert.equal(recover.kind, "reply");
  assert.equal(recover.dedupe_key, "답장:2026-09-19 10:05:00");
  assert.deepEqual(payloadOf(5), {
    userMsgAt: "2026-09-19 10:05:00",
    bubbles: ["늦었지"],
    recover: true,
  });

  // 같은 유저 메시지 답장이 이미 기다리고 있어 row 키로 옮겼다.
  assert.equal(rowOf(6).dedupe_key, "row6");
});

test("깨우기·복귀는 block_end로 가고, 유저 첫 발화 시각은 깨우기 행에만 붙는다", () => {
  const wake = rowOf(7);
  assert.equal(wake.kind, "block_end");
  assert.equal(wake.dedupe_key, "구간끝:10:00");
  assert.deepEqual(payloadOf(7), {
    activity: "회의",
    blockStart: "10:00",
    blockEnd: "11:00",
    userFirstAt: "2026-09-19 10:20:00",
  });

  // 구간 시작이 없던 깨우기 행은 row 키를 받고, 없던 값은 빈 문자열로 채우지 않는다.
  const bare = rowOf(8);
  assert.equal(bare.kind, "block_end");
  assert.equal(bare.dedupe_key, "row8");
  assert.deepEqual(payloadOf(8), { userFirstAt: "2026-09-19 10:25:00" });

  const ret = rowOf(9);
  assert.equal(ret.kind, "block_end");
  assert.equal(ret.dedupe_key, "구간끝:14:00");
  assert.deepEqual(payloadOf(9), {
    activity: "수업",
    blockStart: "14:00",
    blockEnd: "15:30",
  });
});

test("약속은 호출 번호로 키를 만들고, 번호가 없으면 row 키를 받는다", () => {
  const promise = rowOf(10);
  assert.equal(promise.kind, "promise");
  assert.equal(promise.dedupe_key, "약속:42");
  assert.equal(promise.call_id, 42);
  assert.deepEqual(payloadOf(10), {
    activity: "회의",
    blockStart: "10:00",
    blockEnd: "11:00",
    promise: "회의 끝나고 연락할게",
    userMsgAt: "2026-09-19 10:10:00",
  });

  const noCall = rowOf(11);
  assert.equal(noCall.dedupe_key, "row11");
  assert.equal(noCall.call_id, null);
});

test("예약 문안은 새 번호를 받고 옛 번호·발송 창·만료 시각을 함께 옮긴다", () => {
  const scheduled = outbox().filter((r) => r.id > 40);
  // 키가 겹쳐 넣지 못한 시도도 번호 하나를 쓰므로 겹친 행 앞에서 번호가 하나 빈다.
  const dup = scheduled[2]!.id;
  assert.deepEqual(
    scheduled.map((r) => [r.id, r.kind, r.dedupe_key]),
    [
      [41, "morning", "아침:2026-09-20"],
      [42, "checkin", "안부:2026-09-20"],
      // 같은 날 아침이 이미 기다리고 있어 번호가 정해진 뒤 row 키로 바꿨다.
      [dup, "morning", `row${dup}`],
    ],
  );

  const morning = rowOf(41);
  assert.equal(morning.send_at, "2026-09-20 07:10:00");
  // 창 끝 07:40에 90분을 더한 09:10이 오전 상한 11:00보다 이르다.
  assert.equal(morning.expires_at, "2026-09-20 09:10:00");
  assert.equal(morning.attempts, 1);
  assert.equal(morning.detail, "timeout");
  assert.deepEqual(payloadOf(41), {
    date: "2026-09-20",
    windowStart: "07:10",
    windowEnd: "07:40",
    text: "잘 잤어?",
    legacyId: 21,
  });
  // 창 끝 15:30에 90분을 더한 17:00.
  assert.equal(rowOf(42).expires_at, "2026-09-20 17:00:00");
  assert.equal(payloadOf(dup).legacyId, 25);
});

test("새 번호는 두 옛 표에서 쓴 가장 큰 번호 뒤에서 시작한다", () => {
  const seq = (
    db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'outbox'`).get() as
      | { seq: number }
      | undefined
  )?.seq;
  assert.ok(seq !== undefined && seq >= 40, `outbox 번호 카운터가 ${seq}이다`);
});

test("isWaiting은 답장 행과 유저 첫 발화 시각이 있는 구간 끝 행만 센다", () => {
  assert.equal(isWaiting("chat-1"), true); // 답장
  assert.equal(isWaiting("chat-2"), true); // 깨우기에서 옮긴 구간 끝
  assert.equal(isWaiting("chat-3"), false); // 복귀에서 옮긴 구간 끝
  assert.equal(isWaiting("chat-4"), false); // 약속만
});

test("새벽 정리와 다음 아침이 새 표로 돈다", () => {
  // 옮긴 아침 문안을 디스패처가 그날 집는다.
  assert.deepEqual(
    getPendingSends("2026-09-20").map((r) => r.text),
    ["잘 잤어?", "두 번째 아침", "오후 잘 보내고 있어?"],
  );
  assert.equal(hasScheduledSendOn(1, "2026-09-20"), true);
  // 이미 문안이 있는 날에는 새벽 정리가 다시 적어도 하루 1통을 지킨다.
  insertScheduledSend(1, "chat-1", "2026-09-20", "09:00", "09:30", "또 아침", "2026-09-20 04:10:00");
  assert.equal(getScheduledSendsOn(1, "2026-09-20").length, 3);

  // 다음 날 새벽 정리가 적는 아침 문안은 옛 번호 뒤의 새 번호를 받는다.
  insertScheduledSend(1, "chat-1", "2026-09-21", "07:00", "07:30", "내일 아침", "2026-09-21 04:00:00");
  const next = getPendingSends("2026-09-21");
  assert.equal(next.length, 1);
  const moved = Math.max(...outbox().filter((r) => r.id > 40 && r.id !== next[0]!.id).map((r) => r.id));
  assert.ok(next[0]!.id > moved, `새 행 번호가 ${next[0]!.id}이다`);
  assert.equal(next[0]!.dedupe_key, "아침:2026-09-21");
  assert.equal(next[0]!.expires_at, "2026-09-21 09:00:00");
});

test("무결성과 외래 키가 깨끗하다", () => {
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  assert.equal((db.pragma("foreign_key_check") as unknown[]).length, 0);
});

test("기동하면 옮긴 답장·구간 끝·약속 행이 다시 걸려 울린다", async () => {
  const replies: number[] = [];
  const wakes: number[] = [];
  const promises: number[] = [];
  setPendingSender(async (row, bubbles) => {
    replies.push(row.id);
    return { messageId: null, delivered: bubbles.length };
  });
  setWakeHandler(async (row) => {
    wakes.push(row.id);
    return { status: "skipped", reason: "no_turn" };
  });
  setPromiseHandler(async (row) => {
    promises.push(row.id);
    return { status: "sent" };
  });

  resumePendingReplies();
  // 보낼 시각이 지난 행이라 바로 울린다. 핸들러가 비동기라 한 틱 더 기다린다.
  await new Promise((r) => setTimeout(r, 200));

  assert.deepEqual(replies.sort((a, b) => a - b), [3, 5, 6]);
  assert.deepEqual(wakes.sort((a, b) => a - b), [7, 8, 9]);
  assert.deepEqual(promises.sort((a, b) => a - b), [10, 11]);
  // 아침·안부는 디스패처 몫이라 이어받기가 걸지 않는다.
  const state = (id: number): [string, string | null] => {
    const r = rowOf(id);
    return [r.status, r.reason];
  };
  assert.deepEqual(state(3), ["sent", null]);
  assert.deepEqual(state(7), ["skipped", "no_turn"]);
  assert.deepEqual(state(10), ["sent", null]);
  assert.deepEqual(state(41), ["waiting", null]);
  assert.equal(isWaiting("chat-1"), false);
  assert.equal(isWaiting("chat-2"), false);
});
