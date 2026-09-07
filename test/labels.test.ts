// 닫힌 목록 값을 식별자로 되돌리는 정규화 함수(labels.ts)를 검사한다 — DB도 모델도 없다.
//
// 저장된 옛 각본과 외부 생성분에 남은 한글 값, 앞뒤 공백, 문자열이 아닌 입력을 각 함수가
// 어떻게 받는지 보고, 슬랙 리액션 이름을 분류로 옮기는 자리에서 살색 변형이 걷히는지 본다.
// 이름표 레코드의 값은 하나하나 단언하지 않는다. 정규화 함수가 그 키와 한글 이름을 전부
// 되돌리는지만 한 건으로 묶는다 — 표에 값이 늘거나 이름이 바뀌었는데 정규화 표가 따라오지
// 않으면 여기서 걸린다.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ACTIVITY_CATEGORY_NAME,
  BLOCK_SOURCE_NAME,
  FEEDBACK_KIND_NAME,
  HOLD_OUTCOME,
  RESPONSIVENESS_NAME,
  WOKE_OUTCOME,
  isHoldOutcome,
  toActivityCategory,
  toBlockSource,
  toFeedbackKind,
  toResponsiveness,
} from "../src/labels.js";

// ── toResponsiveness ──────────────────────────────────────────────────

test("답장 여건의 정식 값은 그대로 돌아온다", () => {
  assert.equal(toResponsiveness("instant"), "instant");
  assert.equal(toResponsiveness("intermittent"), "intermittent");
  assert.equal(toResponsiveness("unavailable"), "unavailable");
});

test("답장 여건의 한글 값은 식별자로 돌아온다", () => {
  assert.equal(toResponsiveness("즉답"), "instant");
  assert.equal(toResponsiveness("틈틈이"), "intermittent");
  assert.equal(toResponsiveness("불가"), "unavailable");
});

test("옛 표기 짬짬이도 틈틈이로 읽는다", () => {
  assert.equal(toResponsiveness("짬짬이"), "intermittent");
});

test("답장 여건의 앞뒤 공백은 걷어낸다", () => {
  assert.equal(toResponsiveness("  즉답 "), "instant");
  assert.equal(toResponsiveness("\tunavailable\n"), "unavailable");
});

test("답장 여건에 문자열이 아닌 값이 오면 null이다", () => {
  assert.equal(toResponsiveness(3), null);
  assert.equal(toResponsiveness(null), null);
  assert.equal(toResponsiveness(undefined), null);
  assert.equal(toResponsiveness({ value: "즉답" }), null);
});

test("목록에 없는 답장 여건은 null이다", () => {
  assert.equal(toResponsiveness("바쁨"), null);
  assert.equal(toResponsiveness(""), null);
});

// ── toActivityCategory ────────────────────────────────────────────────

test("활동 성격은 정식 값과 한글 값 둘 다 받는다", () => {
  assert.equal(toActivityCategory("personal"), "personal");
  assert.equal(toActivityCategory("개인"), "personal");
  assert.equal(toActivityCategory("사회"), "social");
  assert.equal(toActivityCategory("공적"), "official");
});

test("활동 성격의 공백은 걷어내고 목록 밖 값은 null이다", () => {
  assert.equal(toActivityCategory(" 공적 "), "official");
  assert.equal(toActivityCategory("기타"), null);
  assert.equal(toActivityCategory(1), null);
});

// ── toBlockSource ─────────────────────────────────────────────────────

test("블록 출처는 정식 값과 한글 값 둘 다 받는다", () => {
  assert.equal(toBlockSource("schedule"), "schedule");
  assert.equal(toBlockSource("예정된 일"), "schedule");
  assert.equal(toBlockSource("매주 루틴"), "routine");
  assert.equal(toBlockSource("진행 중인 일"), "ongoing");
});

test("블록 출처의 공백은 걷어내고 목록 밖 값은 null이다", () => {
  assert.equal(toBlockSource(" 매주 루틴 "), "routine");
  assert.equal(toBlockSource("일정"), null);
  assert.equal(toBlockSource(null), null);
});

// ── 이름표와 정규화 표의 정합 ──────────────────────────────────────────

test("이름표의 키와 한글 이름은 전부 정규화 함수로 되돌아온다", () => {
  for (const [key, name] of Object.entries(RESPONSIVENESS_NAME)) {
    assert.equal(toResponsiveness(key), key, `답장 여건 키 ${key}`);
    assert.equal(toResponsiveness(name), key, `답장 여건 이름 ${name}`);
  }
  for (const [key, name] of Object.entries(ACTIVITY_CATEGORY_NAME)) {
    assert.equal(toActivityCategory(key), key, `활동 성격 키 ${key}`);
    assert.equal(toActivityCategory(name), key, `활동 성격 이름 ${name}`);
  }
  for (const [key, name] of Object.entries(BLOCK_SOURCE_NAME)) {
    assert.equal(toBlockSource(key), key, `블록 출처 키 ${key}`);
    assert.equal(toBlockSource(name), key, `블록 출처 이름 ${name}`);
  }
  // 피드백 분류는 이모지 이름에서만 온다 — 이름표에 있는 분류마다 고르는 이모지가 하나는 있어야 한다.
  const reachable = new Set(
    ["x", "speech_balloon", "alarm_clock", "+1", "thumbsup"].map(
      toFeedbackKind,
    ),
  );
  assert.deepEqual(reachable, new Set(Object.keys(FEEDBACK_KIND_NAME)));
});

// ── isHoldOutcome ─────────────────────────────────────────────────────

test("붙잡혀 접은 결말은 취소와 미룸 둘이다", () => {
  assert.equal(isHoldOutcome(HOLD_OUTCOME.cancelled), true);
  assert.equal(isHoldOutcome(HOLD_OUTCOME.deferred), true);
  assert.equal(isHoldOutcome("취소"), true);
  assert.equal(isHoldOutcome("미룸"), true);
});

test("결말의 앞뒤 공백은 걷어낸다", () => {
  assert.equal(isHoldOutcome(" 취소 "), true);
  assert.equal(isHoldOutcome("미룸\n"), true);
});

test("자다 깬 기록은 붙잡힌 결말이 아니다", () => {
  assert.equal(isHoldOutcome(WOKE_OUTCOME), false);
  assert.equal(isHoldOutcome("깸"), false);
  assert.equal(isHoldOutcome(""), false);
});

// ── toFeedbackKind ────────────────────────────────────────────────────

test("리액션 이름마다 분류가 정해져 있다", () => {
  assert.equal(toFeedbackKind("x"), "fact");
  assert.equal(toFeedbackKind("speech_balloon"), "tone");
  assert.equal(toFeedbackKind("alarm_clock"), "timing");
  assert.equal(toFeedbackKind("+1"), "good");
  assert.equal(toFeedbackKind("thumbsup"), "good");
});

test("살색 변형이 붙은 이름은 앞부분만 본다", () => {
  assert.equal(toFeedbackKind("+1::skin-tone-3"), "good");
  assert.equal(toFeedbackKind("thumbsup::skin-tone-2"), "good");
});

test("리액션 이름의 앞뒤 공백은 걷어낸다", () => {
  assert.equal(toFeedbackKind(" x "), "fact");
});

test("목록에 없는 이모지는 표시가 아니라 null이다", () => {
  assert.equal(toFeedbackKind("eyes"), null);
  assert.equal(toFeedbackKind(""), null);
  assert.equal(toFeedbackKind("eyes::skin-tone-3"), null);
});
