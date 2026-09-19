// 주간 관계 요약(trace/relationship-weekly.ts)이 지난주 값을 한 건으로 모으고 같은 주에 두 번 쌓지 않는지 검사한다 — 모델은 부르지 않는다.
//
// 한 주 안에 선톡·플러팅·답·대화 계획을 심고, 주 밖에도 메시지와 처음을 하나씩 둬서 창이 월~일로 잘리는지
// 본다. 틈새 한 줄은 선톡 수에서 빠지고, 다음 논리일에 온 답은 선톡에 답한 것으로 치지 않는다.
// DB는 임시 파일로 새로 만들고 슬랙에는 아무것도 보내지 않는다 — 트레이스 표에 쌓인 행만 읽는다.
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
process.env.SLACK_BOT_TOKEN = "test-slack-token";
process.env.SLACK_TRACE_CHANNEL = "C_TEST";

const {
  db,
  confirmFirst,
  insertFirst,
  logMessage,
  raiseStage,
  saveReactionScore,
  saveRelationshipIntent,
} = await import("../src/db.js");
const { lastWeekStart, durationLabel, postWeeklyRelationship } =
  await import("../src/trace/relationship-weekly.js");
const { createFixtureCharacter } =
  await import("../src/eval/fixture-character.js");
const { kstLogicalDate, shiftDate } = await import("../src/kst.js");
const { FIRST_KIND_NAME } = await import("../src/labels.js");
const { dateLabel } = await import("../src/trace/format.js");

const CHAT_ID = "1";
const characterId = createFixtureCharacter(CHAT_ID);

// 캐릭터를 만든 뒤의 주. 캐릭터가 오늘 생기므로 두 주 뒤 주를 요약 대상으로 삼는다.
const W = lastWeekStart(shiftDate(kstLogicalDate(), 14));
const at = (offset: number, time: string): string =>
  `${shiftDate(W, offset)} ${time}`;

const weeklyRows = (): { dedupe_key: string; text: string }[] =>
  db
    .prepare(
      `SELECT dedupe_key, text FROM trace_events WHERE kind = 'relationship_weekly' ORDER BY id`,
    )
    .all() as { dedupe_key: string; text: string }[];

test("지난주는 오늘이 든 주 월요일에서 7일 앞 월요일이다", () => {
  assert.equal(lastWeekStart("2026-09-21"), "2026-09-14");
  assert.equal(lastWeekStart("2026-09-20"), "2026-09-07");
  assert.equal(lastWeekStart("2026-09-27"), "2026-09-14");
});

test("간격은 초·분·시간으로 읽힌다", () => {
  assert.equal(durationLabel(30_000), "30초");
  assert.equal(durationLabel(5 * 60_000), "5분");
  assert.equal(durationLabel(120 * 60_000), "2시간");
  assert.equal(durationLabel(125 * 60_000), "2시간 5분");
});

test("그 주가 끝난 뒤에 만든 캐릭터는 요약하지 않는다", () => {
  postWeeklyRelationship(kstLogicalDate());
  assert.equal(weeklyRows().length, 0);
});

