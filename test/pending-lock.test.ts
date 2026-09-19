// 구간 끝·약속 행이 선톡 잠금에 막혔을 때 행을 어떻게 다루는지 검사한다(#476).
//
// 핸들러가 busy를 돌려주면 시도로 세지 않는다. 행은 기다리는 채로 남아 지금 자리의 재시도
// 간격 뒤에 다시 울리고, 처음 막힌 시각을 종류별 값의 lockSince에 한 번만 적는다. 그 시각부터
// 30분이 지나면 양보(dropped/yielded)로 닫고 상세에 "잠금 충돌 — …"을 남긴다. 닫을 때 복구
// 표시는 건드리지 않는다. 실제 핸들러는 첫 발화 시각이 있는 구간 끝 행에 busy를 돌려주지
// 않지만, 가짜 핸들러로 그 경우를 만들어 닫는 자리가 표시를 지우지 않는지 본다.
//
// DB는 임시 파일로 새로 만든다. 핸들러는 가짜로 넣고, 남은 타이머는 끝에 전부 거둔다.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";

// DB 경로를 정한 뒤에 읽어야 임시 파일로 열린다 — 정적 import는 이 줄들보다 먼저 돈다.
const {
  db,
  getRecoveryMark,
  getWaitingOutboxRows,
  insertOutboxRow,
  setRecoveryMark,
} = await import("../src/db.js");
const { createFixtureCharacter } =
  await import("../src/eval/fixture-character.js");
const {
  dropPromiseRows,
  dropWakeRows,
  isWaiting,
  resumePendingReplies,
  setPromiseHandler,
  setWakeHandler,
} = await import("../src/pending.js");

// KST 벽시계 "YYYY-MM-DD HH:MM:SS" — pending.ts의 stampAfter와 같은 모양.
const stampAfter = (ms: number): string =>
  new Date(Date.now() + 9 * 3600_000 + ms)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");

const USER_AT = "2026-09-20 10:20:00";
const BLOCK = { activity: "회의", blockStart: "10:00", blockEnd: "11:00" };

const plant = (
  chatId: string,
  kind: "block_end" | "promise",
  payload: object,
): number => {
  const characterId = createFixtureCharacter(chatId);
  const id = insertOutboxRow({
    kind,
    chatId,
    characterId,
    dedupeKey: `lock:${chatId}`,
    // 보낼 시각이 지나 있어 이어받자마자 울린다.
    sendAt: stampAfter(-60_000),
    payload,
    createdAt: stampAfter(-60_000),
  });
  assert.ok(id, `${chatId} 행을 넣지 못했다`);
  return id;
};

interface Row {
  status: string;
  reason: string | null;
  detail: string | null;
  attempts: number;
  payload_json: string;
}
const rowOf = (id: number): Row =>
  db
    .prepare(
      `SELECT status, reason, detail, attempts, payload_json FROM outbox WHERE id = ?`,
    )
    .get(id) as Row;
const lockSinceOf = (id: number): unknown =>
  (JSON.parse(rowOf(id).payload_json) as { lockSince?: unknown }).lockSince;

// 처음 막힌 구간 끝 행, 29분째 막혀 있는 구간 끝 행, 31분째 막혀 있는 구간 끝 행과 약속 행.
const fresh = plant("chat-lock-fresh", "block_end", { ...BLOCK, userFirstAt: USER_AT });
const underSince = stampAfter(-29 * 60_000);
const under = plant("chat-lock-under", "block_end", {
  ...BLOCK,
  userFirstAt: USER_AT,
  lockSince: underSince,
});
const capped = plant("chat-lock-capped", "block_end", {
  ...BLOCK,
  userFirstAt: USER_AT,
  lockSince: stampAfter(-31 * 60_000),
});
const promise = plant("chat-lock-promise", "promise", {
  ...BLOCK,
  promise: "회의 끝나고 연락할게",
  userMsgAt: USER_AT,
  lockSince: stampAfter(-31 * 60_000),
});
// 구간 끝 행이 책임지고 있던 복구 표시 — 잠금 충돌로 닫혀도 그대로 있어야 한다.
setRecoveryMark("chat-lock-capped", USER_AT);

const wakeCalls: number[] = [];
const promiseCalls: number[] = [];

before(async () => {
  setWakeHandler(async (row) => {
    wakeCalls.push(row.id);
    return { status: "busy", detail: "선톡 자리가 차 있음" };
  });
  setPromiseHandler(async (row) => {
    promiseCalls.push(row.id);
    return { status: "busy", detail: "답장을 만드는 중" };
  });
  resumePendingReplies();
  // 보낼 시각이 지난 행이라 바로 울린다. 핸들러가 비동기라 한 틱 더 기다린다.
  await new Promise((r) => setTimeout(r, 200));
});

after(() => {
  // 다시 걸린 행의 타이머를 거둬 프로세스가 매달리지 않게 한다.
  for (const r of getWaitingOutboxRows()) {
    dropWakeRows(r.chat_id);
    dropPromiseRows(r.chat_id);
  }
  db.close();
});

test("잠금에 막힌 행은 한 번씩 울렸다", () => {
  assert.deepEqual(
    wakeCalls.sort((a, b) => a - b),
    [fresh, under, capped].sort((a, b) => a - b),
  );
  assert.deepEqual(promiseCalls, [promise]);
});

test("처음 막힌 행은 시도로 세지 않고 기다리는 채로 남아 막힌 시각을 적는다", () => {
  const r = rowOf(fresh);
  assert.equal(r.status, "waiting");
  assert.equal(r.attempts, 0);
  assert.equal(r.detail, "선톡 자리가 차 있음");
  assert.equal(typeof lockSinceOf(fresh), "string");
  // 유저가 답을 기다리는 중이라는 판정도 그대로다.
  assert.equal(isWaiting("chat-lock-fresh"), true);
});

test("이미 막혀 있던 행은 처음 막힌 시각을 덮어쓰지 않는다", () => {
  const r = rowOf(under);
  assert.equal(r.status, "waiting");
  assert.equal(r.attempts, 0);
  assert.equal(lockSinceOf(under), underSince);
});

test("30분 넘게 막힌 구간 끝 행은 양보로 닫고 복구 표시는 남긴다", () => {
  const r = rowOf(capped);
  assert.equal(r.status, "dropped");
  assert.equal(r.reason, "yielded");
  assert.equal(r.detail, "잠금 충돌 — 선톡 자리가 차 있음");
  assert.equal(r.attempts, 0);
  assert.equal(getRecoveryMark("chat-lock-capped"), USER_AT);
});

test("30분 넘게 막힌 약속 행도 양보로 닫는다", () => {
  const r = rowOf(promise);
  assert.equal(r.status, "dropped");
  assert.equal(r.reason, "yielded");
  assert.equal(r.detail, "잠금 충돌 — 답장을 만드는 중");
  assert.equal(r.attempts, 0);
});
