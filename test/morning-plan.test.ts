// 아침 각본 게시(trace/morning-plan.ts)가 블록 한 줄과 각본 프롬프트를 사람이 읽는 꼴로 옮기는지 검사한다 — 모델은 부르지 않는다.
//
// 블록 줄에는 활동 성격·답장 여건과 텀 표의 범위가 붙고, 당일에 닥치는 일은 별표로 표시한다.
// 각본 프롬프트는 고정 규칙이 시작하는 자리에서 둘로 나뉜다. DB는 임시 파일로 새로 만든다.
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

const { blockLine, promptSections } = await import("../src/trace/morning-plan.js");

const block = (over: Partial<PlanBlock>): PlanBlock => ({
  start: "09:00",
  end: "12:00",
  activity: "오전 업무",
  responsiveness: "intermittent",
  advance_known: true,
  category: "official",
  ...over,
});

test("블록 줄은 활동 성격·답장 여건과 텀 표의 범위를 붙인다", () => {
  assert.equal(blockLine(block({})), "09:00~12:00 (공적) 오전 업무 [틈틈이] 1~8분");
  assert.equal(
    blockLine(block({ activity: "헬스", category: "personal", start: "18:00", end: "19:00" })),
    "18:00~19:00 (개인) 헬스 [틈틈이] 20초~2분 30초",
  );
  assert.equal(
    blockLine(block({ activity: "친구랑 저녁", category: "social", start: "19:30", end: "21:00" })),
    "19:30~21:00 (사회) 친구랑 저녁 [틈틈이] 30초~4분",
  );
  assert.equal(
    blockLine(block({ activity: "집에서 쉼", responsiveness: "instant", category: "personal" })),
    "09:00~12:00 (개인) 집에서 쉼 [즉답] 0초~2분",
  );
});

test("불가 구간은 끝난 뒤 답하고 잠은 깨면 바로 답한다", () => {
  assert.equal(
    blockLine(block({ activity: "팀 회의", responsiveness: "unavailable", start: "13:00", end: "14:30" })),
    "13:00~14:30 (공적) 팀 회의 [불가] 14:30 끝난 뒤 1분 안",
  );
  assert.equal(
    blockLine(
      block({ activity: "잠", responsiveness: "unavailable", category: "personal", start: "24:30", end: "31:00" }),
    ),
    "00:30~07:00 (개인) 잠 [불가] 자다 깨면 바로",
  );
});

test("당일에 닥치는 일은 활동 앞에 별표 두 개가 붙는다", () => {
  assert.equal(
    blockLine(block({ activity: "급한 수정", advance_known: false })),
    "09:00~12:00 (공적) **급한 수정 [틈틈이] 1~8분",
  );
});

test("각본 프롬프트는 고정 규칙 앞에서 둘로 나뉜다", () => {
  const whole = promptSections("규칙 표시가 없는 프롬프트");
  assert.equal(whole.length, 1);
  assert.equal(whole[0].label, "각본 생성 프롬프트");

  const prompt = "오늘 데이터\n\n[컨디션→기상→활동을 하나로 잇기]\n규칙 본문";
  const parts = promptSections(prompt);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].body, "오늘 데이터");
  assert.ok(parts[1].body.startsWith("[컨디션→기상→활동을 하나로 잇기]"));
  assert.ok(parts[1].body.endsWith("규칙 본문"));
});
