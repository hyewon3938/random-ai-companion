// 시각을 읽고 적는 kst.ts의 함수들 — 요일 표기, 각본 표기 시계, 논리일의 시작, 말로 푼 시각 — 을 검사한다.
//
// dayLabel·dayLabelOf는 UTC 필드가 KST 값을 갖는 Date를 받으므로 KST 자정에 해당하는 Date를
// 그대로 만들어 넣는다. 지금 시각을 읽는 함수는 밑이 Date.now()라 node:test의 mock.timers로
// Date만 고정하고, 원하는 KST 시각에서 9시간을 뺀 epoch를 넣는다. 검사 하나가 끝날 때마다
// 시계를 되돌린다. 논리일 경계는 DAY_BOUNDARY_HOUR를 읽어 그 값 기준으로 짚는다.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

import {
  clockLabel,
  dayLabel,
  dayLabelOf,
  holidayGapYear,
  holidaysInMonth,
  kstLogicalClock,
  kstLogicalDate,
  kstVerbalTime,
  logicalDayStartTs,
  workdayContext,
} from "../src/kst.js";
import { DAY_BOUNDARY_HOUR } from "../src/thresholds.js";

const KST_OFFSET_MS = 9 * 3600_000;

// KST 벽시계 날짜와 시각을 실제 epoch(UTC)로 옮긴다.
const kstEpoch = (date: string, hhmm: string): number =>
  Date.parse(`${date}T${hhmm}:00Z`) - KST_OFFSET_MS;

// 시계를 그 KST 시각에 고정한 채 fn을 돌리고 되돌린다.
const atKst = <T>(date: string, hhmm: string, fn: () => T): T => {
  mock.timers.enable({ apis: ["Date"], now: kstEpoch(date, hhmm) });
  try {
    return fn();
  } finally {
    mock.timers.reset();
  }
};

const hh = (h: number): string => String(h).padStart(2, "0");
const BOUNDARY = `${hh(DAY_BOUNDARY_HOUR)}:00`;
const BEFORE_BOUNDARY = `${hh(DAY_BOUNDARY_HOUR - 1)}:59`;

// ── dayLabel · dayLabelOf ─────────────────────────────────────────────

test("공휴일은 요일과 상관없이 공휴일이고 이름이 함께 붙는다", () => {
  // 2026-10-09 한글날은 금요일이다 — 평일 판정보다 공휴일이 앞선다.
  assert.equal(dayLabel(new Date("2026-10-09T00:00:00Z")), "한글날(휴무)");
  assert.equal(dayLabelOf("2026-10-09"), "한글날(휴무)");
});

test("음력 명절과 대체공휴일도 이름표를 받는다", () => {
  // 이름이 없으면 하루 각본도 월 리듬도 추석을 그냥 쉬는 날로 읽는다(이슈 #415).
  assert.equal(dayLabelOf("2026-09-24"), "추석 연휴(휴무)");
  assert.equal(dayLabelOf("2026-09-25"), "추석(휴무)");
  assert.equal(dayLabelOf("2026-09-26"), "추석 연휴(휴무)");
  assert.equal(dayLabelOf("2026-02-17"), "설날(휴무)");
  // 3월 1일이 일요일이라 다음 날이 대체공휴일이다.
  assert.equal(dayLabelOf("2026-03-02"), "삼일절 대체공휴일(휴무)");
});

test("토요일과 일요일은 주말이다", () => {
  assert.equal(dayLabel(new Date("2026-09-05T00:00:00Z")), "주말(휴무)");
  assert.equal(dayLabel(new Date("2026-09-06T00:00:00Z")), "주말(휴무)");
  assert.equal(dayLabelOf("2026-09-05"), "주말(휴무)");
});

test("공휴일도 주말도 아니면 평일이다", () => {
  assert.equal(dayLabel(new Date("2026-09-07T00:00:00Z")), "평일");
  assert.equal(dayLabelOf("2026-09-07"), "평일");
});

test("UTC 필드를 KST 값으로 읽는다 — 밤 늦은 시각도 그날이다", () => {
  assert.equal(dayLabel(new Date("2026-10-09T23:59:00Z")), "한글날(휴무)");
});

// ── holidaysInMonth · holidayGapYear ──────────────────────────────────

test("그 달의 공휴일만 날짜순으로 준다", () => {
  assert.deepEqual(holidaysInMonth("2026-09"), [
    { date: "2026-09-24", name: "추석 연휴" },
    { date: "2026-09-25", name: "추석" },
    { date: "2026-09-26", name: "추석 연휴" },
  ]);
  // 공휴일이 하나도 없는 달은 빈 배열이다 — 월 리듬 재료가 이 값을 그대로 이어 붙인다.
  assert.deepEqual(holidaysInMonth("2026-11"), []);
});

