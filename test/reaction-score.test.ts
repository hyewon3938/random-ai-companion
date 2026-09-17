// 반응 점수가 relationship.md 「반응 점수」 절에 적힌 대로 매겨지고 쌓이는지 검사한다 — 모델은 부르지 않는다.
//
// 앞부분은 순수 계산이다. 신호 7개의 경계값과 가중치, 답 없는 표본이 −0.40인지, 평소 값 표본이
// 20건 아래면 속도·길이를 0으로 두는지, 지수 이동 평균이 표본 3개를 넘기면 α를 바꾸는지, 턴 묶기와
// 평소 값이 같은 날·6시간 규칙을 따르는지를 본다. 뒷부분은 임시 DB 위에서 어제 대화로 표본을 세고,
// 수집이 점수를 얹어 보되 일기가 있는 날은 얹지 않는지, 저장이 표본이 있던 플러팅만 적는지,
// 캐릭터를 바꿔도 같은 대화방의 점수가 이어지는지, 새벽 정리 게시의 점수 변화 줄을 잡는다.
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
  getReactionScores,
  insertDiary,
  insertRelationshipSignal,
  logMessage,
  recordLlmCall,
  saveReactionScore,
  setCallContext,
} = await import("../src/db.js");
const { createFixtureCharacter } =
  await import("../src/eval/fixture-character.js");
const {
  applySamples,
  baselineOf,
  collectReactionSamples,
  emaStep,
  sampleValue,
  scoreSignals,
  userTurnsOf,
} = await import("../src/reaction-score.js");
const { applyRelationOutput, gatherRelation } =
  await import("../src/relationship-stage.js");
const { scoreChangeLine } = await import("../src/nightly-trace.js");

type ReactionBaseline = import("../src/reaction-score.js").ReactionBaseline;
type SampleObservation = import("../src/reaction-score.js").SampleObservation;
type ReactionScoreRow = import("../src/db.js").ReactionScoreRow;

after(() => {
  db.close();
});

// ── 순수 계산 ─────────────────────────────────────────────────────────────────

const MIN = 60_000;

const baseline = (over: Partial<ReactionBaseline> = {}): ReactionBaseline => ({
  turns: 20,
  gapMedianMs: 10 * MIN,
  charsMedian: 10,
  ...over,
});

const observed = (
  reply: Partial<NonNullable<SampleObservation["reply"]>> = {},
  over: Partial<SampleObservation> = {},
): SampleObservation => ({
  reply: {
    gapMs: 10 * MIN,
    chars: 10,
    text: "그렇구나",
    followCount: 1,
    ...reply,
  },
  askedAboutChar: false,
  tone: null,
  cause: null,
  moveReaction: null,
  ...over,
});

test("답 없는 표본은 속도·길이·이어진 턴 수가 −1이라 −0.40이다", () => {
  const s = scoreSignals(observed({}, { reply: null }), baseline());
  assert.deepEqual(s, {
    speed: -1,
    length: -1,
    laugh: 0,
    ask: 0,
    follow: -1,
    state: 0,
    move: 0,
  });
  assert.equal(sampleValue(s), -0.4);
});

test("가중치는 속도·길이·웃음·되묻기 0.15, 이어진 턴·상대 상태 0.10, 플러팅 반응 0.20이다", () => {
  const all = (v: -1 | 1) => ({
    speed: v,
    length: v,
    laugh: v,
    ask: v,
    follow: v,
    state: v,
    move: v,
  });
  assert.equal(sampleValue(all(1)), 1);
  assert.equal(sampleValue(all(-1)), -1);
  const zero = {
    ...all(1),
    speed: 0,
    length: 0,
    laugh: 0,
    ask: 0,
    follow: 0,
    state: 0,
    move: 0,
  } as const;
  assert.equal(sampleValue({ ...zero, speed: 1 }), 0.15);
  assert.equal(sampleValue({ ...zero, length: 1 }), 0.15);
  assert.equal(sampleValue({ ...zero, laugh: 1 }), 0.15);
  assert.equal(sampleValue({ ...zero, ask: 1 }), 0.15);
  assert.equal(sampleValue({ ...zero, follow: 1 }), 0.1);
  assert.equal(sampleValue({ ...zero, state: 1 }), 0.1);
  assert.equal(sampleValue({ ...zero, move: 1 }), 0.2);
});

