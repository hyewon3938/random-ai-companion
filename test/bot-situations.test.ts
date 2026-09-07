// 텔레그램 답장 경로(bot.ts)의 순수 계산 — 토큰 가리기, 말풍선 나누기, 상황 문단 넷, 예고한 자리 비움 판정 — 을 검사한다.
//
// 토큰은 환경변수 값과 토큰 모양 둘 다 가려지고 보통 오류 문구는 그대로인지, 말풍선은 줄바꿈으로
// 나뉘고 빈 줄이 빠지는지, 상황 문단에 인자로 준 활동·약속이 들어가고 promiseSituation의 답장·선톡
// 분기가 다른지 본다. 예고한 자리 비움은 각본과 예고 기록을 임시 DB에 심고 Date만 고정해
// 15분 안팎을 가른다.
//
// bot.ts는 읽을 때 봇 객체와 핸들러만 만들고 폴링은 index.ts가 켠다 — 토큰은 가짜다. 모델 주소는
// 닫힌 포트라 값이 안 든다.
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";

// DB 경로를 정한 뒤에 읽어야 임시 파일로 열린다 — 정적 import는 이 줄들보다 먼저 돈다.
const { db, logMessage, saveDayPlan } = await import("../src/db.js");
const { config } = await import("../src/config.js");
const { createFixtureCharacter } = await import(
  "../src/eval/fixture-character.js"
);
const {
  farewellSituation,
  gatherSituation,
  promiseSituation,
  redactToken,
  returnSituation,
  splitBubbles,
  upcomingAnnouncedAway,
} = await import("../src/bot.js");
type PlanBlock = Parameters<typeof farewellSituation>[0];

// 진짜 토큰이 아니라 토큰 모양만 흉내 낸 값 — 여섯 자리 넘는 숫자, 콜론, 서른 자 넘는 꼬리.
const FAKE_TOKEN = "123456789:AAExampleFakeTokenForTestOnly_abcdefghijklmnop";

const clockToEpoch = (h: number, m: number): number =>
  Date.UTC(2026, 8, 7, h, m) - 9 * 3600_000;

const block = (
  start: string,
  end: string,
  activity: string,
  responsiveness: PlanBlock["responsiveness"] = "unavailable",
): PlanBlock => ({
  start,
  end,
  activity,
  responsiveness,
  advance_known: true,
  category: "official",
});

const planWith = (chatId: string, away: PlanBlock): number => {
  const characterId = createFixtureCharacter(chatId);
  saveDayPlan(
    characterId,
    "2026-09-07",
    JSON.stringify({
      date: "2026-09-07",
      blocks: [block("13:00", away.start, "업무", "intermittent"), away],
    }),
  );
  return characterId;
};

const noticeSent = (chatId: string, characterId: number, start: string): void =>
  logMessage(chatId, characterId, "assistant", "이제 나가요", "2026-09-07 13:50:00", {
    kind: "away",
    proactive: true,
    block: start,
  });

before(() => {
  mock.timers.enable({ apis: ["Date"], now: clockToEpoch(14, 0) });
});
after(() => {
  mock.timers.reset();
  db.close();
});

test("환경변수의 토큰 값은 자리표로 가려진다", () => {
  const out = redactToken(`앞 ${config.telegramToken} 뒤`);
  assert.equal(out.includes(config.telegramToken), false);
  assert.ok(out.includes("<TOKEN>"));
});

test("토큰 모양의 문자열은 값이 달라도 가려진다", () => {
  const out = redactToken(
    `https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`,
  );
  assert.equal(out, "https://api.telegram.org/bot<TOKEN>/sendMessage");
});

test("보통 오류 문구는 그대로 둔다", () => {
  const msg = "ETIMEDOUT: connect 12345 to 443";
  assert.equal(redactToken(msg), msg);
});

test("줄바꿈으로 말풍선을 나누고 빈 줄과 앞뒤 공백은 뺀다", () => {
  assert.deepEqual(splitBubbles("첫 줄\n\n  둘째 줄  \n셋째"), [
    "첫 줄",
    "둘째 줄",
    "셋째",
  ]);
});

