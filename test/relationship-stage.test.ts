// 관계 단계의 문턱 계산과 전이 판정을 검사한다 — 모델은 부르지 않는다.
//
// 앞부분은 순수 계산이다. 05:00 경계로 날을 묶어 세는지, 최소 체류가 하한으로 남는지, 표본이
// 없는 수는 미충족으로 두는지, 마음 확인 사건을 양쪽 방향으로 읽는지, 시도할 수 추천이 점수와
// 어제 쓴 수와 탐색일을 규칙대로 섞는지를 본다. 뒷부분은 임시 DB 위에서 저장 자리를 돌린다 —
// 문턱이 찼고 모델이 넘기자고 했을 때만 단계가 오르는지, 처음 후보를 확정·취소하고 상대가 먼저
// 한 처음을 더하는지, 3→4는 마음 확인 처음이 확정돼야 하는지, 의도는 오늘 것만 적고 고백 차례는
// 수 없이 자리만 남기는지를 잡는다.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

const {
  db,
  logMessage,
  insertFirst,
  getConfirmedFirsts,
  getUnconfirmedFirsts,
  insertRelationshipSignal,
  getRelationshipIntent,
  getStage,
  raiseStage,
  saveReactionScore,
} = await import("../src/db.js");
const { createFixtureCharacter } =
  await import("../src/eval/fixture-character.js");
const {
  applyRelationOutput,
  confessionDueOf,
  confessionExchangeOf,
  countStageValues,
  evaluateThreshold,
  gatherRelation,
  isExploreDay,
  moveCandidates,
  rapportMoves,
} = await import("../src/relationship-stage.js");
const { STAGE_1_TO_2, STAGE_2_TO_3 } = await import("../src/thresholds.js");

type FirstRow = import("../src/db.js").FirstRow;
type ReactionScoreRow = import("../src/db.js").ReactionScoreRow;
type RelationshipSignalRow = import("../src/db.js").RelationshipSignalRow;
type StageCounts = import("../src/relationship-stage.js").StageCounts;
type NightlyRelation = import("../src/relationship-stage.js").NightlyRelation;
type RelationContext = import("../src/relationship-stage.js").RelationContext;

after(() => {
  db.close();
});

// ── 순수 계산 ─────────────────────────────────────────────────────────────────

const counts = (over: Partial<StageCounts> = {}): StageCounts => ({
  stayDays: 0,
  talkedDays: 0,
  userFirstDays: 0,
  selfStoryDays: 0,
  askedCharDays: 0,
  affectionCount: 0,
  stageMoveAvg: null,
  stageScorePositive: null,
  confessionExchange: false,
  ...over,
});

let signalSeq = 0;
const signal = (
  at: string,
  over: Partial<RelationshipSignalRow> = {},
): RelationshipSignalRow => ({
  id: ++signalSeq,
  character_id: 1,
  chat_id: "c",
  at,
  message_id: null,
  opened_self: 0,
  asked_about_char: 0,
  said_affection: 0,
  prev_move: null,
  move_reaction: null,
  call_id: null,
  ...over,
});

const score = (
  move: ReactionScoreRow["move"],
  value: number,
  samples: number,
): ReactionScoreRow => ({
  chat_id: "c",
  move,
  score: value,
  sample_count: samples,
  updated_at: "2026-09-09 05:00:00",
});

const first = (
  kind: FirstRow["kind"],
  by: FirstRow["by"],
  happenedAt: string,
): FirstRow => ({
  id: 1,
  character_id: 1,
  chat_id: "c",
  kind,
  by,
  happened_at: happenedAt,
  message_id: null,
  call_id: null,
  confirmed: 1,
});