test("속도와 길이는 평소 값 중앙값과 견주고 표본이 20건 아래면 0이다", () => {
  const b = baseline();
  assert.equal(scoreSignals(observed({ gapMs: 5 * MIN }), b).speed, 1);
  assert.equal(scoreSignals(observed({ gapMs: 5 * MIN + 1 }), b).speed, 0);
  assert.equal(scoreSignals(observed({ gapMs: 20 * MIN }), b).speed, 0);
  assert.equal(scoreSignals(observed({ gapMs: 20 * MIN + 1 }), b).speed, -1);
  assert.equal(scoreSignals(observed({ chars: 16 }), b).length, 1);
  assert.equal(scoreSignals(observed({ chars: 15 }), b).length, 0);
  assert.equal(scoreSignals(observed({ chars: 5 }), b).length, 0);
  assert.equal(scoreSignals(observed({ chars: 4 }), b).length, -1);

  const few = baseline({ turns: 19 });
  const s = scoreSignals(observed({ gapMs: MIN, chars: 100 }), few);
  assert.equal(s.speed, 0);
  assert.equal(s.length, 0);
});

test("웃음·되묻기·이어진 턴·상대 상태·플러팅 반응은 표의 경계대로 매긴다", () => {
  const b = baseline();
  assert.equal(scoreSignals(observed({ text: "ㅋ 그래" }), b).laugh, 0);
  assert.equal(scoreSignals(observed({ text: "ㅋㅎ 그래" }), b).laugh, 1);
  assert.equal(scoreSignals(observed({ text: "너는？" }), b).ask, 1);
  assert.equal(scoreSignals(observed({}, { askedAboutChar: true }), b).ask, 1);
  assert.equal(scoreSignals(observed({ followCount: 2 }), b).follow, 0);
  assert.equal(scoreSignals(observed({ followCount: 3 }), b).follow, 1);
  assert.equal(scoreSignals(observed({}, { tone: "good" }), b).state, 1);
  assert.equal(scoreSignals(observed({}, { tone: "neutral" }), b).state, 0);
  assert.equal(
    scoreSignals(observed({}, { tone: "bad", cause: "other" }), b).state,
    0,
  );
  assert.equal(
    scoreSignals(observed({}, { tone: "bad", cause: "char" }), b).state,
    -1,
  );
  assert.equal(
    scoreSignals(observed({}, { moveReaction: "accepted" }), b).move,
    1,
  );
  assert.equal(
    scoreSignals(observed({}, { moveReaction: "ignored" }), b).move,
    0,
  );
  assert.equal(scoreSignals(observed({}, { moveReaction: "none" }), b).move, 0);
  assert.equal(
    scoreSignals(observed({}, { moveReaction: "rejected" }), b).move,
    -1,
  );
});

test("지수 이동 평균은 표본 3개까지 α 0.5, 그 뒤 α 0.3이다", () => {
  assert.equal(emaStep(0, 0, 0.2), 0.1);
  assert.equal(emaStep(0.1, 1, 0.2), 0.15);
  assert.equal(emaStep(0.15, 2, 0.2), 0.175);
  assert.equal(emaStep(0.175, 3, 0.2), 0.1825);
  assert.equal(emaStep(0, 0, -0.4), -0.2);
});

