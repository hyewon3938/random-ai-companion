// 선톡 예산과 근거 줄(proactive-policy.ts)의 검사.
//
// 단계별 상한 표는 설계 원본 §7이 원본이라 값을 그대로 적어 두고 어긋나면 깨지게 한다.
// 예산 판정은 오늘 나간 선톡을 세는 자리라 임시 DB에 메시지를 심어 값을 본다. 의도 줄과 여는
// 방식을 돌려 쓰는 순서도 지난 발송 기록을 읽어서 같은 방법으로 본다. 근거 줄과 의도 후보 목록,
// 여는 방식 순서는 순수 함수라 값만 넣는다.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "proactive-budget-")), "t.db");
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

const { db, logMessage, raiseStage } = await import("../src/db.js");
const { createFixtureCharacter } = await import("../src/eval/fixture-character.js");
const {
  basisLine,
  basisLineFromMeta,
  budgetAllows,
  budgetLabel,
  intentCandidates,
  intentLineLastUse,
  onDailyBudget,
  openingLastUse,
  openingOrder,
  proactiveBudget,
  rotationSince,
  usedIntentLines,
} = await import("../src/proactive-policy.js");
const { PROACTIVE_STAGE_BUDGET } = await import("../src/thresholds.js");

const FULL = "budget-full"; // 1단계에서 오늘 예산을 다 쓴 방
const OPEN = "budget-open"; // 3단계에서 아직 아무것도 안 보낸 방
const ROT = "budget-rotate"; // 지난 2주 동안 선톡이 여러 줄과 여는 방식을 쓴 방
const SINCE = "2026-09-06 05:00:00";
let fullId = 0;
let openId = 0;
let rotId = 0;

before(() => {
  fullId = createFixtureCharacter(FULL);
  openId = createFixtureCharacter(OPEN);
  raiseStage(openId, 3, "2026-09-01");
  const say = (at: string, meta: Record<string, unknown>): number =>
    logMessage(FULL, fullId, "assistant", "말", at, meta);
  // 1단계 합계 4는 아침·근황·의도·밤 인사 하나씩이다(설계 원본 §7).
  say("2026-09-06 08:00:00", { kind: "morning", proactive: true });
  say("2026-09-06 12:00:00", { kind: "catchup", proactive: true });
  say("2026-09-06 15:00:00", { kind: "intent", proactive: true, intent_line: "dig" });
  say("2026-09-06 23:40:00", { kind: "goodnight", proactive: true });
  // 합계에 안 드는 넷. 이것까지 세면 위 네 통에서 이미 상한을 넘는다.
  say("2026-09-06 09:00:00", { kind: "away", proactive: true, block: "09:30" });
  say("2026-09-06 11:30:00", { kind: "glance", proactive: true, block: "11:00" });
  say("2026-09-06 16:00:00", { kind: "mend", proactive: true });
  say("2026-09-06 18:00:00", { kind: "promise", proactive: true, promise_row: 12 });
  // 답장이 오늘 시도할 플러팅을 이미 뒀다 — 의도 줄 셈은 이것도 쓴 것으로 본다.
  say("2026-09-06 20:00:00", { kind: "reply", move: "같이 볼 것 하나 고르기" });
  // 답장이 쓴 나머지 의도 줄은 배열 칸으로 온다(이슈 #390). 목록에 없는 코드는 안 센다.
  say("2026-09-06 21:00:00", {
    kind: "reply",
    intent_lines: ["thread", "weather"],
  });

  rotId = createFixtureCharacter(ROT);
  const rot = (at: string, meta: Record<string, unknown>): number =>
    logMessage(ROT, rotId, "assistant", "말", at, meta);
  // 14일 전(8/23 05시)보다 앞선 선톡은 돌려 쓰기에서 안 센다.
  rot("2026-08-20 15:00:00", {
    kind: "intent",
    proactive: true,
    intent_line: "move",
    opening: "my_question",
  });
  rot("2026-09-01 15:00:00", {
    kind: "intent",
    proactive: true,
    intent_line: "dig",
    opening: "ask",
  });
  // 근황 선톡은 쓴 줄을 배열 칸에 적는다(이슈 #475). 목록에 없는 코드는 안 센다.
  rot("2026-09-03 12:00:00", {
    kind: "catchup",
    proactive: true,
    intent_lines: ["share", "weather"],
    opening: "my_day",
  });
  rot("2026-09-04 15:00:00", {
    kind: "intent",
    proactive: true,
    intent_line: "thread",
    opening: "reminded",
  });
  // 답장이 쓴 줄과 칸은 돌려 쓰기에서 안 센다. 오늘 쓴 줄 셈에는 든다.
  rot("2026-09-05 20:00:00", { kind: "reply", intent_lines: ["dig"] });
  rot("2026-09-05 22:00:00", { kind: "reply", opening: "my_day" });
  rot("2026-09-06 12:00:00", {
    kind: "catchup",
    proactive: true,
    intent_lines: ["share"],
    opening: "ask",
  });
});
after(() => {
  db.close();
});

