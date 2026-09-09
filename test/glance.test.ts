// 틈새 한 줄(glance.ts)의 조건 함수와 상황 문단을 검사한다.
//
// glanceBlock은 순수 함수라 블록 목록과 분 값만 넣는다. 시각은 논리 시계의 분 수다.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "glance-")), "t.db");
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

const { glanceBlock, glanceSituation } = await import("../src/glance.js");
const { GLANCE_AFTER_USER_MIN, GLANCE_MIN_LEFT_MIN } = await import("../src/thresholds.js");

type PlanBlock = Parameters<typeof glanceSituation>[0];

const at = (h: number, m: number): number => h * 60 + m;

const before: PlanBlock = {
  start: "18:00",
  end: "19:00",
  activity: "저녁",
  responsiveness: "instant",
  advance_known: true,
};
const workout: PlanBlock = {
  start: "19:00",
  end: "19:40",
  activity: "헬스장 운동",
  responsiveness: "unavailable",
  advance_known: true,
  category: "personal",
};
const blocks = [before, workout];

test("불가 블록 안에서 유저 말이 5분 지났고 15분 넘게 남았으면 그 블록을 돌려준다", () => {
  assert.equal(glanceBlock(blocks, at(19, 20), "user", 8), workout);
});

test("마지막 말이 캐릭터 것이면 보내지 않는다", () => {
  assert.equal(glanceBlock(blocks, at(19, 20), "assistant", 8), null);
});

test("유저 말이 온 지 5분이 안 됐으면 기다린다", () => {
  assert.equal(glanceBlock(blocks, at(19, 20), "user", GLANCE_AFTER_USER_MIN - 1), null);
  assert.equal(glanceBlock(blocks, at(19, 20), "user", GLANCE_AFTER_USER_MIN), workout);
});

test("블록 끝까지 15분 이하로 남으면 몰아 답장에 맡긴다", () => {
  assert.equal(glanceBlock(blocks, at(19, 40 - GLANCE_MIN_LEFT_MIN), "user", 6), null);
  assert.equal(glanceBlock(blocks, at(19, 40 - GLANCE_MIN_LEFT_MIN - 1), "user", 6), workout);
});

test("블록이 시작하기 전에 온 말은 이 블록의 확인 말이 아니다", () => {
  assert.equal(glanceBlock(blocks, at(19, 10), "user", 12), null);
  assert.equal(glanceBlock(blocks, at(19, 10), "user", 10), workout);
});

test("공적 블록과 자는 블록, 불가가 아닌 블록에서는 보내지 않는다", () => {
  const official: PlanBlock = { ...workout, activity: "팀 회의", category: "official" };
  const sleep: PlanBlock = { ...workout, activity: "잠" };
  assert.equal(glanceBlock([before, official], at(19, 20), "user", 8), null);
  assert.equal(glanceBlock([before, sleep], at(19, 20), "user", 8), null);
  assert.equal(glanceBlock(blocks, at(18, 30), "user", 8), null);
  assert.equal(glanceBlock(blocks, at(19, 40), "user", 8), null);
});

test("상황 문단에 하는 일과 끝나는 시각, 보낼지 가르는 기준이 들어간다", () => {
  const s = glanceSituation(workout);
  assert.match(s, /"헬스장 운동"/);
  assert.match(s, /19:40에 끝난다/);
  assert.match(s, /확인 말이면 보낸다/);
  assert.match(s, /나중에 답해도 되는 물음이면 send=false/);
  assert.match(s, /짧은 문장 2~3개/);
  assert.match(s, /\{"send":false\}/);
});

test("자정을 넘긴 블록의 끝 시각은 시계 표기로 적는다", () => {
  const late: PlanBlock = { ...workout, start: "24:10", end: "24:50" };
  assert.match(glanceSituation(late), /00:50에 끝난다/);
});
