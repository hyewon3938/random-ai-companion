// 각본 블록의 활동 성격 추론·자리 비움 판정·생성 결과 정규화(day-plan.ts)를 검사한다 — 모델은 부르지 않는다.
//
// blockCategory가 활동 이름에서 공적·사회·개인을 어떻게 가르고 정해진 세 값 밖의 명시값을
// 어떻게 걸러 내는지, isAwayUnavail이 잠을 빼는지,
// normalizePlan이 자정을 넘긴 시각과 한글 답장 여건을 식별자로 되돌리는지를 손으로 만든 블록으로
// 본다. 출처 두 칸의 정규화는 day-plan-ongoing.test.ts가 본다. ensureTodayPlan은 오늘 각본이
// 이미 있어 모델을 부르지 않고 돌아오는 분기를 본다 — 모델 주소를 닫힌 로컬 포트로 돌려 두어,
// 부르려 하면 기계 밖으로 나가기 전에 실패한다. DB는 임시 파일로 새로 만든다.
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
// 모델 클라이언트는 모듈을 읽을 때 이 주소를 잡는다. 아무것도 듣지 않는 포트라 연결이 바로 끊긴다.
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";

// DB 경로와 모델 주소를 정한 뒤에 읽어야 한다 — 정적 import는 이 줄들보다 먼저 돈다.
const { db, getDayPlan, getDayPlanMadeBy, saveDayPlan } =
  await import("../src/db.js");
const { kstLogicalDate } = await import("../src/kst.js");
const { blockCategory, ensureTodayPlan, isAwayUnavail, normalizePlan } =
  await import("../src/day-plan.js");

after(() => {
  db.close();
});

const makeCharacter = (chatId: string): number =>
  Number(
    db
      .prepare(
        `INSERT INTO characters (chat_id, status, genesis_json, created_at)
         VALUES (?, 'active', '{}', '2026-08-30 12:00:00') RETURNING id`,
      )
      .pluck()
      .get(chatId),
  );

const block = (
  start: string,
  end: string,
  activity: string,
  responsiveness: PlanBlock["responsiveness"],
  over: Partial<PlanBlock> = {},
): PlanBlock => ({
  start,
  end,
  activity,
  responsiveness,
  advance_known: true,
  category: "personal",
  ...over,
});

// 생성이 돌려주는 값은 아직 검사 전이라 어떤 글자든 올 수 있다 — 타입을 우회해 그대로 넣는다.
const raw = (
  start: string,
  end: string,
  activity: string,
  responsiveness: string,
  category?: string,
): PlanBlock =>
  ({
    start,
    end,
    activity,
    responsiveness,
    advance_known: true,
    ...(category === undefined ? {} : { category }),
  }) as unknown as PlanBlock;

// ── blockCategory ─────────────────────────────────────────────────────────

test("회의·시험·업무 같은 공적 키워드가 들어가면 공적이다", () => {
  for (const word of [
    "회의",
    "미팅",
    "근무",
    "업무",
    "출근",
    "출장",
    "발표",
    "시험",
    "면접",
    "세미나",
    "공적",
  ])
    assert.equal(blockCategory({ activity: `오전 ${word}` }), "official", word);
});

test("친구·가족·병원 같은 사회 키워드가 들어가면 사회다", () => {
  for (const word of [
    "친구",
    "약속",
    "동기",
    "동료",
    "가족",
    "부모",
    "엄마",
    "아빠",
    "형",
    "누나",
    "언니",
    "동생",
    "병원",
    "학원",
    "모임",
    "회식",
    "데이트",
    "만남",
    "결혼식",
    "장례",
    "전화",
  ])
    assert.equal(blockCategory({ activity: `저녁 ${word}` }), "social", word);
});

test("혼자 하는 일은 개인이다", () => {
  for (const activity of ["운동", "잠", "집에서 영화", "장보기", "씻기"])
    assert.equal(blockCategory({ activity }), "personal", activity);
});

test("공적 키워드와 사회 키워드가 같이 있으면 공적이 이긴다", () => {
  assert.equal(blockCategory({ activity: "동료와 회의" }), "official");
  assert.equal(blockCategory({ activity: "업무 전화" }), "official");
  assert.equal(blockCategory({ activity: "가족 병원 동행 출장" }), "official");
});

test("명시한 활동 성격은 이름으로 추론한 것보다 앞선다", () => {
  assert.equal(
    blockCategory({ activity: "팀 회의", category: "social" }),
    "social",
  );
  assert.equal(
    blockCategory({ activity: "운동", category: "official" }),
    "official",
  );
  assert.equal(
    blockCategory({ activity: "친구 약속", category: "personal" }),
    "personal",
  );
});

