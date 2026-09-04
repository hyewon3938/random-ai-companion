// 빈 DB에서 지금 스키마가 그대로 서는지 검사한다.
//
// 옛 표와 컬럼을 지우는 마이그레이션(v6)을 더하면서 정의부도 같이 줄였다. 정의부와
// 마이그레이션이 어긋나면 새로 만든 DB에만 옛 자리가 남거나 반대로 새 자리가 빠지는데,
// 둘 다 부팅에서는 조용하고 한참 뒤 질의에서 터진다. 여기서 새로 만든 DB의 버전과
// 없어야 할 자리를 못 박는다.
//
// DB는 임시 파일로 새로 만든다. 모델도 텔레그램도 부르지 않아 값이 안 든다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

// DB 경로를 정한 뒤에 읽어야 임시 파일로 열린다 — 정적 import는 이 줄들보다 먼저 돈다.
const { db } = await import("../src/db.js");

const GONE_TABLES = [
  "cast_members",
  "attention_override",
  "capture_marks",
  "user_preferences",
  "memory_items_legacy",
];

const GONE_COLUMNS: [string, string][] = [
  ["relationships", "legacy_state_json"],
  ["relationships", "last_contact_at"],
  ["user_profile", "age_band"],
];

const tableExists = (name: string): boolean =>
  db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) !== undefined;

const columnNames = (table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (c) => c.name,
  );

test("빈 DB는 최신 버전으로 선다", () => {
  assert.equal(db.pragma("user_version", { simple: true }), 7);
});

test("새로 만든 DB에도 호출 관측 칸 둘이 있다", () => {
  const calls = columnNames("llm_calls");
  for (const c of ["stop_reason", "block_types"])
    assert.ok(calls.includes(c), `llm_calls.${c}이 없다`);
});

test("지운 표는 새로 만든 DB에도 없다", () => {
  for (const name of GONE_TABLES)
    assert.equal(tableExists(name), false, `${name}이 남아 있다`);
});

test("지운 컬럼은 새로 만든 DB에도 없다", () => {
  for (const [table, column] of GONE_COLUMNS)
    assert.equal(
      columnNames(table).includes(column),
      false,
      `${table}.${column}이 남아 있다`,
    );
});

test("남겨야 할 관계 항목과 유저 프로필 컬럼은 그대로다", () => {
  const relation = columnNames("relationships");
  for (const c of [
    "stage",
    "speech_level",
    "speech_note",
    "address_terms",
    "rapport",
    "cautions",
    "history",
    "feelings",
  ])
    assert.ok(relation.includes(c), `relationships.${c}이 없다`);

  const profile = columnNames("user_profile");
  for (const c of ["gender", "birth_year", "job", "region"])
    assert.ok(profile.includes(c), `user_profile.${c}이 없다`);
});

test("무결성과 외래 키가 깨끗하다", () => {
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  assert.equal((db.pragma("foreign_key_check") as unknown[]).length, 0);
});
