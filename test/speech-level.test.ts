// 최근 답장의 종결어미로 반말·존댓말을 판정하는 speech-level.ts의 검사.
//
// 순수 판정(speechLevelOf)은 본문 목록만 넣어 보고, DB를 읽는 currentSpeechLevel은 임시 DB에
// 답장을 심어 선톡이 표본에서 빠지는지까지 본다.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "speech-level-")), "t.db");
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

const { db, logMessage } = await import("../src/db.js");
const { createFixtureCharacter } = await import("../src/eval/fixture-character.js");
const { speechLevelOf, currentSpeechLevel } = await import("../src/speech-level.js");

const CHAT = "chat-speech";
let characterId = 0;

before(() => {
  characterId = createFixtureCharacter(CHAT);
});
after(() => {
  db.close();
});

test("표본이 셋보다 적으면 판단을 보류한다", () => {
  assert.equal(speechLevelOf([]), null);
  assert.equal(speechLevelOf(["뭐 해?", "밥 먹었어"]), null);
  assert.equal(speechLevelOf(["안녕하세요", "뭐 하세요?", "그냥 있음", "글쎄"]), "존댓말");
});

test("마지막 줄의 어미만 보고 다수결로 정한다", () => {
  assert.equal(speechLevelOf(["뭐 하고 있어?", "밥 먹었어", "나도 그래"]), "반말");
  assert.equal(speechLevelOf(["잘 지내세요?", "저는 괜찮아요", "네 그렇죠"]), "존댓말");
  // 첫 줄이 존댓말이어도 마지막 줄이 반말이면 반말로 센다
  assert.equal(
    speechLevelOf(["안녕하세요\n오늘 뭐 해", "밥은 먹었어", "나는 아직이야", "응 알겠어"]),
    "반말",
  );
  // 동수면 존댓말 쪽으로 기운다
  assert.equal(speechLevelOf(["그래", "응 맞아", "네 그래요", "알겠습니다"]), "존댓말");
});

test("최근 답장에서 선톡을 빼고 판정한다", () => {
  logMessage(CHAT, characterId, "user", "안녕하세요", "2026-09-06 10:00:00");
  logMessage(CHAT, characterId, "assistant", "응 잘 지냈어", "2026-09-06 10:00:10", { kind: "reply" });
  logMessage(CHAT, characterId, "assistant", "밥 먹었어?", "2026-09-06 10:01:00", { kind: "reply" });
  logMessage(CHAT, characterId, "assistant", "나는 아직이야", "2026-09-06 10:02:00");
  // 선톡은 존댓말이어도 표본에 들어가지 않는다
  for (let i = 0; i < 5; i++)
    logMessage(CHAT, characterId, "assistant", `잘 지내세요 ${i}`, `2026-09-06 11:0${i}:00`, {
      kind: "checkin",
      proactive: true,
    });
  assert.equal(currentSpeechLevel(CHAT, characterId), "반말");
  assert.equal(currentSpeechLevel("chat-none", characterId), null);
});
