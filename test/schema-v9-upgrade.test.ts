// 관계 단계 칸이 없던 DB가 v9로 올라가면서 단계 두 칸과 표 넷을 얻는지 검사한다.
//
// 운영 DB는 배포할 때 한 번 올라간다. 단계 칸은 비울 수 없는 자리라 옮기는 절차가 값을 못
// 채우면 그 자리에서 실패하고, 채우더라도 엉뚱한 날짜를 넣으면 첫 단계 체류 일수가 어긋난다.
// 배포 전에 v8 모양을 손으로 만들어 왕복을 확인한다 — 칸이 생겼는지, 있던 관계 행이 그대로인지,
// 단계가 1과 캐릭터 생성일로 채워졌는지, 새 표 넷이 비어 있는지.
//
// DB는 임시 파일로 새로 만들고, v8 모양은 이 파일이 손으로 세운다. 모델도 텔레그램도
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

// v8 시절의 characters·relationships를 손으로 세운다 — 지금 정의부에 있는 단계 두 칸이
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
    user_state TEXT,
    user_state_cause TEXT CHECK (user_state_cause IN ('char','other')),
    user_state_tone TEXT CHECK (user_state_tone IN ('good','neutral','bad')),
    user_state_since TEXT,
    updated_at TEXT
  );
`);
seed
  .prepare(
    `INSERT INTO characters (id, chat_id, status, genesis_json, created_at)
     VALUES (1, 'chat-1', 'active', '{}', '2026-09-08 22:51:00')`,
  )
  .run();
seed
  .prepare(
    `INSERT INTO characters (id, chat_id, status, genesis_json, created_at)
     VALUES (2, 'chat-2', 'ended', '{}', '2026-07-02 10:00:00')`,
  )
  .run();
// 만난 날과 캐릭터 생성일을 다르게 둔다 — 단계 시작일이 어느 쪽에서 오는지 갈라 보려는 것.
seed
  .prepare(
    `INSERT INTO relationships
       (character_id, met_at, stage, speech_level, feelings, user_state, user_state_tone, updated_at)
     VALUES (1, '2026-09-01 00:00:00', '알게 된 지 얼마 안 된 사이', 'polite', '아직 어색하다',
             '피곤해 보임', 'bad', '2026-09-09 05:40:00')`,
  )
  .run();
seed
  .prepare(
    `INSERT INTO relationships (character_id, met_at) VALUES (2, '2026-07-02 10:00:00')`,
  )
  .run();
seed.pragma("user_version = 8");
seed.close();

// DB 경로를 정하고 v8 모양을 세운 뒤에 읽어야 이 파일이 열린다 — 읽는 순간 마이그레이션이 돈다.
const { db, getRelationship, getStage, raiseStage } = await import(
  "../src/db.js"
);

const columnNames = (table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (c) => c.name,
  );

const rowCount = (table: string): number =>
  (db.prepare(`SELECT count(*) c FROM ${table}`).get() as { c: number }).c;

test("v8 DB가 지금 스키마 버전까지 올라간다", () => {
  assert.equal(db.pragma("user_version", { simple: true }), 14);
});

test("관계 표에 단계 두 칸이 생긴다", () => {
  const cols = columnNames("relationships");
  for (const c of ["stage_no", "stage_since"])
    assert.ok(cols.includes(c), `relationships.${c}이 없다`);
});

test("있던 관계 행은 그대로 남고 단계는 1과 캐릭터 생성일로 채워진다", () => {
  const rel = getRelationship(1);
  assert.ok(rel);
  assert.equal(rel.stage, "알게 된 지 얼마 안 된 사이");
  assert.equal(rel.speech_level, "polite");
  assert.equal(rel.feelings, "아직 어색하다");
  assert.equal(rel.user_state, "피곤해 보임");
  assert.equal(rel.user_state_tone, "bad");
  assert.equal(rel.met_at, "2026-09-01 00:00:00");
  assert.equal(rel.updated_at, "2026-09-09 05:40:00");

  assert.deepEqual(getStage(1), {
    stage_no: 1,
    stage_since: "2026-09-08",
  });
  assert.deepEqual(getStage(2), {
    stage_no: 1,
    stage_since: "2026-07-02",
  });
});

test("단계는 1~4 밖으로 못 가고 낮추는 저장은 거부된다", () => {
  assert.throws(() =>
    db.prepare(`UPDATE relationships SET stage_no = 5 WHERE character_id = 1`).run(),
  );
  assert.throws(() =>
    db.prepare(`UPDATE relationships SET stage_no = 0 WHERE character_id = 1`).run(),
  );
  assert.equal(raiseStage(1, 3, "2026-09-20"), true);
  assert.deepEqual(getStage(1), {
    stage_no: 3,
    stage_since: "2026-09-20",
  });
  // 같은 단계도, 낮추는 단계도 손대지 않는다 — 시작일까지 그대로여야 한다
  assert.equal(raiseStage(1, 3, "2026-09-21"), false);
  assert.equal(raiseStage(1, 2, "2026-09-21"), false);
  assert.deepEqual(getStage(1), {
    stage_no: 3,
    stage_since: "2026-09-20",
  });
});

test("관계를 쌓는 표 넷이 생기고 비어 있다", () => {
  for (const t of [
    "firsts",
    "reaction_scores",
    "relationship_intents",
    "relationship_signals",
  ]) {
    assert.ok(
      db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(t),
      `${t} 표가 없다`,
    );
    assert.equal(rowCount(t), 0, `${t}에 행이 있다`);
  }
});

test("무결성과 외래 키가 깨끗하다", () => {
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  assert.equal((db.pragma("foreign_key_check") as unknown[]).length, 0);
});
