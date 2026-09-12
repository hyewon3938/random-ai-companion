// 프롬프트 조립(context/assemble.ts)과 각본 위의 지금(context/day-progress.ts)이 값 묶음을 3층으로 쌓는 자리를 검사한다 — 모델은 부르지 않는다.
//
// 읽기와 조립을 갈라 둔 뒤로 조립은 DB 없이 값 묶음만으로 돈다. 층마다 어느 절이 들어가는지,
// 공통 규칙이 한 번만 들어가는지, 지금 시각 절이 지나온 블록과 지금 하는 일을 어떻게 적는지 본다.
// 조립이 부르는 기억 모듈이 DB를 여는 탓에 DB는 임시 파일로 새로 만든다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MemoryRow, RelationshipRow } from "../src/db.js";
import type { PlanBlock } from "../src/day-plan.js";
import type { ContextInput } from "../src/context/input.js";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

const { assembleSystemBlocks } = await import("../src/context/assemble.js");
const { dayProgressOf, sleepGap, wokeNowLine } = await import(
  "../src/context/day-progress.js"
);
const { COLD_START_SEED, PERSON } = await import("../src/prompts/reply.js");
const { REPLY_ENVELOPE } = await import("../src/reply-signal.js");

const blocks: PlanBlock[] = [
  { start: "07:00", end: "09:00", activity: "아침", responsiveness: "instant", advance_known: true, category: "personal" },
  { start: "09:00", end: "12:00", activity: "오전 업무", responsiveness: "intermittent", advance_known: true, category: "official" },
  { start: "13:00", end: "14:30", activity: "팀 회의", responsiveness: "unavailable", advance_known: true, category: "official" },
  { start: "14:30", end: "18:00", activity: "오후 업무", responsiveness: "intermittent", advance_known: true, category: "official" },
  { start: "22:00", end: "24:30", activity: "집에서 쉼", responsiveness: "instant", advance_known: false, category: "personal" },
];

const identityRow = (id: number, subject: string, value: string): MemoryRow => ({
  id,
  character_id: 1,
  item_type: "fact",
  owner: "char",
  area: "기본",
  subject,
  value,
  origin: "creation",
  user_knows: "known",
  relation: null,
  contact_mode: null,
  region: null,
  last_mentioned_at: null,
  end_condition: null,
  interest: null,
  occurred_on: null,
  last_retrieved_at: null,
  retrieval_count: 0,
  updated_at: "2026-08-30 12:00:00",
});

const rel: RelationshipRow = {
  stage: "알아가는 중",
  speech_level: "polite",
  speech_note: null,
  address_terms: null,
  rapport: "산책 얘기",
  cautions: null,
  history: null,
  feelings: null,
  user_state: null,
  user_state_cause: null,
  user_state_tone: null,
  user_state_since: null,
  met_at: "2026-08-30 12:00:00",
  updated_at: "2026-09-05 04:00:00",
};

const input = (over: Partial<ContextInput> = {}): ContextInput => ({
  identity: [identityRow(1, "이름", "한도윤"), identityRow(2, "직업", "건축 설계")],
  rel,
  metAt: "2026-08-30 12:00:00",
  userBlock: "[상대 — 프로필]\n- 이름: 유저",
  today: "2026-09-06",
  logicalToday: "2026-09-06",
  workday: "오늘은 일요일, 내일은 월요일",
  plan: { date: "2026-09-06", blocks },
  now: "15:35",
  progress: dayProgressOf(blocks, "15:35"),
  wokeAt: null,
  nowDescription: "2026년 9월 6일 (일) 15:35",
  nowVerbal: "오후 3시 35분",
  judgedSpeech: null,
  upcoming: [],
  diaries: [{ date: "2026-09-05", entry_json: '{"summary":"조용한 하루"}' }],
  coldStart: false,
  search: { memories: [], oldDiaries: [], schedules: [] },
  workFacts: [],
  notes: [],
  lastTalk: null,
  contactGap: null,
  recent: [],
  userMemories: [],
  relationship: {
    stage: 1,
    stageSince: "2026-08-30",
    days: 8,
    firsts: [],
    todayMoves: [],
    toldPlanAt: null,
    toldPlanWhat: null,
    intent: null,
  },
  ...over,
});

test("각본 위의 지금은 지나온 블록과 지금 블록을 가르고 빈자리는 잠으로 메운다", () => {
  const mid = dayProgressOf(blocks, "10:00");
  assert.deepEqual(mid.past.map((b) => b.activity), ["아침"]);
  assert.equal(mid.cur?.activity, "오전 업무");

  // 자정 전의 빈자리는 각본에 없는 시간일 뿐이라 잠으로 보지 않는다.
  assert.equal(dayProgressOf(blocks, "12:30").cur, null);
  assert.equal(sleepGap(blocks, "23:00"), null);

  const late = dayProgressOf(blocks, "25:00");
  assert.equal(late.past.length, 5);
  assert.deepEqual(late.cur, {
    start: "24:30",
    end: "29:00",
    activity: "잠",
    responsiveness: "unavailable",
    advance_known: true,
    category: "personal",
    fallback: true,
  });
});

