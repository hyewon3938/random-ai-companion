// 상대의 오늘 상태 칸이 없던 DB가 v8로 올라가면서 관계 표에 그 칸 넷을 얻는지 검사한다.
//
// 운영 DB는 배포할 때 한 번 올라간다. 칸을 못 붙이면 그날부터 관계 행을 읽는 SELECT가 통째로
// 실패하고, 붙이면서 옆 값을 건드리면 관계 일곱 항목이 어긋난다. 배포 전에 v7 모양을 손으로
// 만들어 왕복을 확인한다 — 칸이 생겼는지, 있던 관계 행이 그대로인지, 새 칸의 값 검사가 도는지.
//
// DB는 임시 파일로 새로 만들고, v7 모양은 이 파일이 손으로 세운다. 모델도 텔레그램도
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

// v7 시절의 characters·relationships를 손으로 세운다 — 지금 정의부에 있는 user_state 넷이
// 없는 모양이다. 나머지 표는 부팅할 때 createSchema가 만든다.
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
    updated_at TEXT
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
       (character_id, met_at, stage, speech_level, feelings, updated_at)
     VALUES (1, '2026-08-01', '친구', 'casual', '편하다', '2026-09-06 21:00:00')`,
  )
  .run();
seed.pragma("user_version = 7");
seed.close();

// DB 경로를 정하고 v7 모양을 세운 뒤에 읽어야 이 파일이 열린다 — 읽는 순간 마이그레이션이 돈다.
const { db, getRelationship, setUserState } = await import("../src/db.js");

const columnNames = (table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (c) => c.name,
  );

test("v7 DB가 지금 스키마 버전까지 올라간다", () => {
  assert.equal(db.pragma("user_version", { simple: true }), 12);
});

test("상대의 오늘 상태 칸 넷이 생긴다", () => {
  const cols = columnNames("relationships");
  for (const c of ["user_state", "user_state_cause", "user_state_tone", "user_state_since"])
    assert.ok(cols.includes(c), `relationships.${c}이 없다`);
});

test("있던 관계 행은 그대로 남고 새 칸만 빈다", () => {
  const rel = getRelationship(1);
  assert.ok(rel);
  assert.equal(rel.stage, "친구");
  assert.equal(rel.speech_level, "casual");
  assert.equal(rel.feelings, "편하다");
  assert.equal(rel.updated_at, "2026-09-06 21:00:00");
  assert.equal(rel.user_state, null);
  assert.equal(rel.user_state_cause, null);
  assert.equal(rel.user_state_tone, null);
  assert.equal(rel.user_state_since, null);
});

test("새 칸에 값을 적고 비울 수 있고 정해진 값 밖은 막힌다", () => {
  setUserState(1, {
    state: "연락한다던 말을 안 지켜 서운함",
    cause: "char",
    tone: "bad",
    since: "2026-09-06 21:30:00",
  });
  const rel = getRelationship(1);
  assert.ok(rel);
  assert.equal(rel.user_state, "연락한다던 말을 안 지켜 서운함");
  assert.equal(rel.user_state_cause, "char");
  assert.equal(rel.user_state_tone, "bad");
  assert.equal(rel.user_state_since, "2026-09-06 21:30:00");
  // updated_at은 관계 항목이 바뀔 때만 움직인다 — 상태는 건드리지 않는다
  assert.equal(rel.updated_at, "2026-09-06 21:00:00");
  assert.throws(() =>
    db
      .prepare(`UPDATE relationships SET user_state_tone = 'angry' WHERE character_id = 1`)
      .run(),
  );
  assert.throws(() =>
    db
      .prepare(`UPDATE relationships SET user_state_cause = 'self' WHERE character_id = 1`)
      .run(),
  );
  setUserState(1, null);
  assert.equal(getRelationship(1)?.user_state, null);
  assert.equal(getRelationship(1)?.user_state_since, null);
});

test("무결성과 외래 키가 깨끗하다", () => {
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  assert.equal((db.pragma("foreign_key_check") as unknown[]).length, 0);
});
