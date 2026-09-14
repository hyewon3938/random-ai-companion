// 깨우기·약속 표시가 울릴 때 실제로 답장을 만드는 pending-handlers.ts의 갈래 나누기를 검사한다.
//
// createWakeHandler·createPromiseHandler에 가짜 deps를 주입해, 조건마다 어느 deps를 부르고
// 어느 deps는 부르지 않는지, 예외를 던지는 자리에서 실제로 던지는지를 본다. deps로 뺀 자리는
// 실제 발송·재예약 함수를 부르지 않고 스파이로만 확인하고, hasWaitingWakeRow와 currentBlock처럼
// deps로 빠지지 않은 판정은 실제 db.ts·day-plan.ts 함수로 행과 각본을 만들어 그대로 태운다.
//
// composeReply·chatJson을 거쳐 실제로 문안을 만드는 세 갈래(몰아 답장·복귀 인사와 사이 예고·
// 약속대로 먼저 연락)는 여기서 다루지 않는다. composeReply는 가짜 모델 응답을 주입하는
// ask 옵션을 받지만 pending-handlers.ts는 이를 전달하지 않고, chatJson은 애초에 주입 지점이
// 없어 현재 구조로는 실제 호출 없이 두 함수의 갈래를 검사할 방법이 없다(이슈 #449 범위 밖).
// 같은 이유로 "직전 발화는 유저인데 답할 차례가 잡히지 않는다"(no_turn) 갈래도 빼는데,
// pendingUserTurn과 lastMessage가 같은 테이블·같은 조건(chat_id·character_id, id DESC)을
// 써서 한 프로세스 안에서는 last.role이 "user"이면 pendingUserTurn이 항상 그 차례를 잡아
// 도달할 수 없다.
import assert from "node:assert/strict";
import { after, before, mock, test, type Mock } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "pending-handlers-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";
// 이 검사에서 실제로 도달하는 갈래는 모델을 부르지 않지만, 혹시 코드가 바뀌어 실수로
// 부르게 되더라도 기계 밖으로 나가지 않게 닫힌 포트로 돌린다.
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";
// 실행하는 기계의 .env에 실제 슬랙 값이 있어도 트레이스가 그 값으로 켜지지 않도록, 다른
// 트레이스 검사 파일과 같은 방식으로 가짜 값을 대입해 고정한다.
process.env.SLACK_BOT_TOKEN = "test-slack-token";
process.env.SLACK_TRACE_CHANNEL = "C_TEST";

const {
  db,
  getWaitingPendingReplies,
  insertPendingReply,
  logMessage,
  saveDayPlan,
} = await import("../src/db.js");
const { createFixtureCharacter } =
  await import("../src/eval/fixture-character.js");
const { dropPendingReplies, dropPromiseRows, dropWakeRows, parseWakeMeta } =
  await import("../src/pending.js");
const { createPromiseHandler, createWakeHandler } =
  await import("../src/pending-handlers.js");
type PendingReplyRow = Parameters<typeof parseWakeMeta>[0];
type PlanBlock =
  Parameters<typeof saveDayPlan> extends never
    ? never
    : {
        start: string;
        end: string;
        activity: string;
        responsiveness: string;
        advance_known: boolean;
        category: string;
      };

// 지금 시각은 각본이 필요한 검사(약속의 불가 구간 갈래)에서만 쓴다 — 그 밖의 검사는 각본을
// 안 깔아 currentBlock이 항상 null이라 시각과 무관하다.
const PLAN_DATE = "2026-09-07";
const clockToEpoch = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return Date.UTC(2026, 8, 7, h, m) - 9 * 3600_000;
};

const AT = "2026-09-07 09:00:00";

let seq = 0;
/** 캐릭터 하나·대화 하나를 새로 만든다 — 검사마다 서로 섞이지 않게 한다. */
const room = (): { chatId: string; characterId: number } => {
  const chatId = `chat-ph-${++seq}`;
  return { chatId, characterId: createFixtureCharacter(chatId) };
};

const rowOf = (over: Partial<PendingReplyRow>): PendingReplyRow => ({
  id: 1,
  chat_id: "chat-ph-0",
  character_id: 0,
  user_msg_at: AT,
  bubbles_json: "[]",
  note_to_save: null,
  send_at: "2026-09-07 09:30:00",
  kind: "wake",
  meta_json: null,
  call_id: null,
  attempts: 0,
  created_at: AT,
  ...over,
});

const block = (
  start: string,
  end: string,
  activity: string,
  responsiveness: "instant" | "intermittent" | "unavailable",
): PlanBlock => ({
  start,
  end,
  activity,
  responsiveness,
  advance_known: true,
  category: "official",
});

/** 부를 일이 없는 deps를 실수로 부르면 바로 드러나게 예외를 던진다. */
const boom =
  (name: string) =>
  (..._args: unknown[]): never => {
    throw new Error(`예상 밖 호출: ${name}`);
  };

