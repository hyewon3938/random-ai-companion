// 게시 키·스레드 칸이 없던 v14 DB가 v15로 올라가는 자리를 검사한다(#451).
//
// v15는 call_feedback에 emoji·trace_key·thread_ts를 ALTER로 붙이고, 이미 쌓인 행은 트레이스 표에
// 게시 기록이 남은 것만 게시 키와 부모 글 ts를 채운다. 리액션 행의 emoji는 분류에서 되살린다.
// 봐야 할 것은 본문 글·제 키가 있는 자식·제 키 없는 자식이 각각 맞는 값을 받는지, 게시 기록이
// 지워진 행은 비어 있는지, 이유 행의 emoji는 비어 있는지다.
//
// DB는 임시 파일로 새로 만들고, v14 모양은 이 파일이 손으로 세운다. 나머지 표는 기동할 때
// createSchema가 만든다. 모델도 텔레그램도 부르지 않아 값이 안 든다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const DB_PATH = join(mkdtempSync(join(tmpdir(), "companion-test-")), "test.db");
process.env.DB_PATH = DB_PATH;
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

// v14 시절의 characters·trace_events·call_feedback을 손으로 세운다 — call_feedback은 지금 모양에서
// emoji·trace_key·thread_ts 세 칸만 빠진 것이다.
const seed = new Database(DB_PATH);
// call_feedback이 가리키는 llm_calls는 기동할 때 createSchema가 만든다. 그 전에 행을 넣으려면
// 이 연결에서만 외래 키 검사를 끈다.
seed.pragma("foreign_keys = OFF");
seed.exec(`
  CREATE TABLE characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
    genesis_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE trace_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER REFERENCES characters(id),
    kind TEXT NOT NULL,
    dedupe_key TEXT UNIQUE,
    thread_key TEXT,
    parent_key TEXT,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
    slack_ts TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE call_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER REFERENCES characters(id),
    call_id INTEGER REFERENCES llm_calls(id),
    slack_ts TEXT NOT NULL,
    trace_kind TEXT,
    source TEXT NOT NULL CHECK (source IN ('reaction','reply')),
    kind TEXT CHECK (kind IN ('fact','tone','timing','good')),
    slack_user TEXT,
    text TEXT,
    reply_ts TEXT,
    dedupe_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    removed_at TEXT,
    resolved_at TEXT,
    issue_no INTEGER,
    resolution TEXT CHECK (resolution IN ('fixed','wontfix','dup'))
  );
`);
seed
  .prepare(
    `INSERT INTO characters (id, chat_id, status, genesis_json, created_at)
     VALUES (1, 'chat-1', 'active', '{}', '2026-09-01 10:00:00')`,
  )
  .run();

// 답장 게시 한 벌 — 본문 글, 제 키가 있는 발송 결과 자식, 제 키 없는 실시간 꼬리 자식.
const addEvent = seed.prepare(
  `INSERT INTO trace_events
     (character_id, kind, dedupe_key, thread_key, parent_key, text, status, slack_ts, created_at)
   VALUES (1, ?, ?, ?, ?, '게시 글', 'sent', ?, '2026-09-13 12:00:00')`,
);
addEvent.run("call_reply", "call:7", "call:7", null, "1757100001.000100");
addEvent.run("reply_sent", "call:7:sent", null, "call:7", "1757100002.000100");
addEvent.run("call_tail", null, null, "call:7", "1757100003.000100");

const addFeedback = seed.prepare(
  `INSERT INTO call_feedback
     (character_id, slack_ts, trace_kind, source, kind, slack_user, text, reply_ts, dedupe_key, created_at)
   VALUES (1, ?, ?, ?, ?, 'U1', ?, ?, ?, '2026-09-13 12:10:00')`,
);
addFeedback.run(
  "1757100001.000100",
  "call_reply",
  "reaction",
  "fact",
  null,
  null,
  "a",
);
addFeedback.run(
  "1757100001.000100",
  "call_reply",
  "reply",
  null,
  "말투가 딱딱하다",
  "1757100001.000900",
  "b",
);
addFeedback.run(
  "1757100002.000100",
  "reply_sent",
  "reaction",
  "good",
  null,
  null,
  "c",
);
addFeedback.run(
  "1757100003.000100",
  "call_tail",
  "reaction",
  "tone",
  null,
  null,
  "d",
);
// 트레이스 표가 30일이 지나 게시 기록을 지운 글에 달렸던 표시.
addFeedback.run(
  "1757000000.000100",
  "call_reply",
  "reaction",
  "timing",
  null,
  null,
  "e",
);
seed.pragma("user_version = 14");
seed.close();

// DB 경로를 정하고 v14 모양을 세운 뒤에 읽어야 이 파일이 열린다 — 읽는 순간 마이그레이션이 돈다.
const { db } = await import("../src/db.js");

test("v14 DB가 지금 스키마 버전까지 올라간다", () => {
  assert.equal(db.pragma("user_version", { simple: true }), 16);
});

test("call_feedback에 이모지·게시 키·부모 글 칸이 붙는다", () => {
  const cols = (
    db.pragma(`table_info(call_feedback)`) as { name: string }[]
  ).map((c) => c.name);
  for (const col of ["emoji", "trace_key", "thread_ts"])
    assert.ok(cols.includes(col), `${col}이 없다`);
});

test("이미 쌓인 표시는 게시 기록으로 게시 키와 부모 글을 채우고 분류에서 이모지를 되살린다", () => {
  assert.deepEqual(
    db
      .prepare(
        `SELECT dedupe_key, kind, emoji, trace_key, thread_ts FROM call_feedback ORDER BY dedupe_key`,
      )
      .all(),
    [
      // 본문 글 — 부모 글이 없다.
      {
        dedupe_key: "a",
        kind: "fact",
        emoji: "x",
        trace_key: "call:7",
        thread_ts: null,
      },
      // 이유 행은 이모지가 없다.
      {
        dedupe_key: "b",
        kind: null,
        emoji: null,
        trace_key: "call:7",
        thread_ts: null,
      },
      // 제 키가 있는 자식은 제 키, 부모 글은 본문 글의 ts.
      {
        dedupe_key: "c",
        kind: "good",
        emoji: "+1",
        trace_key: "call:7:sent",
        thread_ts: "1757100001.000100",
      },
      // 제 키가 없는 자식은 부모 키로 받는다.
      {
        dedupe_key: "d",
        kind: "tone",
        emoji: "speech_balloon",
        trace_key: "call:7",
        thread_ts: "1757100001.000100",
      },
      // 게시 기록이 지워진 글은 게시 키도 부모 글도 모른다. 이모지는 분류만으로 채운다.
      {
        dedupe_key: "e",
        kind: "timing",
        emoji: "alarm_clock",
        trace_key: null,
        thread_ts: null,
      },
    ],
  );
});

test("무결성과 외래 키가 깨끗하다", () => {
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  assert.equal((db.pragma("foreign_key_check") as unknown[]).length, 0);
});
