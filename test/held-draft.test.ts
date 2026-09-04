// 발송에 실패한 선톡 문안을 다음 틱까지 들고 있는 자리를 검사한다.
//
// 지금까지는 발송이 실패하면 만들어 둔 문안을 버려서, 다음 틱이 같은 조건을 다시 만나 모델을
// 한 번 더 부르고 길이 아직 안 열렸으니 또 실패했다. 조건이 그대로면 문안을 그대로 돌려주는지,
// 자리가 지났거나 오래된 문안은 버리는지 본다. 다른 종류의 자리에서 물어본 것은 남겨 둬야
// 한다 — 10분 틱이 15분 틱의 문안을 대신 버리면 정작 그것을 보낼 틱이 빈손으로 온다.
//
// DB는 임시 파일로 새로 만든다. 모델도 텔레그램도 부르지 않아 값이 안 든다.
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
const { holdFailedDraft, takeHeldDraft } =
  await import("../src/proactive-policy.js");

test("조건이 그대로면 만들어 둔 문안을 그대로 돌려준다", () => {
  const chatId = "chat-goodnight";
  holdFailedDraft(chatId, {
    kind: "goodnight",
    text: "잘 자",
    madeAt: Date.now(),
  });
  assert.equal(takeHeldDraft(chatId, "goodnight")?.text, "잘 자");
});

test("한 번 꺼내면 남지 않는다 — 같은 문안이 두 번 나가지 않게", () => {
  const chatId = "chat-once";
  holdFailedDraft(chatId, {
    kind: "mend",
    text: "아까는 미안",
    madeAt: Date.now(),
  });
  takeHeldDraft(chatId, "mend");
  assert.equal(takeHeldDraft(chatId, "mend"), null);
});

test("자리 비움 예고는 같은 활동 블록에서만 다시 보낸다", () => {
  const chatId = "chat-away";
  holdFailedDraft(chatId, {
    kind: "away",
    text: "회의 들어가",
    block: "14:00",
    madeAt: Date.now(),
  });
  assert.equal(takeHeldDraft(chatId, "away", "14:00")?.text, "회의 들어가");
});

test("블록이 바뀌었으면 버린다 — 다음 블록에 앞 블록 문안이 나가지 않게", () => {
  const chatId = "chat-away-next";
  holdFailedDraft(chatId, {
    kind: "away",
    text: "회의 들어가",
    block: "14:00",
    madeAt: Date.now(),
  });
  assert.equal(takeHeldDraft(chatId, "away", "16:00"), null);
  // 버린 뒤라 원래 블록으로 다시 물어도 없다
  assert.equal(takeHeldDraft(chatId, "away", "14:00"), null);
});

test("만든 지 20분이 넘은 문안은 버린다 — 지난 상황을 말하게 된다", () => {
  const chatId = "chat-stale";
  holdFailedDraft(chatId, {
    kind: "catchup",
    text: "이제 퇴근",
    madeAt: Date.now() - 21 * 60_000,
  });
  assert.equal(takeHeldDraft(chatId, "catchup"), null);
});

test("다른 종류의 자리에서 물어본 것은 그대로 둔다", () => {
  const chatId = "chat-other-kind";
  holdFailedDraft(chatId, {
    kind: "goodnight",
    text: "잘 자",
    madeAt: Date.now(),
  });
  // 자리 비움 틱(10분)이 먼저 지나가도
  assert.equal(takeHeldDraft(chatId, "away", "14:00"), null);
  // 밤 인사 틱(15분)이 올 때 문안이 남아 있어야 한다
  assert.equal(takeHeldDraft(chatId, "goodnight")?.text, "잘 자");
});