test("표본을 순서대로 얹고 새 플러팅은 0에서 시작하며 표본 없는 행은 그대로 둔다", () => {
  const stored: ReactionScoreRow[] = [
    {
      chat_id: "c",
      move: "laugh",
      score: 0.4,
      sample_count: 5,
      updated_at: "2026-09-01 05:10:00",
    },
    {
      chat_id: "c",
      move: "remember",
      score: 0.1,
      sample_count: 2,
      updated_at: "2026-09-01 05:10:00",
    },
  ];
  const out = applySamples(
    "c",
    stored,
    [
      { move: "remember", value: 0.7 },
      { move: "remember", value: 0.7 },
      { move: "nickname", value: -0.4 },
    ],
    "2026-09-10 05:00:00",
  );
  assert.deepEqual(
    out.map((r) => [r.move, r.score, r.sample_count]),
    [
      // remember: 0.1 → (α 0.5) 0.4 → (α 0.3) 0.49
      ["remember", 0.49, 4],
      ["laugh", 0.4, 5],
      ["nickname", -0.2, 1],
    ],
  );
  assert.equal(out[1]!.updated_at, "2026-09-01 05:10:00");
  // 넘긴 배열은 건드리지 않는다
  assert.equal(stored[1]!.score, 0.1);
});

test("턴은 캐릭터 말 뒤 유저 메시지 묶음이고 평소 값은 같은 날·6시간 안의 턴만 쓴다", () => {
  const turns = userTurnsOf([
    { id: 1, role: "user", text: "먼저 건 말", sent_at: "2026-09-01 20:00:00" },
    { id: 2, role: "assistant", text: "응", sent_at: "2026-09-01 20:05:00" },
    { id: 3, role: "user", text: "그래서", sent_at: "2026-09-01 20:15:00" },
    { id: 4, role: "user", text: "있잖아", sent_at: "2026-09-01 20:16:00" },
    { id: 5, role: "assistant", text: "왜", sent_at: "2026-09-01 20:20:00" },
    { id: 6, role: "assistant", text: "자?", sent_at: "2026-09-01 21:00:00" },
    { id: 7, role: "user", text: "아니", sent_at: "2026-09-02 04:00:00" },
    {
      id: 8,
      role: "assistant",
      text: "늦었네",
      sent_at: "2026-09-02 04:50:00",
    },
    { id: 9, role: "user", text: "잘게", sent_at: "2026-09-02 05:10:00" },
  ]);
  assert.deepEqual(turns, [
    {
      prevAt: "2026-09-01 20:05:00",
      firstId: 3,
      at: "2026-09-01 20:15:00",
      nextAt: "2026-09-01 20:20:00",
      text: "그래서\n있잖아",
      chars: 6,
    },
    {
      prevAt: "2026-09-01 21:00:00",
      firstId: 7,
      at: "2026-09-02 04:00:00",
      nextAt: "2026-09-02 04:50:00",
      text: "아니",
      chars: 2,
    },
    {
      prevAt: "2026-09-02 04:50:00",
      firstId: 9,
      at: "2026-09-02 05:10:00",
      nextAt: null,
      text: "잘게",
      chars: 2,
    },
  ]);
  // 7시간 뒤 턴과 05:00을 넘긴 턴은 평소 값에서 빠진다
  assert.deepEqual(baselineOf(turns), {
    turns: 1,
    gapMedianMs: 10 * MIN,
    charsMedian: 6,
  });
});

// ── 임시 DB ───────────────────────────────────────────────────────────────────

const DIARY = "2026-09-09";
const TODAY = "2026-09-10";
const NOW = "2026-09-10 05:10:00";

/** 상대 상태 판정 호출 한 행. 시각은 판정한 때로 고쳐 둔다. */
const judge = (
  characterId: number,
  chatId: string,
  at: string,
  state: { tone: "good" | "neutral" | "bad"; cause: "char" | "other" } | null,
  changed = true,
): number => {
  const id = recordLlmCall({
    purpose: "user_state",
    model: "test",
    characterId,
    chatId,
    system: [{ text: "판정" }],
    turns: "",
    latencyMs: 1,
  });
  setCallContext(id, {
    userState: {
      changed,
      state: state
        ? { state: "기분", cause: state.cause, tone: state.tone, since: at }
        : null,
      prev: null,
    },
  });
  db.prepare(`UPDATE llm_calls SET created_at = ? WHERE id = ?`).run(at, id);
  return id;
};