test("1→2 문턱은 네 조건이 다 차야 하고 최소 체류는 하한이다", () => {
  const full = counts({
    stayDays: STAGE_1_TO_2.stayDays,
    talkedDays: 5,
    userFirstDays: 2,
    selfStoryDays: 2,
  });
  const t = evaluateThreshold(1, full);
  assert.equal(t.from, 1);
  assert.equal(t.to, 2);
  assert.equal(t.met, true);
  assert.deepEqual(
    t.conditions.map((c) => c.key),
    ["stay_days", "talked_days", "user_first_days", "self_story_days"],
  );
  // 다른 조건이 다 차도 체류 일수가 모자라면 안 찬다
  const early = evaluateThreshold(1, { ...full, stayDays: STAGE_1_TO_2.stayDays - 1 });
  assert.equal(early.met, false);
  assert.deepEqual(
    early.conditions.filter((c) => !c.met).map((c) => c.key),
    ["stay_days"],
  );
});

test("2→3 문턱은 표본이 없는 수 평균을 미충족으로 두고 0이면 찬 것으로 본다", () => {
  const base = counts({
    stayDays: STAGE_2_TO_3.stayDays,
    askedCharDays: 3,
    affectionCount: 1,
  });
  const none = evaluateThreshold(2, base);
  assert.equal(none.met, false);
  const avg = none.conditions.find((c) => c.key === "stage_move_avg");
  assert.ok(avg);
  assert.equal(avg.value, null);
  assert.equal(avg.met, false);

  const zero = evaluateThreshold(2, { ...base, stageMoveAvg: 0 });
  assert.equal(zero.met, true);
  const rounded = evaluateThreshold(2, { ...base, stageMoveAvg: 0.123456 });
  assert.equal(
    rounded.conditions.find((c) => c.key === "stage_move_avg")?.value,
    0.12,
  );
});

test("3→4는 마음 확인 사건 하나로 정해지고 4단계는 다음 문턱이 없다", () => {
  const no = evaluateThreshold(3, counts());
  assert.equal(no.met, false);
  assert.equal(no.conditions[0].key, "confession_exchange");
  assert.equal(no.conditions[0].need, true);
  const yes = evaluateThreshold(3, counts({ confessionExchange: true }));
  assert.equal(yes.met, true);
  assert.equal(yes.to, 4);
  const last = evaluateThreshold(4, counts({ stayDays: 100 }));
  assert.equal(last.to, null);
  assert.equal(last.met, false);
  assert.deepEqual(last.conditions, []);
});

test("셈은 05:00 경계로 날을 묶고 그날 첫 메시지가 유저 것인 날만 먼저 건 날로 센다", () => {
  const c = countStageValues({
    stage: 1,
    stageSince: "2026-09-05",
    today: "2026-09-09",
    messages: [
      // 9/5 — 캐릭터 선톡 뒤 유저 답: 대화한 날이지만 먼저 건 날은 아니다
      { role: "assistant", sent_at: "2026-09-05 08:00:00" },
      { role: "user", sent_at: "2026-09-05 08:30:00" },
      // 9/6 새벽 2시는 아직 9/5다 — 새 날로 세지 않는다
      { role: "user", sent_at: "2026-09-06 02:00:00" },
      // 9/6 — 유저가 먼저
      { role: "user", sent_at: "2026-09-06 21:00:00" },
      { role: "assistant", sent_at: "2026-09-06 21:05:00" },
      // 9/7 — 캐릭터만 말한 날은 대화한 날이 아니다
      { role: "assistant", sent_at: "2026-09-07 09:00:00" },
      // 9/8 05:00 정각은 9/8이다 — 유저가 먼저
      { role: "user", sent_at: "2026-09-08 05:00:00" },
    ],
    signals: [
      signal("2026-09-05 08:31:00", { opened_self: 1 }),
      signal("2026-09-06 02:01:00", { opened_self: 1, said_affection: 1 }),
      signal("2026-09-06 21:01:00", { asked_about_char: 1, said_affection: 1 }),
    ],
    scores: [],
    firsts: [],
    usedMoves: [],
  });
  assert.equal(c.stayDays, 4);
  assert.equal(c.talkedDays, 3);
  assert.equal(c.userFirstDays, 2);
  // 9/5에 두 번 열었어도 하루다
  assert.equal(c.selfStoryDays, 1);
  assert.equal(c.askedCharDays, 1);
  // 호감 표현은 행 수다
  assert.equal(c.affectionCount, 2);
  assert.equal(c.stageMoveAvg, null);
  assert.equal(c.stageScorePositive, null);
});

