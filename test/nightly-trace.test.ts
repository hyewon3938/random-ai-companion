// 새벽 정리 전후 값의 차이가 트레이스 게시함(trace_events)에 어떤 글로 쌓이는지 검사한다 — 모델은 부르지 않는다.
//
// beforeNightlyTrace로 스냅숏을 뜨고, 반영 트랜잭션이 할 일을 손으로 DB에 쓴 뒤 afterNightlyTrace를
// 불러 본문 한 행과 스레드 자식(기억·진행 중인 일·일기·선톡 문안·호출 원문)의 문안을 본다.
// 슬랙 토큰은 가짜 값이라 게시함에만 쌓이고 밖으로 나가지 않는다. 발송 틱은 돌리지 않는다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DiaryOutput,
  MemoryExtract,
  NightlyGathered,
  NightlyOutput,
} from "../src/nightly.js";

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
  addSchedule,
  getRelationship,
  insertDiary,
  insertScheduledSend,
  markScheduleKnown,
  recordLlmCall,
  saveUserProfile,
  setScheduleTimeHint,
  setTags,
  updateRelationshipNotes,
} = await import("../src/db.js");
const { beforeNightlyTrace, afterNightlyTrace } = await import(
  "../src/nightly-trace.js"
);
const { saveMemory } = await import("../src/memory.js");
const { createFixtureCharacter } = await import(
  "../src/eval/fixture-character.js"
);

const CHAT_ID = "1";
const characterId = createFixtureCharacter(CHAT_ID);
const NOW = "2026-09-02 04:10:00";

// 트레이스가 읽는 값만 채우고 나머지는 비워 둔다. 시험마다 diaryDate를 달리 줘서 본문 행의
// 중복 방지 키(nightly:캐릭터:날짜)가 겹치지 않게 한다.
const gathered = (over: Partial<NightlyGathered>): NightlyGathered => ({
  characterId,
  chatId: CHAT_ID,
  diaryDate: "2026-09-01",
  today: "2026-09-02",
  todayLabel: "9/2(수)",
  diaryExists: false,
  convo: "",
  msgsCount: 0,
  planBriefYesterday: "",
  planExistsToday: false,
  identity: "",
  people: "",
  ongoing: "",
  ongoingForPlan: "",
  ongoingTouched: [],
  touchedUserFacts: [],
  relationship: "",
  userState: "",
  userProfile: "",
  todayNotes: [],
  dayActuals: [],
  existingKeys: [],
  areas: [],
  tagNames: [],
  userSchedulesUpcoming: "",
  existingSchedules: [],
  arcs: {},
  todaySeed: null,
  lastNight: null,
  awayRule: "",
  rhythmNeeded: [],
  silenceTier: "normal",
  silenceDays: 0,
  sendPlan: "none",
  sendPlanReason: "",
  ...over,
});

const entry = (diary: string): DiaryOutput => ({
  diary,
  plan_vs_actual: "",
  user_mood: "",
  closeness: "",
  tomorrow: [],
});

interface EventRow {
  kind: string;
  dedupe_key: string | null;
  thread_key: string | null;
  parent_key: string | null;
  text: string;
  status: string;
}

const COLS = `kind, dedupe_key, thread_key, parent_key, text, status`;

const parentKeyOf = (diaryDate: string): string =>
  `nightly:${characterId}:${diaryDate}`;

const parentOf = (diaryDate: string): EventRow | undefined =>
  db
    .prepare(`SELECT ${COLS} FROM trace_events WHERE dedupe_key = ?`)
    .get(parentKeyOf(diaryDate)) as EventRow | undefined;

const childrenOf = (diaryDate: string): EventRow[] =>
  db
    .prepare(`SELECT ${COLS} FROM trace_events WHERE parent_key = ? ORDER BY id`)
    .all(parentKeyOf(diaryDate)) as EventRow[];

// 본문 첫 줄에는 지금 시각이 들어가서 날짜 표시까지만 맞춰 본다.
const HEAD_LINE = /^:crescent_moon: \*(\d+\/\d+\([일월화수목금토]\)) 새벽 정리\* · \d{2}:\d{2}:\d{2}\n\n/;

test("skip 결과면 게시함에 아무것도 쌓지 않는다", () => {
  const g = gathered({ diaryDate: "2026-08-31" });
  const out: NightlyOutput = { entry: entry("아무 일 없던 하루") };
  const snap = beforeNightlyTrace(g, out);
  assert.ok(snap);

  afterNightlyTrace(g, out, snap, "skip: 2026-08-31 일기가 이미 있다");

  assert.equal(parentOf("2026-08-31"), undefined);
  assert.equal(childrenOf("2026-08-31").length, 0);
});

