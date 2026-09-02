// 발송을 포기한 행이 답장 책임을 놓는지 검사한다.
//
// 재시도를 다 쓰고 행을 닫을 때 복구 표시를 거두지 않으면, 복구 틱이 이미 답한 메시지로 읽고
// 건너뛰어 유저가 보낸 말이 아무 답도 못 받은 채 남는다. 표시가 이 행 것일 때만 지우는 조건도
// 함께 본다 — 그 사이 다른 경로가 찍은 표시를 지우면 그쪽 답장이 두 번 나간다.
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
const { releaseRecoveryMark } = await import("../src/pending.js");
const { getRecoveryMark, setRecoveryMark } = await import("../src/db.js");
type PendingReplyRow = Parameters<typeof releaseRecoveryMark>[0];

const USER_MSG_AT = "2026-09-02 11:38:26";

const failedRow = (chatId: string): PendingReplyRow => ({
  id: 110,
  chat_id: chatId,
  character_id: 1,
  user_msg_at: USER_MSG_AT,
  bubbles_json: "[]",
  note_to_save: null,
  send_at: "2026-09-02 11:45:44",
  kind: "reply",
  meta_json: null,
  call_id: null,
  attempts: 3,
  created_at: USER_MSG_AT,
});

test("이 행이 찍은 표시면 지운다 — 복구 틱이 이어받는다", () => {
  const chatId = "chat-owned";
  setRecoveryMark(chatId, USER_MSG_AT);
  releaseRecoveryMark(failedRow(chatId));
  assert.notEqual(getRecoveryMark(chatId), USER_MSG_AT);
});

test("그 사이 다른 경로가 찍은 표시는 그대로 둔다", () => {
  const chatId = "chat-newer";
  const newer = "2026-09-02 12:10:00";
  setRecoveryMark(chatId, newer);
  releaseRecoveryMark(failedRow(chatId));
  assert.equal(getRecoveryMark(chatId), newer);
});

test("표시가 없으면 아무것도 만들지 않는다", () => {
  const chatId = "chat-empty";
  releaseRecoveryMark(failedRow(chatId));
  assert.equal(getRecoveryMark(chatId), undefined);
});