test("수 평균은 이 단계에서 열린 수 가운데 표본이 있는 것만 넣고 쓴 수의 부호를 따로 본다", () => {
  const scores = [
    score("remember", 0.5, 2),
    score("laugh", -0.1, 1),
    score("notice", 0.9, 0), // 표본 0은 빠진다
    score("sudden_ping", 1, 3), // 2단계 수는 1단계 평균에 안 들어간다
  ];
  const c = countStageValues({
    stage: 1,
    stageSince: "2026-09-01",
    today: "2026-09-01",
    messages: [],
    signals: [],
    scores,
    firsts: [],
    usedMoves: ["laugh"],
  });
  assert.equal(c.stayDays, 0);
  assert.equal(c.stageMoveAvg, 0.2);
  assert.equal(c.stageScorePositive, false);
  const c2 = countStageValues({
    stage: 2,
    stageSince: "2026-09-01",
    today: "2026-09-03",
    messages: [],
    signals: [],
    scores,
    firsts: [],
    usedMoves: ["remember", "sudden_ping"],
  });
  assert.equal(c2.stageMoveAvg, 1);
  assert.equal(c2.stageScorePositive, true);
});

test("마음 확인 사건은 캐릭터가 먼저면 그 뒤 같은 날 받은 판정, 유저가 먼저면 같은 날 호감 판정이다", () => {
  const byChar = [first("first_confession", "character", "2026-09-08 22:00:00")];
  assert.equal(confessionExchangeOf(byChar, []), false);
  assert.equal(
    confessionExchangeOf(byChar, [
      signal("2026-09-08 22:10:00", { prev_move: "only_you", move_reaction: "accepted" }),
    ]),
    true,
  );
  assert.equal(
    confessionExchangeOf(byChar, [signal("2026-09-09 01:30:00", { said_affection: 1 })]),
    true,
    "새벽 1시는 같은 논리일이다",
  );
  assert.equal(
    confessionExchangeOf(byChar, [signal("2026-09-08 21:00:00", { said_affection: 1 })]),
    false,
    "고백보다 앞선 판정은 받은 것이 아니다",
  );
  assert.equal(
    confessionExchangeOf(byChar, [signal("2026-09-09 09:00:00", { said_affection: 1 })]),
    false,
    "다음 날은 사건이 아니다",
  );
  const byUser = [first("first_confession", "user", "2026-09-08 22:00:00")];
  assert.equal(
    confessionExchangeOf(byUser, [signal("2026-09-08 22:00:00", { said_affection: 1 })]),
    true,
  );
  assert.equal(
    confessionExchangeOf(byUser, [signal("2026-09-08 23:00:00", { move_reaction: "accepted" })]),
    false,
  );
  assert.equal(
    confessionExchangeOf([first("first_laugh", "user", "2026-09-08 22:00:00")], []),
    false,
  );
});

test("고백 차례는 3단계에서 사건 없이 10일 지나고 점수가 양수일 때, 아니면 20일 지났을 때다", () => {
  assert.equal(confessionDueOf(3, counts({ stayDays: 10, stageScorePositive: true })), true);
  assert.equal(confessionDueOf(3, counts({ stayDays: 10, stageScorePositive: null })), false);
  assert.equal(confessionDueOf(3, counts({ stayDays: 19, stageScorePositive: false })), false);
  assert.equal(confessionDueOf(3, counts({ stayDays: 20, stageScorePositive: false })), true);
  assert.equal(
    confessionDueOf(3, counts({ stayDays: 30, stageScorePositive: true, confessionExchange: true })),
    false,
  );
  assert.equal(confessionDueOf(2, counts({ stayDays: 30, stageScorePositive: true })), false);
});

