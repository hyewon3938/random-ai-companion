// 선톡 예산과 근거 줄(proactive-policy.ts)의 검사.
//
// 단계별 상한 표는 설계 원본 §7이 원본이라 값을 그대로 적어 두고 어긋나면 깨지게 한다.
// 예산 판정은 오늘 나간 선톡을 세는 자리라 임시 DB에 메시지를 심어 값을 본다. 근거 줄과 줄
// 고르기는 순수 함수라 값만 넣는다.

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
  onDailyBudget,
  pickIntentLine,
  proactiveBudget,
  usedIntentLines,
} = await import("../src/proactive-policy.js");
const { PROACTIVE_STAGE_BUDGET } = await import("../src/thresholds.js");

const FULL = "budget-full"; // 1단계에서 오늘 예산을 다 쓴 방
const OPEN = "budget-open"; // 3단계에서 아직 아무것도 안 보낸 방
const SINCE = "2026-09-06 05:00:00";
let fullId = 0;
let openId = 0;

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

test("근거 줄은 근거 종류마다 다른 칸을 읽는다", () => {
  assert.equal(
    basisLine({ kind: "intent", intentLine: "thread" }),
    "의도(이어갈 자리)",
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
    "의도(파고들 것)",
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

test("의도 줄은 단계가 여는 줄 가운데 값이 있고 아직 안 쓴 앞선 것을 고른다", () => {
  const intent = {
    dig: "왜 그 팀을 그만뒀는지",
    share: "요즘 새벽에 러닝 나가는 얘기",
    move: "같이 볼 것 하나 고르기",
    thread: "다음 주 발표 준비",
  };
  // 1단계는 파고들 것과 이어갈 자리 둘만 의도 선톡이 된다.
  assert.equal(pickIntentLine(intent, 1, []), "dig");
  assert.equal(pickIntentLine(intent, 1, ["dig"]), "thread");
  assert.equal(pickIntentLine(intent, 1, ["dig", "thread"]), null);
  // 2단계부터 네 줄 전부 열린다.
  assert.equal(pickIntentLine(intent, 2, ["dig"]), "share");
  // 값이 빈 줄은 건너뛴다. 고백 차례는 플러팅 없이 자리만 적혀도 시도할 플러팅 줄이 산다.
  assert.equal(pickIntentLine({ thread: "다음 주 발표 준비" }, 2, []), "thread");
  assert.equal(pickIntentLine({ move_note: "저녁에 마음 확인" }, 2, []), "move");
  assert.equal(pickIntentLine(null, 2, []), null);
});
