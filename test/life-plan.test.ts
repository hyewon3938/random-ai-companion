// 월 리듬(life-plan.ts)이 달의 날짜를 세고 모델 결과를 표에 옮기는 자리를 검사한다 — 모델은 부르지 않는다.
//
// monthDays는 월말·윤년·요일 라벨을, applyMonthPlan은 이벤트와 컨디션 시드가 어느 표에 어떤 값으로
// 들어가고 시드가 이미 있는 달은 건너뛰는지를, monthsNeedingRhythm은 월말 6일 기준으로 어느 달이
// 필요한지를 본다. 모델을 부르는 ensureMonthPlan·ensureRhythmRunway는 시드가 이미 있어 바로
// 돌아오는 경로만 본다. DB는 임시 파일로 새로 만든다.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MonthPlan } from "../src/life-plan.js";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

// DB 경로를 정한 뒤에 읽어야 임시 파일로 열린다 — 정적 import는 이 줄들보다 먼저 돈다.
const { db, getMonthSeeds, getSchedulesInMonth } = await import("../src/db.js");
const { createFixtureCharacter } =
  await import("../src/eval/fixture-character.js");
const {
  applyMonthPlan,
  ensureMonthPlan,
  ensureRhythmRunway,
  monthDays,
  monthsNeedingRhythm,
} = await import("../src/life-plan.js");

let seeded = 0; // 10월·11월 시드를 넣는 캐릭터
let empty = 0; // 시드가 하나도 없는 캐릭터

before(() => {
  seeded = createFixtureCharacter("chat-life-plan-seeded");
  empty = createFixtureCharacter("chat-life-plan-empty");
});
after(() => {
  db.close();
});

const labelOf = (ym: string, date: string): string | undefined =>
  monthDays(ym).find((d) => d.date === date)?.label;

const originOf = (id: number): { owner: string; origin: string } =>
  db.prepare(`SELECT owner, origin FROM schedules WHERE id = ?`).get(id) as {
    owner: string;
    origin: string;
  };

const OCTOBER: MonthPlan = {
  events: [
    { date: "2026-10-09", time_hint: "저녁", content: "팀 회식" },
    { date: "2026-10-17", time_hint: null, content: "청주 부모님 댁" },
  ],
  days: [
    {
      date: "2026-10-09",
      energy: "보통",
      wake_hint: "보통",
      mood: "차분",
      note: "",
    },
    {
      date: "2026-10-10",
      energy: "낮음",
      wake_hint: "늦잠",
      mood: "멍함",
      note: "어제 회식 여파",
    },
    {
      date: "2026-10-11",
      energy: "보통",
      wake_hint: "늦잠",
      mood: "느긋",
      note: "",
    },
  ],
};

test("달의 날짜를 하나도 빠짐없이 세고 윤년 2월은 29일이다", () => {
  const sep = monthDays("2026-09");
  assert.equal(sep.length, 30);
  assert.equal(sep[0]?.date, "2026-09-01");
  assert.equal(sep.at(-1)?.date, "2026-09-30");
  assert.equal(monthDays("2026-12").length, 31);
  assert.equal(monthDays("2026-02").length, 28);
  assert.equal(monthDays("2024-02").at(-1)?.date, "2024-02-29");
});

test("날짜마다 평일과 주말과 공휴일 라벨이 붙는다", () => {
  assert.equal(labelOf("2026-10", "2026-10-06"), "평일");
  assert.equal(labelOf("2026-10", "2026-10-04"), "주말(휴무)");
  // 10월 3일은 토요일이면서 개천절이다. 공휴일이 주말보다 먼저다.
  assert.equal(labelOf("2026-10", "2026-10-03"), "개천절(휴무)");
  assert.equal(labelOf("2026-10", "2026-10-05"), "개천절 대체공휴일(휴무)");
  assert.equal(labelOf("2026-12", "2026-12-25"), "성탄절(휴무)");
});

