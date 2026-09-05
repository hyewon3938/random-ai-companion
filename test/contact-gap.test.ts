// 유저 연락이 캐릭터의 마지막 말에서 얼마 만에 왔는지 재는 자리를 검사한다 — 모델은 부르지 않는다.
//
// 유저가 연달아 보낸 말은 첫 통이 기준이고, 캐릭터가 아직 답하지 않은 자리에서만 값이 나온다
// (이슈 #284). 선톡처럼 캐릭터 말 뒤로 유저 말이 없는 자리는 값이 없어야 한다.
//
// db.ts를 읽으면 DB를 쓰기로 열므로 임시 파일로 새로 만든다.
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
const { logMessage, lastExchangeGap } = await import("../src/db.js");

const CHAT = "chat-gap";
const CHAR = 1;

test("캐릭터 말이 아직 없으면 잴 것이 없다", () => {
  assert.equal(lastExchangeGap(CHAT), undefined);
  logMessage(CHAT, CHAR, "user", "안녕", "2026-09-05 13:58:00");
  assert.equal(lastExchangeGap(CHAT), undefined);
});

test("캐릭터가 답한 뒤 유저 말이 없으면 값이 없다", () => {
  logMessage(CHAT, CHAR, "assistant", "응 안녕", "2026-09-05 14:06:00");
  assert.equal(lastExchangeGap(CHAT), undefined);
});

test("유저가 연달아 보낸 말은 첫 통이 기준이다", () => {
  logMessage(CHAT, CHAR, "user", "나 왔어", "2026-09-05 18:30:00");
  logMessage(CHAT, CHAR, "user", "뭐 해", "2026-09-05 18:31:00");
  assert.deepEqual(lastExchangeGap(CHAT), {
    lastChar: "2026-09-05 14:06:00",
    firstUser: "2026-09-05 18:30:00",
  });
});

test("캐릭터가 다시 답하면 그 말이 새 기준이 된다", () => {
  logMessage(CHAT, CHAR, "assistant", "왔어?", "2026-09-05 18:33:00");
  assert.equal(lastExchangeGap(CHAT), undefined);
  logMessage(CHAT, CHAR, "user", "응", "2026-09-05 18:35:00");
  assert.deepEqual(lastExchangeGap(CHAT), {
    lastChar: "2026-09-05 18:33:00",
    firstUser: "2026-09-05 18:35:00",
  });
});
