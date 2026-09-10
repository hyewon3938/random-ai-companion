// 새벽 정리 전후 값의 차이가 트레이스 게시함(trace_events)에 어떤 글로 쌓이는지 검사한다 — 모델은 부르지 않는다.
//
// beforeNightlyTrace로 스냅숏을 뜨고, 반영 트랜잭션이 할 일을 손으로 DB에 쓴 뒤 afterNightlyTrace를
// 불러 본문 한 행과 스레드 자식(기억·진행 중인 일·일기·선톡 문안·호출 원문)의 문안을 본다.
// 단계 전이와 처음 확정은 스레드 밖 게시로도 나가서 그 행들을 따로 센다.
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
  confirmFirst,
  deleteUnconfirmedFirst,
  getConfirmedFirsts,
  getRelationship,
  insertDiary,
  insertFirst,
  insertScheduledSend,
  markScheduleKnown,
  raiseStage,
  recordLlmCall,
  saveUserProfile,
  setScheduleTimeHint,
  setTags,
  updateRelationshipNotes,
} = await import("../src/db.js");
const { beforeNightlyTrace, afterNightlyTrace } =
  await import("../src/nightly-trace.js");
const { saveMemory } = await import("../src/memory.js");
const { createFixtureCharacter } =
  await import("../src/eval/fixture-character.js");

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
  relation: {
    stageNo: 1,
    stageSince: "2026-09-01",
    stayDays: 0,
    threshold: { from: 1, to: 2, met: false, conditions: [] },
    firstsDone: [],
    firstsOpen: [],
    firstsPending: [],
    moveCandidates: [],
    rapportMoves: [],
    yesterdayIntent: null,
    yesterdayMoves: [],
    confessionDue: false,
  },
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
  workFactsNeeded: [],
  workFactsKnown: [],
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

const standaloneOf = (kinds: string[]): EventRow[] =>
  db
    .prepare(
      `SELECT ${COLS} FROM trace_events
        WHERE kind IN (${kinds.map(() => "?").join(",")}) AND parent_key IS NULL
        ORDER BY id`,
    )
    .all(...kinds) as EventRow[];

const childrenOf = (diaryDate: string): EventRow[] =>
  db
    .prepare(
      `SELECT ${COLS} FROM trace_events WHERE parent_key = ? ORDER BY id`,
    )
    .all(parentKeyOf(diaryDate)) as EventRow[];

// 본문 첫 줄에는 지금 시각이 들어가서 날짜 표시까지만 맞춰 본다.
const HEAD_LINE =
  /^:crescent_moon: \*(\d+\/\d+\([일월화수목금토]\)) 새벽 정리\* · \d{2}:\d{2}:\d{2}\n\n/;

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
  // 관계 단계 절은 바뀐 것이 없어도 단계와 문턱 한 줄을 늘 적는다.
  assert.equal(
    head.text.slice(m[0].length),
    [
      "> ok: 일기 저장",
      "*오늘 메모* 없음",
      "*각본과 달라진 하루* 없음",
      "*관계 단계*\n> 1단계 2026-09-01부터 0일 · 다음 문턱 1→2 안 찼음",
    ].join("\n\n"),
  );
  assert.equal(childrenOf("2026-09-01").length, 0);
  assert.equal(standaloneOf(["stage_change", "first_event"]).length, 0);
});