// mock.fn(...)이 돌려주는 값은 원래 함수 타입에 .mock이 붙은 확장 타입(node:test의
// Mock<F>)인데, deps 인터페이스(WakeHandlerDeps 등)로 반환 타입을 명시하면 .mock이
// 지워진다. 테스트에서 deps.foo.mock.calls로 스파이 호출을 읽어야 하므로, 필드마다
// 원래 함수 타입을 Mock<F>로 감싼 이 타입을 대신 쓴다.
type SpyDeps<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? Mock<(...args: A) => R>
    : T[K];
};

const baseWakeDeps = (
  over: Partial<SpyDeps<Parameters<typeof createWakeHandler>[0]>> = {},
): SpyDeps<Parameters<typeof createWakeHandler>[0]> => ({
  sendBubbleList: mock.fn(boom("sendBubbleList")),
  sendProactive: mock.fn(boom("sendProactive")),
  keepPromise: mock.fn(boom("keepPromise")),
  acquireProactive: mock.fn(boom("acquireProactive")),
  releaseProactive: mock.fn(boom("releaseProactive")),
  isBusy: mock.fn(() => false),
  gatherSituation: mock.fn(boom("gatherSituation")),
  betweenSituation: mock.fn(boom("betweenSituation")),
  returnSituation: mock.fn(boom("returnSituation")),
  pickReturnAction: mock.fn(boom("pickReturnAction")),
  ...over,
});

const basePromiseDeps = (
  over: Partial<SpyDeps<Parameters<typeof createPromiseHandler>[0]>> = {},
): SpyDeps<Parameters<typeof createPromiseHandler>[0]> => ({
  sendBubbleList: mock.fn(boom("sendBubbleList")),
  sendProactive: mock.fn(boom("sendProactive")),
  keepPromise: mock.fn(boom("keepPromise")),
  acquireProactive: mock.fn(boom("acquireProactive")),
  releaseProactive: mock.fn(boom("releaseProactive")),
  isBusy: mock.fn(() => false),
  promiseSituation: mock.fn(boom("promiseSituation")),
  ...over,
});

before(() => {
  mock.timers.enable({ apis: ["Date"], now: clockToEpoch("10:00") });
});
after(() => {
  mock.timers.reset();
  // rearm 검사에서 armReturnRow가 실제 setTimeout까지 건 표시가 남아 있으면 프로세스가
  // 끝나지 않으니, pending-wake.test.ts와 같은 방식으로 대화마다 세 갈래로 거둬 지운다.
  for (const r of getWaitingPendingReplies()) {
    dropPendingReplies(r.chat_id);
    dropPromiseRows(r.chat_id);
    dropWakeRows(r.chat_id);
  }
  db.close();
});

// ── 깨우기 핸들러 ──────────────────────────────────────────────────────

test("깨우기: 답장을 만드는 중이면 그쪽이 답하니 아무것도 안 하고 접는다(yielded)", async () => {
  const { chatId, characterId } = room();
  const deps = baseWakeDeps({ isBusy: mock.fn(() => true) });
  await createWakeHandler(deps)(
    rowOf({ chat_id: chatId, character_id: characterId }),
  );
  assert.equal(deps.isBusy.mock.calls.length, 1);
  assert.equal(deps.pickReturnAction.mock.calls.length, 0);
});

test("깨우기: 이어 붙일 직전 발화가 없으면 복귀 인사 없이 접는다(no_last)", async () => {
  const { chatId, characterId } = room();
  const deps = baseWakeDeps();
  await createWakeHandler(deps)(
    rowOf({ chat_id: chatId, character_id: characterId }),
  );
  assert.equal(deps.pickReturnAction.mock.calls.length, 0);
});

test("깨우기: pickReturnAction이 skip이면 복귀 인사 없이 접는다", async () => {
  const { chatId, characterId } = room();
  logMessage(chatId, characterId, "assistant", "잘 자", AT, { kind: "reply" });
  const deps = baseWakeDeps({ pickReturnAction: mock.fn(() => "skip") });
  await createWakeHandler(deps)(
    rowOf({ chat_id: chatId, character_id: characterId }),
  );
  assert.equal(deps.pickReturnAction.mock.calls.length, 1);
  assert.equal(deps.acquireProactive.mock.calls.length, 0);
});

test("깨우기: pickReturnAction이 rearm이고 지금 블록이 있으면 표시만 다시 걸고 접는다", async () => {
  const { chatId, characterId } = room();
  logMessage(chatId, characterId, "assistant", "이따 얘기하자", AT, {
    kind: "reply",
  });
  // rearm은 지금 블록(cur)이 있을 때만 접는다(pending-handlers.ts:242~254) — cur가
  // 없으면 between도 null이라 이 if를 그냥 지나쳐 문안 생성 경로로 넘어간다. 그 갈래는
  // 각본이 있어야만 실제로 벌어지는 조합이라, 각본을 깔아 cur를 채워서 검사한다.
  saveDayPlan(
    characterId,
    PLAN_DATE,
    JSON.stringify({
      date: PLAN_DATE,
      blocks: [block("11:00", "12:00", "외출", "unavailable")],
    }),
  );
  mock.timers.setTime(clockToEpoch("11:30"));
  const deps = baseWakeDeps({ pickReturnAction: mock.fn(() => "rearm") });
  await createWakeHandler(deps)(
    rowOf({ chat_id: chatId, character_id: characterId }),
  );
  assert.equal(deps.acquireProactive.mock.calls.length, 0);
});

