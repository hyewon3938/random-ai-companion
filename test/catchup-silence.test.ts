// 근황 선톡의 침묵 조건을 검사한다 — 모델은 부르지 않아 값이 안 든다.
//
// 유저 발화만 재던 때는 자리 비움 예고와 복귀 인사가 방금 나간 위에 근황이 겹쳐, 답 없는 말이
// 한 시간 안에 셋 쌓였다(이슈 #274). 유저의 마지막 말과 캐릭터의 마지막 말 둘 다 네 시간이
// 지나야 통과하는지, 어느 한쪽이 최근이면 막히는지 본다.
//
// followup.ts가 DB와 봇 모듈을 함께 읽으므로 DB는 임시 파일로 새로 만들고 토큰은 가짜다.
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
const { catchupSilenceOk } = await import("../src/followup.js");

// 저장된 시각은 KST 벽시계 문자열이다. 기준 시각 19:15에서 분 단위로 거슬러 만든다.
const NOW = new Date("2026-09-04T19:15:00+09:00").getTime();
const kstAgo = (minutes: number): string => {
  const d = new Date(NOW - minutes * 60_000 + 9 * 3600_000);
  return d.toISOString().slice(0, 19).replace("T", " ");
};

test("유저도 캐릭터도 네 시간 넘게 조용하면 근황을 보낼 수 있다", () => {
  assert.equal(catchupSilenceOk(kstAgo(5 * 60), kstAgo(4 * 60 + 30), NOW), true);
});

test("복귀 인사가 15분 전에 나갔으면 유저가 오래 조용해도 근황을 접는다", () => {
  assert.equal(catchupSilenceOk(kstAgo(8 * 60), kstAgo(15), NOW), false);
});

test("유저 말이 세 시간 전이면 캐릭터 말이 오래됐어도 아직 이르다", () => {
  assert.equal(catchupSilenceOk(kstAgo(3 * 60), kstAgo(5 * 60), NOW), false);
});

test("둘 다 정확히 네 시간이면 경계를 포함해 통과한다", () => {
  assert.equal(catchupSilenceOk(kstAgo(4 * 60), kstAgo(4 * 60), NOW), true);
});
