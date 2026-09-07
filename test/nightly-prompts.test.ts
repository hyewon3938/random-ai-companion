// 새벽 정리 문안이 수집 결과의 어느 값을 어디에 넣는지 붙잡는 검사 — 모델을 부르지 않는다.
// prompts/nightly.ts는 타입 말고는 thresholds만 읽어서 DB 없이 바로 가져온다.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NightlyGathered } from "../src/nightly.js";
import {
  arcLinesOf,
  careSituation,
  diaryPrompt,
  morningSituation,
  quietDayPrompt,
  reconnectSituation,
} from "../src/prompts/nightly.js";

const gathered = (over: Partial<NightlyGathered> = {}): NightlyGathered => ({
  characterId: 1,
  chatId: "chat-prompts",
  diaryDate: "2026-09-05",
  today: "2026-09-06",
  todayLabel: "9/6 (일)",
  diaryExists: false,
  convo: "[유저 21:10] 오늘 러닝 했어\n[캐릭터 21:12] 몇 km 뛰었어?",
  msgsCount: 2,
  planBriefYesterday: "09:00 출근\n19:00 러닝",
  planExistsToday: false,
  identity: "- 직업/일: 편집자",
  people: "- 친구/민지: 대학 동기",
  ongoing: "- 독서/오디세이: 3장까지",
  ongoingForPlan: "",
  ongoingTouched: [],
  touchedUserFacts: [],
  relationship: "말투: 반말",
  userState: "",
  userProfile: "(없음)",
  todayNotes: ["러닝 5km"],
  dayActuals: ["19:00 러닝 → 비 와서 취소"],
  existingKeys: [],
  areas: [],
  tagNames: ["러닝", "민지"],
  userSchedulesUpcoming: "9/7 오전 발표",
  existingSchedules: [],
  arcs: { 올해: "이직 준비", 이번주: "마감" },
  todaySeed: null,
  lastNight: { bedtime: "01:30", enoughSleepFrom: "07:30" },
  rhythmNeeded: [],
  silenceTier: "normal",
  silenceDays: 0,
  sendPlan: "morning",
  sendPlanReason: "평소",
  ...over,
});

test("arcLinesOf는 아크를 '이름: 내용' 줄로 잇는다", () => {
  assert.equal(arcLinesOf(gathered()), "올해: 이직 준비\n이번주: 마감");
});

test("diaryPrompt는 수집한 값을 각 절에 넣고 없는 값은 (없음)으로 채운다", () => {
  const p = diaryPrompt(gathered());
  assert.ok(p.includes("[정체성]\n- 직업/일: 편집자"));
  assert.ok(p.includes("[삶의 흐름]\n올해: 이직 준비\n이번주: 마감"));
  assert.ok(p.includes("[상대와의 관계]\n말투: 반말"));
  assert.ok(p.includes("오늘은 2026-09-05였다."));
  assert.ok(p.includes("[오늘의 원래 흐름]\n09:00 출근\n19:00 러닝"));
  assert.ok(p.includes("[각본과 달라진 것]\n19:00 러닝 → 비 와서 취소"));
  assert.ok(p.includes("[오늘 메모 — 대화하며 적어 둔 것]\n러닝 5km"));
  assert.ok(p.includes("[이미 쓰는 태그]\n러닝, 민지"));
  assert.ok(p.includes("[상대와 나눈 대화 전체]\n[유저 21:10] 오늘 러닝 했어"));
  assert.ok(p.includes("주제 태그 3~8개"));

  const empty = diaryPrompt(
    gathered({
      identity: "",
      arcs: {},
      relationship: "",
      userState: "",
      planBriefYesterday: "",
      dayActuals: [],
      todayNotes: [],
      tagNames: [],
    }),
  );
  assert.ok(empty.includes("[정체성]\n(없음)"));
  assert.ok(empty.includes("[삶의 흐름]\n(없음)"));
  assert.ok(empty.includes("[상대와의 관계]\n(이제 막 시작한 사이)"));
  assert.ok(empty.includes("[오늘의 원래 흐름]\n(기록 없음)"));
  assert.ok(empty.includes("[각본과 달라진 것]\n(없음)"));
});

test("quietDayPrompt는 대화 절이 없고 달라진 것은 있을 때만 붙는다", () => {
  const withActuals = quietDayPrompt(gathered());
  assert.ok(withActuals.includes("상대와 대화가 없던 날이다"));
  assert.ok(!withActuals.includes("[상대와 나눈 대화 전체]"));
  assert.ok(!withActuals.includes("오늘 러닝 했어"));
  assert.ok(withActuals.includes("[각본과 달라진 것]\n19:00 러닝 → 비 와서 취소"));
  assert.ok(withActuals.includes("주제 태그 2~8개"));

  const plain = quietDayPrompt(gathered({ dayActuals: [] }));
  assert.ok(!plain.includes("[각본과 달라진 것]"));
});

test("morningSituation은 보내는 시점·이어갈 것·일정·어젯밤 잠을 적는다", () => {
  const p = morningSituation(gathered(), "출근 준비 중", ["책 이야기", "발표 준비"]);
  assert.ok(p.includes("- 보내는 시점: 출근 준비 중"));
  assert.ok(p.includes("- 어제에서 이어갈 것: 책 이야기 / 발표 준비"));
  assert.ok(p.includes("- 상대의 다가오는 일정(들은 것): 9/7 오전 발표"));
  assert.ok(p.includes("어젯밤 01:30에 잠들었다"));
  assert.ok(p.includes("07:30보다 이르면"));
  assert.ok(p.includes('{"send":true,"window":"아침|점심|저녁","text":"..."}'));

  const noSleep = morningSituation(
    gathered({ lastNight: null, userSchedulesUpcoming: "" }),
    "아침 (여유로운 시간대)",
    [],
  );
  assert.ok(!noSleep.includes("어젯밤"));
  assert.ok(noSleep.includes("- 어제에서 이어갈 것: (없음)"));
  assert.ok(noSleep.includes("- 상대의 다가오는 일정(들은 것): (없음)"));
});

test("careSituation과 reconnectSituation은 침묵 일수를 적는다", () => {
  const g = gathered({ silenceTier: "checkin", silenceDays: 5 });
  const care = careSituation(g);
  assert.ok(care.includes("상대와 연락이 오간 지 5일쯤 됐다."));
  assert.ok(care.includes("- 상대의 일정(들은 것): 9/7 오전 발표"));
  assert.ok(care.includes('{"send":true,"text":"..."}'));

  const reconnect = reconnectSituation(g);
  assert.ok(reconnect.includes("[문안 준비 — 오늘 저녁에 보낼 안부 한 통]"));
  assert.ok(reconnect.includes("마지막으로 연락이 오간 지 5일쯤 됐다."));
  assert.ok(reconnect.includes('{"text":"..."}'));
});