test("단계별 상한 표가 설계 원본과 같다", () => {
  assert.deepEqual(PROACTIVE_STAGE_BUDGET, {
    1: { intent: 1, daily: 4 },
    2: { intent: 2, daily: 5 },
    3: { intent: 2, daily: 6 },
    4: { intent: 3, daily: 6 },
  });
});

test("예산은 합계에 드는 선톡만 세고 단계에서 상한을 읽는다", () => {
  const b = proactiveBudget(FULL, fullId, SINCE);
  assert.deepEqual(b, {
    stage: 1,
    dailyMax: 4,
    dailyUsed: 4,
    intentMax: 1,
    intentUsed: 1,
  });
  assert.equal(budgetLabel(b), "1단계 · 합계 4/4통 · 의도 1/1");
});

test("합계가 찬 뒤에도 자리 비움·약속·달래기·살피기·틈새 한 줄은 열려 있다", () => {
  const b = proactiveBudget(FULL, fullId, SINCE);
  for (const kind of ["catchup", "lunch", "goodnight", "intent"] as const)
    assert.equal(budgetAllows(b, kind), false, kind);
  for (const kind of ["away", "promise", "mend", "care", "glance"] as const) {
    assert.equal(onDailyBudget(kind), false, kind);
    assert.equal(budgetAllows(b, kind), true, kind);
  }
});

test("의도 상한은 합계와 따로 찬다", () => {
  const b = proactiveBudget(OPEN, openId, SINCE);
  assert.deepEqual(b, {
    stage: 3,
    dailyMax: 6,
    dailyUsed: 0,
    intentMax: 2,
    intentUsed: 0,
  });
  assert.equal(budgetAllows(b, "intent"), true);
  // 합계에 여유가 있어도 의도를 다 쓰면 의도 선톡만 닫힌다.
  const used = { ...b, intentUsed: 2 };
  assert.equal(budgetAllows(used, "intent"), false);
  assert.equal(budgetAllows(used, "catchup"), true);
});

test("오늘 쓴 의도 줄은 선톡의 줄 코드와 답장이 쓴 줄을 함께 센다", () => {
  assert.deepEqual(usedIntentLines(FULL, fullId, SINCE).sort(), [
    "dig",
    "move",
    "thread",
  ]);
  assert.deepEqual(usedIntentLines(OPEN, openId, SINCE), []);
});

test("근황 선톡이 쓴 줄도 오늘 쓴 의도 줄로 센다", () => {
  assert.deepEqual(usedIntentLines(ROT, rotId, SINCE), ["share"]);
});

test("돌려 쓰기는 오늘 논리일 시작에서 14일 앞부터 되짚는다", () => {
  assert.equal(rotationSince(SINCE), "2026-08-23 05:00:00");
  assert.equal(rotationSince("2026-09-01 05:00:00"), "2026-08-18 05:00:00");
});

