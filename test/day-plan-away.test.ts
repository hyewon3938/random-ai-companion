// 하루 각본의 자리 비움 밀도(day-plan.ts, 이슈 #335)를 검사한다 — 모델은 부르지 않는다.
//
// awayPhaseOf가 관계 단계와 만난 날수로 초반을 가르는지, awayCapsOf가 국면마다 다른 상한을
// 주는지, awayStats가 잠을 빼고 긴 구간·짧은 구간·구간 사이 간격을 세고 길이 상한을 안 받는
// 구간을 가르는지, awayViolations가 이슈에 적힌 하루(운동 뒤에 운전·씻기를 붙이고 아침에도 긴
// 구간 둘)를 잡는지, 생성 프롬프트에 그날 국면의 줄과 숫자가 들어가는지를 손으로 만든 블록으로
// 본다. DB는 임시 파일로 새로 만든다.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DayPlan, PlanBlock } from "../src/day-plan.js";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";

// DB 경로를 정한 뒤에 읽어야 한다 — 정적 import는 이 줄들보다 먼저 돈다.
const { db, insertCharacter, raiseStage } = await import("../src/db.js");
const {
  awayCapsOf,
  awayLengthExempt,
  awayPhaseOf,
  awayStats,
  awaySummary,
  awayViolations,
  buildPlanPrompt,
  checkPlanAway,
} = await import("../src/day-plan.js");
const {
  AWAY_BLOCK_MAX_MIN,
  AWAY_DAILY_MAX,
  AWAY_EARLY_DAILY_MAX,
  AWAY_EARLY_DAYS,
  AWAY_GAP_MIN,
  AWAY_MIN_BLOCK_MIN,
  AWAY_SHORT_DAILY_MAX,
  AWAY_SHORT_TOTAL_MAX_MIN,
} = await import("../src/thresholds.js");

after(() => {
  db.close();
});

const TODAY = "2026-09-09";
const EARLY = { early: true, stage: 1, days: 3 };
const LATER = { early: false, stage: 2, days: 60 };

const block = (
  start: string,
  end: string,
  activity: string,
  responsiveness: PlanBlock["responsiveness"],
  extra: Partial<PlanBlock> = {},
): PlanBlock => ({
  start,
  end,
  activity,
  responsiveness,
  advance_known: true,
  category: "personal",
  ...extra,
});
const plan = (...blocks: PlanBlock[]): DayPlan => ({ date: TODAY, blocks });

// ── awayPhaseOf / awayCapsOf ──────────────────────────────────────────────

test("만난 지 한 달이 안 됐으면 단계와 상관없이 초반이다", () => {
  const id = insertCharacter("away-new", "{}", "2026-09-01 10:00:00");
  const phase = awayPhaseOf(id, TODAY);
  assert.equal(phase.early, true);
  assert.equal(phase.stage, 1);
  assert.equal(phase.days, 8);
  raiseStage(id, 3, TODAY);
  assert.equal(awayPhaseOf(id, TODAY).early, true);
});

test("한 달이 지나도 1단계면 초반이고, 단계가 올라야 풀린다", () => {
  const id = insertCharacter("away-old", "{}", "2026-06-01 10:00:00");
  const stage1 = awayPhaseOf(id, TODAY);
  assert.equal(stage1.early, true);
  assert.equal(stage1.days >= AWAY_EARLY_DAYS, true);
  raiseStage(id, 2, "2026-08-01");
  const later = awayPhaseOf(id, TODAY);
  assert.equal(later.early, false);
  assert.equal(later.stage, 2);
});

test("관계 행이 없는 캐릭터는 초반으로 본다", () => {
  const id = Number(
    db
      .prepare(
        `INSERT INTO characters (chat_id, status, genesis_json, created_at)
         VALUES ('away-norel', 'active', '{}', '2026-01-01 00:00:00') RETURNING id`,
      )
      .pluck()
      .get(),
  );
  const phase = awayPhaseOf(id, TODAY);
  assert.equal(phase.early, true);
  assert.equal(phase.days, 0);
});

test("긴 구간 개수 상한만 국면으로 다르고, 한 구간 길이·짧은 구간·간격은 같다", () => {
  const early = awayCapsOf(EARLY);
  assert.equal(early.longMax, AWAY_EARLY_DAILY_MAX);
  const later = awayCapsOf(LATER);
  assert.equal(later.longMax, AWAY_DAILY_MAX);
  for (const c of [early, later]) {
    assert.equal(c.longBlockMaxMin, AWAY_BLOCK_MAX_MIN);
    assert.equal(c.shortMax, AWAY_SHORT_DAILY_MAX);
    assert.equal(c.shortTotalMaxMin, AWAY_SHORT_TOTAL_MAX_MIN);
    assert.equal(c.gapMin, AWAY_GAP_MIN);
  }
});

