// 플러팅 코드 목록에 notice가 없던 v9 DB가 v10으로 올라가면서 세 표의 CHECK가 새 목록을 받는지 검사한다.
//
// 플러팅 코드는 reaction_scores·relationship_intents·relationship_signals의 CHECK에 박혀 있어
// 표를 다시 만들어야 하고, 세 표는 v9 배포 뒤 비어 있어서 행을 옮기지 않고 지우고 다시 만든다.
// 배포 전에 v9 모양을 손으로 만들어 왕복을 확인한다 — 버전이 10인지, 세 표가 비었는지, 새
// 코드가 들어가는지, 손대지 않는 firsts와 관계 행이 그대로인지.
//
// DB는 임시 파일로 새로 만들고, v9 모양은 이 파일이 손으로 세운다. 모델도 텔레그램도
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

// v9 시절의 플러팅 코드 목록 — notice가 없다.
const OLD_MOVES =
  "'remember','laugh','anticipate','scene','sudden_ping','nickname','weakness','late_night_truth','jealousy_light','dodge_after_direct','only_you','ask_help'";

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
  CREATE TABLE firsts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER NOT NULL REFERENCES characters(id),
    chat_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    by TEXT NOT NULL CHECK (by IN ('character','user')),
    happened_at TEXT NOT NULL,
    message_id INTEGER,
    call_id INTEGER,
    confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0,1)),
    UNIQUE (character_id, kind)
  );
  CREATE TABLE reaction_scores (
    chat_id TEXT NOT NULL,
    move TEXT NOT NULL CHECK (move IN (${OLD_MOVES})),
    score REAL NOT NULL DEFAULT 0 CHECK (score BETWEEN -1 AND 1),
    sample_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (chat_id, move)
  );
  CREATE TABLE relationship_intents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER NOT NULL REFERENCES characters(id),
    date TEXT NOT NULL,
    dig TEXT,
    share TEXT,
    move TEXT CHECK (move IN (${OLD_MOVES})),
    move_note TEXT,
    lead_tone TEXT,
    thread TEXT,
    basis_json TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (character_id, date)
  );
  CREATE TABLE relationship_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER NOT NULL REFERENCES characters(id),
    chat_id TEXT NOT NULL,
    at TEXT NOT NULL,
    message_id INTEGER,
    opened_self INTEGER NOT NULL CHECK (opened_self IN (0,1)),
    asked_about_char INTEGER NOT NULL CHECK (asked_about_char IN (0,1)),
    said_affection INTEGER NOT NULL CHECK (said_affection IN (0,1)),
    prev_move TEXT CHECK (prev_move IN (${OLD_MOVES})),
    move_reaction TEXT CHECK (move_reaction IN ('accepted','ignored','rejected','none')),
    call_id INTEGER
  );
  CREATE INDEX idx_firsts_character ON firsts (character_id, confirmed);
  CREATE INDEX idx_relationship_signals_at ON relationship_signals (character_id, at);
`);
seed
  .prepare(
    `INSERT INTO characters (id, chat_id, status, genesis_json, created_at)
     VALUES (1, 'chat-1', 'active', '{}', '2026-09-08 22:51:00')`,
  )
  .run();
seed
  .prepare(
    `INSERT INTO relationships (character_id, met_at, stage, stage_no, stage_since, speech_level)
     VALUES (1, '2026-09-08 22:51:00', '알게 된 지 얼마 안 된 사이', 2, '2026-09-09', 'casual')`,
  )
  .run();
seed
  .prepare(
    `INSERT INTO firsts (character_id, chat_id, kind, by, happened_at, confirmed)
     VALUES (1, 'chat-1', 'first_laugh', 'character', '2026-09-09 21:10:00', 1)`,
  )
  .run();
seed.pragma("user_version = 9");
seed.close();

// DB 경로를 정하고 v9 모양을 세운 뒤에 읽어야 이 파일이 열린다 — 읽는 순간 마이그레이션이 돈다.
const { db, getStage, getConfirmedFirsts } = await import("../src/db.js");

const rowCount = (table: string): number =>
  (db.prepare(`SELECT count(*) c FROM ${table}`).get() as { c: number }).c;

test("v9 DB가 지금 스키마 버전까지 올라간다", () => {
  assert.equal(db.pragma("user_version", { simple: true }), 13);
});

test("플러팅 코드가 든 세 표는 비어 있고 새 코드 notice를 받는다", () => {
  for (const t of ["reaction_scores", "relationship_intents", "relationship_signals"])
    assert.equal(rowCount(t), 0, `${t}가 비어 있지 않다`);

  db.prepare(
    `INSERT INTO reaction_scores (chat_id, move, score, sample_count, updated_at)
     VALUES ('chat-1', 'notice', 0.5, 1, '2026-09-10 05:00:00')`,
  ).run();
  db.prepare(
    `INSERT INTO relationship_intents (character_id, date, move, lead_tone, created_at)
     VALUES (1, '2026-09-10', 'notice', 'leaky', '2026-09-10 05:00:00')`,
  ).run();
  db.prepare(
    `INSERT INTO relationship_signals
       (character_id, chat_id, at, opened_self, asked_about_char, said_affection, prev_move, move_reaction)
     VALUES (1, 'chat-1', '2026-09-10 12:00:00', 1, 0, 0, 'notice', 'accepted')`,
  ).run();
  assert.equal(rowCount("relationship_intents"), 1);

  // 목록 밖 코드는 여전히 막힌다
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO relationship_intents (character_id, date, move, created_at)
         VALUES (1, '2026-09-11', 'bribe', '2026-09-11 05:00:00')`,
      )
      .run(),
  );
});

test("손대지 않는 관계 행과 처음 기록은 그대로다", () => {
  assert.deepEqual(getStage(1), { stage_no: 2, stage_since: "2026-09-09" });
  const firsts = getConfirmedFirsts(1);
  assert.equal(firsts.length, 1);
  assert.equal(firsts[0]?.kind, "first_laugh");
});

test("관계 신호 표의 색인이 다시 생긴다", () => {
  const idx = (
    db.prepare(`PRAGMA index_list(relationship_signals)`).all() as { name: string }[]
  ).map((i) => i.name);
  assert.ok(idx.includes("idx_relationship_signals_at"));
});
