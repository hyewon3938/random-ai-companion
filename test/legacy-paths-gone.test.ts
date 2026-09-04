// 지운 옛 경로가 코드에 다시 들어오지 않는지 검사한다.
//
// 표와 컬럼은 마이그레이션이 지우지만, 그 이름을 부르는 코드가 어딘가 남아 있으면 배포한 날
// 밤에 질의가 터진다. 타입체크는 SQL 문자열 안의 이름을 못 잡아서 여기서 글자로 센다.
// 지우고 나서 다시 들여오는 것도 같이 막는다 — 새 코드가 옛 이름을 쓰면 이 검사가 걸린다.
//
// 파일만 읽는다. DB도 모델도 부르지 않아 값이 안 든다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const tsFiles = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? tsFiles(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );

// 도는 코드만 센다. 검사 파일은 지운 이름을 일부러 문자열로 들고 있어서 여기서 뺀다.
const ALL = tsFiles("src");

const hits = (name: string, skip: string[]): string[] => {
  const word = new RegExp(`\\b${name}\\b`);
  return ALL.filter(
    (f) => !skip.includes(f) && word.test(readFileSync(join(ROOT, f), "utf8")),
  );
};

// 지운 함수·상수·타입. 부르는 곳이 하나도 없어야 한다.
const GONE_SYMBOLS = [
  "RelationshipState",
  "emptyRelationshipState",
  "getRelationshipState",
  "saveRelationshipState",
  "CastMember",
  "getCast",
  "addCastMember",
  "speechGuard",
  "UserPreferences",
  "getUserPreferences",
  "saveUserPreferences",
  "DAEPYO_BIBLE",
  "DAEPYO_CAST",
  "createDaepyoCharacter",
  "OUTPUT_FORMAT_COMPACT",
];

// 지운 표·컬럼 이름. 일부러 이름을 남긴 파일만 예외로 둔다.
const MIGRATION_TOOLS = [
  join("src", "tools", "migrate-v1-data.ts"),
  join("src", "tools", "migrate-v2-data.ts"),
];
const DB = join("src", "db.ts");

// db.ts는 v6에서 이 자리를 지우는 파일이라 이름이 남는다. 이관 도구 둘은 한 번 돌고 끝난
// 기록이라 지우지 않고 두기로 했다(ADR 0005) — 지금은 실행되지 않는다.
const GONE_NAMES: [string, string[]][] = [
  ["cast_members", [DB, ...MIGRATION_TOOLS]],
  ["attention_override", [DB]],
  ["capture_marks", [DB]],
  ["user_preferences", [DB]],
  ["memory_items_legacy", [DB, ...MIGRATION_TOOLS]],
  ["legacy_state_json", [DB, ...MIGRATION_TOOLS]],
  ["last_contact_at", [DB]],
  // character.ts의 age_band는 옛 바이블 JSON의 키라 컬럼과 무관하다.
  ["age_band", [DB, join("src", "character.ts"), join("src", "context.ts")]],
];

test("지운 함수·상수를 부르는 곳이 없다", () => {
  for (const name of GONE_SYMBOLS)
    assert.deepEqual(hits(name, []), [], `${name}이 남아 있다`);
});

test("지운 표·컬럼 이름이 도는 코드에 없다", () => {
  for (const [name, skip] of GONE_NAMES)
    assert.deepEqual(hits(name, skip), [], `${name}이 남아 있다`);
});

test("지운 개발 화면 파일이 없다", () => {
  for (const f of ["render-map.ts", "render-user.ts"])
    assert.equal(
      ALL.includes(join("src", "tools", f)),
      false,
      `${f}이 남아 있다`,
    );
});
