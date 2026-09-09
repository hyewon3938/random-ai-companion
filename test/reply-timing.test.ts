// 답장 텀을 두 태그 표 한 장에서 정하는 자리(reply-timing.ts)를 검사한다 — 모델은 부르지 않는다.
//
// 각본이 없을 때, 자는 시간에 온 첫 연락과 그 뒤 연락, 이미 붙잡혀 접힌 블록, 즉답·틈틈이의
// 세 칸, 공적 불가 구간까지 표의 길마다 어느 경로로 나오고 텀이 어느 범위에 드는지 본다.
// 개인·사회 불가 구간은 붙잡기 판정 모델을 부르는 자리라, 정해 둔 답을 돌려주는 판정 함수를
// 넘겨 판정에 무엇이 들어가고 답마다 어느 길로 나오는지 본다 — 요청이면 개인은 취소·사회는
// 미룸 행이 남고, 아님은 구간 끝이며, 빈 답과 호출 실패는 아님과 갈라 표시된다(이슈 #336).
// 판정에 주는 글(buildHoldPrompt)이 이어 보낸 통 수와 기다린 시간을 어떻게 적는지도 본다. 붙잡힘
// 표시를 읽고 적는 isHeldNow·recordHold와 유저 이어 보내기 텀을 기록에서 읽는 recentUserGaps도 본다.
//
// 지금 시각은 코드가 kstLogicalClock()으로 읽고 그 밑은 Date.now()라, node:test의 mock.timers로
// Date만 고정해 각본 표기 시각을 정확히 짚는다. SQLite 쪽 now는 이 경로에 없다. DB는 임시
// 파일로 새로 만들고, 모델 주소는 닫힌 로컬 포트로 돌려 호출이 기계 밖으로 나가지 않게 한다.
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PlanBlock } from "../src/day-plan.js";
import type { HoldJudge } from "../src/reply-timing.js";
import type { ActivityCategory, Responsiveness } from "../src/labels.js";
import {
  INSTANT_MIN_MS,
  INSTANT_MAX_MS,
  INTERMITTENT_PERSONAL_MIN_MS,
  INTERMITTENT_PERSONAL_MAX_MS,
  INTERMITTENT_SOCIAL_MIN_MS,
  INTERMITTENT_SOCIAL_MAX_MS,
  INTERMITTENT_OFFICIAL_MIN_MS,
  INTERMITTENT_OFFICIAL_MAX_MS,
  BLOCK_END_JITTER_MS,
} from "../src/thresholds.js";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";
// 모델 클라이언트는 모듈을 읽을 때 이 주소를 잡는다. 아무것도 듣지 않는 포트라 연결이 바로 끊긴다.
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";

// DB 경로와 모델 주소를 정한 뒤에 읽어야 한다 — 정적 import는 이 줄들보다 먼저 돈다.
const { db, getDayActuals, logMessage, recordDayActual, saveDayPlan } =
  await import("../src/db.js");
const { createFixtureCharacter } =
  await import("../src/eval/fixture-character.js");
const {
  buildHoldPrompt,
  decideReplyTiming,
  isHeldNow,
  recordHold,
  recentUserGaps,
} = await import("../src/reply-timing.js");
const { HOLD_OUTCOME, WOKE_OUTCOME } = await import("../src/labels.js");

// 각본이 담는 논리일 하나에 시각만 옮겨 가며 본다. 각본 표기(05:00~28:59)를 그날 KST의
// epoch로 바꾼다 — 24를 넘는 시는 Date.UTC가 다음 날로 넘긴다.
const PLAN_DATE = "2026-09-07";
const clockToEpoch = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return Date.UTC(2026, 8, 7, h, m) - 9 * 3600_000;
};
const setClock = (hhmm: string): void => {
  mock.timers.setTime(clockToEpoch(hhmm));
};

const block = (
  start: string,
  end: string,
  activity: string,
  responsiveness: Responsiveness,
  category: ActivityCategory,
): PlanBlock => ({
  start,
  end,
  activity,
  responsiveness,
  advance_known: true,
  category,
});

