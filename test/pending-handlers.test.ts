// 구간 끝·약속 행이 울릴 때 실제로 답장을 만드는 pending-handlers.ts의 갈래 나누기를 검사한다.
//
// createWakeHandler·createPromiseHandler에 가짜 deps를 주입해, 조건마다 어느 deps를 부르고
// 어느 deps는 부르지 않는지, 행을 어떤 상태와 사유로 닫으라고 돌려주는지를 본다. 선톡 잠금에
// 막힌 자리는 예외 대신 잠금 충돌(busy)을 돌려주고, 자기 행을 다시 거는 갈래는 한 트랜잭션에서
// 자기 행을 닫고 새 행을 넣는다(이슈 #476). deps로 뺀 자리는
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
  getWaitingOutboxRow,
  getWaitingOutboxRows,
  insertOutboxRow,
  logMessage,
  saveDayPlan,
} = await import("../src/db.js");
const { createFixtureCharacter } =
  await import("../src/eval/fixture-character.js");
const { dropPendingReplies, dropPromiseRows, dropWakeRows } =
  await import("../src/pending.js");
const { createPromiseHandler, createWakeHandler } =
  await import("../src/pending-handlers.js");
type OutboxRow = NonNullable<ReturnType<typeof getWaitingOutboxRow>>;
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

/** DB에 넣지 않은 행. 행을 닫거나 다시 거는 갈래가 아니면 핸들러는 받은 값만 읽는다. */
const rowOf = (over: Partial<OutboxRow>): OutboxRow => ({
  id: 1,
  kind: "block_end",
  chat_id: "chat-ph-0",
  character_id: 0,
  dedupe_key: "row1",
  send_at: "2026-09-07 09:30:00",
  expires_at: null,
  payload_json: "{}",
  call_id: null,
  attempts: 0,
  created_at: AT,
  ...over,
});

/**
 * 실제로 대기 행을 넣고 그 행을 돌려준다. 핸들러가 자기 행을 재예약으로 닫는 갈래
 * (replaceWaitingRow)는 행이 표에 대기로 있어야 탄다.
 */
const plantRow = (
  kind: "block_end" | "promise",
  chatId: string,
  characterId: number,
  dedupeKey: string,
  payload: object,
  callId: number | null = null,
): OutboxRow => {
  const id = insertOutboxRow({
    kind,
    chatId,
    characterId,
    dedupeKey,
    sendAt: "2099-01-01 00:00:00",
    payload,
    callId,
    createdAt: AT,
  });
  assert.ok(id !== null);
  const row = getWaitingOutboxRow(id);
  assert.ok(row);
  return row;
};

const statusOf = (id: number): { status: string; reason: string | null } =>
  db.prepare(`SELECT status, reason FROM outbox WHERE id = ?`).get(id) as {
    status: string;
    reason: string | null;
  };

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
  for (const r of getWaitingOutboxRows()) {
    dropPendingReplies(r.chat_id);
    dropPromiseRows(r.chat_id);
    dropWakeRows(r.chat_id);
  }
  db.close();
});

// ── 구간 끝 핸들러 ─────────────────────────────────────────────────────

test("구간 끝: 답장을 만드는 중이면 그쪽이 답하니 양보로 닫는다", async () => {
  const { chatId, characterId } = room();
  const deps = baseWakeDeps({ isBusy: mock.fn(() => true) });
  const out = await createWakeHandler(deps)(
    rowOf({ chat_id: chatId, character_id: characterId }),
  );
  assert.equal(deps.isBusy.mock.calls.length, 1);
  assert.equal(deps.pickReturnAction.mock.calls.length, 0);
  assert.equal(out.status, "dropped");
  assert.equal("reason" in out && out.reason, "yielded");
});

test("구간 끝: 이어 붙일 직전 발화가 없으면 복귀 인사 없이 건너뛴다(no_turn)", async () => {
  const { chatId, characterId } = room();
  const deps = baseWakeDeps();
  const out = await createWakeHandler(deps)(
    rowOf({ chat_id: chatId, character_id: characterId }),
  );
  assert.equal(deps.pickReturnAction.mock.calls.length, 0);
  assert.equal(out.status, "skipped");
  assert.equal("reason" in out && out.reason, "no_turn");
});

