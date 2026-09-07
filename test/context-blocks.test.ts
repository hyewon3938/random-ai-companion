// 각본에서 지금 블록을 읽고 답장 프롬프트 3층을 조립하는 자리를 검사한다 — 모델은 부르지 않는다.
//
// currentBlock이 지금 시각을 덮는 블록·낮의 빈자리·자정 뒤 잠 메움을 어떻게 돌려주는지,
// buildSystemBlocks가 캐시 경계 둘과 실시간 꼬리로 나뉘고 신호 형식과 반말 안내가 어디에
// 붙는지, readTodayPlan이 저장된 각본을 그대로 돌려주고 깨진 JSON은 null로 두는지,
// promiseSlotFor가 불가 블록의 끝에서 약속 시각을 고르는지 본다. readContextInput과 연락 텀은
// 다른 세션(#316)의 자리라 여기서 다루지 않는다.
//
// 지금 시각은 kstLogicalClock() 밑의 Date.now()에서 오므로 node:test의 mock.timers로 Date만
// 고정해 각본 표기 시각을 정확히 짚는다. DB는 임시 파일로 새로 만들고, 모델 주소는 닫힌 로컬
// 포트로 돌려 호출이 기계 밖으로 나가지 않게 한다.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";

import type { DayPlan, PlanBlock } from "../src/day-plan.js";
import type { ActivityCategory, Responsiveness } from "../src/labels.js";
import { BLOCK_END_JITTER_MS } from "../src/thresholds.js";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "context-blocks-")), "t.db");
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";
// 모델 클라이언트는 모듈을 읽을 때 이 주소를 잡는다. 아무것도 듣지 않는 포트라 연결이 바로 끊긴다.
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";

const { db, saveDayPlan, setSpeechLevel } = await import("../src/db.js");
const { createFixtureCharacter } = await import("../src/eval/fixture-character.js");
const { buildSystemBlocks, currentBlock } = await import("../src/context.js");
const { readTodayPlan } = await import("../src/context/input.js");
const { promiseSlotFor } = await import("../src/reply-promise.js");
const { BANMAL_NOTE } = await import("../src/prompts/reply.js");
const { REPLY_ENVELOPE } = await import("../src/reply-signal.js");

// 각본이 담는 논리일 하나에 시각만 옮겨 가며 본다. 각본 표기(05:00~28:59)를 그날 KST의
// epoch로 바꾼다 — 24를 넘는 시는 Date.UTC가 다음 날로 넘긴다.
const PLAN_DATE = "2026-09-07";
const clockToEpoch = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return Date.UTC(2026, 8, 7, h, m) - 9 * 3600_000;
};
const setClock = (hhmm: string): void => {
  mock.timers.setTime(clockToEpoch(hhmm));
};

const block = (
  start: string,
  end: string,
  activity: string,
  responsiveness: Responsiveness,
  category: ActivityCategory,
): PlanBlock => ({
  start,
  end,
  activity,
  responsiveness,
  advance_known: true,
  category,
});

const DAY: PlanBlock[] = [
  block("10:00", "12:00", "집에서 쉼", "instant", "personal"),
  block("13:00", "14:00", "팀 회의", "unavailable", "official"),
  block("19:00", "23:00", "친구와 저녁", "intermittent", "social"),
];

let seq = 0;
/** 각본을 깐 방 하나. 검사마다 새로 만들어 서로 섞이지 않게 한다. */
const roomWith = (
  blocks: PlanBlock[] | null,
): { chatId: string; characterId: number } => {
  const chatId = `chat-blocks-${++seq}`;
  const characterId = createFixtureCharacter(chatId);
  if (blocks)
    saveDayPlan(characterId, PLAN_DATE, JSON.stringify({ date: PLAN_DATE, blocks }));
  return { chatId, characterId };
};

before(() => {
  mock.timers.enable({ apis: ["Date"], now: clockToEpoch("10:30") });
});
after(() => {
  mock.timers.reset();
  db.close();
});

// ── currentBlock ───────────────────────────────────────────────────────

test("오늘 각본이 없으면 지금 블록도 없다", () => {
  setClock("10:30");
  assert.equal(currentBlock(roomWith(null).characterId), null);
});

test("지금 시각을 덮는 블록을 그대로 돌려준다", () => {
  const { characterId } = roomWith(DAY);
  setClock("10:30");
  assert.deepEqual(currentBlock(characterId), DAY[0]);
  setClock("13:59");
  assert.deepEqual(currentBlock(characterId), DAY[1]);
});

