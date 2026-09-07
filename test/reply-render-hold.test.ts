// 재생성 호출과 붙잡기 판정 호출의 게시 문안(trace/reply-render.ts의 renderRetry·renderHold)을 검사한다 — 모델은 부르지 않는다.
//
// 재생성은 머리 줄에 원래 답장 번호를 적고 새 답·실패·응답 모양을 이어 붙이는지, 판정은 물은
// 말에서 유저 표시를 떼고 판정 결과에 그 뜻(취소·양해·그대로·판정 실패)을 붙이는지 본다.
// 답장·선톡 문안 한 장은 reply-render.test.ts가 보므로 여기서는 두 함수만 본다.
// 본문은 prompt_blobs에서 읽으므로 DB는 임시 파일로 새로 만든다.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmCallRow } from "../src/db.js";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

// DB 경로를 정한 뒤에 읽어야 임시 파일로 열린다.
const { db, putBlob } = await import("../src/db.js");
const { renderHold, renderRetry } =
  await import("../src/trace/reply-render.js");

after(() => {
  db.close();
});

const row = (over: Partial<LlmCallRow> = {}): LlmCallRow => ({
  id: 8,
  character_id: 1,
  chat_id: "1",
  purpose: "reply",
  model: "claude-sonnet-5",
  attempt: 1,
  system_hashes: null,
  turns_hash: null,
  output_hash: null,
  input_tokens: null,
  cache_write_tokens: null,
  cache_read_tokens: null,
  output_tokens: null,
  latency_ms: null,
  stop_reason: null,
  block_types: null,
  error: null,
  context_json: null,
  created_at: "2026-09-06 15:48:09",
  ...over,
});

const block = (category: string, responsiveness = "unavailable") => ({
  start: "13:00",
  end: "14:00",
  activity: "낮잠",
  responsiveness,
  category,
});

// ── 재생성 ──────────────────────────────────────────────────────────────

test("재생성 머리 줄은 원래 답장 번호를 적고 새 답을 인용한다", () => {
  const text = renderRetry(
    row({
      id: 8,
      attempt: 2,
      output_hash: putBlob("다시 쓴 답"),
      output_tokens: 40,
    }),
    6,
  );
  assert.deepEqual(text.split("\n"), [
    ":repeat: *재생성* · 호출 #8 · 15:48:09 · sonnet-5 — 답장 #6의 첫 답이 비어 다시 불렀다",
    "> 다시 쓴 답",
    "*토큰* 출력 40",
  ]);
});

test("재생성이 실패하면 실패 줄과 응답 모양을 적고 인용은 없다", () => {
  const text = renderRetry(
    row({
      id: 9,
      error: "overloaded <529>",
      block_types: "thinking:1",
      stop_reason: "max_tokens",
    }),
    6,
  );
  const lines = text.split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[1], ":x: *호출 실패* overloaded &lt;529&gt;");
  assert.equal(lines[2], "*응답* 블록 thinking:1 · 멈춤 상한에서 잘렸다");
});

// ── 붙잡기 판정 ─────────────────────────────────────────────────────────

test("판정 문안은 물은 말에서 유저 표시를 떼고 개인 일정이면 취소한다는 뜻을 붙인다", () => {
  const text = renderHold(
    row({
      id: 6,
      purpose: "hold",
      turns_hash: putBlob("[user] 지금 통화 돼?"),
      output_hash: putBlob("yes\n"),
      latency_ms: 1234,
    }),
    { hold: { block: block("personal"), held: true } },
  );
  assert.deepEqual(text.split("\n"), [
    ":mag: *붙잡기 판정* · 호출 #6 · 15:48:09 · sonnet-5 · 1.2초",
    "> 지금 통화 돼?",
    "*지금 하는 일* 13:00~14:00 낮잠 [불가/개인]",
    "*판정* yes — 이 일정을 취소하고 바로 답한다",
  ]);
});

test("사회 일정은 양해를 구해 미룬다는 뜻, 붙잡지 않으면 그대로 둔다는 뜻이 붙는다", () => {
  const base = row({
    id: 7,
    purpose: "hold",
    output_hash: putBlob("yes"),
  });
  const social = renderHold(base, {
    hold: {
      block: { ...block("social"), activity: "친구와 저녁" },
      held: true,
    },
  });
  assert.ok(
    social.includes("*지금 하는 일* 13:00~14:00 친구와 저녁 [불가/사회]"),
  );
  assert.ok(
    social.endsWith("*판정* yes — 만나기로 한 상대에게 양해를 구하고 미룬다"),
  );

  const kept = renderHold(
    row({ id: 7, purpose: "hold", output_hash: putBlob("no") }),
    {
      hold: { block: block("personal"), held: false },
    },
  );
  assert.ok(
    kept.endsWith("*판정* no — 일정을 그대로 두고 구간이 끝날 때 몰아 답한다"),
  );

  // 판정 결과를 모르면(held 없음) 뜻을 붙이지 않는다.
  const bare = renderHold(
    row({ id: 7, purpose: "hold", output_hash: putBlob("no") }),
    {
      hold: { block: block("personal") },
    },
  );
  assert.ok(bare.endsWith("*판정* no"));
});

test("판정을 못 받으면 답이 비었다는 말과 함께 일정을 그대로 두고 실패 줄을 적는다", () => {
  const text = renderHold(
    row({
      id: 10,
      purpose: "hold",
      error: "timeout",
      block_types: "thinking:1",
      stop_reason: "max_tokens",
    }),
    { hold: { block: block("personal"), failed: true } },
  );
  assert.deepEqual(text.split("\n"), [
    ":mag: *붙잡기 판정* · 호출 #10 · 15:48:09 · sonnet-5",
    "*지금 하는 일* 13:00~14:00 낮잠 [불가/개인]",
    "*판정* (없음) — 답이 비어 판정을 못 받았다. 일정을 그대로 두고 구간이 끝날 때 몰아 답한다",
    ":x: *호출 실패* timeout — 일정을 그대로 둔다",
    "*응답* 블록 thinking:1 · 멈춤 상한에서 잘렸다",
  ]);
});