test("구간 끝: pickReturnAction이 skip이면 복귀 인사 없이 건너뛴다", async () => {
  const { chatId, characterId } = room();
  logMessage(chatId, characterId, "assistant", "잘 자", AT, { kind: "reply" });
  const deps = baseWakeDeps({ pickReturnAction: mock.fn(() => "skip") });
  const out = await createWakeHandler(deps)(
    rowOf({ chat_id: chatId, character_id: characterId }),
  );
  assert.equal(deps.pickReturnAction.mock.calls.length, 1);
  assert.equal(deps.acquireProactive.mock.calls.length, 0);
  // 직전 발화가 복귀 인사가 아니니 잠 구간이라 접은 것으로 적는다
  assert.equal(out.status, "skipped");
  assert.equal("reason" in out && out.reason, "sleep_block");
});

test("구간 끝: pickReturnAction이 rearm이면 자기 행을 재예약으로 닫고 다음 구간 행을 건다", async () => {
  const { chatId, characterId } = room();
  logMessage(chatId, characterId, "assistant", "이따 얘기하자", AT, {
    kind: "reply",
  });
  // rearm은 지금 블록(cur)이 있을 때만 접는다 — cur가 없으면 between도 null이라 이 if를
  // 그냥 지나쳐 문안 생성 경로로 넘어간다. 그 갈래는 각본이 있어야만 실제로 벌어지는
  // 조합이라, 각본을 깔아 cur를 채워서 검사한다.
  saveDayPlan(
    characterId,
    PLAN_DATE,
    JSON.stringify({
      date: PLAN_DATE,
      blocks: [block("11:00", "12:00", "외출", "unavailable")],
    }),
  );
  mock.timers.setTime(clockToEpoch("11:30"));
  const own = plantRow("block_end", chatId, characterId, "구간끝:10:00", {
    activity: "회의",
    blockStart: "10:00",
    blockEnd: "11:00",
  });
  const deps = baseWakeDeps({ pickReturnAction: mock.fn(() => "rearm") });
  const out = await createWakeHandler(deps)(own);
  assert.equal(deps.acquireProactive.mock.calls.length, 0);
  assert.equal(out.status, "skipped");
  assert.equal("reason" in out && out.reason, "rescheduled");
  // 핸들러가 한 트랜잭션에서 자기 행을 닫고 다음 구간 행을 넣었다
  assert.deepEqual(statusOf(own.id), {
    status: "skipped",
    reason: "rescheduled",
  });
  const next = getWaitingOutboxRows(["block_end"]).filter(
    (r) => r.chat_id === chatId,
  );
  assert.equal(next.length, 1);
  assert.equal(next[0]?.dedupe_key, "구간끝:11:00");
});

test("구간 끝: 복귀 인사 차례인데 선톡 자리가 차 있으면 잠금 충돌로 돌려준다", async () => {
  const { chatId, characterId } = room();
  logMessage(chatId, characterId, "assistant", "이따 얘기하자", AT, {
    kind: "reply",
  });
  const deps = baseWakeDeps({
    pickReturnAction: mock.fn(() => "greet"),
    acquireProactive: mock.fn(() => false),
  });
  const out = await createWakeHandler(deps)(
    rowOf({ chat_id: chatId, character_id: characterId }),
  );
  assert.equal(deps.acquireProactive.mock.calls.length, 1);
  // 자리를 못 잡으면 try에 들어가지 않으니(문안도 안 만들고) releaseProactive도 안 부른다.
  assert.equal(deps.releaseProactive.mock.calls.length, 0);
  assert.equal(out.status, "busy");
});

test("구간 끝: 첫 발화가 적힌 행인데 직전 발화가 캐릭터 것이면 다른 경로가 답한 것으로 닫는다", async () => {
  const { chatId, characterId } = room();
  logMessage(chatId, characterId, "assistant", "응 봤어", AT, {
    kind: "reply",
  });
  const deps = baseWakeDeps({ pickReturnAction: mock.fn(() => "greet") });
  const out = await createWakeHandler(deps)(
    rowOf({
      chat_id: chatId,
      character_id: characterId,
      payload_json: JSON.stringify({ userFirstAt: AT }),
    }),
  );
  // 잠금 대기를 돌지 않는다 — 선톡 자리를 잡으러 가지 않는다
  assert.equal(deps.acquireProactive.mock.calls.length, 0);
  assert.equal(out.status, "skipped");
  assert.equal("reason" in out && out.reason, "conversation_moved");
});

// ── 약속 핸들러 ────────────────────────────────────────────────────────

