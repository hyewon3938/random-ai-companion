// 대화를 읽는 함수 전부가 캐릭터 번호로 거르는지 검사한다 — 모델은 부르지 않는다.
//
// 한 대화방에서 캐릭터를 끝내고 새로 시작해도 앞 캐릭터의 메시지는 그대로 남는다. 읽는 쪽이
// 대화방만 보고 거르면 새 캐릭터가 앞 캐릭터의 대화를 자기 것으로 읽어, 처음 만난 자리에서
// 지난 얘기를 이어 하거나 연락 텀·말투를 앞 캐릭터의 기록으로 잰다. 대화방 하나에 캐릭터 둘의
// 메시지를 섞어 넣고, 읽는 함수 열넷이 각자 자기 캐릭터 것만 보는지 본다.
//
// DB는 임시 파일로 새로 만들고 캐릭터는 평가용 고정 캐릭터로 세운다.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

// DB 경로를 정한 뒤에 읽어야 임시 파일로 열린다 — 정적 import는 이 줄들보다 먼저 돈다.
const {
  db,
  logMessage,
  endCharacter,
  getRecentMessages,
  lastCharMessageTsBetween,
  lastMessageBefore,
  reopenedGap,
  hasUserMessageSince,
  lastUserTs,
  lastAssistantTs,
  lastMessage,
  getMessagesBetween,
  hasMessageBetween,
  recentMessageTimes,
  recentReplyTexts,
  countAssistantMeta,
  hasAssistantMeta,
} = await import("../src/db.js");
const { createFixtureCharacter } =
  await import("../src/eval/fixture-character.js");

// 한 대화방에서 앞 캐릭터를 끝내고 새 캐릭터를 시작한 모양을 만든다.
const CHAT = "chat-swap";
const oldId = createFixtureCharacter(CHAT);
endCharacter(oldId);
const newId = createFixtureCharacter(CHAT);

const say = (
  characterId: number,
  role: "user" | "assistant",
  text: string,
  at: string,
  meta?: Record<string, unknown>,
): void => logMessage(CHAT, characterId, role, text, at, meta);

// 앞 캐릭터와 9/9까지 나눈 대화
say(oldId, "user", "안녕하세요", "2026-09-09 10:00:00");
say(oldId, "assistant", "네 안녕하세요", "2026-09-09 10:01:00", { kind: "reply" });
say(oldId, "user", "잘 지냈어요?", "2026-09-09 22:00:00");
say(oldId, "assistant", "덕분에요", "2026-09-09 22:05:00", { kind: "reply" });
say(oldId, "assistant", "먼저 자요", "2026-09-09 23:30:00", { kind: "morning" });

// 새 캐릭터와 9/11에 시작한 대화
say(newId, "assistant", "처음 뵙겠습니다", "2026-09-11 09:00:00", { kind: "morning" });
say(newId, "user", "반가워", "2026-09-11 12:00:00");
say(newId, "assistant", "반가워요", "2026-09-11 12:02:00", { kind: "reply" });

const DAY_START = "2026-09-11 05:00:00";
const DAY_END = "2026-09-12 05:00:00";

after(() => {
  db.close();
});

test("최근 대화와 그 시각은 자기 캐릭터 것만 나온다", () => {
  assert.deepEqual(
    getRecentMessages(CHAT, newId, 10).map((m) => m.text),
    ["처음 뵙겠습니다", "반가워", "반가워요"],
  );
  assert.deepEqual(
    getRecentMessages(CHAT, oldId, 10).map((m) => m.text),
    ["안녕하세요", "네 안녕하세요", "잘 지냈어요?", "덕분에요", "먼저 자요"],
  );
  assert.deepEqual(
    recentMessageTimes(CHAT, newId, 10).map((m) => m.sent_at),
    ["2026-09-11 09:00:00", "2026-09-11 12:00:00", "2026-09-11 12:02:00"],
  );
});