test("줄마다 마지막으로 쓴 시각은 14일 안의 선톡만 보고 늦은 시각이 이긴다", () => {
  // 의도 선톡의 intent_line과 근황 선톡의 intent_lines를 함께 센다. 답장이 9/5에 쓴 dig와
  // 8/20의 move는 안 센다.
  assert.deepEqual(intentLineLastUse(ROT, rotId, rotationSince(SINCE)), {
    dig: "2026-09-01 15:00:00",
    share: "2026-09-06 12:00:00",
    thread: "2026-09-04 15:00:00",
  });
  assert.deepEqual(intentLineLastUse(OPEN, openId, rotationSince(SINCE)), {});
});

test("여는 방식마다 마지막으로 쓴 시각은 14일 안의 선톡만 본다", () => {
  // 8/20의 my_question은 14일 밖이고, 9/5 답장 칸의 my_day는 선톡이 아니라 안 센다.
  assert.deepEqual(openingLastUse(ROT, rotId, rotationSince(SINCE)), {
    ask: "2026-09-06 12:00:00",
    my_day: "2026-09-03 12:00:00",
    reminded: "2026-09-04 15:00:00",
  });
  assert.deepEqual(openingLastUse(FULL, fullId, rotationSince(SINCE)), {});
});

test("여는 방식은 바로 앞에 쓴 것을 빼고 안 쓴 것부터 가장 오래전에 쓴 것 순서다", () => {
  assert.deepEqual(openingOrder({}), ["ask", "reminded", "my_day", "my_question"]);
  assert.deepEqual(openingOrder({ reminded: "2026-09-05 10:00:00" }), [
    "ask",
    "my_day",
    "my_question",
  ]);
  assert.deepEqual(
    openingOrder({
      ask: "2026-09-01 15:00:00",
      reminded: "2026-09-03 12:00:00",
      my_day: "2026-09-02 12:00:00",
    }),
    ["my_question", "ask", "my_day"],
  );
  assert.deepEqual(openingOrder(openingLastUse(ROT, rotId, rotationSince(SINCE))), [
    "my_question",
    "my_day",
    "reminded",
  ]);
});

test("근거 줄은 근거 종류마다 다른 칸을 읽는다", () => {
  assert.equal(
    basisLine({ kind: "intent", intentLine: "thread" }),
    "의도(이어서 할 이야기)",
  );
  assert.equal(basisLine({ kind: "intent" }), "의도");
  assert.equal(basisLine({ kind: "lunch", block: "12:00" }), "일정(12:00 블록)");
  assert.equal(basisLine({ kind: "goodnight" }), "일정(밤 인사 선톡)");
  assert.equal(basisLine({ kind: "promise", promiseId: 12 }), "약속(행 12)");
  assert.equal(basisLine({ kind: "mend" }), "달래기");
  assert.equal(basisLine({ kind: "care" }), "살피기");
});

test("발송 기록으로 만드는 근거 줄은 선톡이 아닌 종류에 null을 준다", () => {
  assert.equal(
    basisLineFromMeta("intent", { intent_line: "dig" }),
    "의도(더 물어볼 것)",
  );
  assert.equal(basisLineFromMeta("away", { block: "09:30" }), "일정(09:30 블록)");
  assert.equal(
    basisLineFromMeta("promise", { promise: "22시에 연락", promise_row: 12 }),
    "약속(행 12)",
  );
  assert.equal(basisLineFromMeta("mend"), "달래기");
  assert.equal(basisLineFromMeta("care"), "살피기");
  assert.equal(basisLineFromMeta("reply"), null);
  // 값이 이상하면 그 칸만 비운 채로 근거 종류는 적는다.
  assert.equal(basisLineFromMeta("intent", { intent_line: "없는줄" }), "의도");
  assert.equal(basisLineFromMeta("catchup", { block: 12 }), "일정(근황 선톡)");
});