test("지난주 단계·처음·플러팅·대화 계획·유저 반응을 한 건으로 모으고 같은 주에는 다시 쌓지 않는다", () => {
  // 주 밖: 앞 주 일요일 밤과 다음 주 월요일 아침.
  logMessage(CHAT_ID, characterId, "user", "주 밖 앞", at(-1, "22:00:00"));
  // 월: 아침 선톡에 20분 뒤 답, 이어서 별명 플러팅에 2분 뒤 답.
  logMessage(CHAT_ID, characterId, "assistant", "잘 잤어?", at(0, "10:00:00"), {
    proactive: true,
    kind: "morning",
  });
  logMessage(CHAT_ID, characterId, "user", "응", at(0, "10:20:00"));
  logMessage(CHAT_ID, characterId, "assistant", "오늘도 힘내", at(0, "10:22:00"), {
    move: "nickname",
    intent_lines: ["dig"],
  });
  logMessage(CHAT_ID, characterId, "user", "고마워", at(0, "10:24:00"));
  // 수: 틈새 한 줄은 선톡으로 세지 않는다. 답은 턴으로 센다(5분).
  logMessage(CHAT_ID, characterId, "assistant", "잠깐", at(2, "21:00:00"), {
    proactive: true,
    kind: "glance",
  });
  logMessage(CHAT_ID, characterId, "user", "왜", at(2, "21:05:00"));
  // 금 밤 선톡은 다음 논리일 낮에야 답이 왔다 — 답한 선톡이 아니고 턴 간격에도 안 든다.
  logMessage(CHAT_ID, characterId, "assistant", "자?", at(4, "23:00:00"), {
    proactive: true,
    kind: "checkin",
  });
  logMessage(CHAT_ID, characterId, "user", "어제 잤어", at(5, "12:00:00"));
  logMessage(CHAT_ID, characterId, "user", "주 밖 뒤", at(7, "10:00:00"));

  const inWeek = insertFirst({
    characterId,
    chatId: CHAT_ID,
    kind: "first_laugh",
    by: "character",
    happenedAt: at(1, "20:00:00"),
  });
  const before = insertFirst({
    characterId,
    chatId: CHAT_ID,
    kind: "first_remember",
    by: "character",
    happenedAt: at(-2, "20:00:00"),
  });
  assert.ok(inWeek && before);
  confirmFirst(inWeek);
  confirmFirst(before);
  raiseStage(characterId, 2, shiftDate(W, 3));
  saveReactionScore(CHAT_ID, "nickname", 0.4, 5, at(1, "05:10:00"));
  // 계획: 월요일 두 줄은 답장이 다 썼고, 수요일 한 줄은 안 썼다. 다음 주 월요일 계획은 창 밖이다.
  saveRelationshipIntent(characterId, shiftDate(W, 0), { dig: "주말 계획", move: "nickname" }, at(0, "05:10:00"));
  saveRelationshipIntent(characterId, shiftDate(W, 2), { thread: "어제 본 영화" }, at(2, "05:10:00"));
  saveRelationshipIntent(characterId, shiftDate(W, 7), { dig: "창 밖" }, at(7, "05:10:00"));

  postWeeklyRelationship(shiftDate(W, 7));
  postWeeklyRelationship(shiftDate(W, 7));
  postWeeklyRelationship(shiftDate(W, 9));

  const rows = weeklyRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dedupe_key, `relationship_weekly:${characterId}:${W}`);
  const lines = rows[0].text.split("\n");
  assert.equal(
    lines[0],
    `:calendar: *주간 관계 요약* ${dateLabel(W)}~${dateLabel(shiftDate(W, 6))} · 캐릭터 #${characterId}`,
  );
  assert.equal(
    lines[1],
    `단계: 2단계 편해진 사이 · ${dateLabel(shiftDate(W, 3))}부터 · 이번 주에 2단계로 넘어갔다`,
  );
  assert.equal(
    lines[2],
    `처음: 이번 주 1개 · 확정 누적 2/${Object.keys(FIRST_KIND_NAME).length}`,
  );
  assert.equal(lines[3], `> 웃기기 · 캐릭터 · ${at(1, "20:00:00").slice(5, 16)} · 확정`);
  assert.equal(lines[4], "플러팅 반응: 이번 주 표본 1개 (새벽 정리 규칙으로 다시 셈)");
  assert.match(lines[5], /^> 별명 부르기 1회 · 표본 평균 −?\d\.\d\d · 지금 점수 0\.40 \(누적 표본 5\)$/);
  assert.equal(
    lines[6],
    "대화 계획: 계획이 있던 날 2/7일 · 계획한 줄 3개 중 그날 쓴 줄 2개",
  );
  assert.equal(
    lines[7],
    "유저 반응: 말한 날 3/7일 · 선톡 2통 중 답 1통 · 캐릭터 말 뒤 6시간 안에 다시 말한 턴 3건, 간격 중앙값 5분",
  );
  assert.equal(lines.length, 8);
});

test("대화가 없던 주는 없다고 적는다", () => {
  const empty = shiftDate(W, 14);
  postWeeklyRelationship(shiftDate(empty, 7));
  const row = weeklyRows().find(
    (r) => r.dedupe_key === `relationship_weekly:${characterId}:${empty}`,
  );
  assert.ok(row);
  const lines = row.text.split("\n");
  assert.equal(lines[1], `단계: 2단계 편해진 사이 · ${dateLabel(shiftDate(W, 3))}부터`);
  assert.equal(lines[2], `처음: 이번 주 없음 · 확정 누적 2/${Object.keys(FIRST_KIND_NAME).length}`);
  assert.equal(lines[3], "플러팅 반응: 이번 주 쓴 플러팅 없음");
  assert.equal(lines[4], "대화 계획: 이번 주 저장된 계획 없음");
  assert.equal(
    lines[5],
    "유저 반응: 말한 날 0/7일 · 선톡 0통 중 답 0통 · 캐릭터 말 뒤 6시간 안에 다시 말한 턴 없음",
  );
});
