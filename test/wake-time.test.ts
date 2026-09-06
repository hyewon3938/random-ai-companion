// 자는 시간에 깬 시각이 프롬프트와 새벽 정리 재료에 실제 값으로 들어가는지 검사한다 — 모델은 부르지 않는다.
//
// 답장 텀 판정이 잠 블록의 첫 연락에 남긴 깸 행을, 지금 상황 문단은 깬 시각과 깨어 있는 분으로
// 옮기고, 새벽 정리는 각본과 달라진 블록 줄에 그렇게 된 시각을 붙인다(이슈 #288). 둘 다 모델이
// 몇 시에 깼는지 어림하지 않게 코드가 세어 준 값이어야 한다.
//
// DB는 임시 파일로 새로 만든다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CharacterRow } from "../src/db.js";
import type { PlanBlock } from "../src/day-plan.js";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

const { db, saveDayPlan, recordDayActual } = await import("../src/db.js");
const { isSleeping } = await import("../src/day-plan.js");
const { wokeNowLine } = await import("../src/context.js");
const { logicalClockOf } = await import("../src/kst.js");
const { gatherNightlyInput } = await import("../src/nightly.js");
const { WOKE_OUTCOME } = await import("../src/labels.js");

const DIARY_DATE = "2026-09-05";

const character = db
  .prepare(
    `INSERT INTO characters (chat_id, status, genesis_json, created_at)
     VALUES ('1', 'active', '{}', '2026-08-30 12:00:00') RETURNING *`,
  )
  .get() as CharacterRow;

const sleep: PlanBlock = {
  start: "23:30",
  end: "30:30",
  activity: "잠",
  responsiveness: "unavailable",
  advance_known: false,
};

test("벽시계 시각을 각본 표기로 옮긴다 — 자정 뒤는 24를 더한다", () => {
  assert.equal(logicalClockOf("2026-09-06 02:10:00"), "26:10");
  assert.equal(logicalClockOf("2026-09-06 14:05:00"), "14:05");
  assert.equal(logicalClockOf("2026-09-06 04:59:00"), "28:59");
  assert.equal(logicalClockOf("2026-09-06 05:00:00"), "05:00");
});

test("잠 블록 판정은 잘 준비를 잠으로 치지 않는다", () => {
  assert.equal(isSleeping(sleep), true);
  assert.equal(isSleeping({ ...sleep, activity: "잘 준비" }), false);
  assert.equal(isSleeping({ ...sleep, responsiveness: "intermittent" }), false);
});

test("깬 뒤의 지금 문장은 기록된 시각과 깨어 있는 분을 그대로 쓴다", () => {
  const line = wokeNowLine(sleep, "2026-09-06 02:10:00", "26:45");
  assert.match(line, /23:30~06:30 자는 시간이지만 02:10에 상대 연락에 깼고/);
  assert.match(line, /지금 35분째 깨어 있다/);
  assert.match(line, /답장 여건은 즉답/);
  // 시작 몇 분째·끝나기까지 몇 분 같은 일 블록 표현은 없다
  assert.doesNotMatch(line, /끝나기까지/);
});

test("깬 직후에는 0분째로 세고 음수가 나오지 않는다", () => {
  const line = wokeNowLine(sleep, "2026-09-06 02:10:00", "26:10");
  assert.match(line, /지금 0분째 깨어 있다/);
});

test("새벽 정리 재료의 달라진 블록 줄에 그렇게 된 시각이 붙는다", () => {
  saveDayPlan(
    character.id,
    DIARY_DATE,
    JSON.stringify({ date: DIARY_DATE, blocks: [sleep] }),
    "nightly",
  );
  recordDayActual(
    character.id,
    DIARY_DATE,
    sleep.start,
    sleep.activity,
    WOKE_OUTCOME,
    "자는데 연락이 와서",
    "2026-09-06 02:10:00",
  );
  const g = gatherNightlyInput(character, DIARY_DATE);
  assert.deepEqual(g.dayActuals, [
    `- 23:30 잠 → ${WOKE_OUTCOME} 02:10 (자는데 연락이 와서)`,
  ]);
});