// ── awayLengthExempt / awayStats ──────────────────────────────────────────

test("공적 구간은 언제나 길이 상한을 안 받고, 확정 일정 구간은 관계가 쌓인 뒤에만 안 받는다", () => {
  const exam = block("13:00", "16:00", "자격증 시험", "unavailable", {
    category: "official",
  });
  const movie = block("19:00", "21:30", "영화관", "unavailable", {
    source: "schedule",
    source_id: 7,
  });
  const gym = block("19:00", "20:00", "헬스", "unavailable");
  assert.equal(awayLengthExempt(exam, EARLY), true);
  assert.equal(awayLengthExempt(exam, LATER), true);
  assert.equal(awayLengthExempt(movie, EARLY), false);
  assert.equal(awayLengthExempt(movie, LATER), true);
  assert.equal(awayLengthExempt(gym, EARLY), false);
  assert.equal(awayLengthExempt(gym, LATER), false);
});

test("잠은 세지 않고, 긴 구간과 짧은 구간을 나눠 세며 길이 상한을 받는 구간만 이름을 남긴다", () => {
  const s = awayStats(
    plan(
      block("05:00", "07:00", "잠", "unavailable"),
      block("08:00", "09:00", "업무 회의", "unavailable", {
        category: "official",
      }),
      block("09:00", "12:00", "근무", "intermittent"),
      block("19:00", "19:40", "헬스", "unavailable"),
      block("19:40", "20:00", "정리", "instant"),
      block("20:00", "20:20", "씻기", "unavailable"),
      block("24:00", "29:00", "잠", "unavailable"),
    ),
    EARLY,
  );
  assert.equal(s.long, 2);
  assert.equal(s.longestMin, 60);
  assert.equal(s.longExempt, 1);
  assert.deepEqual(s.longCapped, [{ activity: "헬스", min: 40 }]);
  assert.equal(s.short, 1);
  assert.equal(s.shortMin, 20);
  assert.equal(s.awayMin, 120);
  // 헬스와 씻기 사이 정리 20분이 가장 짧은 간격이다(빈 시간은 블록이 아니라 안 센다).
  assert.equal(s.minGapMin, 20);
});

test("불가 구간이 하나 이하면 간격은 null이다", () => {
  assert.equal(awayStats(plan(), EARLY).minGapMin, null);
  assert.equal(
    awayStats(plan(block("19:00", "20:00", "운동", "unavailable")), EARLY)
      .minGapMin,
    null,
  );
});

test("불가 구간을 바로 이어 붙이면 간격이 0이다", () => {
  const s = awayStats(
    plan(
      block("19:00", "20:10", "운동", "unavailable"),
      block("20:10", "20:35", "귀가 운전", "unavailable"),
      block("20:35", "20:55", "씻기", "unavailable"),
    ),
    EARLY,
  );
  assert.equal(s.long, 1);
  assert.equal(s.short, 2);
  assert.equal(s.shortMin, 45);
  assert.equal(s.minGapMin, 0);
});

// ── awayViolations ────────────────────────────────────────────────────────

const ISSUE_DAY = plan(
  block("05:00", "07:00", "잠", "unavailable"),
  block("07:30", "08:05", "씻고 준비", "unavailable"),
  block("08:05", "08:45", "출근 운전", "unavailable"),
  block("09:00", "18:00", "근무", "intermittent"),
  block("19:00", "20:10", "운동", "unavailable"),
  block("20:10", "20:35", "귀가 운전", "unavailable"),
  block("20:35", "20:55", "씻기", "unavailable"),
  block("21:00", "24:00", "쉬기", "instant"),
);

test("이슈에 적힌 하루는 초반에 긴 구간 개수·길이와 간격을 어긴다", () => {
  const v = awayViolations(awayStats(ISSUE_DAY, EARLY), awayCapsOf(EARLY));
  assert.equal(v.length, 3, v.join(" / "));
  assert.match(
    v[0]!,
    new RegExp(`${AWAY_MIN_BLOCK_MIN}분 이상 불가 구간이 3개 \\(상한 1개\\)`),
  );
  assert.match(
    v[1]!,
    new RegExp(`한 구간이 ${AWAY_BLOCK_MAX_MIN}분을 넘는 불가 구간: 운동 70분`),
  );
  assert.match(v[2]!, /답할 수 있는 시간이 0분 \(최소 5분\)/);
});