test("탐색일은 날짜 일련번호가 5로 나누어떨어지는 날이라 다시 돌려도 같다", () => {
  assert.equal(isExploreDay("2026-09-09"), true);
  assert.equal(isExploreDay("2026-09-10"), false);
  assert.equal(isExploreDay("2026-09-14"), true);
});

test("시도할 수 추천은 점수순에 어제 쓴 수를 뒤로 보내고 낮은 점수에 표본이 찬 수를 뺀다", () => {
  const scores = [
    score("remember", 0.5, 4),
    score("laugh", -0.5, 3), // 낮고 표본이 차서 뺀다
    score("anticipate", -0.5, 2), // 낮지만 표본이 모자라 남긴다
    score("notice", 0.8, 1),
  ];
  assert.deepEqual(moveCandidates(1, scores, ["notice"], "2026-09-10"), [
    "remember",
    "scene",
    "anticipate",
    "notice",
  ]);
  // 점수가 없는 수는 0으로 두고 열린 순서를 지킨다
  assert.deepEqual(moveCandidates(1, [], [], "2026-09-10"), [
    "remember",
    "laugh",
    "anticipate",
    "scene",
    "notice",
  ]);
  // 탐색일에는 표본이 가장 적은 수가 맨 앞이다 — scene은 표본 0
  assert.deepEqual(moveCandidates(1, scores, ["notice"], "2026-09-09"), [
    "scene",
    "remember",
    "anticipate",
    "notice",
  ]);
  // 한 번 열린 수는 그 뒤 단계에서도 후보다 — 2단계 수가 1단계 수 뒤에 붙는다
  assert.deepEqual(moveCandidates(2, [], [], "2026-09-10"), [
    "remember",
    "laugh",
    "anticipate",
    "scene",
    "notice",
    "sudden_ping",
    "nickname",
    "weakness",
  ]);
});

test("잘 통하는 수는 점수와 표본이 둘 다 찬 것만이다", () => {
  assert.deepEqual(
    rapportMoves([
      score("remember", 0.3, 3),
      score("laugh", 0.9, 2),
      score("notice", 0.2, 10),
      score("scene", 0.6, 5),
    ]),
    ["remember", "scene"],
  );
});

// ── 저장 자리 — 임시 DB ────────────────────────────────────────────────────────

const CHAT = "chat-stage";
const charId = createFixtureCharacter(CHAT);
const DIARY = "2026-09-09";
const TODAY = "2026-09-10";

db.prepare(`UPDATE relationships SET stage_since = ? WHERE character_id = ?`).run(
  "2026-09-01",
  charId,
);

const relation = (over: Partial<NightlyRelation> = {}): NightlyRelation => ({
  stageNo: 1,
  stageSince: "2026-09-01",
  stayDays: 9,
  threshold: { from: 1, to: 2, met: false, conditions: [] },
  firstsDone: [],
  firstsOpen: [],
  firstsPending: [],
  moveCandidates: [],
  rapportMoves: [],
  yesterdayIntent: null,
  yesterdayMoves: [],
  confessionDue: false,
  ...over,
});

const ctx = (rel: NightlyRelation, diaryDate = DIARY, today = TODAY): RelationContext => ({
  characterId: charId,
  chatId: CHAT,
  diaryDate,
  today,
  relation: rel,
});

const NOW = "2026-09-10 05:10:00";