test("줄바꿈이 없으면 말풍선 하나다", () => {
  assert.deepEqual(splitBubbles("한 줄"), ["한 줄"]);
});

test("공백뿐인 문안은 빈 말풍선 하나로 돌려준다", () => {
  assert.deepEqual(splitBubbles("   "), [""]);
});

test("배웅 답 문단에 시작 시각과 활동이 들어간다", () => {
  const out = farewellSituation(block("15:00", "16:30", "팀 회의"));
  assert.match(out, /^\[배웅 답 — 곧 자리를 비운다\]/);
  assert.match(out, /15:00부터 "팀 회의" 때문에 자리를 비운다/);
});

test("몰아 답장 문단에 방금 끝낸 활동이 들어간다", () => {
  const out = gatherSituation("헬스장");
  assert.match(out, /^\[몰아 답장 — 방금 자리에서 돌아왔다\]/);
  assert.match(out, /"헬스장"을\(를\) 끝냈다/);
});

test("복귀 인사 문단에 활동이 들어가고 send로 접을 수 있는 형식이다", () => {
  const out = returnSituation("장보기");
  assert.match(out, /^\[문안 — 지금 보낼 복귀 인사 한 통\]/);
  assert.match(out, /"장보기"을\(를\) 끝내고 돌아왔다/);
  assert.match(out, /\{"send":true,"text":"\.\.\."\} 또는 \{"send":false\}/);
});

test("약속 연락이 답장 자리면 약속과 활동이 들어가고 형식 줄은 붙지 않는다", () => {
  const out = promiseSituation("회의 끝나고 연락할게", "팀 회의", true);
  assert.match(out, /^\[약속한 연락 — 이 답장이 그 약속을 지키는 자리다\]/);
  assert.match(out, /"회의 끝나고 연락할게"라고 했고, 방금 "팀 회의"을\(를\) 끝냈다/);
  assert.doesNotMatch(out, /JSON으로만 답한다/);
  assert.doesNotMatch(out, /send=false/);
});

test("약속 연락이 선톡 자리면 형식 줄과 send=false로 접는 길이 붙는다", () => {
  const out = promiseSituation("회의 끝나고 연락할게", "팀 회의", false);
  assert.match(out, /^\[문안 — 약속한 연락 한 통\]/);
  assert.match(out, /send=false/);
  assert.match(out, /\{"send":true,"text":"\.\.\."\} 또는 \{"send":false\}/);
  assert.notEqual(out, promiseSituation("회의 끝나고 연락할게", "팀 회의", true));
});

test("15분 뒤 시작하는 자리 비움에 예고가 나갔으면 그 블록을 돌려준다", () => {
  const chat = "chat-away-15";
  const characterId = planWith(chat, block("14:15", "15:30", "외근 이동"));
  noticeSent(chat, characterId, "14:15");
  assert.equal(upcomingAnnouncedAway(chat, characterId)?.activity, "외근 이동");
});

test("예고가 안 나갔으면 곧 시작해도 null이다", () => {
  const chat = "chat-away-quiet";
  const characterId = planWith(chat, block("14:15", "15:30", "외근 이동"));
  assert.equal(upcomingAnnouncedAway(chat, characterId), null);
});

test("20분 뒤 시작하는 자리 비움은 예고가 나갔어도 null이다", () => {
  const chat = "chat-away-20";
  const characterId = planWith(chat, block("14:20", "15:30", "외근 이동"));
  noticeSent(chat, characterId, "14:20");
  assert.equal(upcomingAnnouncedAway(chat, characterId), null);
});

test("이미 시작한 자리 비움은 null이다", () => {
  const chat = "chat-away-started";
  const characterId = planWith(chat, block("14:00", "15:30", "외근 이동"));
  noticeSent(chat, characterId, "14:00");
  assert.equal(upcomingAnnouncedAway(chat, characterId), null);
});

test("오늘 각본이 없으면 null이다", () => {
  const characterId = createFixtureCharacter("chat-away-noplan");
  assert.equal(upcomingAnnouncedAway("chat-away-noplan", characterId), null);
});
