// 캐릭터·관계·유저 프로필과 일정·각본·일기·월 리듬 시드의 저장 함수가 조회 규칙대로 도는지 검사한다.
//
// 캐릭터 행을 넣으면 관계 행이 함께 생기는지, 관계 첫 값과 말투 갱신이 맡은 컬럼만 바꾸는지,
// 일정 조회가 어디서는 취소·미룸을 거르고 어디서는 일부러 안 거르는지, 글자까지 같은 일정만
// 한 줄로 합치는지, 최근 일기가 오래된 순으로 오는지 본다. 모두 src/db/life.ts와
// src/db/characters.ts의 함수다.
//
// DB는 임시 파일로 새로 만든다. 모델도 텔레그램도 부르지 않아 값이 안 든다.
import assert from "node:assert/strict";
import { after, test } from "node:test";
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
const {
  db,
  addSchedule,
  getActiveSchedulesOn,
  getCharacterById,
  getDayPlanMadeBy,
  getDaySeed,
  getMetAt,
  getRecentDiaries,
  getRelationship,
  getSchedulesFrom,
  getUpcomingSchedules,
  getUserProfile,
  hasUserScheduleOn,
  insertCharacter,
  insertDiary,
  monthHasSeeds,
  saveDayPlan,
  saveDaySeed,
  saveRelationshipFirstValues,
  saveUserProfile,
  setSpeechLevel,
} = await import("../src/db.js");

const AT = "2026-09-07 10:00:00";
const characterId = insertCharacter("chat-life", '{"v":2}', AT);

const setScheduleStatus = (id: number, status: string): void => {
  db.prepare(`UPDATE schedules SET status = ? WHERE id = ?`).run(status, id);
};

after(() => db.close());

// ── 캐릭터와 관계 ─────────────────────────────────────────────────────────

test("캐릭터 행을 넣으면 만난 시각만 적힌 관계 행이 함께 생긴다", () => {
  const ch = getCharacterById(characterId);
  assert.equal(ch?.chat_id, "chat-life");
  assert.equal(ch?.status, "active");
  assert.equal(ch?.genesis_json, '{"v":2}');
  assert.equal(ch?.created_at, AT);
  assert.equal(getMetAt(characterId), AT);
  const rel = getRelationship(characterId);
  assert.equal(rel?.met_at, AT);
  assert.equal(rel?.stage, null);
  assert.equal(rel?.speech_level, null);
  assert.equal(rel?.rapport, null);
  assert.equal(rel?.user_state, null);
  assert.equal(rel?.updated_at, null);
});

test("관계 첫 값은 다섯 항목과 말투를 채우고 잘 통하는 것·조심할 것은 비워 둔다", () => {
  const now = "2026-09-07 10:00:05";
  saveRelationshipFirstValues(
    characterId,
    {
      stage: "알게 된 지 얼마 안 됨",
      speechLevel: "polite",
      speechNote: "서로 존댓말",
      addressTerms: "이름으로 부른다",
      history: "친구 소개로 만났다",
      feelings: "궁금하다",
    },
    now,
  );
  const rel = getRelationship(characterId);
  assert.equal(rel?.stage, "알게 된 지 얼마 안 됨");
  assert.equal(rel?.speech_level, "polite");
  assert.equal(rel?.speech_note, "서로 존댓말");
  assert.equal(rel?.address_terms, "이름으로 부른다");
  assert.equal(rel?.history, "친구 소개로 만났다");
  assert.equal(rel?.feelings, "궁금하다");
  assert.equal(rel?.rapport, null);
  assert.equal(rel?.cautions, null);
  assert.equal(rel?.updated_at, now);
});

test("말투 갱신은 말투와 갱신 시각만 바꾼다", () => {
  const now = "2026-09-08 21:00:00";
  setSpeechLevel(characterId, "casual", now);
  const rel = getRelationship(characterId);
  assert.equal(rel?.speech_level, "casual");
  assert.equal(rel?.updated_at, now);
  assert.equal(rel?.stage, "알게 된 지 얼마 안 됨");
  assert.equal(rel?.speech_note, "서로 존댓말");
});