test("의도 후보는 단계가 여는 줄 가운데 값이 있고 오늘 아직 안 쓴 줄 전부다", () => {
  const intent = {
    dig: "왜 그 팀을 그만뒀는지",
    share: "요즘 새벽에 러닝 나가는 얘기",
    move: "같이 볼 것 하나 고르기",
    thread: "다음 주 발표 준비",
  };
  // 1단계는 파고들 것과 이어갈 자리 둘만 의도 선톡이 된다.
  assert.deepEqual(intentCandidates(intent, 1, []), ["dig", "thread"]);
  assert.deepEqual(intentCandidates(intent, 1, ["dig"]), ["thread"]);
  assert.deepEqual(intentCandidates(intent, 1, ["dig", "thread"]), []);
  // 2단계부터 네 줄 전부 열린다.
  assert.deepEqual(intentCandidates(intent, 2, []), ["dig", "share", "move", "thread"]);
  assert.deepEqual(intentCandidates(intent, 2, ["dig"]), ["share", "move", "thread"]);
  // 값이 빈 줄은 빠진다. 고백 차례는 플러팅 없이 자리만 적혀도 시도할 플러팅 줄이 산다.
  assert.deepEqual(intentCandidates({ thread: "다음 주 발표 준비" }, 2, []), ["thread"]);
  assert.deepEqual(intentCandidates({ move_note: "저녁에 마음 확인" }, 2, []), ["move"]);
  assert.deepEqual(intentCandidates(null, 2, []), []);
});

test("의도 후보는 안 쓴 줄부터 적고 최근 14일에 쓴 줄은 가장 오래전에 쓴 것부터 뒤에 둔다", () => {
  const intent = {
    dig: "왜 그 팀을 그만뒀는지",
    share: "요즘 새벽에 러닝 나가는 얘기",
    move: "같이 볼 것 하나 고르기",
    thread: "다음 주 발표 준비",
  };
  // 최근에 파고들 것으로 열었으면 그 줄을 맨 뒤에 둔다. 모델은 지금 맞는 줄이 여럿일 때 앞선
  // 줄을 고른다.
  assert.deepEqual(intentCandidates(intent, 2, [], { dig: "2026-09-05 15:00:00" }), [
    "share",
    "move",
    "thread",
    "dig",
  ]);
  // 둘 다 썼으면 더 오래전에 쓴 줄이 앞이다. 어제 쓴 줄만 뒤로 보내던 때는 9/1에 쓴 dig가
  // 안 쓴 줄과 같이 맨 앞에 섰다.
  assert.deepEqual(
    intentCandidates(intent, 2, [], {
      dig: "2026-09-01 15:00:00",
      share: "2026-09-05 12:00:00",
    }),
    ["move", "thread", "dig", "share"],
  );
  assert.deepEqual(
    intentCandidates(intent, 1, [], {
      dig: "2026-09-05 15:00:00",
      thread: "2026-09-02 15:00:00",
    }),
    ["thread", "dig"],
  );
  // 쓴 시각이 같으면 원래 순서를 지킨다.
  assert.deepEqual(
    intentCandidates(intent, 1, [], {
      dig: "2026-09-05 15:00:00",
      thread: "2026-09-05 15:00:00",
    }),
    ["dig", "thread"],
  );
  // 오늘 이미 쓴 줄은 쓴 시각과 상관없이 빠진다.
  assert.deepEqual(intentCandidates(intent, 1, ["thread"], { dig: "2026-09-05 15:00:00" }), [
    "dig",
  ]);
  assert.deepEqual(intentCandidates(intent, 1, ["dig", "thread"], {}), []);
  // 되짚을 기록이 없으면 단계 순서 그대로다.
  assert.deepEqual(
    intentCandidates(intent, 2, [], intentLineLastUse(OPEN, openId, rotationSince(SINCE))),
    ["dig", "share", "move", "thread"],
  );
});
