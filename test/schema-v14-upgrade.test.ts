// 있었던 날 칸이 없던 v13 DB가 v14로 올라가는 자리를 검사한다(#388).
//
// 붙이는 칸이 비어 있어도 되므로 v14는 표를 다시 만들지 않고 ALTER로 붙인다. 여기서 봐야 할
// 것은 이미 쌓인 기억이 다치지 않는지와, 그 행들의 있었던 날이 채워지지 않고 비어 있는지다 —
// 값 안에 적힌 날짜를 뽑아 채우면 틀린 날이 섞이고, 틀린 날은 비어 있는 것보다 나쁘다.
//
// DB는 임시 파일로 새로 만들고, v13 모양은 이 파일이 손으로 세운다. 나머지 표는 기동할 때
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

// v13 시절의 characters·memory_items를 손으로 세운다 — memory_items는 지금 모양에서
// occurred_on 한 칸만 빠진 것이다.
const seed = new Database(DB_PATH);
seed.exec(`
  CREATE TABLE characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
    genesis_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE memory_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER NOT NULL REFERENCES characters(id),
    item_type TEXT NOT NULL CHECK (item_type IN ('fact','ongoing','person')),
    owner TEXT NOT NULL CHECK (owner IN ('char','user')),
    area TEXT NOT NULL,
    subject TEXT NOT NULL,
    value TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'conversation' CHECK (origin IN ('creation','conversation')),
    user_knows TEXT NOT NULL DEFAULT 'unknown' CHECK (user_knows IN ('unknown','known','waiting')),
    relation TEXT,
    contact_mode TEXT,
    region TEXT,
    last_mentioned_at TEXT,
    end_condition TEXT,
    interest TEXT CHECK (interest IN ('high','medium','low')),
    last_retrieved_at TEXT,
    retrieval_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    CHECK (item_type = 'person' OR (relation IS NULL AND contact_mode IS NULL AND region IS NULL AND last_mentioned_at IS NULL)),
    CHECK (item_type = 'ongoing' OR end_condition IS NULL),
    CHECK (owner = 'char' OR interest IS NULL),
    CHECK (owner = 'char' OR user_knows = 'known'),
    UNIQUE (character_id, item_type, owner, area, subject, origin)
  );
`);
seed
  .prepare(
    `INSERT INTO characters (id, chat_id, status, genesis_json, created_at)
     VALUES (1, 'chat-1', 'active', '{}', '2026-09-01 10:00:00')`,
  )
  .run();
seed
  .prepare(
    `INSERT INTO memory_items
       (character_id, item_type, owner, area, subject, value, origin, user_knows, updated_at)
     VALUES (1, 'ongoing', 'user', '일', '이사', '9/10 저녁에 이사했다', 'conversation', 'known', '2026-09-11 22:00:00')`,
  )
  .run();
seed.pragma("user_version = 13");
seed.close();

// DB 경로를 정하고 v13 모양을 세운 뒤에 읽어야 이 파일이 열린다 — 읽는 순간 마이그레이션이 돈다.
const { db } = await import("../src/db.js");

test("v13 DB가 지금 스키마 버전까지 올라간다", () => {
  assert.equal(db.pragma("user_version", { simple: true }), 14);
});

test("memory_items에 있었던 날 칸이 붙는다", () => {
  const cols = (db.pragma(`table_info(memory_items)`) as { name: string }[]).map(
    (c) => c.name,
  );
  assert.ok(cols.includes("occurred_on"), "occurred_on이 없다");
});

test("이미 쌓인 기억은 그대로 남고 있었던 날은 비어 있다", () => {
  assert.deepEqual(
    db
      .prepare(`SELECT subject, value, occurred_on, updated_at FROM memory_items`)
      .all(),
    [
      {
        subject: "이사",
        value: "9/10 저녁에 이사했다",
        // 값 안에 날짜가 적혀 있어도 뽑아서 채우지 않는다 — 새벽 정리가 그 기억을 다시 쓸 때 찬다.
        occurred_on: null,
        updated_at: "2026-09-11 22:00:00",
      },
    ],
  );
});

test("무결성과 외래 키가 깨끗하다", () => {
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  assert.equal((db.pragma("foreign_key_check") as unknown[]).length, 0);
});