test("약속: 구간 끝 행이 걸려 있으면 그쪽에 맡기고 양보로 닫는다(deferred)", async () => {
  const { chatId, characterId } = room();
  plantRow("block_end", chatId, characterId, "구간끝:08:00", {
    activity: "출근",
    blockStart: "08:00",
    blockEnd: "09:00",
  });
  const deps = basePromiseDeps();
  const out = await createPromiseHandler(deps)(
    rowOf({ chat_id: chatId, character_id: characterId, kind: "promise" }),
  );
  assert.equal(deps.isBusy.mock.calls.length, 0);
  assert.equal(out.status, "dropped");
  assert.equal("reason" in out && out.reason, "yielded");
});

test("약속: 답장을 만드는 중이면 시도로 세지 않고 다시 걸게 잠금 충돌로 돌려준다", async () => {
  const { chatId, characterId } = room();
  const deps = basePromiseDeps({ isBusy: mock.fn(() => true) });
  const out = await createPromiseHandler(deps)(
    rowOf({ chat_id: chatId, character_id: characterId, kind: "promise" }),
  );
  assert.deepEqual(out, { status: "busy", detail: "답장을 만드는 중" });
});

test("약속: 지금이 불가 구간이면 자기 행을 닫고 keepPromise로 다시 걸거나 자리가 없으면 행을 남긴다", async () => {
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
  const payload = {
    activity: "팀 회의",
    blockStart: "13:00",
    blockEnd: "14:00",
    promise: "회의 끝나고 연락",
    userMsgAt: AT,
  };
  const row = plantRow("promise", chatId, characterId, "약속:5", payload, 5);

  // 다시 걸 블록이 있으면 그 값 그대로 keepPromise를 부르고, 자기 행은 재예약으로 닫힌다.
  const kept = {
    sendAt: "2026-09-07 14:00:30",
    block: "14:00",
    activity: "팀 회의",
    replaced: 0,
  };
  const deps = basePromiseDeps({ keepPromise: mock.fn(() => kept) });
  const out = await createPromiseHandler(deps)(row);
  assert.equal(deps.keepPromise.mock.calls.length, 1);
  assert.deepEqual(deps.keepPromise.mock.calls[0].arguments, [
    chatId,
    characterId,
    AT,
    "회의 끝나고 연락",
    5,
    row.id,
  ]);
  assert.equal("reason" in out && out.reason, "rescheduled");
  assert.deepEqual(statusOf(row.id), {
    status: "skipped",
    reason: "rescheduled",
  });

  // 자리가 없어 keepPromise가 null을 돌려주면 자기 행을 닫은 것까지 되돌리고 no_slot을 돌려준다.
  // 행을 닫는 일은 결과를 받은 pending.ts가 한다.
  const again = plantRow("promise", chatId, characterId, "약속:5", payload, 5);
  const depsNoSlot = basePromiseDeps({ keepPromise: mock.fn(() => null) });
  const noSlot = await createPromiseHandler(depsNoSlot)(again);
  assert.equal(depsNoSlot.keepPromise.mock.calls.length, 1);
  assert.equal(noSlot.status, "skipped");
  assert.equal("reason" in noSlot && noSlot.reason, "no_slot");
  assert.deepEqual(statusOf(again.id), { status: "waiting", reason: null });
});

test("약속: 온 말도 이어 붙일 직전 발화도 없으면 건너뛴다(no_turn)", async () => {
  const { chatId, characterId } = room();
  const deps = basePromiseDeps();
  const out = await createPromiseHandler(deps)(
    rowOf({ chat_id: chatId, character_id: characterId, kind: "promise" }),
  );
  assert.equal(deps.acquireProactive.mock.calls.length, 0);
  assert.equal(out.status, "skipped");
  assert.equal("reason" in out && out.reason, "no_turn");
});

test("약속: 먼저 연락할 차례인데 선톡 자리가 차 있으면 잠금 충돌로 돌려준다", async () => {
  const { chatId, characterId } = room();
  logMessage(chatId, characterId, "assistant", "이따 다시 연락할게", AT, {
    kind: "reply",
  });
  const deps = basePromiseDeps({ acquireProactive: mock.fn(() => false) });
  const out = await createPromiseHandler(deps)(
    rowOf({ chat_id: chatId, character_id: characterId, kind: "promise" }),
  );
  assert.deepEqual(out, { status: "busy", detail: "선톡 자리가 차 있음" });
  assert.equal(deps.releaseProactive.mock.calls.length, 0);
});
