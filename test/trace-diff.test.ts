// 슬랙 게시용 비교(trace/diff.ts)가 줄 단위와 낱말 단위로 달라진 자리만 표시하는지 검사한다 — 모델도 DB도 쓰지 않는다.
//
// 줄 단위 비교는 바뀐 줄만 `[빠짐]`·`[더함]`으로 남기고 너무 길면 자르는지, 낱말 단위 비교는 전문
// 하나 안에서 빠진 말을 `[-…-]`, 더한 말을 `{+…+}`로 감싸는지 본다. 이전 값 전문과 새 값
// 전문을 나란히 적지 않는 것이 이슈 #312의 요구라, 같은 낱말은 표시 없이 그대로 남아야 한다.
import assert from "node:assert/strict";
import { test } from "node:test";

import { lineDiff, wordDiff } from "../src/trace/diff.js";

test("줄 단위 비교는 바뀐 줄만 남기고 너무 길면 자른다", () => {
  assert.equal(lineDiff("a\nb", "a\nb"), "(줄 단위로는 같다 — 공백만 바뀌었다)");
  assert.equal(lineDiff("a\nb\nc", "a\nx\nc"), "[빠짐] b\n[더함] x");
  // 본문이 `- `로 시작하는 목록이어도 표시와 겹치지 않는다 (이슈 #347)
  assert.equal(lineDiff("- 가\n- 나", "- 가\n- 다"), "[빠짐] - 나\n[더함] - 다");
  const before = ["1", "2", "3", "4"].join("\n");
  const after = ["5", "6", "7", "8"].join("\n");
  const cut = lineDiff(before, after, 2);
  assert.equal(cut.split("\n").length, 3);
  assert.match(cut, /… 6줄 더$/);
});

test("낱말 단위 비교는 같은 낱말은 두고 바뀐 자리만 감싼다", () => {
  assert.equal(
    wordDiff("회사를 다닌다", "회사를 옮길 생각이 있다"),
    "회사를 [-다닌다-] {+옮길 생각이 있다+}",
  );
  // 가운데 낱말이 바뀌면 앞뒤는 그대로 남는다
  assert.equal(
    wordDiff("주말에 집 근처를 달린다", "주말에 한강을 달린다"),
    "주말에 [-집 근처를-] {+한강을+} 달린다",
  );
  // 끝에 덧붙이기만 하면 빠진 표시가 없다
  assert.equal(
    wordDiff("아이스 라떼만 마신다", "아이스 라떼만 마신다. 디카페인은 안 찾는다"),
    "아이스 라떼만 [-마신다-] {+마신다. 디카페인은 안 찾는다+}",
  );
  assert.equal(wordDiff("그대로", "그대로"), "그대로");
});

test("한쪽이 비면 전문을 통째로 더한 말이나 빠진 말로 적는다", () => {
  assert.equal(wordDiff("", "영화 얘기"), "{+영화 얘기+}");
  assert.equal(wordDiff("영화 얘기", ""), "[-영화 얘기-]");
  assert.equal(wordDiff("", ""), "");
  // 공백만 다른 것은 같은 글로 본다
  assert.equal(wordDiff("영화  얘기", "영화 얘기"), "영화 얘기");
});

test("겹치는 낱말이 없으면 빠진 말을 먼저, 더한 말을 뒤에 적는다", () => {
  assert.equal(
    wordDiff("주 이삼 회 집 근처를 달린다", "요즘은 아침마다 달린다"),
    "[-주 이삼 회 집 근처를-] {+요즘은 아침마다+} 달린다",
  );
  assert.equal(
    wordDiff("말이 잘 통해서 기다려진다", "편해졌다"),
    "[-말이 잘 통해서 기다려진다-] {+편해졌다+}",
  );
});