test("관계가 쌓인 뒤에도 같은 하루는 긴 구간 개수·길이와 간격을 어긴다", () => {
  const v = awayViolations(awayStats(ISSUE_DAY, LATER), awayCapsOf(LATER));
  assert.equal(v.length, 3, v.join(" / "));
  assert.match(v[0]!, /3개 \(상한 2개\)/);
  assert.match(v[1]!, /운동 70분/);
  assert.match(v[2]!, /답할 수 있는 시간이 0분/);
});

test("짧은 구간이 많거나 합이 길면 어긴 것이다", () => {
  const s = awayStats(
    plan(
      block("07:30", "07:50", "씻기", "unavailable"),
      block("07:50", "09:00", "출근", "intermittent"),
      block("12:00", "12:20", "은행 통화", "unavailable"),
      block("12:20", "18:00", "근무", "intermittent"),
      block("18:30", "18:55", "귀가 운전", "unavailable"),
      block("18:55", "21:00", "저녁", "instant"),
      block("21:00", "21:20", "씻기", "unavailable"),
      block("21:20", "22:00", "쉬기", "instant"),
      block("22:00", "22:15", "친구 전화", "unavailable"),
    ),
    EARLY,
  );
  assert.equal(s.short, 5);
  assert.equal(s.shortMin, 100);
  const v = awayViolations(s, awayCapsOf(EARLY));
  assert.equal(v.length, 2, v.join(" / "));
  assert.match(
    v[0]!,
    new RegExp(`미만 불가 구간이 5개 \\(상한 ${AWAY_SHORT_DAILY_MAX}개\\)`),
  );
  assert.match(
    v[1]!,
    new RegExp(`합이 100분 \\(상한 ${AWAY_SHORT_TOTAL_MAX_MIN}분\\)`),
  );
});

test("긴 구간 하나가 40분을 넘기면 국면과 상관없이 어긴 것이고, 시험은 예외다", () => {
  const gym = plan(block("19:00", "20:00", "헬스", "unavailable"));
  for (const phase of [EARLY, LATER]) {
    const v = awayViolations(awayStats(gym, phase), awayCapsOf(phase));
    assert.equal(v.length, 1, v.join(" / "));
    assert.match(v[0]!, /헬스 60분 \(중간에 폰을 보는 틈을 넣어 나눈다\)/);
  }
  const exam = plan(
    block("13:00", "16:00", "자격증 시험", "unavailable", {
      category: "official",
    }),
  );
  for (const phase of [EARLY, LATER])
    assert.deepEqual(awayViolations(awayStats(exam, phase), awayCapsOf(phase)), []);
});

test("확정 일정의 영화관은 초반에는 길이를 어기고 관계가 쌓인 뒤에는 실제 길이대로 둔다", () => {
  const movie = plan(
    block("19:00", "21:30", "영화관", "unavailable", {
      source: "schedule",
      source_id: 7,
    }),
  );
  const early = awayViolations(awayStats(movie, EARLY), awayCapsOf(EARLY));
  assert.equal(early.length, 1, early.join(" / "));
  assert.match(early[0]!, /영화관 150분/);
  assert.deepEqual(awayViolations(awayStats(movie, LATER), awayCapsOf(LATER)), []);
});

test("1시간 운동을 중간에 폰 보는 틈으로 나눈 하루는 초반 상한 안이다", () => {
  const split = plan(
    block("05:00", "07:00", "잠", "unavailable"),
    block("08:00", "18:00", "근무", "intermittent"),
    block("19:00", "19:40", "헬스", "unavailable"),
    block("19:40", "19:46", "쉬면서 폰 확인", "intermittent"),
    block("19:46", "20:10", "헬스", "unavailable"),
    block("20:10", "20:20", "집 도착해서 정리", "instant"),
    block("20:20", "20:40", "씻기", "unavailable"),
    block("20:40", "24:00", "쉬기", "instant"),
  );
  const s = awayStats(split, EARLY);
  assert.equal(s.long, 1);
  assert.equal(s.short, 2);
  assert.equal(s.shortMin, 44);
  assert.equal(s.minGapMin, 6);
  assert.deepEqual(awayViolations(s, awayCapsOf(EARLY)), []);
});

test("긴 구간이 하나도 없는 하루도 어긴 것이 없다", () => {
  const quiet = plan(
    block("05:00", "07:00", "잠", "unavailable"),
    block("08:00", "18:00", "근무", "intermittent"),
    block("19:00", "19:40", "저녁 산책", "intermittent"),
    block("20:00", "20:20", "씻기", "unavailable"),
    block("20:20", "24:00", "쉬기", "instant"),
  );
  for (const phase of [EARLY, LATER])
    assert.deepEqual(awayViolations(awayStats(quiet, phase), awayCapsOf(phase)), []);
});