let seq = 0;
/** 각본을 깐 방 하나. 실제 기록은 캐릭터마다 쌓이므로 검사마다 새로 만든다. */
const roomWith = (
  blocks: PlanBlock[] | null,
): { chatId: string; characterId: number } => {
  const chatId = `chat-timing-${++seq}`;
  const characterId = createFixtureCharacter(chatId);
  if (blocks)
    saveDayPlan(
      characterId,
      PLAN_DATE,
      JSON.stringify({ date: PLAN_DATE, blocks }),
    );
  return { chatId, characterId };
};

const actualsOf = (characterId: number) =>
  getDayActuals(characterId, PLAN_DATE);

const inRange = (v: number, min: number, max: number): boolean =>
  v >= min && v <= max;

before(() => {
  mock.timers.enable({ apis: ["Date"], now: clockToEpoch("10:30") });
});
after(() => {
  mock.timers.reset();
  db.close();
});

// ── decideReplyTiming ──────────────────────────────────────────────────

test("오늘 각본이 없으면 즉답 범위에서 텀을 정한다", async () => {
  const { characterId } = roomWith(null);
  setClock("10:30");
  const d = await decideReplyTiming(characterId, "뭐 해?");
  assert.equal(d.trace.path, "no_plan");
  assert.equal(d.trace.block, null);
  assert.equal(d.held, null);
  assert.equal(d.gather, null);
  assert.ok(inRange(d.waitMs, INSTANT_MIN_MS, INSTANT_MAX_MS));
});

test("자는 시간에 온 첫 연락은 깸 행을 남기고 틈틈이·개인 칸으로 답한다", async () => {
  const { characterId } = roomWith([
    block("23:30", "31:00", "잠", "unavailable", "personal"),
  ]);
  setClock("25:10");
  assert.equal(actualsOf(characterId).length, 0);

  const d = await decideReplyTiming(characterId, "자?");
  assert.equal(d.trace.path, "sleeping");
  assert.equal(d.trace.justWoke, true);
  assert.equal(d.trace.asked, false);
  assert.equal(d.gather, null);
  assert.ok(
    inRange(
      d.waitMs,
      INTERMITTENT_PERSONAL_MIN_MS,
      INTERMITTENT_PERSONAL_MAX_MS,
    ),
  );
  const rows = actualsOf(characterId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].block_start, "23:30");
  assert.equal(rows[0].outcome, WOKE_OUTCOME);
});

test("같은 잠 블록에서 이미 깼으면 즉답 칸으로 답하고 깸 행을 다시 남기지 않는다", async () => {
  const { characterId } = roomWith([
    block("23:30", "31:00", "잠", "unavailable", "personal"),
  ]);
  setClock("25:10");
  recordDayActual(
    characterId,
    PLAN_DATE,
    "23:30",
    "잠",
    WOKE_OUTCOME,
    "자는데 연락이 와서",
    "2026-09-08 01:00:00",
  );

  const d = await decideReplyTiming(characterId, "아직 안 자?");
  assert.equal(d.trace.path, "sleeping");
  assert.equal(d.trace.justWoke, false);
  assert.ok(inRange(d.waitMs, INSTANT_MIN_MS, INSTANT_MAX_MS));
  assert.equal(actualsOf(characterId).length, 1);
});

test("이미 붙잡혀 접힌 블록이면 텀 없이 바로 답한다", async () => {
  const cancelled = roomWith([
    block("10:00", "12:00", "달리기", "intermittent", "personal"),
  ]);
  const deferred = roomWith([
    block("10:00", "12:00", "친구와 카페", "unavailable", "social"),
  ]);
  setClock("10:30");
  recordDayActual(
    cancelled.characterId,
    PLAN_DATE,
    "10:00",
    "달리기",
    HOLD_OUTCOME.cancelled,
    "유저가 붙잡아서",
    "2026-09-07 10:05:00",
  );
  recordDayActual(
    deferred.characterId,
    PLAN_DATE,
    "10:00",
    "친구와 카페",
    HOLD_OUTCOME.deferred,
    "유저가 붙잡아서",
    "2026-09-07 10:05:00",
  );

  for (const { characterId } of [cancelled, deferred]) {
    const d = await decideReplyTiming(characterId, "그래서?");
    assert.equal(d.trace.path, "already_held");
    assert.equal(d.waitMs, 0);
    assert.equal(d.held, null);
    assert.equal(d.gather, null);
  }
});

