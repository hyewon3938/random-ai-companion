// 답이 없는 날 낮에 나가는 선톡의 조건을 검사한다 — 모델은 부르지 않는다(이슈 #314).
//
// 이틀째에 나가는 점심 한 통은 lunchDueToday가 정하고, 그날 아침 문안이 아직 안 나갔는지는
// hasPendingSendOn이 본다. 둘 다 저장된 값을 읽으므로 임시 DB에 메시지와 예약 행을 심는다.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "daytime-followup-")), "t.db");
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

const {
  db,
  getPendingSends,
  hasPendingSendOn,
  insertScheduledSend,
  logMessage,
  markScheduledSend,
} = await import("../src/db.js");
const { kstLogicalDate } = await import("../src/kst.js");
const { createFixtureCharacter } = await import("../src/eval/fixture-character.js");
const { dailySendPlan, lunchDueToday } = await import("../src/proactive-policy.js");

// 침묵 일수는 오늘 논리일에서 거슬러 세므로 기준 날짜도 같은 함수에서 받는다.
const TODAY = kstLogicalDate();
const dayAgo = (n: number): string =>
  new Date(new Date(`${TODAY}T00:00:00Z`).getTime() - n * 86_400_000)
    .toISOString()
    .slice(0, 10);

// 마지막 유저 말이 n일 전인 방을 만든다. 정오로 적어 논리일이 그 날짜와 같게 둔다.
const roomSilentFor = (n: number): { chatId: string; characterId: number } => {
  const chatId = `chat-silent-${n}`;
  const characterId = createFixtureCharacter(chatId);
  logMessage(chatId, characterId, "user", "응", `${dayAgo(n)} 12:00:00`);
  return { chatId, characterId };
};

let day2 = { chatId: "", characterId: 0 };

before(() => {
  day2 = roomSilentFor(2);
});
after(() => {
  db.close();
});

test("점심 한 통은 무응답 이틀째에만 나간다", () => {
  const today = roomSilentFor(0);
  const day1 = roomSilentFor(1);
  const day3 = roomSilentFor(3);
  assert.equal(lunchDueToday(today.chatId, today.characterId), false);
  assert.equal(lunchDueToday(day1.chatId, day1.characterId), false);
  assert.equal(lunchDueToday(day2.chatId, day2.characterId), true);
  // 3일째부터는 조용한 단계라 낮에도 보내지 않는다
  assert.equal(lunchDueToday(day3.chatId, day3.characterId), false);
});

test("이틀째에 미리 만들어 두는 선톡은 그대로 아침 한 통이다", () => {
  const plan = dailySendPlan(day2.chatId, day2.characterId, TODAY);
  assert.equal(plan.kind, "morning");
  assert.equal(plan.tier, "normal");
  assert.equal(plan.days, 2);
});

test("아직 안 나간 아침 문안이 있으면 hasPendingSendOn이 참이다", () => {
  const { chatId, characterId } = day2;
  insertScheduledSend(
    characterId,
    chatId,
    TODAY,
    "09:00",
    "10:00",
    "잘 잤어?",
    `${TODAY} 04:30:00`,
  );
  assert.equal(hasPendingSendOn(characterId, TODAY), true);
  // 다른 날짜의 행은 오늘 판단에 들어가지 않는다
  assert.equal(hasPendingSendOn(characterId, dayAgo(1)), false);

  const row = getPendingSends(TODAY).find((r) => r.character_id === characterId);
  assert.ok(row);
  markScheduledSend(row.id, "sent", null, `${TODAY} 09:12:00`);
  assert.equal(hasPendingSendOn(characterId, TODAY), false);
});
