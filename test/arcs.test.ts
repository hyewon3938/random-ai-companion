// 아크를 다시 쓰는 날을 날짜만 보고 정하는지, 이미 있는 아크를 다시 만들지 않는지 검사한다.
//
// arcRefreshTargets는 순수 함수라 그대로 부른다. ensureArcs는 아크가 하나라도 있으면 모델을
// 부르기 전에 돌아오므로, 임시 DB에 네 칸을 넣어 두고 불러서 값이 그대로인지 본다.
// 모델은 부르지 않는다 — API 키는 자리만 채운다.
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
const { db, getArcs, saveArc } = await import("../src/db.js");
const { arcRefreshTargets, ensureArcs } = await import("../src/arcs.js");

test("경계가 아닌 날은 아무 칸도 다시 쓰지 않는다", () => {
  assert.deepEqual(arcRefreshTargets("2026-09-08"), []); // 화요일, 8일
  assert.deepEqual(arcRefreshTargets("2026-09-15"), []); // 화요일, 15일
});

test("월요일은 이번 주만 다시 쓴다", () => {
  assert.deepEqual(arcRefreshTargets("2026-09-07"), ["week"]);
  assert.deepEqual(arcRefreshTargets("2026-09-14"), ["week"]);
});

test("1일은 이달을 다시 쓰고, 분기 시작 달이면 계절까지, 1월이면 올해까지", () => {
  assert.deepEqual(arcRefreshTargets("2026-02-01"), ["month"]); // 일요일
  assert.deepEqual(arcRefreshTargets("2026-05-01"), ["month"]); // 금요일
  assert.deepEqual(arcRefreshTargets("2026-03-01"), ["month", "season"]);
  assert.deepEqual(arcRefreshTargets("2026-09-01"), ["month", "season"]); // 화요일
  assert.deepEqual(arcRefreshTargets("2026-12-01"), ["month", "season"]);
  assert.deepEqual(arcRefreshTargets("2026-01-01"), ["month", "year"]);
});

test("월요일이면서 1일이면 이번 주와 이달을 함께 다시 쓴다", () => {
  assert.deepEqual(arcRefreshTargets("2026-06-01"), [
    "week",
    "month",
    "season",
  ]);
});

test("이미 아크가 있으면 ensureArcs는 모델을 부르지 않고 값을 그대로 둔다", async () => {
  const { id } = db
    .prepare(
      `INSERT INTO characters (chat_id, status, genesis_json, created_at)
       VALUES ('1', 'active', '{}', '2026-09-06 12:00:00') RETURNING id`,
    )
    .get() as { id: number };
  saveArc(id, "year", "올해");
  saveArc(id, "season", "계절");
  saveArc(id, "month", "이달");
  saveArc(id, "week", "이번 주");
  await ensureArcs(id, "(인물 재료)");
  assert.deepEqual(getArcs(id), {
    year: "올해",
    season: "계절",
    month: "이달",
    week: "이번 주",
  });
});
