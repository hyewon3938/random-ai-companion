// 슬랙 게시 문안의 표기 도우미(trace/format.ts)와 게시함에 쌓는 두 함수(trace.ts)를 검사한다 — 슬랙은 부르지 않는다.
//
// 표기 도우미는 넣은 글자와 나온 글자만 견준다. recordTraceChunks는 긴 본문이 상한 단위로
// 몇 행이 되고 머리에 번호가 붙는지, 코드 울타리로 감싸는지를 게시함 행에서 읽어 본다.
// recordTraceEvent는 슬랙 값이 없을 때 아무것도 안 쌓는지와 없는 캐릭터 번호를 받아도
// 예외가 밖으로 나오지 않는지를 본다.
//
// DB는 임시 파일로 새로 만들고 슬랙 토큰은 가짜다 — 게시함에 쌓기까지만 보므로 밖으로
// 나가는 것은 없다.
import assert from "node:assert/strict";
import { after, test } from "node:test";
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
const { config } = await import("../src/config.js");
const { db } = await import("../src/db.js");
const { recordTraceChunks, recordTraceEvent, traceEnabled } =
  await import("../src/trace.js");
const {
  CHUNK,
  callKey,
  chunked,
  clip,
  clock,
  dateLabel,
  esc,
  purposeName,
  quote,
  shortModel,
  tokenLine,
} = await import("../src/trace/format.js");

after(() => {
  db.close();
});

// 게시함 행이 캐릭터를 가리키므로 캐릭터 한 명을 먼저 넣는다.
const characterId = Number(
  db
    .prepare(
      `INSERT INTO characters (chat_id, status, genesis_json, created_at)
       VALUES ('1', 'active', '{}', '2026-09-07 12:00:00') RETURNING id`,
    )
    .pluck()
    .get(),
);

interface EventRow {
  character_id: number | null;
  kind: string;
  parent_key: string | null;
  text: string;
}

const eventsAfter = (id: number): EventRow[] =>
  db
    .prepare(
      `SELECT character_id, kind, parent_key, text FROM trace_events WHERE id > ? ORDER BY id`,
    )
    .all(id) as EventRow[];