test("한글로 적었거나 앞뒤가 벌어진 활동 성격도 식별자로 되돌려 앞세운다", () => {
  assert.equal(
    blockCategory({ activity: "운동", category: "공적" }),
    "official",
  );
  assert.equal(
    blockCategory({ activity: "팀 회의", category: " 사회 " }),
    "social",
  );
  assert.equal(
    blockCategory({ activity: "팀 회의", category: " personal " }),
    "personal",
  );
});

test("정해진 세 값 밖의 활동 성격은 무시하고 이름으로 추론한다", () => {
  for (const category of ["긴급", "work", "개인적", "", "미정"])
    assert.equal(
      blockCategory({ activity: "팀 회의", category }),
      "official",
      category,
    );
  assert.equal(
    blockCategory({ activity: "운동", category: "중요" }),
    "personal",
  );
  assert.equal(
    blockCategory({ activity: "친구 약속", category: "unknown" }),
    "social",
  );
});

// ── isAwayUnavail ─────────────────────────────────────────────────────────

test("불가 구간 중 실제로 자리를 비우는 일만 자리 비움이다", () => {
  assert.equal(
    isAwayUnavail(block("19:00", "20:00", "운동", "unavailable")),
    true,
  );
  assert.equal(
    isAwayUnavail(block("13:00", "13:20", "통화", "unavailable")),
    true,
  );
});

test("잠·낮잠·수면·숙면은 불가여도 자리 비움이 아니다", () => {
  for (const activity of ["잠", "낮잠", "수면", "숙면"])
    assert.equal(
      isAwayUnavail(block("24:00", "29:00", activity, "unavailable")),
      false,
      activity,
    );
});

test("틈틈이·즉답 구간은 자리 비움이 아니다", () => {
  assert.equal(
    isAwayUnavail(block("19:00", "20:00", "운동", "intermittent")),
    false,
  );
  assert.equal(
    isAwayUnavail(block("19:00", "20:00", "운동", "instant")),
    false,
  );
});

// ── normalizePlan ─────────────────────────────────────────────────────────

test("자정을 넘긴 시각을 00:30으로 적어 오면 24:30으로 되돌려 순서를 살린다", () => {
  const plan = normalizePlan({
    date: "2026-09-07",
    blocks: [
      block("22:00", "23:30", "책 읽기", "intermittent"),
      block("23:30", "00:30", "잘 준비", "instant"),
      block("00:30", "05:00", "잠", "unavailable"),
    ],
  });
  assert.deepEqual(
    plan.blocks.map((b) => [b.start, b.end]),
    [
      ["22:00", "23:30"],
      ["23:30", "24:30"],
      ["24:30", "29:00"],
    ],
  );
});

test("이미 24시 이후 표기로 적힌 시각과 아침 시각은 그대로 둔다", () => {
  const plan = normalizePlan({
    date: "2026-09-07",
    blocks: [
      block("05:00", "07:00", "잠", "unavailable"),
      block("07:00", "22:00", "하루", "intermittent"),
      block("22:00", "24:30", "잘 준비", "instant"),
      block("24:30", "29:00", "잠", "unavailable"),
    ],
  });
  assert.deepEqual(
    plan.blocks.map((b) => [b.start, b.end]),
    [
      ["05:00", "07:00"],
      ["07:00", "22:00"],
      ["22:00", "24:30"],
      ["24:30", "29:00"],
    ],
  );
});

test("한글로 적은 답장 여건은 식별자로 되돌린다", () => {
  const plan = normalizePlan({
    date: "2026-09-07",
    blocks: [
      raw("09:00", "10:00", "커피", "즉답"),
      raw("10:00", "12:00", "업무", "틈틈이"),
      raw("12:00", "13:00", "집안일", "짬짬이"),
      raw("13:00", "14:00", "운동", "불가"),
      raw("14:00", "15:00", "산책", " instant "),
    ],
  });
  assert.deepEqual(
    plan.blocks.map((b) => b.responsiveness),
    ["instant", "intermittent", "intermittent", "unavailable", "instant"],
  );
});

test("모르는 답장 여건은 틈틈이로 채운다", () => {
  const plan = normalizePlan({
    date: "2026-09-07",
    blocks: [
      raw("09:00", "10:00", "커피", "모름"),
      raw("10:00", "11:00", "산책", ""),
    ],
  });
  assert.deepEqual(
    plan.blocks.map((b) => b.responsiveness),
    ["intermittent", "intermittent"],
  );
});