test("표가 안 덮은 해는 그 해를 알린다", () => {
  assert.equal(holidayGapYear("2026-09"), null);
  assert.equal(holidayGapYear("2027-02"), "2027");
});

// ── workdayContext ────────────────────────────────────────────────────

test("오늘과 내일의 요일 표기를 한 줄로 준다", () => {
  assert.equal(
    atKst("2026-09-04", "12:00", workdayContext),
    "오늘은 평일, 내일은 주말(휴무)",
  );
  assert.equal(
    atKst("2026-10-08", "22:00", workdayContext),
    "오늘은 평일, 내일은 한글날(휴무)",
  );
});

// ── kstLogicalClock ───────────────────────────────────────────────────

test("경계 직전 시각은 24를 더해 적는다", () => {
  assert.equal(
    atKst("2026-09-07", BEFORE_BOUNDARY, kstLogicalClock),
    `${hh(DAY_BOUNDARY_HOUR - 1 + 24)}:59`,
  );
  assert.equal(atKst("2026-09-07", "00:30", kstLogicalClock), "24:30");
});

test("경계부터는 벽시계 그대로다", () => {
  assert.equal(atKst("2026-09-07", BOUNDARY, kstLogicalClock), BOUNDARY);
  assert.equal(atKst("2026-09-07", "13:05", kstLogicalClock), "13:05");
  assert.equal(atKst("2026-09-07", "23:59", kstLogicalClock), "23:59");
});

// ── clockLabel ────────────────────────────────────────────────────────

test("24를 넘긴 각본 표기는 시계 표기로 되돌린다", () => {
  assert.equal(clockLabel("26:30"), "02:30");
  assert.equal(clockLabel("24:00"), "00:00");
  assert.equal(clockLabel("28:59"), "04:59");
});

test("24 아래 표기는 그대로 둔다", () => {
  assert.equal(clockLabel("04:30"), "04:30");
  assert.equal(clockLabel("13:05"), "13:05");
  assert.equal(clockLabel("23:59"), "23:59");
});

test("분이 없거나 숫자가 아니면 입력을 그대로 돌려준다", () => {
  assert.equal(clockLabel("26"), "26");
  assert.equal(clockLabel("밤"), "밤");
  assert.equal(clockLabel(""), "");
});

// ── kstLogicalDate · logicalDayStartTs ────────────────────────────────

test("경계 직전은 아직 어제 논리일이다", () => {
  assert.equal(
    atKst("2026-09-07", BEFORE_BOUNDARY, kstLogicalDate),
    "2026-09-06",
  );
  assert.equal(atKst("2026-09-07", "00:00", kstLogicalDate), "2026-09-06");
  assert.equal(
    atKst("2026-09-07", BEFORE_BOUNDARY, logicalDayStartTs),
    `2026-09-06 ${BOUNDARY}:00`,
  );
});

test("경계부터 오늘 논리일이다", () => {
  assert.equal(atKst("2026-09-07", BOUNDARY, kstLogicalDate), "2026-09-07");
  assert.equal(atKst("2026-09-07", "23:59", kstLogicalDate), "2026-09-07");
  assert.equal(
    atKst("2026-09-07", BOUNDARY, logicalDayStartTs),
    `2026-09-07 ${BOUNDARY}:00`,
  );
});

test("달이 바뀌는 새벽도 전달의 마지막 날이다", () => {
  assert.equal(atKst("2026-10-01", "03:00", kstLogicalDate), "2026-09-30");
  assert.equal(
    atKst("2026-10-01", "03:00", logicalDayStartTs),
    `2026-09-30 ${BOUNDARY}:00`,
  );
});

// ── kstVerbalTime ─────────────────────────────────────────────────────

test("정각 직후는 그 시가 막 지난 참이다", () => {
  assert.equal(
    atKst("2026-09-07", "09:00", kstVerbalTime),
    "오전 9시 0분 (오전 9시가 막 지난 참)",
  );
});

test("30분은 반쯤이고 낮 12시는 오전·오후 대신 낮이다", () => {
  assert.equal(
    atKst("2026-09-07", "12:30", kstVerbalTime),
    "낮 12시 30분 (낮 12시 반쯤)",
  );
});

test("45분은 다음 시가 가까워지는 때다", () => {
  assert.equal(
    atKst("2026-09-07", "14:45", kstVerbalTime),
    "오후 2시 45분 (오후 3시가 가까워지는 때)",
  );
});

test("55분은 거의 다음 시이고 자정은 밤 12시다", () => {
  assert.equal(
    atKst("2026-09-07", "23:55", kstVerbalTime),
    "오후 11시 55분 (거의 밤 12시)",
  );
  assert.equal(
    atKst("2026-09-07", "11:55", kstVerbalTime),
    "오전 11시 55분 (거의 낮 12시)",
  );
  assert.equal(
    atKst("2026-09-07", "00:10", kstVerbalTime),
    "밤 12시 10분 (밤 12시대 초반)",
  );
});