test("유저 프로필은 행이 없으면 빈 객체, 비운 칸은 undefined로 주고 빈 값은 앞 값을 덮지 않는다", () => {
  assert.deepEqual(getUserProfile("chat-life-none"), {});
  saveUserProfile("chat-life", { gender: "여성" }, AT);
  const first = getUserProfile("chat-life");
  assert.equal(first.gender, "여성");
  assert.equal(first.job, undefined);
  assert.equal(first.region, undefined);
  saveUserProfile("chat-life", { job: "간호사", gender: "" }, AT);
  const second = getUserProfile("chat-life");
  assert.equal(second.gender, "여성");
  assert.equal(second.job, "간호사");
  assert.equal(second.region, undefined);
});

// ── 일정 ──────────────────────────────────────────────────────────────────

test("그날 살아 있는 일정만 주고 취소·미룸은 뺀다", () => {
  const date = "2026-09-10";
  const active = addSchedule(
    characterId,
    "char",
    date,
    "오후",
    "치과",
    AT,
    "conversation",
  );
  const cancelled = addSchedule(
    characterId,
    "char",
    date,
    null,
    "회식",
    AT,
    "conversation",
  );
  const deferred = addSchedule(
    characterId,
    "char",
    date,
    null,
    "미용실",
    AT,
    "conversation",
  );
  addSchedule(characterId, "user", date, null, "면접", AT, "conversation");
  setScheduleStatus(cancelled, "cancelled");
  setScheduleStatus(deferred, "deferred");
  assert.deepEqual(
    getActiveSchedulesOn(characterId, "char", date).map((s) => s.id),
    [active],
  );
});

test("새벽 정리에 보여줄 목록은 취소·미룸 일정도 감추지 않고 상태를 같이 준다", () => {
  const rows = getSchedulesFrom(characterId, "2026-09-10", 50).filter(
    (s) => s.date === "2026-09-10",
  );
  assert.deepEqual(
    rows.map((s) => [s.content, s.status]),
    [
      ["치과", "active"],
      ["회식", "cancelled"],
      ["미용실", "deferred"],
      ["면접", "active"],
    ],
  );
});

test("유저 일정이 있는 날만 참이고 캐릭터 일정이나 취소된 유저 일정은 세지 않는다", () => {
  const charOnly = "2026-09-11";
  addSchedule(characterId, "char", charOnly, null, "야근", AT, "conversation");
  assert.equal(hasUserScheduleOn(characterId, charOnly), false);
  assert.equal(hasUserScheduleOn(characterId, "2026-09-10"), true);
  const userDay = "2026-09-12";
  const id = addSchedule(
    characterId,
    "user",
    userDay,
    null,
    "발표",
    AT,
    "conversation",
  );
  assert.equal(hasUserScheduleOn(characterId, userDay), true);
  setScheduleStatus(id, "cancelled");
  assert.equal(hasUserScheduleOn(characterId, userDay), false);
});

test("같은 주인·날짜에 글자까지 같은 내용을 두 번 넣으면 한 줄로 두고 그 번호를 돌려준다", () => {
  // 이 층은 글자 일치만 본다. 공백·기호를 지워 견주는 것은 schedule-dedupe.ts가 하고
  // 새벽 정리가 넣기 전에 따로 부른다 — 여기서는 그 층을 거치지 않는다.
  const date = "2026-09-13";
  const first = addSchedule(
    characterId,
    "char",
    date,
    "저녁",
    "친구 만남",
    AT,
    "conversation",
  );
  const again = addSchedule(
    characterId,
    "char",
    date,
    "밤",
    "친구 만남",
    AT,
    "rhythm",
  );
  assert.equal(again, first);
  const spaced = addSchedule(
    characterId,
    "char",
    date,
    null,
    "친구  만남",
    AT,
    "conversation",
  );
  assert.notEqual(spaced, first);
  const userSide = addSchedule(
    characterId,
    "user",
    date,
    null,
    "친구 만남",
    AT,
    "conversation",
  );
  assert.notEqual(userSide, first);
  const rows = getActiveSchedulesOn(characterId, "char", date);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.time_hint, "저녁");
});