test("단계가 오르고 처음이 확정·취소되면 본문의 관계 단계 절과 스레드 밖 게시가 함께 나온다", () => {
  // 어제 답장이 표시한 처음 후보 둘 — 하나는 확정, 하나는 취소된다.
  const laugh = insertFirst({
    characterId,
    chatId: CHAT_ID,
    kind: "first_laugh",
    by: "character",
    happenedAt: "2026-09-08 21:00:00",
    messageId: 41,
  });
  const remember = insertFirst({
    characterId,
    chatId: CHAT_ID,
    kind: "first_remember",
    by: "character",
    happenedAt: "2026-09-08 20:00:00",
  });
  assert.ok(laugh !== undefined && remember !== undefined);
  const g = gathered({
    diaryDate: "2026-09-08",
    today: "2026-09-09",
    todayLabel: "9/9(수)",
    relation: {
      stageNo: 1,
      stageSince: "2026-09-01",
      stayDays: 8,
      threshold: {
        from: 1,
        to: 2,
        met: true,
        conditions: [
          { key: "stay_days", name: "체류 일수", value: 8, need: 5, met: true },
          {
            key: "talked_days",
            name: "대화한 날",
            value: 6,
            need: 5,
            met: true,
          },
          {
            key: "user_first_days",
            name: "유저가 먼저 건 날",
            value: 3,
            need: 2,
            met: true,
          },
          {
            key: "self_story_days",
            name: "유저가 자기 얘기를 연 날",
            value: 2,
            need: 2,
            met: true,
          },
        ],
      },
      firstsDone: [],
      firstsOpen: ["first_self_story", "first_waited"],
      firstsPending: [
        {
          id: laugh,
          kind: "first_laugh",
          by: "character",
          happenedAt: "2026-09-08 21:00:00",
        },
        {
          id: remember,
          kind: "first_remember",
          by: "character",
          happenedAt: "2026-09-08 20:00:00",
        },
      ],
      moveCandidates: ["remember", "notice"],
      rapportMoves: [],
      yesterdayIntent: null,
      yesterdayMoves: [],
      confessionDue: false,
    },
  });
  const out: NightlyOutput = {
    entry: entry("웃긴 하루"),
    extract: {
      memories: [],
      schedules: [],
      relation: {
        advance: { go: true, basis: "근황을 먼저 묻고 자기 얘기를 꺼낸다" },
        firsts: [
          { kind: "first_laugh", keep: true },
          { kind: "first_remember", keep: false },
          { kind: "first_self_story", by: "user", keep: true },
        ],
        intent: {
          dig: "어제 말한 러닝",
          share: "요즘 잠이 얕다",
          move: "remember",
          move_note: "저녁에 지나가듯",
          lead_tone: "silent_care",
          thread: "퇴근길",
          basis: { dig: "21:10 러닝 얘기" },
        },
      },
    },
  };
  const snap = beforeNightlyTrace(g, out);
  assert.ok(snap);

  // 반영 트랜잭션이 할 일을 손으로 한다 — 확정·취소·상대가 먼저 한 처음·단계 올림.
  confirmFirst(laugh);
  deleteUnconfirmedFirst(remember);
  const selfStory = insertFirst({
    characterId,
    chatId: CHAT_ID,
    kind: "first_self_story",
    by: "user",
    happenedAt: "2026-09-08 22:10:00",
  });
  assert.ok(selfStory !== undefined);
  confirmFirst(selfStory);
  assert.equal(raiseStage(characterId, 2, "2026-09-09"), true);

  afterNightlyTrace(
    g,
    out,
    snap,
    "ok: 일기 저장, 단계 1→2, 처음 확정 1건, 처음 취소 1건, 상대가 먼저 한 처음 1건, 오늘 의도",
  );

  const head = parentOf("2026-09-08");
  assert.ok(head);
  const block = head.text
    .split("\n\n")
    .find((p) => p.startsWith("*관계 단계*"));
  assert.ok(block);
  assert.equal(
    block,
    [
      "*관계 단계*",
      "> 1단계 2026-09-01부터 8일 · 다음 문턱 1→2 찼음",
      "> 조건: 체류 일수 8/5 찼음 · 대화한 날 6/5 찼음 · 유저가 먼저 건 날 3/2 찼음 · 유저가 자기 얘기를 연 날 2/2 찼음",
      "> 넘김 판단: 넘긴다 — 근황을 먼저 묻고 자기 얘기를 꺼낸다",
      "> *단계 전이* 1단계 → 2단계",
      "> 처음 확정: 웃기기 · 캐릭터 · 09-08 21:00 · 메시지 #41",
      "> 처음 취소: 기억해서 챙기기",
      "> 상대가 먼저 한 처음: 자기 얘기 · 유저 · 09-08 22:10",
      "> 오늘 의도: 파고들 것: 어제 말한 러닝 / 흘릴 내 얘기: 요즘 잠이 얕다 / 시도할 수: 기억해서 챙기기 저녁에 지나가듯, 앞세울 결은 말없이 챙김 / 이어갈 자리: 퇴근길",
      "> 의도 근거: dig=21:10 러닝 얘기",
    ].join("\n"),
  );

  const events = standaloneOf(["stage_change", "first_event"]);
  assert.deepEqual(
    events.map((e) => [e.kind, e.dedupe_key]),
    [
      ["stage_change", `stage:${characterId}:2`],
      ["first_event", `first:${characterId}:first_laugh:2026-09-08:confirm`],
      ["first_event", `first:${characterId}:first_remember:2026-09-08:cancel`],
      ["first_event", `first:${characterId}:first_self_story:2026-09-08:user`],
    ],
  );
  for (const e of events) {
    assert.equal(e.parent_key, null);
    assert.equal(e.thread_key, null);
  }
  const stage = events[0].text;
  assert.match(
    stage,
    /^:arrow_up: \*단계 전이\* 1단계 → 2단계 · \d{2}:\d{2}:\d{2}\n/,
  );
  assert.match(stage, /> 1단계에 2026-09-01부터 8일 머묾/);
  assert.match(stage, /> 근거: 근황을 먼저 묻고 자기 얘기를 꺼낸다$/);
  assert.match(
    events[1].text,
    /처음 확정\* 웃기기 · 캐릭터 · 09-08 21:00 · 메시지 #41 · 확정됨/,
  );
  assert.match(events[2].text, /처음 취소\* 기억해서 챙기기/);
  assert.match(
    events[3].text,
    /처음 확정\* 자기 얘기 · 유저 · 09-08 22:10 · 상대가 먼저 한 것/,
  );

  // 같은 밤을 다시 돌려도 같은 게시가 두 번 나가지 않는다.
  afterNightlyTrace(g, out, snap, "ok: 일기 저장");
  assert.equal(standaloneOf(["stage_change", "first_event"]).length, 4);
});