test("깨우기: 복귀 인사 차례인데 선톡 자리가 차 있으면 접는다(busy)", async () => {
  const { chatId, characterId } = room();
  logMessage(chatId, characterId, "assistant", "이따 얘기하자", AT, {
    kind: "reply",
  });
  const deps = baseWakeDeps({
    pickReturnAction: mock.fn(() => "greet"),
    acquireProactive: mock.fn(() => false),
  });
  await createWakeHandler(deps)(
    rowOf({ chat_id: chatId, character_id: characterId }),
  );
  assert.equal(deps.acquireProactive.mock.calls.length, 1);
  // 자리를 못 잡으면 try에 들어가지 않으니(문안도 안 만들고) releaseProactive도 안 부른다.
  assert.equal(deps.releaseProactive.mock.calls.length, 0);
});

// ── 약속 핸들러 ────────────────────────────────────────────────────────

test("약속: 깨우기 표시가 걸려 있으면 그쪽에 맡기고 접는다(deferred)", async () => {
  const { chatId, characterId } = room();
  insertPendingReply({
    chatId,
    characterId,
    userMsgAt: AT,
    bubbles: [],
    notesToSave: [],
    sendAt: "2099-01-01 00:00:00",
    kind: "wake",
    metaJson: null,
    createdAt: AT,
  });
  const deps = basePromiseDeps();
  await createPromiseHandler(deps)(
    rowOf({ chat_id: chatId, character_id: characterId, kind: "promise" }),
  );
  assert.equal(deps.isBusy.mock.calls.length, 0);
});

test("약속: 답장을 만드는 중이면 잠시 뒤 다시 걸라고 예외를 던진다", async () => {
  const { chatId, characterId } = room();
  const deps = basePromiseDeps({ isBusy: mock.fn(() => true) });
  await assert.rejects(
    createPromiseHandler(deps)(
      rowOf({ chat_id: chatId, character_id: characterId, kind: "promise" }),
    ),
    /답장을 만드는 중/,
  );
});

test("약속: 지금이 불가 구간이면 keepPromise로 다시 걸거나 자리가 없으면 접는다", async () => {
  const { chatId, characterId } = room();
  mock.timers.setTime(clockToEpoch("13:30"));
  saveDayPlan(
    characterId,
    PLAN_DATE,
    JSON.stringify({
      date: PLAN_DATE,
      blocks: [block("13:00", "14:00", "팀 회의", "unavailable")],
    }),
  );
  const row = rowOf({
    chat_id: chatId,
    character_id: characterId,
    kind: "promise",
    id: 7,
    meta_json: JSON.stringify({
      activity: "팀 회의",
      blockStart: "13:00",
      blockEnd: "14:00",
      promise: "회의 끝나고 연락",
      callId: 5,
    }),
  });

  // 다시 걸 블록이 있으면 그 값 그대로 keepPromise를 부른다.
  const kept = {
    sendAt: "2026-09-07 14:00:30",
    block: "14:00",
    activity: "팀 회의",
    replaced: 0,
  };
  const deps = basePromiseDeps({ keepPromise: mock.fn(() => kept) });
  await createPromiseHandler(deps)(row);
  assert.equal(deps.keepPromise.mock.calls.length, 1);
  assert.deepEqual(deps.keepPromise.mock.calls[0].arguments, [
    chatId,
    characterId,
    AT,
    "회의 끝나고 연락",
    5,
    7,
  ]);

  // 자리가 없어 keepPromise가 null을 돌려줘도 예외 없이 접는다.
  const depsNoSlot = basePromiseDeps({ keepPromise: mock.fn(() => null) });
  await createPromiseHandler(depsNoSlot)(row);
  assert.equal(depsNoSlot.keepPromise.mock.calls.length, 1);
});

test("약속: 온 말도 이어 붙일 직전 발화도 없으면 접는다(skipped)", async () => {
  const { chatId, characterId } = room();
  const deps = basePromiseDeps();
  await createPromiseHandler(deps)(
    rowOf({ chat_id: chatId, character_id: characterId, kind: "promise" }),
  );
  assert.equal(deps.acquireProactive.mock.calls.length, 0);
});

test("약속: 먼저 연락할 차례인데 선톡 자리가 차 있으면 예외를 던진다", async () => {
  const { chatId, characterId } = room();
  logMessage(chatId, characterId, "assistant", "이따 다시 연락할게", AT, {
    kind: "reply",
  });
  const deps = basePromiseDeps({ acquireProactive: mock.fn(() => false) });
  await assert.rejects(
    createPromiseHandler(deps)(
      rowOf({ chat_id: chatId, character_id: characterId, kind: "promise" }),
    ),
    /선톡 자리가 차 있음/,
  );
});