test("다가오는 일정은 기준일부터 날짜·번호 순으로 살아 있는 것만 상한까지 준다", () => {
  const fresh = insertCharacter("chat-life-upcoming", "{}", AT);
  const past = addSchedule(
    fresh,
    "char",
    "2026-09-01",
    null,
    "지난 일",
    AT,
    "conversation",
  );
  const later = addSchedule(
    fresh,
    "char",
    "2026-09-20",
    null,
    "나중 일",
    AT,
    "conversation",
  );
  const today = addSchedule(
    fresh,
    "user",
    "2026-09-07",
    null,
    "오늘 일",
    AT,
    "conversation",
  );
  const gone = addSchedule(
    fresh,
    "char",
    "2026-09-08",
    null,
    "취소한 일",
    AT,
    "conversation",
  );
  const soon = addSchedule(
    fresh,
    "char",
    "2026-09-09",
    null,
    "곧 할 일",
    AT,
    "conversation",
  );
  setScheduleStatus(gone, "cancelled");
  assert.deepEqual(
    getUpcomingSchedules(fresh, "2026-09-07").map((s) => s.id),
    [today, soon, later],
  );
  assert.deepEqual(
    getUpcomingSchedules(fresh, "2026-09-07", 2).map((s) => s.id),
    [today, soon],
  );
  assert.ok(
    !getUpcomingSchedules(fresh, "2026-09-07").some((s) => s.id === past),
  );
});

// ── 일기·각본·시드 ────────────────────────────────────────────────────────

test("최근 일기는 마지막 n편을 오래된 순으로 준다", () => {
  insertDiary(characterId, "2026-09-04", '{"d":4}');
  insertDiary(characterId, "2026-09-05", '{"d":5}');
  insertDiary(characterId, "2026-09-06", '{"d":6}');
  assert.deepEqual(
    getRecentDiaries(characterId, 2).map((d) => d.date),
    ["2026-09-05", "2026-09-06"],
  );
  assert.deepEqual(
    getRecentDiaries(characterId, 10).map((d) => d.entry_json),
    ['{"d":4}', '{"d":5}', '{"d":6}'],
  );
  assert.deepEqual(
    getRecentDiaries(insertCharacter("chat-life-nodiary", "{}", AT), 3),
    [],
  );
});

test("각본을 만든 경로는 기본이 새벽 정리이고 다시 저장하면 바뀐다", () => {
  const date = "2026-09-07";
  assert.equal(getDayPlanMadeBy(characterId, date), undefined);
  saveDayPlan(characterId, date, "[]");
  assert.equal(getDayPlanMadeBy(characterId, date), "nightly");
  saveDayPlan(characterId, date, "[]", "ondemand");
  assert.equal(getDayPlanMadeBy(characterId, date), "ondemand");
});

test("월 리듬 시드는 저장한 달에만 있다고 답하고 그날 값을 그대로 돌려준다", () => {
  assert.equal(monthHasSeeds(characterId, "2026-10"), false);
  assert.equal(getDaySeed(characterId, "2026-10-03"), undefined);
  saveDaySeed(characterId, {
    date: "2026-10-03",
    energy: "낮음",
    wake_hint: "늦잠",
    mood: "느긋",
    reason: null,
  });
  assert.equal(monthHasSeeds(characterId, "2026-10"), true);
  assert.equal(monthHasSeeds(characterId, "2026-11"), false);
  assert.deepEqual(getDaySeed(characterId, "2026-10-03"), {
    date: "2026-10-03",
    energy: "낮음",
    wake_hint: "늦잠",
    mood: "느긋",
    reason: null,
  });
  saveDaySeed(characterId, {
    date: "2026-10-03",
    energy: "높음",
    wake_hint: "이른",
    mood: "들뜸",
    reason: "휴가 첫날",
  });
  assert.equal(getDaySeed(characterId, "2026-10-03")?.reason, "휴가 첫날");
});