test("어제 플러팅마다 표본을 세고 신호 행·상대 상태·같은 날 6시간 규칙을 따른다", () => {
  const CHAT = "chat-rs-collect";
  const id = createFixtureCharacter(CHAT);
  // 그저께 쓴 플러팅은 어제 표본이 아니다
  logMessage(CHAT, id, "assistant", "ㅋㅋ", "2026-09-08 21:00:00", {
    kind: "reply",
    move: "laugh",
  });
  logMessage(CHAT, id, "user", "ㅋㅋ", "2026-09-08 21:10:00");

  judge(id, CHAT, "2026-09-09 20:00:00", { tone: "good", cause: "other" });
  logMessage(CHAT, id, "assistant", "꼬맹아", "2026-09-09 21:00:00", {
    kind: "reply",
    move: "nickname",
  });
  logMessage(CHAT, id, "user", "ㅋㅋ 뭐야 그 이름?", "2026-09-09 21:02:00");
  const unchanged = judge(id, CHAT, "2026-09-09 21:03:00", null, false);
  insertRelationshipSignal({
    characterId: id,
    chatId: CHAT,
    at: "2026-09-09 21:03:00",
    openedSelf: false,
    askedAboutChar: false,
    saidAffection: false,
    prevMove: "nickname",
    moveReaction: "accepted",
    callId: unchanged,
  });
  logMessage(CHAT, id, "user", "아 진짜", "2026-09-09 21:05:00");
  logMessage(CHAT, id, "assistant", "왜 웃어", "2026-09-09 21:10:00", {
    kind: "reply",
    move: "laugh",
  });
  logMessage(CHAT, id, "user", "재미없어", "2026-09-09 21:12:00");
  const bad = judge(id, CHAT, "2026-09-09 21:13:00", {
    tone: "bad",
    cause: "char",
  });
  insertRelationshipSignal({
    characterId: id,
    chatId: CHAT,
    at: "2026-09-09 21:13:00",
    openedSelf: false,
    askedAboutChar: false,
    saidAffection: false,
    prevMove: "laugh",
    moveReaction: "rejected",
    callId: bad,
  });
  logMessage(CHAT, id, "assistant", "넌 참 솔직해", "2026-09-09 21:30:00", {
    kind: "reply",
    move: "notice",
  });
  logMessage(CHAT, id, "user", "응", "2026-09-09 21:31:00");
  // 판정 호출 번호가 없는 행은 시각으로 상대 상태를 찾고, 판정이 다른 플러팅을 봤으면 이 표본의
  // 플러팅 반응은 0이다
  insertRelationshipSignal({
    characterId: id,
    chatId: CHAT,
    at: "2026-09-09 21:31:00",
    openedSelf: false,
    askedAboutChar: false,
    saidAffection: false,
    prevMove: "laugh",
    moveReaction: "accepted",
  });
  // 6시간 30분 뒤 답은 답 없음이다
  logMessage(CHAT, id, "assistant", "그때 그 얘기", "2026-09-09 22:00:00", {
    kind: "reply",
    move: "remember",
  });
  logMessage(CHAT, id, "user", "이제 봤어", "2026-09-10 04:30:00");
  // 05:00 뒤 답은 다음 날이라 답 없음이다
  logMessage(CHAT, id, "assistant", "내일 뭐해", "2026-09-10 04:40:00", {
    kind: "reply",
    move: "anticipate",
  });
  logMessage(CHAT, id, "user", "몰라", "2026-09-10 05:10:00");

  const samples = collectReactionSamples(CHAT, id, DIARY);
  assert.deepEqual(
    samples.map((x) => [x.move, x.at, x.value]),
    [
      ["nickname", "2026-09-09 21:00:00", 0.7],
      ["laugh", "2026-09-09 21:10:00", -0.3],
      ["notice", "2026-09-09 21:30:00", -0.1],
      ["remember", "2026-09-09 22:00:00", -0.4],
      ["anticipate", "2026-09-10 04:40:00", -0.4],
    ],
  );
  // 턴 두 메시지를 이어 웃음 2자·물음표를 보고, 30분 안 메시지 4건, 판정 호출 시점의 좋음을 읽는다.
  // 뒤에 나쁨으로 바꾼 판정은 이 턴의 판정 호출보다 늦어서 읽지 않는다
  assert.deepEqual(samples[0]!.signals, {
    speed: 0,
    length: 0,
    laugh: 1,
    ask: 1,
    follow: 1,
    state: 1,
    move: 1,
  });
  assert.deepEqual(samples[1]!.signals, {
    speed: 0,
    length: 0,
    laugh: 0,
    ask: 0,
    follow: 0,
    state: -1,
    move: -1,
  });
  assert.deepEqual(samples[2]!.signals, {
    speed: 0,
    length: 0,
    laugh: 0,
    ask: 0,
    follow: 0,
    state: -1,
    move: 0,
  });
});