test("즉답 블록은 표의 즉답 칸에서 텀을 정한다", async () => {
  const { characterId } = roomWith([
    block("10:00", "12:00", "집에서 쉼", "instant", "personal"),
  ]);
  setClock("10:30");
  const d = await decideReplyTiming(characterId, "뭐 해?");
  assert.equal(d.trace.path, "table");
  assert.equal(d.trace.block?.responsiveness, "instant");
  assert.equal(d.trace.asked, false);
  assert.equal(d.gather, null);
  assert.ok(inRange(d.waitMs, INSTANT_MIN_MS, INSTANT_MAX_MS));
});

test("틈틈이 블록은 활동 성격 칸(개인·사회·공적)의 범위에서 텀을 정한다", async () => {
  const cells: [ActivityCategory, number, number][] = [
    ["personal", INTERMITTENT_PERSONAL_MIN_MS, INTERMITTENT_PERSONAL_MAX_MS],
    ["social", INTERMITTENT_SOCIAL_MIN_MS, INTERMITTENT_SOCIAL_MAX_MS],
    ["official", INTERMITTENT_OFFICIAL_MIN_MS, INTERMITTENT_OFFICIAL_MAX_MS],
  ];
  setClock("10:30");
  for (const [category, min, max] of cells) {
    const { characterId } = roomWith([
      block("10:00", "12:00", "할 일", "intermittent", category),
    ]);
    const d = await decideReplyTiming(characterId, "바빠?");
    assert.equal(d.trace.path, "table", category);
    assert.equal(d.trace.block?.category, category);
    assert.ok(inRange(d.waitMs, min, max), `${category}: ${d.waitMs}`);
  }
});

test("공적 불가 블록은 판정 없이 구간 끝까지 미루고 몰아 답장 정보를 넘긴다", async () => {
  const { characterId } = roomWith([
    block("13:00", "14:30", "팀 회의", "unavailable", "official"),
  ]);
  setClock("13:20");
  const d = await decideReplyTiming(characterId, "회의 언제 끝나?");
  assert.equal(d.trace.path, "until_end");
  assert.equal(d.trace.asked, false);
  assert.equal(d.held, null);
  assert.deepEqual(d.gather, {
    activity: "팀 회의",
    blockStart: "13:00",
    blockEnd: "14:30",
  });
  const untilEnd = 70 * 60_000;
  assert.ok(inRange(d.waitMs, untilEnd, untilEnd + BLOCK_END_JITTER_MS));
  // 판정을 안 불렀으니 실제 기록에도 아무것도 남지 않는다
  assert.equal(actualsOf(characterId).length, 0);
});

// ── 붙잡기 판정 ────────────────────────────────────────────────────────

