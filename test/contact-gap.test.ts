// 유저가 다시 말을 건 자리를 어떻게 잡는지 검사한다 — 모델은 부르지 않는다.
//
// 창(sinceTs) 안에 든 유저의 첫 말과 그 앞 캐릭터 말이 한 쌍이다. 유저가 연달아 보낸 말은 첫
// 통이 기준이고(이슈 #284), 캐릭터가 답한 뒤에도 그 재개 지점은 창 안에 있는 동안 남는다
// (이슈 #316). 선톡처럼 창 안에 유저 말이 없는 자리는 값이 없어야 한다.
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
const { logMessage, reopenedGap } = await import("../src/db.js");

const CHAT = "chat-gap";
const CHAR = 1;
// 창은 "이 시각 뒤에 온 유저 말"을 뜻한다 — 실제로는 30분 전 시각이 들어온다.
const SINCE_18 = "2026-09-05 18:00:00";

test("캐릭터 말이 아직 없으면 잴 것이 없다", () => {
  assert.equal(reopenedGap(CHAT, SINCE_18), undefined);
  logMessage(CHAT, CHAR, "user", "안녕", "2026-09-05 13:58:00");
  assert.equal(reopenedGap(CHAT, SINCE_18), undefined);
});

test("창 안에 유저 말이 없으면 값이 없다", () => {
  logMessage(CHAT, CHAR, "assistant", "응 안녕", "2026-09-05 14:06:00");
  assert.equal(reopenedGap(CHAT, SINCE_18), undefined);
});

test("유저가 연달아 보낸 말은 첫 통이 기준이다", () => {
  logMessage(CHAT, CHAR, "user", "나 왔어", "2026-09-05 18:30:00");
  logMessage(CHAT, CHAR, "user", "뭐 해", "2026-09-05 18:31:00");
  assert.deepEqual(reopenedGap(CHAT, SINCE_18), {
    lastChar: "2026-09-05 14:06:00",
    firstUser: "2026-09-05 18:30:00",
  });
});

test("캐릭터가 답한 뒤에도 재개 지점은 창 안에 있는 동안 남는다", () => {
  logMessage(CHAT, CHAR, "assistant", "왔어?", "2026-09-05 18:33:00");
  logMessage(CHAT, CHAR, "user", "응", "2026-09-05 18:35:00");
  assert.deepEqual(reopenedGap(CHAT, SINCE_18), {
    lastChar: "2026-09-05 14:06:00",
    firstUser: "2026-09-05 18:30:00",
  });
});

test("재개 지점이 창 밖으로 밀려나면 그 뒤 대화가 기준이 된다", () => {
  assert.deepEqual(reopenedGap(CHAT, "2026-09-05 18:34:00"), {
    lastChar: "2026-09-05 18:33:00",
    firstUser: "2026-09-05 18:35:00",
  });
});