test("관계 절이 없는 회차의 후보 확정과, 후보를 지우고 같은 종류를 유저 쪽으로 새로 적은 밤이 게시된다", () => {
  const remember = insertFirst({
    characterId,
    chatId: CHAT_ID,
    kind: "first_remember",
    by: "character",
    happenedAt: "2026-09-10 20:00:00",
  });
  const waited = insertFirst({
    characterId,
    chatId: CHAT_ID,
    kind: "first_waited",
    by: "user",
    happenedAt: "2026-09-10 21:00:00",
  });
  assert.ok(remember !== undefined && waited !== undefined);
  const g = gathered({
    diaryDate: "2026-09-10",
    today: "2026-09-11",
    todayLabel: "9/11(금)",
    relation: {
      stageNo: 2,
      stageSince: "2026-09-09",
      stayDays: 2,
      threshold: { from: 2, to: 3, met: false, conditions: [] },
      firstsDone: [
        { kind: "first_laugh", by: "character", date: "2026-09-08" },
        { kind: "first_self_story", by: "user", date: "2026-09-08" },
      ],
      firstsOpen: [],
      firstsPending: [
        {
          id: remember,
          kind: "first_remember",
          by: "character",
          happenedAt: "2026-09-10 20:00:00",
        },
        {
          id: waited,
          kind: "first_waited",
          by: "user",
          happenedAt: "2026-09-10 21:00:00",
        },
      ],
      moveCandidates: [],
      rapportMoves: [],
      yesterdayIntent: null,
      yesterdayMoves: [],
      confessionDue: false,
    },
  });
  // 관계 절이 통째로 없는 출력 — 반영 자리는 후보를 그대로 확정한다.
  const out: NightlyOutput = {
    entry: entry("조용한 하루"),
    extract: { memories: [], schedules: [] },
  };
  const snap = beforeNightlyTrace(g, out);
  assert.ok(snap);

  // 반영 트랜잭션이 할 일을 손으로 한다 — 하나는 확정, 하나는 지우고 같은 종류를 유저 쪽 행으로.
  confirmFirst(remember);
  deleteUnconfirmedFirst(waited);
  const waitedByUser = insertFirst({
    characterId,
    chatId: CHAT_ID,
    kind: "first_waited",
    by: "user",
    happenedAt: "2026-09-10 21:30:00",
  });
  assert.ok(waitedByUser !== undefined);
  confirmFirst(waitedByUser);

  afterNightlyTrace(
    g,
    out,
    snap,
    "ok: 일기 저장, 처음 확정 1건, 처음 취소 1건, 상대가 먼저 한 처음 1건",
  );

  const head = parentOf("2026-09-10");
  assert.ok(head);
  const block = head.text
    .split("\n\n")
    .find((p) => p.startsWith("*관계 단계*"));
  assert.equal(
    block,
    [
      "*관계 단계*",
      "> 2단계 2026-09-09부터 2일 · 다음 문턱 2→3 안 찼음",
      "> 처음 확정: 기억해서 챙기기 · 캐릭터 · 09-10 20:00",
      "> 처음 취소: 기다렸다는 말",
      "> 상대가 먼저 한 처음: 기다렸다는 말 · 유저 · 09-10 21:30",
    ].join("\n"),
  );
  const events = standaloneOf(["first_event"]).filter((e) =>
    e.dedupe_key?.includes(":2026-09-10:"),
  );
  assert.deepEqual(
    events.map((e) => e.dedupe_key),
    [
      `first:${characterId}:first_remember:2026-09-10:confirm`,
      `first:${characterId}:first_waited:2026-09-10:cancel`,
      `first:${characterId}:first_waited:2026-09-10:user`,
    ],
  );
});