test("처음 후보는 모델이 지운 것만 지우고 나머지는 확정하며 상대가 먼저 한 처음을 더한다", () => {
  const laugh = insertFirst({
    characterId: charId,
    chatId: CHAT,
    kind: "first_laugh",
    by: "character",
    happenedAt: "2026-09-09 21:00:00",
  });
  const remember = insertFirst({
    characterId: charId,
    chatId: CHAT,
    kind: "first_remember",
    by: "character",
    happenedAt: "2026-09-09 20:00:00",
  });
  assert.ok(laugh !== undefined && remember !== undefined);
  logMessage(CHAT, charId, "user", "오늘 좀 힘들었어", "2026-09-09 22:10:00");
  logMessage(CHAT, charId, "assistant", "무슨 일 있었어?", "2026-09-09 22:12:00");

  const r = applyRelationOutput(
    ctx(
      relation({
        firstsPending: [
          { id: laugh, kind: "first_laugh", by: "character", happenedAt: "2026-09-09 21:00:00" },
          { id: remember, kind: "first_remember", by: "character", happenedAt: "2026-09-09 20:00:00" },
        ],
        firstsOpen: ["first_self_story", "first_waited"],
      }),
    ),
    {
      firsts: [
        { kind: "first_laugh", keep: false },
        { kind: "first_self_story", by: "user", keep: true },
        // 2단계 처음은 1단계에서 더하지 않는다
        { kind: "first_nickname", by: "user", keep: true },
        // 모르는 코드는 무시한다
        { kind: "first_unknown", keep: true },
      ],
    },
    NOW,
  );
  assert.deepEqual(r.cancelled, ["first_laugh"]);
  assert.deepEqual(r.confirmed, ["first_remember"]);
  assert.deepEqual(r.userAdded, ["first_self_story"]);
  assert.equal(r.advanced, null);
  assert.equal(r.intentSaved, false);

  const confirmed = getConfirmedFirsts(charId);
  assert.deepEqual(
    confirmed.map((f) => [f.kind, f.by, f.happened_at]).sort(),
    [
      ["first_remember", "character", "2026-09-09 20:00:00"],
      ["first_self_story", "user", "2026-09-09 22:10:00"],
    ].sort(),
  );
  assert.deepEqual(getUnconfirmedFirsts(charId), []);
});

test("문턱이 안 찼으면 넘기자는 출력을 받아도 단계는 그대로다", () => {
  const r = applyRelationOutput(
    ctx(relation()),
    { advance: { go: true, basis: "느낌이 그렇다" } },
    NOW,
  );
  assert.equal(r.advanced, null);
  assert.match(r.advanceRejected ?? "", /문턱이 안 찼는데/);
  assert.equal(getStage(charId)?.stage_no, 1);
});

test("문턱이 찼고 모델이 넘기자고 하면 한 단계 오르고 시작일은 오늘이다", () => {
  const met = relation({
    threshold: { from: 1, to: 2, met: true, conditions: [] },
  });
  // 찼어도 모델이 아니라고 하면 안 넘긴다
  const hold = applyRelationOutput(ctx(met), { advance: { go: false } }, NOW);
  assert.equal(hold.advanced, null);
  assert.equal(hold.advanceRejected, null);
  assert.equal(getStage(charId)?.stage_no, 1);

  const r = applyRelationOutput(
    ctx(met),
    { advance: { go: true, basis: "  근황을  먼저 묻는다 " } },
    NOW,
  );
  assert.deepEqual(r.advanced, { from: 1, to: 2, basis: "근황을 먼저 묻는다" });
  assert.deepEqual(getStage(charId), { stage_no: 2, stage_since: TODAY });

  // 수집 때 단계로 다시 부르면 건너뛴다 — 두 단계를 한 번에 올리지 않는다
  const again = applyRelationOutput(ctx(met), { advance: { go: true } }, NOW);
  assert.equal(again.advanced, null);
  assert.match(again.advanceRejected ?? "", /단계가 달라/);
  assert.equal(getStage(charId)?.stage_no, 2);
});

