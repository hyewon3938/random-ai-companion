// 유저가 오래 답이 없을 때 물러나는 단계(proactive-policy.ts)를 검사한다 — 모델은 부르지 않는다.
//
// silenceState가 마지막 유저 말에서 며칠 지났는지로 normal·quiet·checkin·dormant를 가르고,
// proactiveAllowed가 그중 normal에서만 선톡을 허락하며, dailySendPlan이 단계마다 아침 한 통·
// 안부·안 보냄 중 무엇을 고르는지 본다. 경계는 QUIET_AFTER_DAYS·RECONNECT_AT_DAYS를 그대로 쓴다.
// 모두 저장된 말과 일정을 읽는 자리라 임시 DB에 심는다. normal의 아침 한 통은
// daytime-followup.test.ts가 이미 보므로 여기서는 다루지 않는다.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { QUIET_AFTER_DAYS, RECONNECT_AT_DAYS } from "../src/thresholds.js";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "proactive-silence-")),
  "t.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

const { addSchedule, db, logMessage } = await import("../src/db.js");
const { kstLogicalDate } = await import("../src/kst.js");
const { createFixtureCharacter } =
  await import("../src/eval/fixture-character.js");
const { dailySendPlan, proactiveAllowed, silenceState } =
  await import("../src/proactive-policy.js");

// 침묵 일수는 오늘 논리일에서 거슬러 세므로 기준 날짜도 같은 함수에서 받는다.
const TODAY = kstLogicalDate();
const dayAgo = (n: number): string =>
  new Date(new Date(`${TODAY}T00:00:00Z`).getTime() - n * 86_400_000)
    .toISOString()
    .slice(0, 10);

let seq = 0;
// 마지막 유저 말이 n일 전인 방을 만든다. 정오로 적어 논리일이 그 날짜와 같게 둔다.
const roomSilentFor = (n: number): { chatId: string; characterId: number } => {
  const chatId = `chat-silence-${n}-${++seq}`;
  const characterId = createFixtureCharacter(chatId);
  logMessage(chatId, characterId, "user", "응", `${dayAgo(n)} 12:00:00`);
  return { chatId, characterId };
};

// 14일째 안부 선톡이 이미 나간 방 — 마지막 유저 말 뒤에 kind:checkin 캐릭터 말이 있다.
const roomAfterCheckin = (): { chatId: string; characterId: number } => {
  const room = roomSilentFor(RECONNECT_AT_DAYS);
  logMessage(
    room.chatId,
    room.characterId,
    "assistant",
    "잘 지내?",
    `${dayAgo(RECONNECT_AT_DAYS - 1)} 18:00:00`,
    { kind: "checkin", proactive: true },
  );
  return room;
};

after(() => {
  db.close();
});

// ── silenceState ───────────────────────────────────────────────────────

test("사흘이 안 됐으면 normal이고 정확히 사흘째부터 quiet다", () => {
  const two = roomSilentFor(QUIET_AFTER_DAYS - 1);
  const s2 = silenceState(two.chatId, two.characterId);
  assert.equal(s2.tier, "normal");
  assert.equal(s2.days, QUIET_AFTER_DAYS - 1);

  const three = roomSilentFor(QUIET_AFTER_DAYS);
  const s3 = silenceState(three.chatId, three.characterId);
  assert.equal(s3.tier, "quiet");
  assert.equal(s3.days, QUIET_AFTER_DAYS);
});

test("14일이 되기 전날까지는 quiet다", () => {
  const room = roomSilentFor(RECONNECT_AT_DAYS - 1);
  const s = silenceState(room.chatId, room.characterId);
  assert.equal(s.tier, "quiet");
  assert.equal(s.days, RECONNECT_AT_DAYS - 1);
});

test("14일째에 안부 선톡이 아직 없으면 checkin이다", () => {
  const room = roomSilentFor(RECONNECT_AT_DAYS);
  const s = silenceState(room.chatId, room.characterId);
  assert.equal(s.tier, "checkin");
  assert.equal(s.days, RECONNECT_AT_DAYS);
});

test("안부 선톡이 나간 뒤에도 답이 없으면 dormant다", () => {
  const room = roomAfterCheckin();
  const s = silenceState(room.chatId, room.characterId);
  assert.equal(s.tier, "dormant");
  assert.equal(s.days, RECONNECT_AT_DAYS);
});

test("유저가 한 번도 말하지 않은 방은 캐릭터가 생긴 날부터 센다", () => {
  const chatId = "chat-silence-never";
  const characterId = createFixtureCharacter(chatId);
  const s = silenceState(chatId, characterId);
  assert.equal(s.tier, "normal");
  assert.equal(s.days, 0);
});

// ── proactiveAllowed ───────────────────────────────────────────────────

test("선톡은 normal에서만 허락하고 quiet·checkin·dormant는 막는다", () => {
  const normal = roomSilentFor(1);
  const quiet = roomSilentFor(QUIET_AFTER_DAYS);
  const checkin = roomSilentFor(RECONNECT_AT_DAYS);
  const dormant = roomAfterCheckin();
  assert.equal(proactiveAllowed(normal.chatId, normal.characterId), true);
  assert.equal(proactiveAllowed(quiet.chatId, quiet.characterId), false);
  assert.equal(proactiveAllowed(checkin.chatId, checkin.characterId), false);
  assert.equal(proactiveAllowed(dormant.chatId, dormant.characterId), false);
});

// ── dailySendPlan ──────────────────────────────────────────────────────

test("quiet에 상대 일정이 없으면 보내지 않는다", () => {
  const room = roomSilentFor(QUIET_AFTER_DAYS);
  const plan = dailySendPlan(room.chatId, room.characterId, TODAY);
  assert.equal(plan.kind, "none");
  assert.equal(plan.tier, "quiet");
  assert.equal(plan.days, QUIET_AFTER_DAYS);
  assert.match(plan.reason, /조용/);
});

test("quiet라도 오늘 상대 일정이 있으면 아침에 한 통 보낸다", () => {
  const room = roomSilentFor(QUIET_AFTER_DAYS);
  addSchedule(
    room.characterId,
    "user",
    TODAY,
    null,
    "치과 예약",
    `${TODAY} 04:00:00`,
    "conversation",
  );
  const plan = dailySendPlan(room.chatId, room.characterId, TODAY);
  assert.equal(plan.kind, "morning");
  assert.equal(plan.tier, "quiet");
  assert.match(plan.reason, /일정/);
});

test("checkin 단계면 안부 선톡을 고른다", () => {
  const room = roomSilentFor(RECONNECT_AT_DAYS);
  const plan = dailySendPlan(room.chatId, room.characterId, TODAY);
  assert.equal(plan.kind, "checkin");
  assert.equal(plan.tier, "checkin");
  assert.equal(plan.days, RECONNECT_AT_DAYS);
});

test("dormant 단계면 보내지 않고 이유에 안부 뒤 침묵을 적는다", () => {
  const room = roomAfterCheckin();
  const plan = dailySendPlan(room.chatId, room.characterId, TODAY);
  assert.equal(plan.kind, "none");
  assert.equal(plan.tier, "dormant");
  assert.match(plan.reason, /안부/);
  assert.match(plan.reason, /조용/);
});
