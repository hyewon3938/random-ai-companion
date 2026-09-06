// 답장에서 한 연락 약속의 시각을 각본 블록 경계에서 고르는 계산(reply-promise.ts)을 검사한다.
//
// 모델이 시각을 지어내지 않게 코드가 정하는 자리다. 지금 블록이 즉답 구간이 아니면 그 블록 끝,
// 즉답 구간이면 다음 블록 끝, 남은 블록이 없거나 자정 뒤 잠으로 메운 가짜 블록이면 null이
// 나오는지 본다. 기다릴 시간은 블록 끝까지에 1분 안의 흩뜨린 값만 더해지는지 본다.
//
// DB는 임시 파일로 새로 만든다. 모델도 텔레그램도 부르지 않아 값이 안 든다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PlanBlock } from "../src/day-plan.js";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

// DB 경로를 정한 뒤에 읽어야 임시 파일로 열린다 — 정적 import는 이 줄들보다 먼저 돈다.
const { promiseBlock, promiseWaitMs } = await import("../src/reply-promise.js");
const { BLOCK_END_JITTER_MS } = await import("../src/thresholds.js");

const block = (
  start: string,
  end: string,
  activity: string,
  responsiveness: PlanBlock["responsiveness"],
): PlanBlock => ({
  start,
  end,
  activity,
  responsiveness,
  advance_known: true,
  category: "personal",
});

const DAY: PlanBlock[] = [
  block("09:00", "12:00", "오전 업무", "intermittent"),
  block("12:00", "13:00", "점심", "instant"),
  block("13:00", "14:00", "통화", "unavailable"),
  block("14:00", "18:00", "오후 업무", "intermittent"),
  block("19:00", "21:00", "저녁 약속", "unavailable"),
];

test("즉답 구간이 아닌 블록에서 한 약속은 그 블록이 끝날 때 지킨다", () => {
  assert.equal(promiseBlock(DAY, "13:20")?.activity, "통화");
  assert.equal(promiseBlock(DAY, "10:00")?.activity, "오전 업무");
});

test("즉답 구간에서 한 약속은 다음 블록이 끝날 때 지킨다", () => {
  assert.equal(promiseBlock(DAY, "12:30")?.activity, "통화");
});

test("블록 사이 빈 시간에 한 약속은 다음 블록이 끝날 때 지킨다", () => {
  assert.equal(promiseBlock(DAY, "18:30")?.activity, "저녁 약속");
});

test("남은 블록이 없으면 null — 코드가 시각을 정할 수 없어 걸지 않는다", () => {
  assert.equal(promiseBlock(DAY, "21:30"), null);
  // 자정 뒤 잠으로 메운 가짜 블록은 각본에 없는 블록이라 약속 블록이 아니다
  assert.equal(promiseBlock(DAY, "25:00"), null);
});

test("기다릴 시간은 블록 끝까지에 1분 안의 흩뜨린 값만 더한다", () => {
  const cur = block("13:00", "14:00", "통화", "unavailable");
  const wait = promiseWaitMs(cur, "13:20");
  assert.ok(wait >= 40 * 60_000 && wait < 40 * 60_000 + BLOCK_END_JITTER_MS);
  const past = promiseWaitMs(cur, "14:30");
  assert.ok(past >= 0 && past < BLOCK_END_JITTER_MS);
});