test("낮의 빈자리는 비워 두고 자정 뒤 빈자리는 잠으로 메운다", () => {
  const { characterId } = roomWith(DAY);
  // 12:00~13:00 사이 — 어느 블록도 덮지 않고 자정 전이라 null
  setClock("12:30");
  assert.equal(currentBlock(characterId), null);
  // 자정 뒤 — 자정(또는 그 뒤에 끝난 마지막 블록의 끝)부터 하루 끝까지 잠으로 메운 가짜 블록.
  // 마지막 블록이 23:00에 끝나도 시작은 24:00이다
  setClock("25:00");
  const sleep = (start: string): PlanBlock => ({
    start,
    end: "29:00",
    activity: "잠",
    responsiveness: "unavailable",
    advance_known: true,
    category: "personal",
    fallback: true,
  });
  assert.deepEqual(currentBlock(characterId), sleep("24:00"));
  // 자정을 넘겨 끝난 블록이 있으면 그 끝부터다
  const late = roomWith([block("22:00", "25:00", "야근", "unavailable", "official")]);
  setClock("25:30");
  assert.deepEqual(currentBlock(late.characterId), sleep("25:00"));
});

// ── buildSystemBlocks ──────────────────────────────────────────────────

test("프롬프트는 캐시 경계 둘과 실시간 꼬리 하나로 조립된다", () => {
  const { chatId, characterId } = roomWith(DAY);
  setClock("10:30");
  const blocks = buildSystemBlocks(characterId, chatId, {});
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].cache, true);
  assert.equal(blocks[1].cache, true);
  assert.equal("cache" in blocks[2], false);
  for (const b of blocks) assert.ok(b.text.length > 0);
  // 신호를 안 켰으면 형식 문단은 붙지 않는다
  assert.equal(blocks[2].text.includes(REPLY_ENVELOPE), false);
});

test("signals를 켜면 실시간 꼬리 맨 끝에 형식 문단이 붙는다", () => {
  const { chatId, characterId } = roomWith(DAY);
  setClock("10:30");
  const blocks = buildSystemBlocks(characterId, chatId, { signals: true });
  assert.ok(blocks[2].text.endsWith(REPLY_ENVELOPE));
  assert.equal(blocks[0].text.includes(REPLY_ENVELOPE), false);
  assert.equal(blocks[1].text.includes(REPLY_ENVELOPE), false);
});

test("말투가 반말로 저장돼 있으면 반말 안내가 들어간다", () => {
  const { chatId, characterId } = roomWith(DAY);
  setClock("10:30");
  const joined = (opts: Record<string, never>): string =>
    buildSystemBlocks(characterId, chatId, opts)
      .map((b) => b.text)
      .join("\n");
  // 새로 만든 캐릭터는 존댓말이라 반말 안내가 없다
  assert.equal(joined({}).includes(BANMAL_NOTE), false);
  setSpeechLevel(characterId, "casual", `${PLAN_DATE} 10:20:00`);
  assert.ok(joined({}).includes(BANMAL_NOTE));
});

// ── readTodayPlan ──────────────────────────────────────────────────────

test("저장된 각본을 그대로 돌려주고 없거나 깨졌으면 null이다", () => {
  setClock("10:30");
  assert.equal(readTodayPlan(roomWith(null).characterId), null);

  const saved: DayPlan = { date: PLAN_DATE, blocks: DAY };
  const { characterId } = roomWith(DAY);
  assert.deepEqual(readTodayPlan(characterId), saved);
  assert.deepEqual(readTodayPlan(characterId, PLAN_DATE), saved);
  // 다른 날짜로 물으면 없다
  assert.equal(readTodayPlan(characterId, "2026-09-06"), null);

  const broken = roomWith(null);
  saveDayPlan(broken.characterId, PLAN_DATE, "{ 깨진 JSON");
  assert.equal(readTodayPlan(broken.characterId), null);
});

// ── promiseSlotFor ─────────────────────────────────────────────────────

test("각본이 없으면 약속 시각을 고르지 않는다", () => {
  setClock("13:20");
  assert.equal(promiseSlotFor(roomWith(null).characterId), null);
});

test("불가 블록 안이면 그 블록 끝에서 흩뜨린 값 안으로 약속 시각을 고른다", () => {
  const { characterId } = roomWith(DAY);
  setClock("13:20");
  const slot = promiseSlotFor(characterId);
  assert.ok(slot);
  assert.deepEqual(slot.block, DAY[1]);
  const untilEnd = 40 * 60_000;
  assert.ok(slot.waitMs >= untilEnd && slot.waitMs < untilEnd + BLOCK_END_JITTER_MS);
});

test("즉답 블록 안이면 다음 블록 끝으로 잡는다", () => {
  const { characterId } = roomWith(DAY);
  setClock("10:30");
  const slot = promiseSlotFor(characterId);
  assert.ok(slot);
  assert.deepEqual(slot.block, DAY[1]);
  const untilEnd = (14 * 60 - (10 * 60 + 30)) * 60_000;
  assert.ok(slot.waitMs >= untilEnd && slot.waitMs < untilEnd + BLOCK_END_JITTER_MS);
});
