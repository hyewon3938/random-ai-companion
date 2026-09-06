// 어젯밤 잠이 각본 생성 프롬프트와 새벽 정리 재료에 들어가는지 검사한다 — 모델은 부르지 않는다.
//
// 어제 각본의 밤 잠 블록과 어제 논리일 안 캐릭터의 마지막 말에서 잠든 시각을 뽑고, 충분히 잔
// 기준 시각과 함께 각본 프롬프트의 [어젯밤 잠] 절에 넣는다(이슈 #289). 재료가 없으면 시드대로
// 가라고 적는다.
//
// DB는 임시 파일로 새로 만든다.
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

const { db, saveDayPlan, logMessage } = await import("../src/db.js");
const { buildPlanPrompt, lastNightSleep } = await import("../src/day-plan.js");

const YESTERDAY = "2026-09-05";
const TODAY = "2026-09-06";

const character = db
  .prepare(
    `INSERT INTO characters (chat_id, status, genesis_json, created_at)
     VALUES ('1', 'active', '{}', '2026-08-30 12:00:00') RETURNING *`,
  )
  .get() as CharacterRow;

test("어제 각본도 대화도 없으면 시드대로 간다", () => {
  assert.equal(lastNightSleep(character.id, TODAY), null);
  assert.match(buildPlanPrompt(character.id, TODAY), /\(어젯밤 기록 없음 — 시드대로\)/);
});

test("각본의 잠 뒤에도 말을 했으면 마지막 말이 잠든 시각이다", () => {
  saveDayPlan(
    character.id,
    YESTERDAY,
    JSON.stringify({
      date: YESTERDAY,
      blocks: [
        { start: "05:00", end: "06:30", activity: "잠", responsiveness: "unavailable", advance_known: true },
        { start: "06:30", end: "24:30", activity: "하루", responsiveness: "instant", advance_known: true },
        { start: "24:30", end: "29:00", activity: "잠", responsiveness: "unavailable", advance_known: true },
      ],
    }),
    "nightly",
  );
  logMessage(character.chat_id, character.id, "assistant", "잘 자", `${YESTERDAY} 23:50:00`);
  logMessage(character.chat_id, character.id, "user", "아직 안 자?", `${TODAY} 02:10:00`);
  logMessage(character.chat_id, character.id, "assistant", "이제 잘게", `${TODAY} 02:40:00`);
  // 다음 논리일의 말은 어젯밤 잠에 들어가지 않는다
  logMessage(character.chat_id, character.id, "assistant", "좋은 아침", `${TODAY} 07:30:00`);

  assert.deepEqual(lastNightSleep(character.id, TODAY), {
    bedtime: "02:40",
    enoughSleepFrom: "08:40",
  });
  const prompt = buildPlanPrompt(character.id, TODAY);
  assert.match(prompt, /\[어젯밤 잠 — 오늘 피곤한지는 이 값으로 정한다\]\n- 어젯밤 02:40에 잠들었다\. 오늘 기상 시각이 08:40보다 이르면/);
  assert.doesNotMatch(prompt, /늦게 잤으면 오늘 피곤한 식으로/);
});
