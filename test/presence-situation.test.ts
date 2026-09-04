// 자리 비움 예고의 상황 문단을 검사한다 — 모델은 부르지 않아 값이 안 든다.
//
// 무슨 일로 자리를 비우는지 남기라는 줄이 상대가 방금 남긴 말이 있을 때만 붙어서, 마지막 말이
// 캐릭터 것인 날은 예고가 지난 대화에 답만 하고 나갔다(이슈 #265). 마지막 말이 누구 것이든 그
// 줄이 들어가는지, 캐릭터 말로 끝났으면 이미 답한 말에 다시 답하지 말라는 줄이 붙는지, 문안
// 형식에 자리를 비우는 일을 적는 칸이 있는지 본다.
//
// presence.ts가 DB와 봇 모듈을 함께 읽으므로 DB는 임시 파일로 새로 만들고 토큰은 가짜다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

// DB 경로를 정한 뒤에 읽어야 임시 파일로 열린다 — 정적 import는 이 줄들보다 먼저 돈다.
const { presenceSituation } = await import("../src/presence.js");
type PlanBlock = Parameters<typeof presenceSituation>[0];

const meeting: PlanBlock = {
  start: "15:00",
  end: "16:30",
  activity: "팀 회의",
  responsiveness: "unavailable",
  advance_known: true,
};

const AWAY_REASON = /무슨 일로 자리를 비우는지는 반드시 남긴다/;
const PENDING_LINE = /상대가 방금 남긴 말이 있다/;
const NO_REANSWER = /다시 답하지 않고/;

test("상대가 방금 남긴 말이 있으면 미뤄도 된다는 줄과 자리를 비우는 이유를 남기라는 줄이 함께 들어간다", () => {
  const out = presenceSituation(meeting, false, "", true);
  assert.match(out, PENDING_LINE);
  assert.match(out, AWAY_REASON);
  assert.doesNotMatch(out, NO_REANSWER);
});

test("마지막 말이 캐릭터 것이어도 자리를 비우는 이유를 남기라는 줄이 들어간다", () => {
  const out = presenceSituation(meeting, false, "", false);
  assert.match(out, AWAY_REASON);
  assert.match(out, NO_REANSWER);
  assert.doesNotMatch(out, PENDING_LINE);
});

test("연속 불가 사이의 경계에서도 같은 줄이 들어간다", () => {
  const out = presenceSituation(meeting, true, "점심 약속", false);
  assert.match(out, /"점심 약속"을\(를\) 막 끝냈고/);
  assert.match(out, AWAY_REASON);
});

test("문안 형식에 자리를 비우는 일을 적는 칸이 있다", () => {
  const out = presenceSituation(meeting, false, "", true);
  assert.match(out, /"send":true,"away":/);
  assert.match(out, /away 칸에는 무슨 일로 자리를 비우는지/);
});
