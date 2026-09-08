// 봇 시작점(index.ts)의 크론표 — 틱 여덟 개의 표현식과 시간대 — 를 검사한다.
//
// index.ts는 읽는 순간 봇 폴링을 켜므로 모듈로 부르지 않고 파일을 글자로 읽는다. cron.schedule
// 호출마다 첫 문자열 인자와 본문을 뽑아, 본문이 부르는 틱 함수 이름으로 어느 틱인지 찾고 표현식을
// 견준다. 호출마다 timezone: "Asia/Seoul"이 붙는지도 센다. 표현식이 바뀌면 그 틱의 검사가 걸려
// 무엇이 언제 도는지 다시 적게 된다.
//
// 파일만 읽는다. DB도 모델도 부르지 않아 값이 안 든다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { NIGHTLY_RUN_AT } from "../src/thresholds.js";

const SRC = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

// cron.schedule( 뒤부터 그 호출을 닫는 줄(`);`)까지가 한 호출의 본문이다 — 마지막 호출 뒤에 오는
// 기동 코드(부팅 복구 등)가 본문에 섞이지 않게 거기서 자른다.
const calls = SRC.split("cron.schedule(")
  .slice(1)
  .map((seg) => seg.split("\n);")[0] ?? "")
  .map((body) => ({
    expr: body.match(/^\s*"([^"]+)"/)?.[1] ?? "",
    seoul: body.includes('timezone: "Asia/Seoul"'),
    body,
  }));

const exprOf = (handler: string): string => {
  const hit = calls.filter((c) => c.body.includes(handler));
  assert.equal(hit.length, 1, `${handler}를 부르는 크론 호출이 하나여야 한다`);
  return hit[0]?.expr ?? "";
};

test("크론 호출이 여덟 개이고 전부 Asia/Seoul 시간대가 붙는다", () => {
  assert.equal(calls.length, 8);
  for (const c of calls) assert.ok(c.expr, "표현식이 첫 인자여야 한다");
  assert.ok(calls.every((c) => c.seoul));
});

test("새벽 정리 API 폴백은 05:40에 돌고 그 시각은 NIGHTLY_RUN_AT과 같다", () => {
  assert.equal(exprOf("runNightly("), "40 5 * * *");
  assert.equal(
    exprOf("runNightly("),
    `${NIGHTLY_RUN_AT.minute} ${NIGHTLY_RUN_AT.hour} * * *`,
  );
});

test("선톡 디스패처는 6시부터 22시까지 3분마다 돈다", () => {
  assert.equal(exprOf("runDispatchTick()"), "*/3 6-22 * * *");
});

test("침묵 팔로업은 0~4시와 8~23시에 15분마다 돈다", () => {
  assert.equal(exprOf("runFollowupTick()"), "*/15 0-4,8-23 * * *");
});

test("자리 비움 예고는 하루 종일 10분마다 돈다", () => {
  assert.equal(exprOf("runPresenceTick()"), "*/10 * * * *");
});

test("놓친 답장 복구는 2분마다 돈다", () => {
  assert.equal(exprOf("recoverMissedReplies()"), "*/2 * * * *");
});

test("슬랙 게시와 답장 트레이스는 1분마다 돈다", () => {
  assert.equal(exprOf("runTraceTick()"), "* * * * *");
});

test("피드백 수집은 10분마다 돈다", () => {
  assert.equal(exprOf("runFeedbackTick()"), "*/10 * * * *");
});

test("관측 기록 정리는 새벽 정리 10분 뒤인 05:50에 돈다", () => {
  assert.equal(exprOf("pruneLlmCalls()"), "50 5 * * *");
});
