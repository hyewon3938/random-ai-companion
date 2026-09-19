// 새벽 정리가 캐릭터의 오늘 생긴 마음을 비우는 기준을 검사한다 — 모델은 부르지 않는다(#473).
//
// 마음은 하루 동안만 두는 값이라 새벽 정리가 그 하루를 닫을 때 비운다. 창은 상대 상태와 같아서,
// 정리하는 날의 다음 날 05:00 전에 생긴 마음은 비우고 그 뒤에 생긴 마음(새벽 정리가 늦게 돈 날
// 새로 나눈 대화에서 생긴 것)은 오늘 것이라 남긴다. DB는 임시 파일로 새로 만든다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CharacterRow } from "../src/db.js";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

const { db, setMind } = await import("../src/db.js");
const { gatherNightlyInput, applyNightlyOutput } = await import(
  "../src/nightly.js"
);
const { kstLogicalDate, shiftDate } = await import("../src/kst.js");

// 새벽 정리는 하루에 한 번만 반영된다 — 회차마다 날짜를 가른다.
const DAY = (back: number) => shiftDate(kstLogicalDate(), -back);

const character = db
  .prepare(
    `INSERT INTO characters (chat_id, status, genesis_json, created_at)
     VALUES ('1', 'active', '{}', '2026-08-30 12:00:00') RETURNING *`,
  )
  .get() as CharacterRow;
db.prepare(
  `INSERT INTO relationships (character_id, met_at, stage_no, stage_since) VALUES (?, ?, 1, ?)`,
).run(character.id, "2026-08-30", "2026-08-30");

const entry = {
  diary: "",
  plan_vs_actual: "",
  user_mood: "",
  closeness: "",
  tomorrow: [],
  tags: [],
};

const mindKind = (): unknown =>
  (
    db
      .prepare(`SELECT mind_kind FROM relationships WHERE character_id = ?`)
      .get(character.id) as { mind_kind: unknown }
  ).mind_kind;

const run = (day: string): string =>
  applyNightlyOutput(gatherNightlyInput(character, day), {
    entry,
    extract: { memories: [], schedules: [] },
  });

test("정리하는 날의 다음 날 05:00 전에 생긴 마음은 비운다", () => {
  setMind(character.id, {
    kind: "hurt",
    level: 2,
    reason: "약속을 잊었다",
    since: `${DAY(2)} 04:30:00`,
  });
  const out = run(DAY(3));
  assert.equal(mindKind(), null);
  assert.ok(out.includes(", 캐릭터 마음 비움"));
});

test("그 창이 닫힌 뒤에 생긴 마음은 오늘 것이라 남긴다", () => {
  setMind(character.id, {
    kind: "flutter",
    level: 1,
    reason: "보고 싶었다고 했다",
    since: `${DAY(1)} 05:10:00`,
  });
  const out = run(DAY(2));
  assert.equal(mindKind(), "flutter");
  assert.ok(!out.includes("캐릭터 마음 비움"));
});
