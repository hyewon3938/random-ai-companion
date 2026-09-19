// 캐릭터 마음 칸이 없던 v15 DB가 v16으로 올라가는 자리를 검사한다(#473).
//
// v16은 relationships에 mind_kind·mind_level·mind_reason·mind_since를 ALTER로 붙인다. 이미 있는
// 관계 행은 네 칸이 비어 평소(마음 없음)로 읽혀야 하고, 다른 칸은 그대로여야 한다.
//
// DB는 임시 파일로 새로 만들고, v15 모양의 characters·relationships는 이 파일이 손으로 세운다.
// 나머지 표는 기동할 때 createSchema가 만든다. 모델도 텔레그램도 부르지 않아 값이 안 든다.
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

// v15 시절의 relationships — 지금 모양에서 마음 칸 넷만 빠진 것이다.
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
    stage_no INTEGER NOT NULL DEFAULT 1 CHECK (stage_no BETWEEN 1 AND 4),
    stage_since TEXT NOT NULL,
    speech_level TEXT CHECK (speech_level IN ('polite','casual')),
    speech_note TEXT,
    address_terms TEXT,
    rapport TEXT,
    cautions TEXT,
    history TEXT,
    feelings TEXT,
    user_state TEXT,
    user_state_cause TEXT CHECK (user_state_cause IN ('char','other')),
    user_state_tone TEXT CHECK (user_state_tone IN ('good','neutral','bad')),
    user_state_since TEXT,
    updated_at TEXT
  );
  INSERT INTO characters (id, chat_id, status, genesis_json, created_at)
    VALUES (1, 'chat-1', 'active', '{}', '2026-09-01 10:00:00');
  INSERT INTO relationships
    (character_id, met_at, stage_no, stage_since, speech_level, user_state, user_state_cause, user_state_tone, user_state_since)
    VALUES (1, '2026-09-01', 2, '2026-09-10', 'casual', '면접 결과를 기다리며 초조해한다', 'other', 'bad', '2026-09-19 20:10:00');
`);
seed.pragma("user_version = 15");
seed.close();

// DB 경로를 정하고 v15 모양을 세운 뒤에 읽어야 이 파일이 열린다 — 읽는 순간 마이그레이션이 돈다.
const { db, getRelationship } = await import("../src/db.js");
const { storedMind } = await import("../src/context/mind.js");

test("v15 DB가 v16으로 올라간다", () => {
  assert.equal(db.pragma("user_version", { simple: true }), 16);
});

test("relationships에 마음 칸 넷이 붙고 있던 행은 마음 없음으로 읽힌다", () => {
  const cols = (db.pragma(`table_info(relationships)`) as { name: string }[]).map(
    (c) => c.name,
  );
  for (const col of ["mind_kind", "mind_level", "mind_reason", "mind_since"])
    assert.ok(cols.includes(col), `${col}이 없다`);
  const rel = getRelationship(1);
  assert.ok(rel);
  assert.equal(storedMind(rel), null);
  assert.equal(rel.mind_kind, null);
  assert.equal(rel.mind_since, null);
  // 다른 칸은 그대로다
  assert.deepEqual(
    db
      .prepare(
        `SELECT stage_no, speech_level, user_state_tone FROM relationships WHERE character_id = 1`,
      )
      .get(),
    { stage_no: 2, speech_level: "casual", user_state_tone: "bad" },
  );
});

test("무결성과 외래 키가 깨끗하다", () => {
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  assert.equal((db.pragma("foreign_key_check") as unknown[]).length, 0);
});