test("바뀐 것이 없으면 본문 한 행만 쌓고 스레드는 붙이지 않는다", () => {
  const g = gathered({ diaryDate: "2026-09-01" });
  const out: NightlyOutput = { entry: entry("조용한 하루") };
  const snap = beforeNightlyTrace(g, out);
  assert.ok(snap);

  afterNightlyTrace(g, out, snap, "ok: 일기 저장");

  const head = parentOf("2026-09-01");
  assert.ok(head);
  assert.equal(head.kind, "nightly");
  assert.equal(head.thread_key, parentKeyOf("2026-09-01"));
  assert.equal(head.parent_key, null);
  assert.equal(head.status, "pending");
  const m = HEAD_LINE.exec(head.text);
  assert.ok(m);
  assert.equal(m[1], "9/1(화)");
  assert.equal(
    head.text.slice(m[0].length),
    ["> ok: 일기 저장", "*오늘 메모* 없음", "*각본과 달라진 하루* 없음"].join(
      "\n\n",
    ),
  );
  assert.equal(childrenOf("2026-09-01").length, 0);
});

test("일기 전문이 오늘 메모와 각본과 달라진 하루와 함께 붙는다", () => {
  const g = gathered({
    diaryDate: "2026-09-02",
    today: "2026-09-03",
    todayLabel: "9/3(목)",
    todayNotes: ["점심에 김밥을 먹었다고 했다"],
    dayActuals: ["- 09:00 출근 블록이 10:00으로 밀림"],
  });
  const e: DiaryOutput = {
    diary: "비가 와서 늦게 나갔다",
    plan_vs_actual: "각본보다 한 시간 늦게",
    user_mood: "",
    closeness: "",
    tomorrow: ["우산 챙기기"],
  };
  const out: NightlyOutput = { entry: e };
  const snap = beforeNightlyTrace(g, out);
  assert.ok(snap);

  // 반영 트랜잭션 몫 — 일기 행을 넣고 태그를 단다.
  const diaryId = insertDiary(characterId, "2026-09-02", JSON.stringify(e));
  setTags(characterId, "diary", diaryId, ["출근", "비"]);
  afterNightlyTrace(g, out, snap, "ok: 일기 저장");

  const head = parentOf("2026-09-02");
  assert.ok(head);
  assert.ok(
    head.text.includes("*오늘 메모* 1건\n> 점심에 김밥을 먹었다고 했다"),
  );
  assert.ok(
    head.text.includes(
      "*각본과 달라진 하루* 1건\n> 09:00 출근 블록이 10:00으로 밀림",
    ),
  );

  const children = childrenOf("2026-09-02");
  assert.deepEqual(
    children.map((c) => c.kind),
    ["nightly_diary"],
  );
  assert.equal(
    children[0].text,
    [
      "일기",
      "*9/2(수) 일기*",
      "",
      "> 비가 와서 늦게 나갔다",
      "",
      "*각본 대비*",
      "> 각본보다 한 시간 늦게",
      "",
      "*내일 챙길 것*",
      "> - 우산 챙기기",
      "",
      "*태그* 비, 출근",
    ].join("\n"),
  );
});

