// 선톡이 못 나갔을 때 게시함에 행이 쌓이는지 검사한다.
//
// 발송 실패가 send_failures에만 적히면 슬랙에는 문안만 남아, 채널을 보는 사람이 그 통을 나간
// 것으로 읽는다. 문안 호출 번호를 받은 경우 그 문안 스레드에 달리는지(parent_key), 번호를
// 모르는 경우에도 독립 행으로 쌓이는지 함께 본다.
//
// DB는 임시 파일로 새로 만들고 슬랙 토큰은 가짜다 — 게시함에 쌓기까지만 보므로 밖으로
// 나가는 것은 없다.
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
process.env.SLACK_BOT_TOKEN = "test-slack-token";
process.env.SLACK_TRACE_CHANNEL = "C_TEST";

// DB 경로와 슬랙 값을 정한 뒤에 읽어야 임시 파일로 열리고 트레이스가 켜진다.
const { traceProactiveFail } = await import("../src/reply-trace.js");
const { db } = await import("../src/db.js");

// 게시함 행이 캐릭터를 가리키므로 캐릭터 한 명을 먼저 넣는다.
const characterId = Number(
  db
    .prepare(
      `INSERT INTO characters (chat_id, status, genesis_json, created_at)
       VALUES ('1', 'active', '{}', '2026-09-02 12:00:00') RETURNING id`,
    )
    .pluck()
    .get(),
);

interface EventRow {
  kind: string;
  parent_key: string | null;
  text: string;
}

const lastEvent = (): EventRow =>
  db
    .prepare(
      `SELECT kind, parent_key, text FROM trace_events ORDER BY id DESC LIMIT 1`,
    )
    .get() as EventRow;

test("문안 호출 번호를 받으면 그 문안 스레드에 단다", () => {
  traceProactiveFail({
    characterId,
    kind: "away",
    error: "sendMessage 실패(4회)",
    callId: 208,
  });
  const row = lastEvent();
  assert.equal(row.kind, "proactive_fail");
  assert.equal(row.parent_key, "call:208");
  assert.match(row.text, /자리비움 선톡 발송 포기/);
  assert.match(row.text, /sendMessage 실패\(4회\)/);
});

test("호출 번호를 모르면 독립 행으로 쌓는다", () => {
  traceProactiveFail({
    characterId,
    kind: "catchup",
    error: "타임아웃",
  });
  const row = lastEvent();
  assert.equal(row.parent_key, null);
  assert.match(row.text, /근황 선톡 발송 포기/);
});