/** 정해 둔 답을 돌려주는 판정 함수. 무엇을 받았는지는 seen에 남긴다. */
const judgeWith = (answer: string | Error) => {
  const seen: { system: string; prompt: string; purpose: string }[] = [];
  const judge: HoldJudge = async (system, turns, meta) => {
    seen.push({
      system,
      prompt: turns.map((t) => t.content).join("\n---\n"),
      purpose: meta.purpose,
    });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { judge, seen };
};

test("판정에 주는 글은 한 통이면 방금 보낸 말로, 여러 통이면 통 수와 기다린 시간을 앞세운다", () => {
  setClock("25:10");
  assert.equal(
    buildHoldPrompt({ activity: "자는 중", knows: null, userText: "자?" }),
    "내가 지금 하는 일: 자는 중\n상대가 방금 보낸 말: 자?",
  );
  // 한 통은 burst가 있어도 방금 보낸 말이다
  assert.equal(
    buildHoldPrompt({
      activity: "자는 중",
      knows: "상대는 내게 이 일정이 있다는 걸 안다.",
      userText: "자?",
      burst: { n: 1, firstAt: "2026-09-08 01:09:40" },
    }),
    "내가 지금 하는 일: 자는 중\n상대는 내게 이 일정이 있다는 걸 안다.\n상대가 방금 보낸 말: 자?",
  );
  // 세 통을 5분에 걸쳐 보냈다
  assert.equal(
    buildHoldPrompt({
      activity: "자는 중",
      knows: null,
      userText: "자?\n자나 보네\n일어나면 답해",
      burst: { n: 3, firstAt: "2026-09-08 01:05:00" },
    }),
    "내가 지금 하는 일: 자는 중\n상대가 내 답을 못 받은 채로 5분 동안 이어 보낸 말 3통:\n자?\n자나 보네\n일어나면 답해",
  );
});

test("기다린 시간은 1분이 안 되면 한 번에 보낸 것으로, 한 시간을 넘으면 시간 단위로 적는다", () => {
  setClock("13:20");
  const line = (firstAt: string): string =>
    buildHoldPrompt({
      activity: "낮잠",
      knows: null,
      userText: "있어?\n자?",
      burst: { n: 2, firstAt },
    }).split("\n")[1] ?? "";
  assert.equal(
    line("2026-09-07 13:19:40"),
    "상대가 내 답을 못 받은 채로 1분 안에 이어 보낸 말 2통:",
  );
  assert.equal(
    line("2026-09-07 12:15:00"),
    "상대가 내 답을 못 받은 채로 1시간 5분 동안 이어 보낸 말 2통:",
  );
  assert.equal(
    line("2026-09-07 11:20:00"),
    "상대가 내 답을 못 받은 채로 2시간 동안 이어 보낸 말 2통:",
  );
  // 첫 통 시각을 못 읽으면 한 통일 때의 글로 간다
  assert.equal(line(""), "상대가 방금 보낸 말: 있어?");
});

test("개인 불가 블록에서 요청이 나오면 취소 행을 적고 틈틈이·개인 칸으로 바로 답한다", async () => {
  const { characterId } = roomWith([
    block("13:00", "14:00", "헬스장 운동", "unavailable", "personal"),
  ]);
  setClock("13:20");
  const { judge, seen } = judgeWith("요청");
  const d = await decideReplyTiming(characterId, "자?\n있어?", {
    burst: { n: 2, firstAt: "2026-09-07 13:17:00" },
    judge,
  });
  assert.equal(d.trace.path, "held");
  assert.equal(d.trace.asked, true);
  assert.equal(d.trace.heldJudged, true);
  assert.equal(d.gather, null);
  assert.deepEqual(d.held, {
    outcome: HOLD_OUTCOME.cancelled,
    activity: "헬스장 운동",
  });
  assert.ok(
    inRange(
      d.waitMs,
      INTERMITTENT_PERSONAL_MIN_MS,
      INTERMITTENT_PERSONAL_MAX_MS,
    ),
  );
  const rows = actualsOf(characterId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.outcome, HOLD_OUTCOME.cancelled);
  assert.equal(rows[0]?.block_start, "13:00");

  // 판정은 한 번만 물었고, 문안에 두 답과 요청으로 볼 신호·경계 예시가 있으며, 글에는
  // 지금 하는 일과 이어 보낸 통 수·기다린 시간이 들어간다
  assert.equal(seen.length, 1);
  const call = seen[0];
  assert.equal(call?.purpose, "hold");
  for (const s of [
    '"요청"',
    '"아님"',
    "계속 연락해 달라는 말",
    "곁에 있어 달라는 뜻이 담긴 말",
    "재촉하는 말",
    "짧은 말을 이어 보내는 것",
    "가벼운 질문은 나중에 답해도 된다",
    "안 가면 안 돼? → 요청",
    "이어 보낸 말 3통: 자? / 뭐해 / 자나 보네 → 요청",
    "지금 뭐해? → 아님",
    "나 이거 살까 저거 살까? → 아님",
  ])
    assert.ok(call?.system.includes(s), s);
  assert.equal(
    call?.prompt,
    "내가 지금 하는 일: 헬스장 운동\n상대가 내 답을 못 받은 채로 3분 동안 이어 보낸 말 2통:\n자?\n있어?",
  );
});

test("사회 불가 블록에서 요청이 나오면 미룸 행을 적는다", async () => {
  const { characterId } = roomWith([
    block("19:00", "21:00", "친구와 저녁", "unavailable", "social"),
  ]);
  setClock("19:30");
  const d = await decideReplyTiming(characterId, "지금 통화 돼?", {
    judge: judgeWith("요청").judge,
  });
  assert.equal(d.trace.path, "held");
  assert.deepEqual(d.held, {
    outcome: HOLD_OUTCOME.deferred,
    activity: "친구와 저녁",
  });
  assert.equal(actualsOf(characterId)[0]?.outcome, HOLD_OUTCOME.deferred);
});

test("판정 답은 요청이라는 낱말로 읽되 아님이 같이 오면 요청으로 세지 않는다", async () => {
  const cases: [string, boolean][] = [
    ['"요청"', true],
    ["요청.", true],
    ["요청 아님", false],
    ["아님", false],
  ];
  for (const [answer, held] of cases) {
    const { characterId } = roomWith([
      block("13:00", "14:00", "헬스장 운동", "unavailable", "personal"),
    ]);
    setClock("13:20");
    const d = await decideReplyTiming(characterId, "안 가면 안 돼?", {
      judge: judgeWith(answer).judge,
    });
    assert.equal(d.trace.path, held ? "held" : "until_end", answer);
    assert.equal(d.trace.heldJudged, held, answer);
    assert.ok(!d.trace.holdFailed, answer);
    assert.equal(actualsOf(characterId).length, held ? 1 : 0, answer);
  }
});

test("아님이 나오면 일정을 그대로 두고 구간 끝까지 미루며 몰아 답장 정보를 넘긴다", async () => {
  const { characterId } = roomWith([
    block("13:00", "14:00", "헬스장 운동", "unavailable", "personal"),
  ]);
  setClock("13:20");
  const d = await decideReplyTiming(characterId, "나 이제 집 가는 중", {
    burst: { n: 1, firstAt: "2026-09-07 13:19:50" },
    judge: judgeWith("아님").judge,
  });
  assert.equal(d.trace.path, "until_end");
  assert.equal(d.trace.asked, true);
  assert.equal(d.trace.heldJudged, false);
  assert.equal(d.trace.holdFailed, false);
  assert.equal(d.held, null);
  assert.deepEqual(d.gather, {
    activity: "헬스장 운동",
    blockStart: "13:00",
    blockEnd: "14:00",
  });
  const untilEnd = 40 * 60_000;
  assert.ok(inRange(d.waitMs, untilEnd, untilEnd + BLOCK_END_JITTER_MS));
  assert.equal(actualsOf(characterId).length, 0);
});

test("빈 답과 호출 실패는 아님과 갈라 표시하고 일정은 그대로 둔다", async () => {
  for (const answer of ["", "  \n", new Error("overloaded")]) {
    const { characterId } = roomWith([
      block("13:00", "14:00", "헬스장 운동", "unavailable", "personal"),
    ]);
    setClock("13:20");
    const d = await decideReplyTiming(characterId, "자?", {
      judge: judgeWith(answer).judge,
    });
    assert.equal(d.trace.path, "until_end", String(answer));
    assert.equal(d.trace.asked, true);
    assert.equal(d.trace.heldJudged, false);
    assert.equal(d.trace.holdFailed, true, String(answer));
    assert.equal(d.held, null);
    assert.ok(d.gather);
    assert.equal(actualsOf(characterId).length, 0);
  }
});

// ── isHeldNow ──────────────────────────────────────────────────────────

test("붙잡힘 표시는 지금 블록의 시작 시각으로 적힌 취소·미룸 행만 본다", () => {
  setClock("10:30");
  assert.equal(isHeldNow(roomWith(null).characterId), false);

  const plan = [block("10:00", "12:00", "달리기", "intermittent", "personal")];

  const held = roomWith(plan);
  recordDayActual(
    held.characterId,
    PLAN_DATE,
    "10:00",
    "달리기",
    HOLD_OUTCOME.cancelled,
    "유저가 붙잡아서",
    "2026-09-07 10:05:00",
  );
  assert.equal(isHeldNow(held.characterId), true);

  // 다른 블록의 취소 행은 지금 블록에 걸리지 않는다
  const other = roomWith(plan);
  recordDayActual(
    other.characterId,
    PLAN_DATE,
    "08:00",
    "아침 산책",
    HOLD_OUTCOME.cancelled,
    "유저가 붙잡아서",
    "2026-09-07 08:05:00",
  );
  assert.equal(isHeldNow(other.characterId), false);

  // 깸은 붙잡힘이 아니다
  const woke = roomWith(plan);
  recordDayActual(
    woke.characterId,
    PLAN_DATE,
    "10:00",
    "달리기",
    WOKE_OUTCOME,
    "자는데 연락이 와서",
    "2026-09-07 10:05:00",
  );
  assert.equal(isHeldNow(woke.characterId), false);
});

// ── recordHold ─────────────────────────────────────────────────────────

test("답장의 stay 신호는 개인은 취소, 사회는 미룸으로 적고 공적은 적지 않는다", () => {
  setClock("10:30");

  const official = roomWith([
    block("10:00", "12:00", "팀 회의", "unavailable", "official"),
  ]);
  assert.equal(recordHold(official.characterId), null);
  assert.equal(actualsOf(official.characterId).length, 0);

  const personal = roomWith([
    block("10:00", "12:00", "달리기", "intermittent", "personal"),
  ]);
  assert.deepEqual(recordHold(personal.characterId), {
    blockStart: "10:00",
    activity: "달리기",
    outcome: HOLD_OUTCOME.cancelled,
  });
  const personalRows = actualsOf(personal.characterId);
  assert.equal(personalRows.length, 1);
  assert.equal(personalRows[0].outcome, HOLD_OUTCOME.cancelled);

  const social = roomWith([
    block("10:00", "12:00", "친구와 카페", "unavailable", "social"),
  ]);
  assert.equal(recordHold(social.characterId)?.outcome, HOLD_OUTCOME.deferred);
  assert.equal(
    actualsOf(social.characterId)[0]?.outcome,
    HOLD_OUTCOME.deferred,
  );

  // 이미 붙잡힌 블록은 다시 적지 않는다
  assert.equal(recordHold(personal.characterId), null);
  assert.equal(actualsOf(personal.characterId).length, 1);
});

// ── recentUserGaps ─────────────────────────────────────────────────────

test("유저가 이어 보낸 텀을 기록에서 읽는다 — 답장이 끼거나 2분을 넘으면 뺀다", () => {
  const { chatId, characterId } = roomWith(null);
  const say = (role: "user" | "assistant", at: string): number =>
    logMessage(chatId, characterId, role, "말", at);
  say("user", "2026-09-07 10:00:00");
  say("user", "2026-09-07 10:00:20");
  say("assistant", "2026-09-07 10:01:00");
  say("user", "2026-09-07 10:02:00");
  say("user", "2026-09-07 10:05:00");
  say("user", "2026-09-07 10:05:05");
  assert.deepEqual(recentUserGaps(chatId, characterId), [20_000, 5_000]);
  assert.deepEqual(recentUserGaps("chat-timing-empty", characterId), []);
});

test("읽는 행 수를 줄이면 그 안의 이어 보내기만 센다", () => {
  const { chatId, characterId } = roomWith(null);
  const say = (at: string): number =>
    logMessage(chatId, characterId, "user", "말", at);
  say("2026-09-07 10:00:00");
  say("2026-09-07 10:00:20");
  say("2026-09-07 10:05:00");
  say("2026-09-07 10:05:05");
  assert.deepEqual(recentUserGaps(chatId, characterId, 2), [5_000]);
  assert.deepEqual(recentUserGaps(chatId, characterId), [20_000, 5_000]);
});