test("기억 신규와 덮어쓰기가 바뀐 자리 표시와 태그 변화까지 스레드에 붙는다", () => {
  // 대화로 이미 쌓여 있던 두 행 — 하나는 이번에 값이 바뀌고 하나는 그대로다.
  saveMemory({
    characterId,
    itemType: "fact",
    owner: "user",
    area: "일",
    subject: "직장",
    value: "회사를 다닌다",
    tags: ["회사"],
  });
  saveMemory({
    characterId,
    itemType: "fact",
    owner: "user",
    area: "취미",
    subject: "독서",
    value: "주말에 읽는다",
  });
  const memories: MemoryExtract[] = [
    {
      item_type: "fact",
      owner: "user",
      area: "일",
      subject: "직장",
      value: "회사를 옮길 생각이 있다",
      tags: ["회사", "이직"],
    },
    {
      item_type: "fact",
      owner: "char",
      area: "생활",
      subject: "운동",
      value: "요즘은 아침마다 달린다",
      interest: "medium",
    },
    {
      item_type: "fact",
      owner: "user",
      area: "음식",
      subject: "커피",
      value: "아이스 라떼만 마신다",
      tags: ["커피"],
    },
    {
      item_type: "fact",
      owner: "user",
      area: "일",
      subject: "직장/부서",
      value: "기획팀이다",
    },
    {
      item_type: "fact",
      owner: "user",
      area: "취미",
      subject: "독서",
      value: "주말에 읽는다",
    },
  ];
  const g = gathered({ diaryDate: "2026-09-03", today: "2026-09-04" });
  const out: NightlyOutput = {
    entry: entry("기억이 늘어난 하루"),
    extract: { memories, schedules: [] },
  };
  const snap = beforeNightlyTrace(g, out);
  assert.ok(snap);
  assert.equal(snap.memories.size, 3);

  // 반영 트랜잭션 몫 — 키 규칙에 맞는 네 건을 대화 쪽 행으로 쓴다.
  for (const m of memories) {
    if (m.subject.includes("/")) continue;
    saveMemory({
      characterId,
      itemType: m.item_type,
      owner: m.owner,
      area: m.area,
      subject: m.subject,
      value: m.value,
      tags: m.tags,
      interest: m.interest,
    });
  }
  afterNightlyTrace(g, out, snap, "ok: 기억 4건");

  const children = childrenOf("2026-09-03");
  assert.deepEqual(
    children.map((c) => c.kind),
    ["nightly_memory"],
  );
  // 태그에는 영역과 무엇이 늘 함께 들어가고 글자 순으로 나온다. 생성 때 값만 있던 키는
  // 이전 값의 출처를 밝히고, 캐릭터 쪽 사실은 관심 수준을 한 줄 더 단다.
  assert.equal(
    children[0].text,
    [
      "기억",
      "*기억* 신규 1건 · 덮어쓰기 2건 · 값 그대로 1건 · 키 불가 1건",
      "",
      "＋ *[사실 · 유저] 음식/커피*",
      "> 아이스 라떼만 마신다",
      "> 태그: 음식 · 커피",
      "",
      "～ *[사실 · 유저] 일/직장*",
      "> 회사를 [-다닌다-] {+옮길 생각이 있다+}",
      "> 태그: 이직 · 일 · 직장 · 회사 (이전 일 · 직장 · 회사)",
      "",
      "～ *[사실 · 캐릭터] 생활/운동* (생성 때 값을 덮음)",
      "> [-주 이삼 회 집 근처를 달린다. 바쁘면 건너뛴다-] {+요즘은 아침마다 달린다+}",
      "> 태그: 생활 · 운동",
      "> 관심 수준: 보통",
      "",
      "= 값 그대로: [사실 · 유저] 취미/독서",
      "",
      ":warning: 키 규칙에 안 맞아 건너뜀: 일/직장/부서",
    ].join("\n"),
  );
});

test("관계 항목과 상대 프로필이 바뀌면 전문 하나에 빠진 말과 더한 말을 표시한다", () => {
  const g = gathered({ diaryDate: "2026-09-04", today: "2026-09-05" });
  const out: NightlyOutput = { entry: entry("가까워진 하루") };
  const snap = beforeNightlyTrace(g, out);
  assert.ok(snap);
  const feelingsBefore = getRelationship(characterId)?.feelings;
  assert.ok(feelingsBefore);

  // 반영 트랜잭션 몫 — 비어 있던 항목 하나와 값이 있던 항목 하나, 프로필 한 값을 채운다.
  updateRelationshipNotes(
    characterId,
    { rapport: "영화 얘기", feelings: "편해졌다" },
    NOW,
  );
  saveUserProfile(CHAT_ID, { job: "디자이너" }, NOW);
  afterNightlyTrace(g, out, snap, "ok: 관계 갱신");

  const head = parentOf("2026-09-04");
  assert.ok(head);
  assert.ok(
    head.text.includes(
      [
        "*관계 갱신* 2항목",
        "*잘 통하는 것*",
        "> {+영화 얘기+}",
        "*지금 마음*",
        "> [-말이 잘 통해서 다음 대화가 조금 기다려진다-] {+편해졌다+}",
      ].join("\n"),
    ),
  );
  assert.ok(
    head.text.includes(
      [
        "*상대 프로필 갱신* 1항목",
        "*하는 일*",
        "> {+디자이너+}",
      ].join("\n"),
    ),
  );
  assert.equal(childrenOf("2026-09-04").length, 0);
});