test("마지막 말 시각은 앞 캐릭터의 기록을 넘겨받지 않는다", () => {
  assert.equal(lastUserTs(CHAT, newId), "2026-09-11 12:00:00");
  assert.equal(lastAssistantTs(CHAT, newId), "2026-09-11 12:02:00");
  assert.equal(lastMessage(CHAT, newId)?.text, "반가워요");

  assert.equal(lastUserTs(CHAT, oldId), "2026-09-09 22:00:00");
  assert.equal(lastAssistantTs(CHAT, oldId), "2026-09-09 23:30:00");
});

test("어젯밤 몇 시까지 깨어 있었는지는 자기 캐릭터의 말로만 잰다", () => {
  // 9/9 밤 창에는 앞 캐릭터의 말만 있다 — 새 캐릭터에게는 값이 없어야 한다
  assert.equal(
    lastCharMessageTsBetween(CHAT, newId, "2026-09-09 20:00:00", "2026-09-10 05:00:00"),
    null,
  );
  assert.equal(
    lastCharMessageTsBetween(CHAT, oldId, "2026-09-09 20:00:00", "2026-09-10 05:00:00"),
    "2026-09-09 23:30:00",
  );
});

test("어떤 시각 이전의 마지막 말도 캐릭터를 건너뛰지 않는다", () => {
  // 새 캐릭터의 첫 말 이전에는 앞 캐릭터의 말뿐이라 값이 없다
  assert.equal(lastMessageBefore(CHAT, newId, "2026-09-11 09:00:00"), undefined);
  assert.equal(
    lastMessageBefore(CHAT, oldId, "2026-09-11 09:00:00")?.text,
    "먼저 자요",
  );
});

test("연락 텀은 앞 캐릭터의 마지막 말을 시작점으로 삼지 않는다", () => {
  // 새 캐릭터 쪽에서는 자기 선톡과 유저 답 사이가 텀이다
  assert.deepEqual(reopenedGap(CHAT, newId, "2026-09-11 05:00:00"), {
    lastChar: "2026-09-11 09:00:00",
    firstUser: "2026-09-11 12:00:00",
  });
  // 앞 캐릭터에게는 그 창에 유저 말이 없다
  assert.equal(reopenedGap(CHAT, oldId, "2026-09-11 05:00:00"), undefined);
});

test("유저가 먼저 연락했는지와 창 안 대화 여부도 캐릭터별로 센다", () => {
  assert.equal(hasUserMessageSince(CHAT, newId, "2026-09-11 05:00:00"), true);
  assert.equal(hasUserMessageSince(CHAT, oldId, "2026-09-11 05:00:00"), false);
  assert.equal(hasMessageBetween(CHAT, oldId, DAY_START, DAY_END), false);
  assert.equal(hasMessageBetween(CHAT, newId, DAY_START, DAY_END), true);
  assert.deepEqual(
    getMessagesBetween(CHAT, newId, DAY_START, DAY_END).map((m) => m.text),
    ["처음 뵙겠습니다", "반가워", "반가워요"],
  );
  assert.deepEqual(getMessagesBetween(CHAT, oldId, DAY_START, DAY_END), []);
});

test("말투를 재는 답장 본문은 선톡을 빼고 자기 캐릭터 것만 준다", () => {
  assert.deepEqual(recentReplyTexts(CHAT, newId, 10), ["반가워요"]);
  assert.deepEqual(recentReplyTexts(CHAT, oldId, 10), [
    "덕분에요",
    "네 안녕하세요",
  ]);
});

test("선톡을 세는 함수도 앞 캐릭터의 선톡을 얹지 않는다", () => {
  const f = { like: ['%"kind":"morning"%'] };
  assert.equal(countAssistantMeta(CHAT, newId, "2026-09-09 05:00:00", f), 1);
  assert.equal(countAssistantMeta(CHAT, oldId, "2026-09-09 05:00:00", f), 1);
  assert.equal(hasAssistantMeta(CHAT, newId, DAY_START, f), true);
  assert.equal(hasAssistantMeta(CHAT, oldId, DAY_START, f), false);
});
