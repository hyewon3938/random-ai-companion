// 문화 스크립트 표가 없던 v12 DB가 v13으로 올라가는 자리를 검사한다(#405).
//
// 새 표는 createSchema가 만들고 v13 절차는 버전만 올린다 — v11이 같은 꼴이다. 여기서 봐야 할 것은
// 올라가는 김에 있던 행이 다치지 않는지와, 새 표가 비어 있는 채로 생기는 게 아니라 코드에 적힌
// 원본으로 차 있는지다. 이 표만 기동할 때마다 지우고 다시 넣는 유일한 표라, 그 절차가 이미 있는
// 캐릭터 행을 건드리면 옮기는 자리에서 바로 드러나야 한다.
//
// DB는 임시 파일로 새로 만들고, v12 모양은 이 파일이 손으로 세운다. 나머지 표는 기동할 때
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

// v12 시절의 characters·schedules를 손으로 세운다. 일정의 원본 두 칸(parent_kind·parent_id)은
// v12에도 있었다 — 선언만 되어 있고 읽고 쓰는 코드가 없었을 뿐이라 옮길 칸이 없다.
const seed = new Database(DB_PATH);
seed.exec(`
  CREATE TABLE characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
    genesis_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER NOT NULL REFERENCES characters(id),
    owner TEXT NOT NULL CHECK (owner IN ('char','user')),
    date TEXT NOT NULL,
    time_hint TEXT,
    content TEXT NOT NULL,
    with_name TEXT,
    area TEXT,
    user_knows TEXT NOT NULL DEFAULT 'unknown' CHECK (user_knows IN ('unknown','known','waiting')),
    origin TEXT NOT NULL DEFAULT 'conversation' CHECK (origin IN ('conversation','rhythm','ongoing')),
    parent_kind TEXT CHECK (parent_kind IN ('memory','schedule')),
    parent_id INTEGER,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','deferred')),
    created_at TEXT NOT NULL
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
    `INSERT INTO schedules (character_id, owner, date, content, origin, created_at)
     VALUES (1, 'char', '2026-10-17', '청주 부모님 댁', 'rhythm', '2026-09-01 10:00:00')`,
  )
  .run();
seed.pragma("user_version = 12");
seed.close();

// DB 경로를 정하고 v12 모양을 세운 뒤에 읽어야 이 파일이 열린다 — 읽는 순간 마이그레이션이 돈다.
const { db, CULTURE_SCRIPTS, getCultureScript, seedCultureScripts } =
  await import("../src/db.js");

const scriptRows = (): number =>
  (db.prepare(`SELECT count(*) c FROM culture_scripts`).get() as { c: number })
    .c;

test("v12 DB가 지금 스키마 버전까지 올라간다", () => {
  assert.equal(db.pragma("user_version", { simple: true }), 14);
});

test("있던 캐릭터와 일정은 그대로 남는다", () => {
  assert.deepEqual(
    db.prepare(`SELECT id, chat_id, created_at FROM characters`).all(),
    [{ id: 1, chat_id: "chat-1", created_at: "2026-09-01 10:00:00" }],
  );
  assert.deepEqual(
    db
      .prepare(`SELECT content, origin, parent_kind, parent_id FROM schedules`)
      .all(),
    [
      {
        content: "청주 부모님 댁",
        origin: "rhythm",
        parent_kind: null,
        parent_id: null,
      },
    ],
  );
});

test("문화 스크립트 표가 코드에 적힌 원본으로 차 있다", () => {
  assert.equal(
    scriptRows(),
    CULTURE_SCRIPTS.reduce((n, s) => n + s.steps.length, 0),
  );
  assert.ok(getCultureScript("명절", "본인").length > 0, "명절 줄이 없다");
});

test("다시 기동하면 손으로 고친 줄이 원본으로 돌아가고 행이 겹쳐 쌓이지 않는다", () => {
  const before = scriptRows();
  const original = getCultureScript("명절", "본인")[0]?.step;
  db.prepare(
    `UPDATE culture_scripts SET step = '손으로 고친 줄'
     WHERE locale = 'KR' AND event = '명절' AND role = '본인' AND step_no = 1`,
  ).run();
  db.prepare(
    `INSERT INTO culture_scripts (locale, event, role, step_no, days_before, step)
     VALUES ('KR', '없는 이벤트', '본인', 1, 0, '손으로 넣은 줄')`,
  ).run();

  seedCultureScripts();

  assert.equal(scriptRows(), before);
  assert.equal(getCultureScript("명절", "본인")[0]?.step, original);
  assert.equal(getCultureScript("없는 이벤트", "본인").length, 0);
});

test("원본에 없는 국적의 줄은 다시 넣을 때도 남는다", () => {
  db.prepare(
    `INSERT INTO culture_scripts (locale, event, role, step_no, days_before, step)
     VALUES ('JP', '결혼', '본인', 1, 30, '다른 국적의 줄')`,
  ).run();

  seedCultureScripts();

  assert.equal(getCultureScript("결혼", "본인", "JP").length, 1);
  db.prepare(`DELETE FROM culture_scripts WHERE locale = 'JP'`).run();
});

test("무결성과 외래 키가 깨끗하다", () => {
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  assert.equal((db.pragma("foreign_key_check") as unknown[]).length, 0);
});