test("새 일정과 일정 시각 고침이 본문에 적힌다", () => {
  const dentistId = addSchedule(
    characterId,
    "char",
    "2026-09-10",
    "오후",
    "치과",
    NOW,
    "conversation",
  );
  const g = gathered({ diaryDate: "2026-09-05", today: "2026-09-06" });
  const out: NightlyOutput = {
    entry: entry("약속이 잡힌 하루"),
    extract: {
      memories: [],
      schedules: [
        {
          who: "user",
          date: "2026-09-12",
          time_hint: "19:00",
          content: "친구 결혼식",
          tags: ["결혼식"],
        },
        { who: "char", date: "2026-09-13", time_hint: null, content: "청주 내려감" },
      ],
      schedule_updates: [
        { id: dentistId, time_hint: "14:30" },
        { id: 999999, time_hint: "10:00" },
      ],
    },
  };
  const snap = beforeNightlyTrace(g, out);
  assert.ok(snap);
  assert.equal(snap.scheduleTimes.size, 1);

  // 반영 트랜잭션 몫 — 있는 줄의 시각만 고친다. 새 일정은 본문이 출력에서 바로 읽는다.
  assert.equal(setScheduleTimeHint(characterId, dentistId, "14:30"), true);
  afterNightlyTrace(g, out, snap, "ok: 일정 2건");

  const head = parentOf("2026-09-05");
  assert.ok(head);
  assert.ok(
    head.text.includes(
      [
        "*새 일정* 2건",
        "> 2026-09-12 19:00 · 친구 결혼식 (유저 쪽) · 태그 결혼식",
        "> 2026-09-13 · 청주 내려감 (캐릭터 쪽) · 태그 없음",
      ].join("\n"),
    ),
  );
  assert.ok(
    head.text.includes(
      [
        "*일정 시각 고침* 2건",
        "> 2026-09-10 치과 · 오후 → 14:30",
        "> [999999] 반영 대상이 아니라 건너뜀",
      ].join("\n"),
    ),
  );
  assert.equal(childrenOf("2026-09-05").length, 0);
});

test("상대에게 말한 일정이 이전 값과 함께 본문에 적힌다", () => {
  const showId = addSchedule(
    characterId,
    "char",
    "2026-09-18",
    "저녁",
    "공연",
    NOW,
    "conversation",
  );
  const knownId = addSchedule(
    characterId,
    "char",
    "2026-09-19",
    null,
    "본가",
    NOW,
    "conversation",
    "known",
  );
  const g = gathered({ diaryDate: "2026-09-14", today: "2026-09-15" });
  const out: NightlyOutput = {
    entry: entry("발표 이야기를 한 하루"),
    extract: {
      memories: [],
      schedules: [],
      schedule_updates: [
        { id: showId, user_knows: "known" },
        { id: knownId, user_knows: "known" },
        { id: 999999, user_knows: "known" },
      ],
    },
  };
  const snap = beforeNightlyTrace(g, out);
  assert.ok(snap);

  // 반영 트랜잭션 몫 — 이미 아는 줄은 바뀔 것이 없어 건너뛴다.
  assert.equal(markScheduleKnown(characterId, showId), true);
  assert.equal(markScheduleKnown(characterId, knownId), false);
  afterNightlyTrace(g, out, snap, "ok: 일정 1건");

  const head = parentOf("2026-09-14");
  assert.ok(head);
  assert.ok(
    head.text.includes(
      [
        "*상대에게 말한 일정* 3건",
        "> 2026-09-18 공연 · 상대는 모름 → 상대가 앎",
        "> 2026-09-19 본가 · 이미 상대가 아는 일정",
        "> [999999] 반영 대상이 아니라 건너뜀",
      ].join("\n"),
    ),
  );
});