test("3→4는 마음 확인 처음이 확정돼야 오르고 그 확정은 같은 밤에 할 수 있다", () => {
  const CHAT3 = "chat-stage-3";
  const id3 = createFixtureCharacter(CHAT3);
  assert.equal(raiseStage(id3, 3, "2026-08-20"), true);
  const rel3 = relation({
    stageNo: 3,
    stageSince: "2026-08-20",
    stayDays: 21,
    threshold: { from: 3, to: 4, met: true, conditions: [] },
  });
  const g3: RelationContext = { ...ctx(rel3), characterId: id3, chatId: CHAT3 };

  const noFirst = applyRelationOutput(g3, { advance: { go: true } }, NOW);
  assert.equal(noFirst.advanced, null);
  assert.match(noFirst.advanceRejected ?? "", /마음 확인 처음/);
  assert.equal(getStage(id3)?.stage_no, 3);

  const confession = insertFirst({
    characterId: id3,
    chatId: CHAT3,
    kind: "first_confession",
    by: "character",
    happenedAt: "2026-09-09 23:00:00",
  });
  assert.ok(confession !== undefined);
  const r = applyRelationOutput(
    {
      ...g3,
      relation: {
        ...rel3,
        firstsPending: [
          { id: confession, kind: "first_confession", by: "character", happenedAt: "2026-09-09 23:00:00" },
        ],
      },
    },
    { firsts: [{ kind: "first_confession", keep: true }], advance: { go: true, basis: "받았다" } },
    NOW,
  );
  assert.deepEqual(r.confirmed, ["first_confession"]);
  assert.deepEqual(r.advanced, { from: 3, to: 4, basis: "받았다" });
  assert.deepEqual(getStage(id3), { stage_no: 4, stage_since: TODAY });
});

test("의도는 오늘 것만 적고 고백 차례의 마음 확인은 수 없이 자리만 남긴다", () => {
  const stale = applyRelationOutput(
    ctx(relation({ stageNo: 2 }), "2026-09-07", TODAY),
    { intent: { dig: "러닝 얘기", share: "요즘 잠", move: "sudden_ping", lead_tone: "direct", thread: "저녁" } },
    NOW,
  );
  assert.equal(stale.intentSaved, false);
  assert.equal(getRelationshipIntent(charId, TODAY), undefined);

  const r = applyRelationOutput(
    ctx(relation({ stageNo: 2 })),
    {
      intent: {
        dig: "  어제 말한  러닝 ",
        share: null,
        move: "마음 확인",
        move_note: null,
        lead_tone: "hidden_love",
        thread: "저녁에 이어서",
        basis: { dig: "21:10 러닝 얘기" },
      },
    },
    NOW,
  );
  assert.equal(r.intentSaved, true);
  const row = getRelationshipIntent(charId, TODAY);
  assert.ok(row);
  assert.equal(row.dig, "어제 말한 러닝");
  assert.equal(row.share, null);
  assert.equal(row.move, null);
  assert.equal(row.move_note, "마음 확인");
  assert.equal(row.lead_tone, null);
  assert.equal(row.thread, "저녁에 이어서");
  assert.equal(row.basis_json, JSON.stringify({ dig: "21:10 러닝 얘기" }));

  // 같은 날 다시 적으면 덮어쓰고 수 코드와 결 코드는 그대로 들어간다
  const r2 = applyRelationOutput(
    ctx(relation({ stageNo: 2 })),
    { intent: { move: "sudden_ping", move_note: "점심에", lead_tone: "tease_sincere" } },
    NOW,
  );
  assert.equal(r2.intentSaved, true);
  const row2 = getRelationshipIntent(charId, TODAY);
  assert.equal(row2?.move, "sudden_ping");
  assert.equal(row2?.move_note, "점심에");
  assert.equal(row2?.lead_tone, "tease_sincere");
  assert.equal(row2?.dig, null);

  // 네 줄이 다 비면 안 적는다
  const empty = applyRelationOutput(
    ctx(relation({ stageNo: 2 })),
    { intent: { lead_tone: "direct", basis: { dig: "x" } } },
    NOW,
  );
  assert.equal(empty.intentSaved, false);
});