const lastId = (): number =>
  (
    db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM trace_events`).get() as {
      id: number;
    }
  ).id;

// ── 표기 도우미 ─────────────────────────────────────────────────────────

test("슬랙 문법과 겹치는 세 글자를 치환한다", () => {
  assert.equal(esc("a&b<c>d"), "a&amp;b&lt;c&gt;d");
  assert.equal(esc("<<>>"), "&lt;&lt;&gt;&gt;");
  assert.equal(esc("그대로 두는 글"), "그대로 두는 글");
});

test("날짜 표기는 월/일 뒤에 요일을 붙인다", () => {
  assert.equal(dateLabel("2026-09-07"), "9/7(월)");
  assert.equal(dateLabel("2026-01-01"), "1/1(목)");
  assert.equal(dateLabel("2026-12-27"), "12/27(일)");
});

test("본문은 상한 단위로 조각내고 상한 안이면 한 조각이다", () => {
  const full = "가".repeat(CHUNK);
  assert.deepEqual(
    chunked(full).map((p) => p.length),
    [CHUNK],
  );
  const over = chunked(`${full}나`);
  assert.deepEqual(
    over.map((p) => p.length),
    [CHUNK, 1],
  );
  assert.equal(over[1], "나");
  assert.deepEqual(
    chunked("가".repeat(CHUNK * 2)).map((p) => p.length),
    [CHUNK, CHUNK],
  );
  assert.deepEqual(chunked("짧다"), ["짧다"]);
  // 빈 본문은 조각이 없다 — recordTraceChunks가 이 경우 행을 하나도 쌓지 않는다.
  assert.deepEqual(chunked(""), []);
});

test("자르기는 넘칠 때만 말줄임과 원래 글자 수를 붙인다", () => {
  assert.equal(clip("가나다", 3), "가나다");
  assert.equal(clip("가나다라", 3), "가나다… (4자)");
  assert.equal(clip("", 3), "");
});

test("인용은 줄마다 인용 표시를 붙이고 슬랙 문법을 이스케이프한다", () => {
  assert.equal(quote("a<b\nc"), "> a&lt;b\n> c");
  assert.equal(quote("한 줄"), "> 한 줄");
});

test("이름표는 모델 접두어를 떼고 목적은 이름이 있을 때만 바꾼다", () => {
  assert.equal(shortModel("claude-sonnet-5"), "sonnet-5");
  assert.equal(shortModel("other-model"), "other-model");
  assert.equal(purposeName("reply"), "답장");
  assert.equal(purposeName("hold"), "붙잡기 판정");
  assert.equal(purposeName("unknown_purpose"), "unknown_purpose");
  assert.equal(callKey(12), "call:12");
  assert.match(clock(), /^\d{2}:\d{2}:\d{2}$/);
});

test("토큰 줄은 값이 있는 칸만 적고 전부 비면 null이다", () => {
  assert.equal(
    tokenLine({
      input_tokens: null,
      cache_write_tokens: null,
      cache_read_tokens: 512,
      output_tokens: null,
    }),
    "*토큰* 캐시 읽기 512",
  );
  assert.equal(
    tokenLine({
      input_tokens: 12,
      cache_write_tokens: 0,
      cache_read_tokens: 0,
      output_tokens: 34,
    }),
    "*토큰* 입력 12 · 출력 34",
  );
  assert.equal(
    tokenLine({
      input_tokens: 0,
      cache_write_tokens: 0,
      cache_read_tokens: 0,
      output_tokens: 0,
    }),
    null,
  );
  assert.equal(
    tokenLine({
      input_tokens: null,
      cache_write_tokens: null,
      cache_read_tokens: null,
      output_tokens: null,
    }),
    null,
  );
});

// ── 게시함에 쌓기 ───────────────────────────────────────────────────────

test("짧은 본문은 번호 없는 머리 한 행으로 쌓인다", () => {
  const from = lastId();
  recordTraceChunks(
    characterId,
    "call:1",
    "call_tail",
    "실시간 꼬리",
    "짧은 본문",
  );
  const rows = eventsAfter(from);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "call_tail");
  assert.equal(rows[0].parent_key, "call:1");
  assert.equal(rows[0].character_id, characterId);
  assert.equal(rows[0].text, "실시간 꼬리\n짧은 본문");
});

test("상한을 넘는 본문은 번호가 붙은 두 행으로 나뉘어 쌓인다", () => {
  const from = lastId();
  const full = "가".repeat(CHUNK);
  recordTraceChunks(
    characterId,
    "call:2",
    "call_tail",
    "실시간 꼬리",
    `${full}나`,
  );
  const rows = eventsAfter(from);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].text, `실시간 꼬리 (1/2)\n${full}`);
  assert.equal(rows[1].text, "실시간 꼬리 (2/2)\n나");
  assert.ok(rows.every((r) => r.parent_key === "call:2"));
});

test("code를 켜면 조각마다 코드 울타리로 감싼다", () => {
  const from = lastId();
  recordTraceChunks(
    undefined,
    "prompt_full:1:2026-09-07",
    "prompt_day_body",
    "잘 바뀌지 않는 데이터",
    "본문",
    true,
  );
  const rows = eventsAfter(from);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].character_id, null);
  assert.equal(rows[0].text, "잘 바뀌지 않는 데이터\n```\n본문\n```");
});

test("슬랙 값이 없으면 게시함에 아무것도 쌓지 않는다", () => {
  assert.equal(traceEnabled(), true);
  const from = lastId();
  // config는 모듈을 읽을 때 env를 한 번 읽어 둔 값이라 여기서 그 값을 잠시 비운다.
  const token = config.slackBotToken;
  config.slackBotToken = undefined;
  try {
    assert.equal(traceEnabled(), false);
    recordTraceEvent({
      characterId,
      kind: "call_tail",
      text: "안 쌓여야 한다",
    });
    recordTraceChunks(
      characterId,
      "call:3",
      "call_tail",
      "실시간 꼬리",
      "안 쌓여야 한다",
    );
    assert.equal(eventsAfter(from).length, 0);
  } finally {
    config.slackBotToken = token;
  }
  assert.equal(traceEnabled(), true);
});

test("없는 캐릭터 번호로 쌓으면 예외 대신 로그만 남기고 행을 만들지 않는다", (t) => {
  const error = t.mock.method(console, "error", () => {});
  const from = lastId();
  assert.doesNotThrow(() =>
    recordTraceEvent({
      characterId: 999_999,
      kind: "call_tail",
      text: "없는 캐릭터",
    }),
  );
  assert.equal(eventsAfter(from).length, 0);
  assert.equal(error.mock.callCount(), 1);
});