// ── checkPlanAway / awaySummary / buildPlanPrompt ─────────────────────────

test("checkPlanAway는 캐릭터의 국면으로 상한을 고르고 요약 한 줄에 국면과 가장 긴 구간을 적는다", () => {
  const id = insertCharacter("away-check", "{}", "2026-09-05 10:00:00");
  const c = checkPlanAway(id, TODAY, ISSUE_DAY);
  assert.equal(c.phase.early, true);
  assert.equal(c.caps.longMax, AWAY_EARLY_DAILY_MAX);
  assert.equal(c.violations.length, 3);
  const line = awaySummary(c);
  assert.match(line, /관계 초반\(1단계, 만난 지 4일째\)/);
  assert.match(
    line,
    new RegExp(
      `${AWAY_MIN_BLOCK_MIN}분 이상 3개\\(상한 1개·한 구간 ${AWAY_BLOCK_MAX_MIN}분\\) · 가장 긴 것 70분`,
    ),
  );
});

test("요약 한 줄은 길이 제한을 안 받는 구간의 수를 따로 적는다", () => {
  const id = insertCharacter("away-check-exempt", "{}", "2026-09-05 10:00:00");
  const c = checkPlanAway(
    id,
    TODAY,
    plan(
      block("13:00", "16:00", "자격증 시험", "unavailable", {
        category: "official",
      }),
    ),
  );
  assert.deepEqual(c.violations, []);
  assert.match(awaySummary(c), /길이 제한 없는 공적·일정 구간 1개\) · 가장 긴 것 180분/);
});

test("생성 프롬프트는 초반이면 없는 날이 기본이라 말하고 그 국면의 숫자를 넣는다", () => {
  const id = insertCharacter("away-prompt-early", "{}", "2026-09-01 10:00:00");
  const prompt = buildPlanPrompt(id, TODAY);
  assert.match(prompt, /없는 날이 기본이다\. 지금은 1단계이고 만난 지 8일째인 관계 초반이라/);
  assert.match(prompt, new RegExp(`하루 ${AWAY_EARLY_DAILY_MAX}개까지 두고, 쉬는 날에는 그것도 없어도 된다`));
  assert.match(prompt, /상대가 먼저 권한 것이 아니면 초반에는 각본에 넣지 않는다/);
  assert.match(prompt, new RegExp(`한 구간은 ${AWAY_BLOCK_MAX_MIN}분을 넘기지 않는다`));
  assert.match(prompt, /공적 일만 실제 길이대로 둔다/);
  assert.match(prompt, new RegExp(`하루 ${AWAY_SHORT_DAILY_MAX}개, 합쳐서 ${AWAY_SHORT_TOTAL_MAX_MIN}분까지만`));
  assert.match(prompt, new RegExp(`최소 ${AWAY_GAP_MIN}분 둔다`));
  assert.doesNotMatch(prompt, /관계가 쌓였으니/);
});

test("생성 프롬프트는 관계가 쌓였으면 그리워할 틈을 말하고 없는 날과 2개인 날을 섞게 한다", () => {
  const id = insertCharacter("away-prompt-later", "{}", "2026-06-01 10:00:00");
  raiseStage(id, 2, "2026-08-01");
  const prompt = buildPlanPrompt(id, TODAY);
  assert.match(prompt, /2단계이고 만난 지 100일째라 관계가 쌓였으니/);
  assert.match(prompt, new RegExp(`하나도 없는 날과 ${AWAY_DAILY_MAX}개까지 있는 날이 섞이게 한다`));
  assert.match(prompt, /공적 일과 확정 일정의 영화관·공연만 실제 길이대로 둔다/);
  assert.doesNotMatch(prompt, /관계 초반이라/);
});

test("프롬프트의 예시 각본은 두 국면의 상한을 다 지킨다", () => {
  const id = insertCharacter("away-example", "{}", "2026-09-01 10:00:00");
  const prompt = buildPlanPrompt(id, TODAY);
  const m = /\{"date":"[^"]+","blocks":\[.*?\]\}/.exec(prompt);
  assert.ok(m, "예시 각본을 못 찾았다");
  const example = JSON.parse(m[0]) as DayPlan;
  for (const phase of [EARLY, LATER])
    assert.deepEqual(
      awayViolations(awayStats(example, phase), awayCapsOf(phase)),
      [],
    );
});