test("수집은 단계 창의 값을 세고 어제 후보·어제 쓴 수·의도를 함께 돌려준다", () => {
  const CHATG = "chat-stage-gather";
  const idG = createFixtureCharacter(CHATG);
  db.prepare(`UPDATE relationships SET stage_since = ? WHERE character_id = ?`).run(
    "2026-09-05",
    idG,
  );
  // 9/5·9/6은 유저가 먼저, 9/9는 캐릭터가 먼저 — 창 밖(9/4)은 안 센다
  logMessage(CHATG, idG, "user", "안녕", "2026-09-04 20:00:00");
  logMessage(CHATG, idG, "user", "안녕", "2026-09-05 20:00:00");
  logMessage(CHATG, idG, "user", "뭐해", "2026-09-06 20:00:00");
  logMessage(CHATG, idG, "assistant", "일어났어?", "2026-09-09 08:00:00", {
    move: "notice",
  });
  logMessage(CHATG, idG, "user", "응", "2026-09-09 08:10:00");
  logMessage(CHATG, idG, "assistant", "그때 얘기", "2026-09-09 21:00:00", {
    move: "remember",
  });
  logMessage(CHATG, idG, "user", "기억하네", "2026-09-09 21:05:00");
  insertRelationshipSignal({
    characterId: idG,
    chatId: CHATG,
    at: "2026-09-09 08:11:00",
    openedSelf: false,
    askedAboutChar: true,
    saidAffection: false,
    prevMove: "notice",
    moveReaction: "ignored",
  });
  insertRelationshipSignal({
    characterId: idG,
    chatId: CHATG,
    at: "2026-09-09 21:06:00",
    openedSelf: true,
    askedAboutChar: false,
    saidAffection: false,
    prevMove: "remember",
    moveReaction: "accepted",
  });
  const pendingId = insertFirst({
    characterId: idG,
    chatId: CHATG,
    kind: "first_remember",
    by: "character",
    happenedAt: "2026-09-09 21:00:00",
  });
  // 오늘 새벽 이후 것은 아직 후보가 아니다
  insertFirst({
    characterId: idG,
    chatId: CHATG,
    kind: "first_laugh",
    by: "character",
    happenedAt: "2026-09-10 06:00:00",
  });
  saveReactionScore(CHATG, "remember", 0.6, 3, NOW);

  const rel = gatherRelation(idG, CHATG, DIARY, TODAY);
  assert.equal(rel.stageNo, 1);
  assert.equal(rel.stageSince, "2026-09-05");
  assert.equal(rel.stayDays, 5);
  assert.equal(rel.threshold.met, false);
  const byKey = Object.fromEntries(rel.threshold.conditions.map((c) => [c.key, c.value]));
  assert.deepEqual(byKey, {
    stay_days: 5,
    talked_days: 3,
    user_first_days: 2,
    self_story_days: 1,
  });
  assert.deepEqual(rel.firstsDone, []);
  assert.deepEqual(rel.firstsPending, [
    { id: pendingId, kind: "first_remember", by: "character", happenedAt: "2026-09-09 21:00:00" },
  ]);
  // 후보는 열린 처음에서 빠지고, 다음 단계 처음은 아직 안 열린다
  assert.deepEqual(rel.firstsOpen, ["first_self_story", "first_laugh", "first_waited"]);
  assert.deepEqual(rel.yesterdayMoves, [
    { move: "notice", reaction: "ignored" },
    { move: "remember", reaction: "accepted" },
  ]);
  // 어제 쓴 수 둘은 뒤로 간다. 9/9는 탐색일이라 표본이 가장 적은 laugh가 맨 앞이다
  assert.deepEqual(rel.moveCandidates, [
    "laugh",
    "anticipate",
    "scene",
    "remember",
    "notice",
  ]);
  assert.deepEqual(rel.rapportMoves, ["remember"]);
  assert.equal(rel.yesterdayIntent, null);
  assert.equal(rel.confessionDue, false);
});
