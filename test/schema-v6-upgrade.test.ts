// 옛 자리가 남은 DB가 v6으로 올라가면서 그 자리를 잃는지 검사한다.
//
// 운영 DB는 배포할 때 한 번 올라가고 되돌릴 수 없다. 마이그레이션이 표를 못 지우거나
// 지우면서 옆 행을 함께 날리면 그때 알게 되므로, 배포 전에 같은 모양을 손으로 만들어
// 왕복을 확인한다. 지운 자리가 사라졌는지와 남긴 값이 그대로인지를 함께 본다.
//
// DB는 임시 파일로 새로 만들고, v5 모양은 이 파일이 손으로 세운다. 모델도 텔레그램도
// 부르지 않아 값이 안 든다.
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

// v5 시절 모양을 손으로 세운다. 지금 정의부에는 없는 표 다섯과 컬럼 셋이 여기에 들어 있고,
// 나머지 표는 부팅할 때 createSchema가 만든다. relationships·user_profile은 옛 컬럼을 달고
// 미리 만들어 둬야 한다 — CREATE TABLE IF NOT EXISTS는 이미 있는 표를 건드리지 않는다.
const seed = new Database(DB_PATH);
seed.exec(`
  CREATE TABLE characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
    genesis_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE relationships (
    character_id INTEGER PRIMARY KEY REFERENCES characters(id),
    met_at TEXT NOT NULL,
    stage TEXT,
    speech_level TEXT CHECK (speech_level IN ('polite','casual')),
    speech_note TEXT,
    address_terms TEXT,
    rapport TEXT,
    cautions TEXT,
    history TEXT,
    feelings TEXT,
    updated_at TEXT,
    last_contact_at TEXT,
    legacy_state_json TEXT
  );
  CREATE TABLE user_profile (
    chat_id TEXT PRIMARY KEY,
    preferred_name TEXT,
    gender TEXT,
    birth_year INTEGER,
    job TEXT,
    region TEXT,
    updated_at TEXT,
    age_band TEXT
  );
  CREATE TABLE cast_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER NOT NULL REFERENCES characters(id),
    name TEXT NOT NULL
  );
  CREATE TABLE attention_override (
    character_id INTEGER NOT NULL REFERENCES characters(id),
    date TEXT NOT NULL
  );
  CREATE TABLE capture_marks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER NOT NULL REFERENCES characters(id)
  );
  CREATE TABLE user_preferences (
    chat_id TEXT PRIMARY KEY,
    pref_json TEXT NOT NULL
  );
  CREATE TABLE memory_items_legacy (
    id INTEGER PRIMARY KEY,
    character_id INTEGER NOT NULL,
    value TEXT
  );
`);
seed
  .prepare(
    `INSERT INTO characters (id, chat_id, status, genesis_json, created_at)
     VALUES (1, 'chat-1', 'active', '{}', '2026-08-01 09:00:00')`,
  )
  .run();
seed
  .prepare(
    `INSERT INTO relationships
       (character_id, met_at, stage, speech_level, history, last_contact_at, legacy_state_json)
     VALUES (1, '2026-08-01', '친구', 'casual', '여름에 만났다', '2026-09-01 21:00:00', '{"open_loops":[]}')`,
  )
  .run();
seed
  .prepare(
    `INSERT INTO user_profile (chat_id, gender, birth_year, job, region, updated_at, age_band)
     VALUES ('chat-1', '여성', 1993, '디자이너', '서울', '2026-09-01 05:00:00', '30대 초반')`,
  )
  .run();
seed
  .prepare(`INSERT INTO cast_members (character_id, name) VALUES (1, '누나')`)
  .run();
seed.pragma("user_version = 5");
seed.close();

// DB 경로를 정하고 v5 모양을 세운 뒤에 읽어야 이 파일이 열린다 — 읽는 순간 마이그레이션이 돈다.
const { db } = await import("../src/db.js");

const tableExists = (name: string): boolean =>
  db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) !== undefined;

const columnNames = (table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (c) => c.name,
  );

// v5에서 열면 그 뒤에 붙은 마이그레이션까지 이어서 돈다. 이 파일이 보는 것은 v6이 지우는
// 자리지만, 멈추는 버전은 언제나 지금 스키마 버전이다.
test("v5 DB가 지금 스키마 버전까지 올라간다", () => {
  assert.equal(db.pragma("user_version", { simple: true }), 7);
});

test("옛 표 다섯이 사라진다", () => {
  for (const name of [
    "cast_members",
    "attention_override",
    "capture_marks",
    "user_preferences",
    "memory_items_legacy",
  ])
    assert.equal(tableExists(name), false, `${name}이 남아 있다`);
});

test("옛 컬럼 셋이 사라진다", () => {
  const relation = columnNames("relationships");
  assert.equal(relation.includes("legacy_state_json"), false);
  assert.equal(relation.includes("last_contact_at"), false);
  assert.equal(columnNames("user_profile").includes("age_band"), false);
});

test("남긴 값은 그대로다", () => {
  const relation = db
    .prepare(
      `SELECT stage, speech_level, history FROM relationships WHERE character_id = 1`,
    )
    .get() as { stage: string; speech_level: string; history: string };
  assert.deepEqual(relation, {
    stage: "친구",
    speech_level: "casual",
    history: "여름에 만났다",
  });

  const profile = db
    .prepare(
      `SELECT gender, birth_year, job, region FROM user_profile WHERE chat_id = 'chat-1'`,
    )
    .get() as {
    gender: string;
    birth_year: number;
    job: string;
    region: string;
  };
  assert.deepEqual(profile, {
    gender: "여성",
    birth_year: 1993,
    job: "디자이너",
    region: "서울",
  });
});

test("무결성과 외래 키가 깨끗하다", () => {
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  assert.equal((db.pragma("foreign_key_check") as unknown[]).length, 0);
});
