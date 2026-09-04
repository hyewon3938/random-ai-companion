// 호출 관측 칸이 없던 DB가 v7로 올라가면서 그 칸을 얻는지 검사한다.
//
// 운영 DB는 배포할 때 한 번 올라간다. 칸을 못 붙이면 그날부터 호출 기록이 통째로 실패하고
// (INSERT가 없는 컬럼을 적는다), 붙이면서 옆 값을 건드리면 지난 호출 기록이 어긋난다.
// 배포 전에 v6 모양을 손으로 만들어 왕복을 확인한다 — 칸이 생겼는지, 있던 행이 그대로인지,
// 새로 적는 호출에 두 값이 실제로 들어가는지.
//
// DB는 임시 파일로 새로 만들고, v6 모양은 이 파일이 손으로 세운다. 모델도 텔레그램도
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

// v6 시절의 llm_calls를 손으로 세운다 — 지금 정의부에 있는 stop_reason·block_types가 없는
// 모양이다. 나머지 표는 부팅할 때 createSchema가 만든다.
const seed = new Database(DB_PATH);
// characters는 부팅할 때 createSchema가 만든다. 그 전에 llm_calls에 행을 넣으려면 가리키는
// 표가 아직 없어도 되게 외래 키를 꺼 둔다 — 넣는 행의 character_id는 어차피 비어 있다.
seed.pragma("foreign_keys = OFF");
seed.exec(`
  CREATE TABLE llm_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER REFERENCES characters(id),
    chat_id TEXT,
    purpose TEXT NOT NULL,
    model TEXT NOT NULL,
    max_tokens INTEGER,
    attempt INTEGER NOT NULL DEFAULT 1,
    system_hashes TEXT,
    turns_hash TEXT,
    output_hash TEXT,
    input_tokens INTEGER,
    cache_write_tokens INTEGER,
    cache_read_tokens INTEGER,
    output_tokens INTEGER,
    latency_ms INTEGER,
    error TEXT,
    context_json TEXT,
    code_version TEXT,
    created_at TEXT NOT NULL,
    traced INTEGER NOT NULL DEFAULT 0
  );
`);
seed
  .prepare(
    `INSERT INTO llm_calls
       (id, purpose, model, output_tokens, latency_ms, created_at)
     VALUES (1, 'reply', 'claude-sonnet-5', 369, 4200, '2026-09-01 21:00:00')`,
  )
  .run();
seed.pragma("user_version = 6");
seed.close();

// DB 경로를 정하고 v6 모양을 세운 뒤에 읽어야 이 파일이 열린다 — 읽는 순간 마이그레이션이 돈다.
const { db, recordLlmCall } = await import("../src/db.js");

const columnNames = (table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (c) => c.name,
  );

test("v6 DB가 v7로 올라간다", () => {
  assert.equal(db.pragma("user_version", { simple: true }), 7);
});

test("호출 관측 칸 둘이 생긴다", () => {
  const calls = columnNames("llm_calls");
  for (const c of ["stop_reason", "block_types"])
    assert.ok(calls.includes(c), `llm_calls.${c}이 없다`);
});

test("이미 쌓인 호출은 그대로 남고 새 칸만 빈다", () => {
  const row = db
    .prepare(
      `SELECT purpose, model, output_tokens, latency_ms, stop_reason, block_types
         FROM llm_calls WHERE id = 1`,
    )
    .get() as {
    purpose: string;
    model: string;
    output_tokens: number;
    latency_ms: number;
    stop_reason: string | null;
    block_types: string | null;
  };
  assert.deepEqual(row, {
    purpose: "reply",
    model: "claude-sonnet-5",
    output_tokens: 369,
    latency_ms: 4200,
    stop_reason: null,
    block_types: null,
  });
});

test("새로 적는 호출에는 두 값이 들어간다", () => {
  const id = recordLlmCall({
    purpose: "reply",
    model: "claude-sonnet-5",
    system: [{ text: "규칙", cache: true }],
    turns: "[user] 안녕",
    output: "안녕!",
    usage: { input: 10, cacheWrite: 0, cacheRead: 100, output: 369 },
    latencyMs: 4200,
    stopReason: "max_tokens",
    blockTypes: "thinking:1,text:1",
  });
  const row = db
    .prepare(`SELECT stop_reason, block_types FROM llm_calls WHERE id = ?`)
    .get(id) as { stop_reason: string; block_types: string };
  assert.deepEqual(row, {
    stop_reason: "max_tokens",
    block_types: "thinking:1,text:1",
  });
});

test("무결성과 외래 키가 깨끗하다", () => {
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  assert.equal((db.pragma("foreign_key_check") as unknown[]).length, 0);
});