test("자다 깬 줄은 깬 시각을 기록 그대로 쓰고 깨어 있는 분을 센다", () => {
  const sleep: PlanBlock = {
    start: "24:30",
    end: "31:00",
    activity: "잠",
    responsiveness: "unavailable",
    advance_known: true,
    category: "personal",
  };
  const line = wokeNowLine(sleep, "2026-09-06 02:10:00", "26:25");
  assert.ok(line.includes("각본상 00:30~07:00 자는 시간이지만 02:10에 상대 연락에 깼고, 지금 15분째 깨어 있다"));
  assert.ok(line.includes("답장 여건은 즉답"));
});

test("3층은 안정도 순이고 앞 두 층만 캐시한다", () => {
  const [stable, daily, live] = assembleSystemBlocks(input());
  assert.equal(stable.cache, true);
  assert.equal(daily.cache, true);
  assert.equal(live.cache, undefined);

  assert.ok(stable.text.startsWith("너는 아래 인물이다.\n\n[너 — 정체성]"));
  assert.ok(stable.text.includes("한도윤"));
  assert.ok(stable.text.includes("- 네 이름: 한도윤"));
  assert.ok(stable.text.includes("[시간] 너희가 처음 연결된 날은 2026-08-30."));
  assert.ok(stable.text.includes("- 지금 어떤 사이: 알아가는 중"));
  assert.ok(stable.text.includes("- 잘 통하는 것: 산책 얘기"));
  assert.ok(!stable.text.includes("- 조심할 것:"));
  assert.ok(stable.text.endsWith("[상대 — 프로필]\n- 이름: 유저"));

  assert.ok(daily.text.startsWith("[오늘/내일] 오늘은 일요일, 내일은 월요일."));
  assert.ok(!daily.text.includes("처음 만난 날"));
  assert.ok(daily.text.includes("[너의 오늘 하루 — 미리 알고 있는 흐름]\n07:00~09:00 아침 → 09:00~12:00 오전 업무 → 13:00~14:30 팀 회의 → 14:30~18:00 오후 업무"));
  assert.ok(!daily.text.includes("집에서 쉼"), "당일에 닥치는 일은 미리 아는 흐름에 넣지 않는다");
  assert.ok(daily.text.includes('[너의 최근 일기 — 기억의 원본]\n2026-09-05: {"summary":"조용한 하루"}'));
  assert.ok(!daily.text.includes(COLD_START_SEED));
});

test("정체성 절에도 날짜 읽는 규칙이 붙는다", () => {
  // 새벽 정리는 주인을 가리지 않고 있었던 날을 적어서, 대화로 쌓인 캐릭터 쪽 사실에도
  // 날짜가 붙는다. 규칙이 없으면 그 줄의 두 날짜를 무엇으로 읽어야 할지 알 수 없다.
  const grown = {
    ...identityRow(3, "이사", "회사 근처로 옮겼다"),
    origin: "conversation" as const,
    occurred_on: "2026-09-10",
    updated_at: "2026-09-12 04:00:00",
  };
  const [stable] = assembleSystemBlocks(
    input({ identity: [identityRow(1, "이름", "한도윤"), grown] }),
  );
  assert.ok(stable.text.includes("(9/10에 있었던 일 · 9/12 갱신)"));
  assert.ok(stable.text.includes("'갱신'은 그 줄을 마지막으로 고친 날이다"));
});

const WORK_HEAD = "[작품 — 네가 보거나 읽는 것에서 확인된 사실]";

test("작품 사실 카드는 카드가 있을 때만 일간층에 붙는다", () => {
  const facts = [
    {
      title: "여름 언덕",
      summary: "이사 온 소년이 한 계절을 보내는 이야기.",
      scenes: ["둑길에서 자전거가 멈추는 장면"],
      differences: "원작 소설과 결말이 다르다",
    },
  ];
  const [stable, daily, live] = assembleSystemBlocks(input({ workFacts: facts }));
  assert.ok(daily.text.includes(WORK_HEAD));
  assert.ok(daily.text.includes("· 여름 언덕: 이사 온 소년이 한 계절을 보내는 이야기."));
  assert.ok(daily.text.includes("  기억에 남는 장면: 둑길에서 자전거가 멈추는 장면"));
  assert.ok(daily.text.includes("  원작과 다른 점: 원작 소설과 결말이 다르다"));
  // 규칙층의 "[작품] 절에 적힌 것만" 문안은 불변층에 있다 — 절 머리로 자리를 가른다.
  assert.ok(!stable.text.includes(WORK_HEAD));
  assert.ok(!live.text.includes(WORK_HEAD));

  const [, empty] = assembleSystemBlocks(input());
  assert.ok(!empty.text.includes(WORK_HEAD), "카드가 없으면 절 자체가 안 나온다");
});

