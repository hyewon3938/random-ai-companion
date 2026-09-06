// 답장 게시 문안 그리기(trace/reply-render.ts)가 호출 행과 판단 근거를 슬랙 문안으로 옮기는 자리를 검사한다 — 모델은 부르지 않는다.
//
// 텀 표시·도착 대기·붙잡기 판정 줄, 기다린 시간 표기, 하루 고정 두 덩이의 줄 단위 비교와
// 바뀐 절 이름이 그대로 나오는지 본다. 답장 본문 한 장은 유저 말과 실패 표시가 자리에 붙는지만
// 본다. DB는 임시 파일로 새로 만든다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LlmCallRow } from "../src/db.js";
import type { CallContext } from "../src/trace/reply-render.js";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

const { putBlob } = await import("../src/db.js");
const {
  changeLabel,
  changedSections,
  fmtWait,
  LAYER_NAME,
  lineDiff,
  parseContext,
  parseHashes,
  renderReply,
  timingLines,
} = await import("../src/trace/reply-render.js");

const row = (over: Partial<LlmCallRow> = {}): LlmCallRow => ({
  id: 6,
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

test("기다린 시간은 초·분·시간 단위로 읽히게 적는다", () => {
  assert.equal(fmtWait(500), "바로");
  assert.equal(fmtWait(20_000), "20초");
  assert.equal(fmtWait(95_000), "1분 35초");
  assert.equal(fmtWait(120_000), "2분");
  assert.equal(fmtWait(66 * 60_000), "1시간 6분");
  assert.equal(fmtWait(2 * 3_600_000), "2시간");
});

test("해시 목록과 판단 근거는 깨진 JSON이면 빈 값으로 읽는다", () => {
  assert.deepEqual(parseHashes(null), []);
  assert.deepEqual(parseHashes('[{"h":"a","cache":true}]'), [
    { h: "a", cache: true },
  ]);
  assert.deepEqual(parseHashes("{}"), []);
  assert.deepEqual(parseHashes("not json"), []);
  assert.equal(parseContext(null), null);
  assert.equal(parseContext("not json"), null);
  assert.deepEqual(parseContext('{"turns":3}'), { turns: 3 });
});

test("몰아 답장은 구간이 끝나 바로 보냈다는 줄과 쌓인 메시지 수를 적는다", () => {
  const ctx: CallContext = {
    gathered: { activity: "팀 회의", blockStart: "13:00", waitedMs: 66 * 60_000 },
    userMsgs: 3,
  };
  assert.deepEqual(timingLines(ctx), [
    "*텀* 몰아 답장 — 팀 회의 구간이 끝나 바로 보냈다",
    "*지금 하는 일* 13:00 팀 회의 — 방금 끝났다",
    "*쌓인 메시지* 3통 · 첫 메시지가 온 지 1시간 6분 만에 답한다",
  ]);
  assert.deepEqual(timingLines({}), []);
});

test("텀 표로 정한 답장은 도착 대기·발송 예정·블록 두 태그를 적는다", () => {
  const ctx: CallContext = {
    timing: {
      waitMs: 95_000,
      path: "table",
      block: {
        start: "14:30",
        end: "18:00",
        activity: "오후 업무",
        responsiveness: "intermittent",
        category: "official",
      },
    },
    arrival: { waitMs: 20_000, spanMs: 25_000, msgs: 2 },
    sendAt: "2026-09-06 15:33:00",
  };
  const lines = timingLines(ctx);
  assert.equal(lines[0], "*도착 대기* 20초 기다림 · 메시지 2통 · 첫 메시지로부터 25초");
  assert.equal(lines[1], "*텀* 1분 35초 뒤 · 15:33:00 발송 예정 · 텀 표");
  assert.equal(lines[2], "*지금 하는 일* 14:30~18:00 오후 업무 [틈틈이/공적]");
  assert.match(lines[3], /^\*붙잡기 판정\* 묻지 않음 — /);
});

test("자다 깨서 이어 답하는 자리와 판정을 물은 자리가 구분된다", () => {
  const woke = timingLines({
    timing: { waitMs: 0, path: "sleeping", justWoke: false, block: null },
  });
  assert.equal(woke[0], "*텀* 바로 뒤 · 자다 깨서 이어 답하는 중");
  assert.equal(woke[1], "*지금 하는 일* 각본에 이 시각 블록이 없다");

  const block = {
    start: "13:00",
    end: "14:30",
    activity: "팀 회의",
    responsiveness: "unavailable",
    category: "official",
  };
  const held = timingLines({
    timing: {
      waitMs: 0,
      path: "held",
      block,
      asked: true,
      heldJudged: true,
      held: { outcome: "붙잡음", activity: "팀 회의" },
    },
  });
  assert.equal(held[0], "*텀* 바로 뒤 · 붙잡혀 접음");
  assert.equal(held[2], "*붙잡기 판정* 물었다 · 붙잡음 → 일정 붙잡음");

  const failed = timingLines({
    timing: { waitMs: 0, path: "until_end", block, asked: true, holdFailed: true },
  });
  assert.match(failed[2], /^\*붙잡기 판정\* 물었다 · :warning: 판정 실패/);
});

test("약속 연락으로 만든 답장은 텀 자리에 지킨 약속을 적는다", () => {
  assert.deepEqual(
    timingLines({
      promised: { promise: "통화 끝나고 다시 연락", activity: "통화", blockStart: "13:00" },
    }),
    [
      "*텀* 약속 연락 — 13:00 통화 구간이 끝나 약속대로 답했다",
      "*지킨 약속* 통화 끝나고 다시 연락",
    ],
  );
});

test("답장이 한 약속은 건 시각이나 못 건 사유와 함께 적는다", () => {
  const kept = renderReply(row(), {
    promise: {
      text: "통화 끝나고 다시 연락",
      sendAt: "2026-09-07 14:00:30",
      block: "13:00~14:00",
      activity: "통화",
    },
  });
  assert.ok(
    kept.includes("*약속* 통화 끝나고 다시 연락 → 2026-09-07 14:00:30 (통화 끝)"),
  );
  const dropped = renderReply(row(), {
    promise: { text: "통화 끝나고 다시 연락", dropped: "각본에 남은 블록이 없음" },
  });
  assert.ok(
    dropped.includes("*약속* 통화 끝나고 다시 연락 — 못 걸었다: 각본에 남은 블록이 없음"),
  );
});

test("답장 한 장은 유저 말과 호출 실패를 제자리에 붙인다", () => {
  const turns = putBlob("[assistant] 응\n[user] 이제 봤어 미안\n[user] 뭐 하고 있었어?");
  const text = renderReply(
    row({ turns_hash: turns, error: "overloaded_error", latency_ms: 2300 }),
    { timing: { waitMs: 5_000, path: "table", block: null }, userMsgs: 2 },
  );
  const lines = text.split("\n");
  assert.equal(lines[0], ":speech_balloon: *답장* · 호출 #6 · 15:48:09 · sonnet-5 · 2.3초");
  assert.equal(lines[1], "_유저 메시지 2통을 묶어 한 번에 답한다_");
  assert.equal(lines[2], "> 이제 봤어 미안");
  assert.equal(lines[4], "> 뭐 하고 있었어?");
  assert.ok(text.includes(":x: *호출 실패* overloaded_error"));
  assert.ok(text.includes("*답장 신호* 남음 없음 · 서운함 없음"));
  assert.ok(text.includes("*오늘 메모* 추가 없음"));
});

test("줄 단위 비교는 바뀐 줄만 남기고 너무 길면 자른다", () => {
  assert.equal(lineDiff("a\nb", "a\nb"), "(줄 단위로는 같다 — 공백만 바뀌었다)");
  assert.equal(lineDiff("a\nb\nc", "a\nx\nc"), "- b\n+ x");
  const before = ["1", "2", "3", "4"].join("\n");
  const after = ["5", "6", "7", "8"].join("\n");
  const cut = lineDiff(before, after, 2);
  assert.equal(cut.split("\n").length, 3);
  assert.match(cut, /… 6줄 더$/);
});

test("바뀐 절은 대괄호 제목으로 세고 넷부터는 줄여 적는다", () => {
  const before = "[너 — 정체성]\n- 이름: 한도윤\n\n[오늘 메모]\n- 없음";
  const after = "[너 — 정체성]\n- 이름: 한도윤\n\n[오늘 메모]\n- 두 시 반 약속";
  assert.deepEqual(changedSections(before, after), ["오늘 메모"]);
  assert.deepEqual(changedSections(before, before), []);
  assert.deepEqual(changedSections(before, `${after}\n\n[연락 텀]\n3시간`), [
    "오늘 메모",
    "연락 텀",
  ]);
  assert.equal(changeLabel([], 0), LAYER_NAME[0]);
  assert.equal(changeLabel([], 1), LAYER_NAME[1]);
  assert.equal(changeLabel(["가", "나"], 0), "가 · 나");
  assert.equal(changeLabel(["가", "나", "다", "라", "마"], 1), "가 · 나 · 다 외 2곳");
});