test("넘기자는 출력을 반영하지 않은 회차는 단계 그대로 줄과 결과 줄의 까닭이 함께 보인다", () => {
  // 앞 시험들이 확정해 둔 처음은 수집 값의 firstsDone에 들어 있어야 상대가 먼저 한 처음으로 다시 안 잡힌다.
  const g = gathered({
    diaryDate: "2026-09-11",
    today: "2026-09-12",
    todayLabel: "9/12(토)",
    relation: {
      stageNo: 1,
      stageSince: "2026-09-01",
      stayDays: 0,
      threshold: { from: 1, to: 2, met: false, conditions: [] },
      firstsDone: getConfirmedFirsts(characterId).map((f) => ({
        kind: f.kind,
        by: f.by,
        date: f.happened_at.slice(0, 10),
      })),
      firstsOpen: [],
      firstsPending: [],
      moveCandidates: [],
      rapportMoves: [],
      yesterdayIntent: null,
      yesterdayMoves: [],
      confessionDue: false,
    },
  });
  const out: NightlyOutput = {
    entry: entry("평범한 하루"),
    extract: {
      memories: [],
      schedules: [],
      relation: { advance: { go: true, basis: "느낌이 그렇다" } },
    },
  };
  const snap = beforeNightlyTrace(g, out);
  assert.ok(snap);
  afterNightlyTrace(
    g,
    out,
    snap,
    "ok: 2026-09-11 일기 응고 (대화 3개, 단계 전이 건너뜀(문턱이 안 찼는데 넘기자는 출력))",
  );
  const head = parentOf("2026-09-11");
  assert.ok(head);
  assert.match(head.text, /단계 전이 건너뜀\(문턱이 안 찼는데 넘기자는 출력\)/);
  const block = head.text
    .split("\n\n")
    .find((p) => p.startsWith("*관계 단계*"));
  assert.equal(
    block,
    [
      "*관계 단계*",
      "> 1단계 2026-09-01부터 0일 · 다음 문턱 1→2 안 찼음",
      "> 넘김 판단: 넘긴다 — 느낌이 그렇다",
      "> 단계는 그대로 — 반영 자리가 건너뜀, 까닭은 위 결과 줄에",
    ].join("\n"),
  );
  assert.equal(
    standaloneOf(["stage_change"]).some((e) =>
      e.dedupe_key?.endsWith(":2026-09-11"),
    ),
    false,
  );
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
      ["*상대 프로필 갱신* 1항목", "*하는 일*", "> {+디자이너+}"].join("\n"),
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
        {
          who: "char",
          date: "2026-09-13",
          time_hint: null,
          content: "청주 내려감",
        },
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