test("진행 중인 일의 한 걸음이 바뀐 자리 표시로 붙고 끝난 것은 사실로 옮겼다고 적는다", () => {
  interface OngoingRow {
    id: number;
    area: string;
    subject: string;
    value: string;
  }
  const rows = db
    .prepare(
      `SELECT id, area, subject, value FROM memory_items
        WHERE character_id = ? AND item_type = 'ongoing' ORDER BY id`,
    )
    .all(characterId) as OngoingRow[];
  assert.equal(rows.length, 2);
  const [design, move] = rows;

  const g = gathered({ diaryDate: "2026-09-06", today: "2026-09-07" });
  const out: NightlyOutput = {
    entry: entry("한 걸음 나아간 하루"),
    progress: [
      { id: design.id, value: "도면 2차 검토를 넘겼다" },
      { id: move.id, value: "근처 투룸을 계약했다", done: true },
      { id: 999999, value: "없는 행" },
    ],
  };
  const snap = beforeNightlyTrace(g, out);
  assert.ok(snap);
  assert.equal(snap.progress.size, 2);

  // 반영 트랜잭션은 값을 옮기고 끝난 행은 사실 행으로 바꾸지만, 게시는 스냅숏만 보므로
  // 여기서는 값을 바꾸는 것까지만 흉내 낸다.
  db.prepare(`UPDATE memory_items SET value = ? WHERE id = ?`).run(
    "도면 2차 검토를 넘겼다",
    design.id,
  );
  afterNightlyTrace(g, out, snap, "ok: 진행 2건");

  const children = childrenOf("2026-09-06");
  assert.deepEqual(
    children.map((c) => c.kind),
    ["nightly_progress"],
  );
  assert.equal(
    children[0].text,
    [
      "진행 중인 일",
      `*${design.area}/${design.subject}*`,
      "[-성수동 상가 리모델링 도면을 맡아 매주-] {+도면 2차+} 검토를 [-넘긴다-] {+넘겼다+}",
      "",
      `*${move.area}/${move.subject}* · 끝나서 사실로 옮김`,
      "[-지금 원룸 계약이 끝나가서-] 근처 [-매물을 틈틈이 본다-] {+투룸을 계약했다+}",
      "",
      ":warning: [999999] 반영 대상이 아니라 건너뜀",
    ].join("\n"),
  );
});

test("침묵 단계와 선톡 문안과 새벽 정리가 부른 호출 원문이 함께 붙는다", () => {
  const g = gathered({
    diaryDate: "2026-09-07",
    today: "2026-09-08",
    todayLabel: "9/8(화)",
    silenceTier: "checkin",
    silenceDays: 5,
  });
  const out: NightlyOutput = { entry: entry("조용한 닷새째") };
  const snap = beforeNightlyTrace(g, out);
  assert.ok(snap);

  // 반영 트랜잭션 몫 — 오늘 저녁 안부 문안을 걸어 둔다. 호출 원문은 생성 경로가 반영 직전에
  // 남긴 것이라 새벽 정리 몫(diary)과 답장 몫(reply)을 하나씩 넣어 가르는지 본다.
  insertScheduledSend(
    characterId,
    CHAT_ID,
    "2026-09-08",
    "19:00",
    "21:00",
    "잘 지내요?",
    NOW,
    "checkin",
  );
  const diaryCallId = recordLlmCall({
    purpose: "diary",
    model: "claude-opus-4-8",
    characterId,
    chatId: CHAT_ID,
    system: [{ text: "시스템 글" }],
    turns: "대화 글",
    output: "출력 글",
    usage: { input: 800, cacheWrite: 0, cacheRead: 0, output: 300 },
    latencyMs: 4200,
  });
  const replyCallId = recordLlmCall({
    purpose: "reply",
    model: "claude-sonnet-5",
    characterId,
    chatId: CHAT_ID,
    system: [],
    turns: "",
    latencyMs: 100,
  });
  afterNightlyTrace(g, out, snap, "ok: 안부 문안");

  const head = parentOf("2026-09-07");
  assert.ok(head);
  assert.ok(
    head.text.includes(
      "*침묵 5일째(checkin)* — 각본은 만들지 않았다 — 저녁 안부 문안만",
    ),
  );

  const children = childrenOf("2026-09-07");
  assert.deepEqual(
    children.map((c) => c.kind),
    [
      "nightly_send",
      "nightly_call_diary",
      "nightly_call_prompt",
      "nightly_call_output",
    ],
  );
  assert.equal(
    children[0].text,
    [
      "선톡 문안",
      "*9/8(화) 안부 선톡 문안* · 발송 창 19:00~21:00",
      "> 잘 지내요?",
    ].join("\n"),
  );
  assert.match(
    children[1].text,
    new RegExp(
      `^:brain: \\*일기\\* · 호출 #${diaryCallId} · \\d{2}:\\d{2}:\\d{2} · opus-4-8 · 4\\.2초\\n\\*토큰\\* 입력 800 · 출력 300$`,
    ),
  );
  assert.equal(
    children[2].text,
    [
      `호출 #${diaryCallId} 프롬프트`,
      "```",
      "시스템 글",
      "",
      "───",
      "",
      "대화 글",
      "```",
    ].join("\n"),
  );
  assert.equal(
    children[3].text,
    [`호출 #${diaryCallId} 출력`, "```", "출력 글", "```"].join("\n"),
  );

  const traced = (id: number): number =>
    (
      db.prepare(`SELECT traced FROM llm_calls WHERE id = ?`).get(id) as {
        traced: number;
      }
    ).traced;
  assert.equal(traced(diaryCallId), 1);
  assert.equal(traced(replyCallId), 0);
});