test("활동 성격이 빠진 블록은 활동 이름으로 추론해 채운다", () => {
  const plan = normalizePlan({
    date: "2026-09-07",
    blocks: [
      raw("09:00", "10:00", "팀 회의", "unavailable"),
      raw("19:00", "21:00", "친구 약속", "intermittent"),
      raw("21:00", "22:00", "운동", "unavailable"),
    ],
  });
  assert.deepEqual(
    plan.blocks.map((b) => b.category),
    ["official", "social", "personal"],
  );
});

test("한글로 적은 활동 성격은 식별자로 되돌리고 이름 추론보다 앞선다", () => {
  const plan = normalizePlan({
    date: "2026-09-07",
    blocks: [
      raw("09:00", "10:00", "운동", "unavailable", "공적"),
      raw("10:00", "11:00", "팀 회의", "unavailable", "사회"),
      raw("11:00", "12:00", "친구 약속", "intermittent", "개인"),
    ],
  });
  assert.deepEqual(
    plan.blocks.map((b) => b.category),
    ["official", "social", "personal"],
  );
});

test("정해진 세 값 밖의 활동 성격은 저장하지 않고 이름으로 다시 추론한다", () => {
  const plan = normalizePlan({
    date: "2026-09-07",
    blocks: [
      raw("09:00", "10:00", "팀 회의", "unavailable", "긴급"),
      raw("19:00", "21:00", "친구 약속", "intermittent", "work"),
      raw("21:00", "22:00", "운동", "unavailable", ""),
    ],
  });
  assert.deepEqual(
    plan.blocks.map((b) => b.category),
    ["official", "social", "personal"],
  );
});

test("정규화는 날짜와 나머지 칸을 그대로 둔다", () => {
  const plan = normalizePlan({
    date: "2026-09-07",
    blocks: [
      block("09:00", "10:00", "커피", "instant", { advance_known: false }),
    ],
  });
  assert.equal(plan.date, "2026-09-07");
  assert.equal(plan.blocks[0]?.activity, "커피");
  assert.equal(plan.blocks[0]?.advance_known, false);
  assert.equal(
    normalizePlan({ date: "2026-09-07", blocks: [] }).blocks.length,
    0,
  );
});

// ── ensureTodayPlan 스킵 분기 (DB) ────────────────────────────────────────

const TODAY_PLAN: DayPlan = {
  date: kstLogicalDate(),
  blocks: [
    block("05:00", "07:00", "잠", "unavailable"),
    block("07:00", "24:00", "하루", "intermittent"),
    block("24:00", "29:00", "잠", "unavailable"),
  ],
};
const TODAY_JSON = JSON.stringify(TODAY_PLAN);

test("오늘 각본이 있으면 대화 중 경로는 모델을 부르지 않고 그대로 둔다", async () => {
  const id = makeCharacter("chat-plan-ondemand");
  saveDayPlan(id, TODAY_PLAN.date, TODAY_JSON, "ondemand");
  await ensureTodayPlan(id);
  assert.equal(getDayPlan(id, TODAY_PLAN.date), TODAY_JSON);
  assert.equal(getDayPlanMadeBy(id, TODAY_PLAN.date), "ondemand");
});

test("정식 각본이 있으면 대화 중 경로도 그대로 둔다", async () => {
  const id = makeCharacter("chat-plan-nightly-lazy");
  saveDayPlan(id, TODAY_PLAN.date, TODAY_JSON, "nightly");
  await ensureTodayPlan(id, false);
  assert.equal(getDayPlan(id, TODAY_PLAN.date), TODAY_JSON);
  assert.equal(getDayPlanMadeBy(id, TODAY_PLAN.date), "nightly");
});

test("정식 각본이 있으면 밤 정리 경로도 다시 만들지 않는다", async () => {
  const id = makeCharacter("chat-plan-nightly");
  saveDayPlan(id, TODAY_PLAN.date, TODAY_JSON, "nightly");
  await ensureTodayPlan(id, true);
  assert.equal(getDayPlan(id, TODAY_PLAN.date), TODAY_JSON);
  assert.equal(getDayPlanMadeBy(id, TODAY_PLAN.date), "nightly");
});

test("낮에 만든 임시 각본은 밤 정리 경로가 다시 만들려 한다 — 모델이 닿지 않아 실패로 드러난다", async () => {
  const id = makeCharacter("chat-plan-replace");
  saveDayPlan(id, TODAY_PLAN.date, TODAY_JSON, "ondemand");
  await assert.rejects(ensureTodayPlan(id, true));
  // 실패했으니 임시 각본은 그대로 남아 있다.
  assert.equal(getDayPlan(id, TODAY_PLAN.date), TODAY_JSON);
  assert.equal(getDayPlanMadeBy(id, TODAY_PLAN.date), "ondemand");
});
