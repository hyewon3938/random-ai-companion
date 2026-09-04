// 발송이 실패했을 때 다음 재시도까지 얼마나 기다리는지 검사한다.
//
// 텔레그램이 몇 분 끊기는 날 1분 간격 세 번으로는 3분밖에 못 버텨 만들어 둔 답장을 버렸다.
// 표가 1·2·5·10분으로 늘어 20분 가까이 버티는지, 표를 다 쓰면 null을 돌려 행을 닫게 하는지
// 본다. 깨우기·복귀는 재시도마다 모델을 다시 부르므로 앞 두 칸만 쓴다.
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
const { retryDelayMs } = await import("../src/pending.js");
type PendingReplyRow = Parameters<typeof retryDelayMs>[0];

const row = (kind: string, attempts: number): PendingReplyRow => ({
  id: 1,
  chat_id: "chat-1",
  character_id: 1,
  user_msg_at: "2026-09-04 11:38:26",
  bubbles_json: "[]",
  note_to_save: null,
  send_at: "2026-09-04 11:45:44",
  kind,
  meta_json: null,
  call_id: null,
  attempts,
  created_at: "2026-09-04 11:38:26",
});

test("답장은 1·2·5·10분 간격으로 네 번 다시 보낸다", () => {
  assert.deepEqual(
    [0, 1, 2, 3].map((n) => retryDelayMs(row("reply", n))),
    [60_000, 120_000, 300_000, 600_000],
  );
});

test("네 번을 다 쓰면 null — 그 자리에서 행을 닫는다", () => {
  assert.equal(retryDelayMs(row("reply", 4)), null);
});

test("표를 다 쓰기까지 18분을 버틴다", () => {
  let total = 0;
  for (let n = 0; ; n += 1) {
    const d = retryDelayMs(row("reply", n));
    if (d === null) break;
    total += d;
  }
  assert.equal(total / 60_000, 18);
});

test("깨우기·복귀는 앞 두 칸만 쓴다 — 재시도마다 모델을 다시 부른다", () => {
  assert.deepEqual(
    [0, 1, 2].map((n) => retryDelayMs(row("wake", n))),
    [60_000, 120_000, null],
  );
  assert.equal(retryDelayMs(row("return", 2)), null);
});