test("이벤트는 캐릭터 일정에 리듬 출처로 들어가고 시드는 날짜마다 한 줄씩 들어간다", () => {
  applyMonthPlan(seeded, "2026-10", OCTOBER);

  const events = getSchedulesInMonth(seeded, "2026-10", "char");
  assert.deepEqual(
    events.map((e) => [e.date, e.time_hint, e.content]),
    [
      ["2026-10-09", "저녁", "팀 회식"],
      ["2026-10-17", null, "청주 부모님 댁"],
    ],
  );
  assert.deepEqual(originOf(events[0]!.id), {
    owner: "char",
    origin: "rhythm",
  });

  const seeds = getMonthSeeds(seeded, "2026-10");
  assert.deepEqual(
    seeds.map((s) => [s.date, s.energy, s.wake_hint, s.mood, s.reason]),
    [
      ["2026-10-09", "보통", "보통", "차분", null],
      ["2026-10-10", "낮음", "늦잠", "멍함", "어제 회식 여파"],
      ["2026-10-11", "보통", "늦잠", "느긋", null],
    ],
  );
});

test("빈 값은 보통으로 채우고 날짜나 내용이 없는 항목은 버린다", () => {
  applyMonthPlan(seeded, "2026-11", {
    events: [
      { date: "", time_hint: "오전", content: "날짜 없는 이벤트" },
      { date: "2026-11-03", time_hint: null, content: "" },
      { date: "2026-11-05", time_hint: "오전", content: "치과" },
    ],
    days: [
      { date: "", energy: "높음", wake_hint: "이른", mood: "상쾌", note: "" },
      { date: "2026-11-05", energy: "", wake_hint: "", mood: "", note: "" },
    ],
  });

  assert.deepEqual(
    getSchedulesInMonth(seeded, "2026-11", "char").map((e) => e.content),
    ["치과"],
  );
  assert.deepEqual(getMonthSeeds(seeded, "2026-11"), [
    {
      date: "2026-11-05",
      energy: "보통",
      wake_hint: "보통",
      mood: "",
      reason: null,
    },
  ]);
});

test("시드가 이미 있는 달은 다시 적지 않는다", () => {
  applyMonthPlan(seeded, "2026-10", {
    events: [{ date: "2026-10-20", time_hint: null, content: "두 번째 계획" }],
    days: [
      {
        date: "2026-10-20",
        energy: "높음",
        wake_hint: "이른",
        mood: "들뜸",
        note: "",
      },
    ],
  });
  assert.equal(getSchedulesInMonth(seeded, "2026-10", "char").length, 2);
  assert.equal(getMonthSeeds(seeded, "2026-10").length, 3);
});

test("이번 달은 늘 필요하고 월말 6일 안에 들어오면 다음 달도 필요하다", () => {
  assert.deepEqual(monthsNeedingRhythm(empty, "2026-10-15"), ["2026-10"]);
  // 10월 24일은 7일 남아 아직이고, 25일은 6일 남아 다음 달까지 든다.
  assert.deepEqual(monthsNeedingRhythm(empty, "2026-10-24"), ["2026-10"]);
  assert.deepEqual(monthsNeedingRhythm(empty, "2026-10-25"), [
    "2026-10",
    "2026-11",
  ]);
  assert.deepEqual(monthsNeedingRhythm(empty, "2026-12-28"), [
    "2026-12",
    "2027-01",
  ]);
});

test("시드가 있는 달은 필요한 달 목록에서 빠진다", () => {
  assert.deepEqual(monthsNeedingRhythm(seeded, "2026-10-28"), []);
  assert.deepEqual(monthsNeedingRhythm(seeded, "2026-11-28"), ["2026-12"]);
  assert.deepEqual(monthsNeedingRhythm(seeded, "2026-09-30"), ["2026-09"]);
});

test("시드가 이미 있는 달의 생성은 모델을 부르지 않고 아무것도 안 했다고 돌아온다", async () => {
  assert.equal(await ensureMonthPlan(seeded, "2026-10"), false);
  // 10월 28일은 11월까지 런웨이에 들지만 둘 다 시드가 있어 아무것도 만들지 않는다.
  await ensureRhythmRunway(seeded, "2026-10-28");
  assert.equal(getSchedulesInMonth(seeded, "2026-10", "char").length, 2);
  assert.equal(getSchedulesInMonth(seeded, "2026-11", "char").length, 1);
  assert.equal(getMonthSeeds(seeded, "2026-10").length, 3);
  assert.equal(getMonthSeeds(seeded, "2026-11").length, 1);
});
