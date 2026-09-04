// 평가 실행기가 쓰는 고정 캐릭터가 실제로 저장되는지 검사한다.
//
// 평가는 캐릭터가 있어야 프롬프트를 조립한다. 그 자리를 옛 대표 캐릭터에서 고정 재료 한 벌로
// 바꿨는데, 재료가 생성 검사에 걸리거나 저장이 비면 평가는 모델을 부르고 나서야 멈춘다.
// 값이 드는 호출 앞에서 막으려고 검사를 여기에 둔다.
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
const { genesisProblem } = await import("../src/character.js");
const { EVAL_GENESIS, createFixtureCharacter } =
  await import("../src/eval/fixture-character.js");

test("고정 재료가 생성 검사를 통과한다", () => {
  assert.equal(genesisProblem(EVAL_GENESIS), null);
});

test("캐릭터 행과 기억이 저장된다", () => {
  const id = createFixtureCharacter("chat-eval");
  assert.ok(id > 0);

  const character = db
    .prepare(`SELECT chat_id, status FROM characters WHERE id = ?`)
    .get(id) as { chat_id: string; status: string } | undefined;
  assert.deepEqual(character, { chat_id: "chat-eval", status: "active" });

  const counts = db
    .prepare(
      `SELECT item_type AS t, count(*) AS n FROM memory_items
        WHERE character_id = ? GROUP BY item_type`,
    )
    .all(id) as { t: string; n: number }[];
  const byType = new Map(counts.map((r) => [r.t, r.n]));
  assert.equal(byType.get("fact"), EVAL_GENESIS.identity.length);
  assert.equal(byType.get("person"), EVAL_GENESIS.cast.length);
  assert.equal(byType.get("ongoing"), EVAL_GENESIS.ongoing.length);

  const relation = db
    .prepare(`SELECT stage, history FROM relationships WHERE character_id = ?`)
    .get(id) as { stage: string; history: string };
  assert.equal(relation.stage, EVAL_GENESIS.relationship.stage);
  assert.equal(relation.history, EVAL_GENESIS.relationship.history);
});