test("평소 값 턴이 20건을 넘으면 어제 턴의 속도와 길이를 중앙값과 견준다", () => {
  const CHAT = "chat-rs-baseline";
  const id = createFixtureCharacter(CHAT);
  let n = 0;
  for (let day = 1; day <= 7 && n < 20; day++)
    for (const hour of [19, 20, 21]) {
      if (n >= 20) break;
      const date = `2026-09-0${day}`;
      logMessage(CHAT, id, "assistant", "뭐해", `${date} ${hour}:00:00`);
      logMessage(
        CHAT,
        id,
        "user",
        "가나다라마바사아자차",
        `${date} ${hour}:10:00`,
      );
      n++;
    }
  logMessage(CHAT, id, "assistant", "창밖 봐", "2026-09-09 21:00:00", {
    kind: "reply",
    move: "scene",
  });
  logMessage(
    CHAT,
    id,
    "user",
    "가나다라마바사아자차카타파하가나",
    "2026-09-09 21:02:00",
  );
  logMessage(CHAT, id, "assistant", "지금은?", "2026-09-09 22:00:00", {
    kind: "reply",
    move: "scene",
  });
  logMessage(CHAT, id, "user", "응", "2026-09-09 22:25:00");

  const samples = collectReactionSamples(CHAT, id, DIARY);
  assert.deepEqual(
    samples.map((x) => [x.signals.speed, x.signals.length, x.value]),
    [
      [1, 1, 0.3],
      [-1, -1, -0.3],
    ],
  );
  // 같은 날 같은 플러팅 두 번은 표본 두 개다
  assert.deepEqual(
    applySamples(CHAT, [], samples, NOW).map((r) => [
      r.move,
      r.score,
      r.sample_count,
    ]),
    [["scene", -0.075, 2]],
  );
});

test("수집은 어제 표본을 얹어 보고, 일기가 있는 날은 얹지 않으며, 저장은 표본이 있던 플러팅만 적는다", () => {
  const CHAT = "chat-rs-apply";
  const id = createFixtureCharacter(CHAT);
  saveReactionScore(CHAT, "remember", 0.25, 3, "2026-09-05 05:10:00");
  saveReactionScore(CHAT, "laugh", 0.1, 1, "2026-09-05 05:10:00");
  logMessage(CHAT, id, "assistant", "그때 말한 거", "2026-09-09 21:00:00", {
    kind: "reply",
    move: "remember",
  });
  logMessage(CHAT, id, "user", "ㅋㅋ 기억하네?", "2026-09-09 21:01:00");
  insertRelationshipSignal({
    characterId: id,
    chatId: CHAT,
    at: "2026-09-09 21:01:00",
    openedSelf: false,
    askedAboutChar: false,
    saidAffection: false,
    prevMove: "remember",
    moveReaction: "accepted",
  });

  // 표본 값 0.50을 얹으면 0.25 → 0.325라 잘 통하는 플러팅에 든다
  const rel = gatherRelation(id, CHAT, DIARY, TODAY);
  assert.deepEqual(rel.rapportMoves, ["remember"]);
  // 수집은 적지 않는다
  assert.equal(
    getReactionScores(CHAT).find((r) => r.move === "remember")?.score,
    0.25,
  );

  const r = applyRelationOutput(
    {
      characterId: id,
      chatId: CHAT,
      diaryDate: DIARY,
      today: TODAY,
      relation: rel,
    },
    null,
    NOW,
  );
  assert.equal(r.scoreSamples, 1);
  assert.deepEqual(
    getReactionScores(CHAT).map((x) => [
      x.move,
      x.score,
      x.sample_count,
      x.updated_at,
    ]),
    [
      ["remember", 0.325, 4, NOW],
      ["laugh", 0.1, 1, "2026-09-05 05:10:00"],
    ],
  );

  // 일기가 있는 날은 저장이 끝난 날이라 다시 얹지 않는다 — 점수를 되돌려 확인한다
  saveReactionScore(CHAT, "remember", 0.25, 3, "2026-09-05 05:10:00");
  insertDiary(id, DIARY, "{}");
  assert.deepEqual(gatherRelation(id, CHAT, DIARY, TODAY).rapportMoves, []);
});

