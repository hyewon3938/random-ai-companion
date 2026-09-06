// 선제 발화 카운터(proactive-policy.ts)와 유저 이어 보내기 텀(reply-timing.ts)의 검사.
//
// 카운터는 캐릭터 말의 meta_json 패턴으로 세는 자리라 임시 DB에 메시지를 심어 값을 본다.
// 이어 보내기 텀은 순수 함수라 행 목록만 넣는다.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "proactive-counters-")), "t.db");
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

const { db, logMessage } = await import("../src/db.js");
const { createFixtureCharacter } = await import("../src/eval/fixture-character.js");
const {
  awayNoticeCountToday,
  awayNoticeSent,
  mendSentSince,
  proactiveCountToday,
  proactiveKindCountToday,
  proactiveSinceLastUser,
} = await import("../src/proactive-policy.js");
const { userBurstGaps } = await import("../src/reply-timing.js");

const CHAT = "chat-counters";
const SINCE = "2026-09-06 05:00:00";
let characterId = 0;

before(() => {
  characterId = createFixtureCharacter(CHAT);
  const say = (at: string, meta?: Record<string, unknown>): void =>
    logMessage(CHAT, characterId, "assistant", "말", at, meta);
  // 어제 것은 오늘 집계에 들어가지 않는다
  say("2026-09-05 22:00:00", { kind: "checkin", proactive: true });
  say("2026-09-06 08:00:00", { kind: "morning", proactive: true });
  say("2026-09-06 09:00:00", { kind: "away", proactive: true, block: "09:30" });
  say("2026-09-06 11:00:00", { kind: "away", proactive: true, return: true, block: "09:30" });
  say("2026-09-06 12:00:00", { kind: "reply" });
  logMessage(CHAT, characterId, "user", "응", "2026-09-06 12:30:00");
  say("2026-09-06 13:00:00", { kind: "reply" });
  say("2026-09-06 14:00:00", { kind: "checkin", proactive: true });
  say("2026-09-06 15:00:00", { kind: "mend", proactive: true });
});
after(() => {
  db.close();
});

test("오늘 선톡 수는 자리 비움을 빼고 센다", () => {
  assert.equal(proactiveCountToday(CHAT, SINCE), 3);
  assert.equal(proactiveKindCountToday(CHAT, SINCE, "checkin"), 1);
  assert.equal(proactiveKindCountToday(CHAT, SINCE, "morning"), 1);
});

test("자리 비움 예고는 블록별로 찾고 복귀 인사는 빼고 센다", () => {
  assert.equal(awayNoticeSent(CHAT, SINCE, "09:30"), true);
  assert.equal(awayNoticeSent(CHAT, SINCE, "18:00"), false);
  assert.equal(awayNoticeCountToday(CHAT, SINCE), 1);
});

test("마지막 유저 말 이후 구간만 본다", () => {
  assert.equal(proactiveSinceLastUser(CHAT), 2);
  // 달래기는 상대 상태가 시작된 시각 뒤로만 찾는다
  assert.equal(mendSentSince(CHAT, "2026-09-06 12:30:00"), true);
  assert.equal(mendSentSince(CHAT, "2026-09-06 15:30:00"), false);
  // 유저가 한 번도 말하지 않은 방은 대화 전체를 본다
  logMessage("chat-quiet", characterId, "assistant", "말", "2026-09-06 09:00:00", {
    kind: "checkin",
    proactive: true,
  });
  assert.equal(proactiveSinceLastUser("chat-quiet"), 1);
  assert.equal(mendSentSince("chat-quiet", "2026-09-06 00:00:00"), false);
});

test("유저가 이어 보낸 텀만 세고 답장이 끼거나 2분을 넘으면 뺀다", () => {
  const rows = [
    { role: "user", sent_at: "2026-09-06 10:00:00" },
    { role: "user", sent_at: "2026-09-06 10:00:20" },
    { role: "assistant", sent_at: "2026-09-06 10:01:00" },
    { role: "user", sent_at: "2026-09-06 10:02:00" },
    { role: "user", sent_at: "2026-09-06 10:05:00" },
    { role: "user", sent_at: "2026-09-06 10:05:05" },
  ];
  assert.deepEqual(userBurstGaps(rows), [20000, 5000]);
  assert.deepEqual(userBurstGaps([]), []);
});