test("장면과 다른 점이 비면 그 줄은 안 적는다", () => {
  const [, daily] = assembleSystemBlocks(
    input({
      workFacts: [
        { title: "빈 카드", summary: "줄거리만 있다.", scenes: [], differences: null },
      ],
    }),
  );
  assert.ok(daily.text.includes("· 빈 카드: 줄거리만 있다."));
  assert.ok(!daily.text.includes("기억에 남는 장면:"));
  assert.ok(!daily.text.includes("원작과 다른 점:"));
});

test("공통 규칙 덩이는 불변층에 한 번만 들어간다", () => {
  const [stable, daily, live] = assembleSystemBlocks(input());
  const head = PERSON.split("\n")[0];
  assert.equal(stable.text.split(head).length - 1, 1);
  assert.ok(!daily.text.includes(head));
  assert.ok(!live.text.includes(head));
});

test("지금 절은 지나온 오늘과 지금 하는 일의 분째·남은 시간을 적는다", () => {
  const [, , live] = assembleSystemBlocks(input());
  assert.ok(live.text.includes("- 지나온 오늘(전부 이미 마친 일이다): 07:00~09:00 아침 → 09:00~12:00 오전 업무 → 13:00~14:30 팀 회의"));
  assert.ok(live.text.includes('너는 지금 "오후 업무" 중이다(이 일 14:30~18:00·시작 65분째·끝나기까지 145분, 답장 여건 틈틈이, 활동 성격 공적).'));
  assert.ok(live.text.includes("- 말투: 존댓말."));
  assert.ok(!live.text.includes("[연락 텀]"));
  assert.ok(!live.text.includes("[직전 대화]"));
  assert.ok(!live.text.includes(REPLY_ENVELOPE));
});

test("자다 깬 자리는 깬 줄로 바꾸고 분째 규칙을 붙이지 않는다", () => {
  const sleepBlocks: PlanBlock[] = [
    ...blocks,
    { start: "24:30", end: "31:00", activity: "잠", responsiveness: "unavailable", advance_known: true, category: "personal" },
  ];
  const [, , live] = assembleSystemBlocks(
    input({
      now: "26:25",
      progress: dayProgressOf(sleepBlocks, "26:25"),
      wokeAt: "2026-09-06 02:10:00",
      nowDescription: "2026년 9월 7일 (월) 02:25",
      nowVerbal: "새벽 2시 25분",
    }),
  );
  assert.ok(live.text.includes("02:10에 상대 연락에 깼고, 지금 15분째 깨어 있다"));
  assert.ok(!live.text.includes("위 '분째'에 맞게 말한다"));
});

test("첫 만남·첫 대화·연락 텀·상황 문단·답장 형식은 켤 때만 붙는다", () => {
  const [, daily, live] = assembleSystemBlocks(
    input({
      metAt: "2026-09-06 01:00:00",
      coldStart: true,
      contactGap: {
        label:
          "캐릭터가 12:00에 마지막으로 말했고 유저가 15:30에 다시 말을 걸었다. 3시간 30분 만이다.",
        longing: false,
      },
      lastTalk: "어제",
      notes: ["두 시 반에 병원"],
      judgedSpeech: "반말",
      rel: { ...rel, speech_level: null },
    }),
    { situation: "  지금은 몰아 답장 자리다.  ", signals: true },
  );
  assert.ok(daily.text.includes("[관계] 오늘은 이 사람과 처음 만난 날이다."));
  assert.ok(daily.text.endsWith(COLD_START_SEED));
  assert.ok(live.text.includes("[오늘 메모 — 대화하며 적어 둔 것]\n- 두 시 반에 병원"));
  assert.ok(live.text.includes("[직전 대화]\n마지막으로 대화한 날은 어제다."));
  assert.ok(live.text.includes("[연락 텀]\n캐릭터가 12:00에 마지막으로 말했고"));
  assert.ok(live.text.includes("- 그 사이 네가 각본대로 바빴으면"));
  assert.ok(!live.text.includes("- 오래 기다린 자리다."));
  assert.ok(live.text.includes("- 말투: 서로 반말"));
  assert.ok(live.text.includes("지금은 몰아 답장 자리다.\n\n"));
  assert.ok(live.text.endsWith(REPLY_ENVELOPE));
});

test("긴 텀에는 기다렸다는 말 규칙이 붙고 바빴으면 접으라는 줄은 빠진다", () => {
  const [, , live] = assembleSystemBlocks(
    input({
      contactGap: {
        label:
          "네가 09:10에 마지막으로 말한 뒤 상대 연락은 19:10에 왔다. 10시간 만이다.",
        longing: true,
      },
    }),
  );
  assert.ok(live.text.includes("[연락 텀]\n네가 09:10에 마지막으로"));
  assert.ok(live.text.includes("- 오래 기다린 자리다."));
  assert.ok(live.text.includes("일하는 틈틈이 확인했다는 결로 말한다."));
  assert.ok(live.text.includes("몇 마디 주고받다가 꺼내도 된다."));
  assert.ok(!live.text.includes("- 그 사이 네가 각본대로 바빴으면"));
});