test("캐릭터를 바꿔도 같은 대화방의 점수가 이어진다", () => {
  const CHAT = "chat-rs-carry";
  const oldId = createFixtureCharacter(CHAT);
  logMessage(
    CHAT,
    oldId,
    "assistant",
    "늦은 밤이라 하는 말인데",
    "2026-09-09 23:00:00",
    {
      kind: "reply",
      move: "late_night_truth",
    },
  );
  logMessage(CHAT, oldId, "user", "뭔데? ㅎㅎ", "2026-09-09 23:01:00");
  insertRelationshipSignal({
    characterId: oldId,
    chatId: CHAT,
    at: "2026-09-09 23:01:00",
    openedSelf: false,
    askedAboutChar: false,
    saidAffection: false,
    prevMove: "late_night_truth",
    moveReaction: "accepted",
  });
  saveReactionScore(CHAT, "late_night_truth", 0.3, 3, "2026-09-05 05:10:00");
  applyRelationOutput(
    {
      characterId: oldId,
      chatId: CHAT,
      diaryDate: DIARY,
      today: TODAY,
      relation: gatherRelation(oldId, CHAT, DIARY, TODAY),
    },
    null,
    NOW,
  );

  const newId = createFixtureCharacter(CHAT);
  const rel = gatherRelation(newId, CHAT, TODAY, "2026-09-11");
  assert.deepEqual(rel.rapportMoves, ["late_night_truth"]);
  // 새 캐릭터는 어제 대화가 없어 표본이 없고, 옛 캐릭터 말은 새 캐릭터 표본으로 세지 않는다
  assert.deepEqual(collectReactionSamples(CHAT, newId, DIARY), []);
  assert.deepEqual(
    getReactionScores(CHAT).map((x) => [x.move, x.score, x.sample_count]),
    [["late_night_truth", 0.36, 4]],
  );
});

test("점수 변화 줄은 표본이 늘어난 플러팅 가운데 오른 3개와 내린 3개만 적는다", () => {
  const row = (
    move: ReactionScoreRow["move"],
    score: number,
    n: number,
  ): ReactionScoreRow => ({
    chat_id: "c",
    move,
    score,
    sample_count: n,
    updated_at: NOW,
  });
  const before = [
    row("laugh", 0.2, 3),
    row("remember", 0.1, 2),
    row("scene", 0, 1),
  ];
  const afterRows = [
    row("laugh", 0.29, 4),
    row("remember", 0.4, 3),
    // 표본이 안 늘었으면 적지 않는다
    row("scene", 0, 1),
    row("nickname", 0.35, 1),
    row("anticipate", 0.05, 1),
    row("notice", -0.2, 1),
    row("weakness", -0.05, 1),
  ];
  assert.equal(
    scoreChangeLine(before, afterRows),
    "오름 별명 부르기 0.00→0.35 · 기억해서 챙기기 0.10→0.40 · 웃기기 0.20→0.29 / 내림 어떤 사람인지 말해 주기 0.00→−0.20 · 약한 소리 0.00→−0.05",
  );
  assert.equal(scoreChangeLine(before, before), null);
});
