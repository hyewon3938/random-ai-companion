// 작품 사실 카드 표가 없던 v10 DB가 v11로 올라가는 자리를 검사한다(#287).
//
// 새 표는 createSchema가 만들고 v11 절차는 버전만 올린다. 여기서 봐야 할 것은 새 표가
// 생겼는지보다 v10 절차가 다시 돌지 않는지다 — migrateToV10은 플러팅 코드가 든 표 셋을 지우고
// 다시 만드는데, 그 표들은 V3 배포 뒤로 행이 차 있다. 버전을 올릴 때 그 조건을 10에 못 박지
// 않으면 올라가는 김에 쌓인 반응 점수·의도·신호가 통째로 사라진다.
//
// DB는 임시 파일로 새로 만들고, v10 모양은 이 파일이 손으로 세운다. 모델도 텔레그램도
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

// v10 시절의 플러팅 코드 목록 — notice까지 들어 있다.
const MOVES =
  "'remember','laugh','anticipate','scene','sudden_ping','nickname','weakness','late_night_truth','jealousy_light','dodge_after_direct','only_you','ask_help','notice'";

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
  CREATE TABLE reaction_scores (
    chat_id TEXT NOT NULL,
    move TEXT NOT NULL CHECK (move IN (${MOVES})),
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
    move TEXT CHECK (move IN (${MOVES})),
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
    prev_move TEXT CHECK (prev_move IN (${MOVES})),
    move_reaction TEXT CHECK (move_reaction IN ('accepted','ignored','rejected','none')),
    call_id INTEGER
  );
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
     VALUES (1, '2026-09-08 22:51:00', '알게 된 지 얼마 안 된 사이', 1, '2026-09-08', 'casual')`,
  )
  .run();
// V3 배포 뒤로 쌓인 행 — v11로 올라가도 그대로 있어야 한다.
seed
  .prepare(
    `INSERT INTO reaction_scores (chat_id, move, score, sample_count, updated_at)
     VALUES ('chat-1', 'laugh', 0.4, 3, '2026-09-10 05:00:00')`,
  )
  .run();
seed
  .prepare(
    `INSERT INTO relationship_intents (character_id, date, dig, move, lead_tone, created_at)
     VALUES (1, '2026-09-10', '요즘 뭐가 바쁜지', 'notice', 'leaky', '2026-09-10 05:00:00')`,
  )
  .run();
seed
  .prepare(
    `INSERT INTO relationship_signals
       (character_id, chat_id, at, opened_self, asked_about_char, said_affection, prev_move, move_reaction)
     VALUES (1, 'chat-1', '2026-09-10 12:00:00', 1, 0, 0, 'laugh', 'accepted')`,
  )
  .run();
seed.pragma("user_version = 10");
seed.close();

// DB 경로를 정하고 v10 모양을 세운 뒤에 읽어야 이 파일이 열린다 — 읽는 순간 마이그레이션이 돈다.
const { db, listWorkFactTitles, saveWorkFact, getWorkFactsByTitles } =
  await import("../src/db.js");

const rowCount = (table: string): number =>
  (db.prepare(`SELECT count(*) c FROM ${table}`).get() as { c: number }).c;

test("v10 DB가 지금 스키마 버전까지 올라간다", () => {
  assert.equal(db.pragma("user_version", { simple: true }), 11);
});

test("v10에서 쌓인 반응 점수·의도·신호는 그대로 남는다", () => {
  assert.equal(rowCount("reaction_scores"), 1);
  assert.equal(rowCount("relationship_intents"), 1);
  assert.equal(rowCount("relationship_signals"), 1);
  const score = db
    .prepare(`SELECT score, sample_count FROM reaction_scores WHERE move = 'laugh'`)
    .get() as { score: number; sample_count: number };
  assert.equal(score.score, 0.4);
  assert.equal(score.sample_count, 3);
});

test("작품 사실 카드 표가 비어 있는 채로 생긴다", () => {
  assert.equal(rowCount("work_facts"), 0);
  assert.deepEqual(listWorkFactTitles(1), []);
});

test("카드를 넣고 제목으로 꺼내면 장면 목록이 되돌아온다", () => {
  saveWorkFact(
    1,
    {
      title: "여름 언덕",
      summary: "고향에 돌아온 사람이 옛 친구를 다시 만나는 이야기",
      scenes: ["첫 장면의 버스 정류장", "비 오는 날의 다툼"],
      differences: null,
    },
    "2026-09-11 05:00:00",
  );
  assert.deepEqual(listWorkFactTitles(1), ["여름 언덕"]);
  const [card] = getWorkFactsByTitles(1, ["여름 언덕", "없는 작품"]);
  assert.equal(card?.summary, "고향에 돌아온 사람이 옛 친구를 다시 만나는 이야기");
  assert.deepEqual(card?.scenes, ["첫 장면의 버스 정류장", "비 오는 날의 다툼"]);
  assert.equal(card?.differences, null);
  assert.deepEqual(getWorkFactsByTitles(1, []), []);
});

test("같은 제목을 다시 넣으면 카드가 갈린다 — 한 작품에 한 줄", () => {
  saveWorkFact(
    1,
    {
      title: "여름 언덕",
      summary: "다시 찾아본 줄거리",
      scenes: ["새로 적은 장면"],
      differences: "이번 판은 결말이 다르다",
    },
    "2026-09-12 05:00:00",
  );
  assert.equal(rowCount("work_facts"), 1);
  const [card] = getWorkFactsByTitles(1, ["여름 언덕"]);
  assert.equal(card?.summary, "다시 찾아본 줄거리");
  assert.equal(card?.differences, "이번 판은 결말이 다르다");
});
