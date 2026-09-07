// 게시함(trace_events)과 모델 호출(llm_calls·prompt_blobs)의 오래된 행 정리가 남길 것을 남기는지 검사한다.
//
// 게시함은 기한이 지나도 아직 못 올린 행과 그런 자식이 매달린 부모를 남겨야 하고, 호출 표는
// 기한이 지나면 본문만 비우되 사람이 표시를 남긴 호출은 그대로 두고 아무도 안 가리키는 본문만
// 지워야 한다. 조건이 NULL을 내면 행이 조용히 안 지워지는 함정이 있어(trace-events.ts 주석)
// parent_key·thread_key가 NULL인 행을 꼭 넣는다. 본문 저장과 사용량 누적, 스레드 부모 찾기도
// 여기서 본다. 오래된 행은 넣을 때 시각을 과거로 주거나 넣은 뒤 UPDATE로 민다.
//
// DB는 임시 파일로 새로 만든다. 모델도 슬랙도 부르지 않아 값이 안 든다.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

// DB 경로를 정한 뒤에 읽어야 임시 파일로 열린다 — 정적 import는 이 줄들보다 먼저 돈다.
const {
  db,
  getBlob,
  insertFeedback,
  insertTraceEvent,
  markTraceEventSent,
  pruneLlmCalls,
  pruneTraceEvents,
  putBlob,
  recordLlmCall,
  recordLlmUsage,
  removeFeedback,
  setCallContext,
  traceParentOf,
} = await import("../src/db.js");
const { getKstNow, kstDateString } = await import("../src/kst.js");
const { createFixtureCharacter } =
  await import("../src/eval/fixture-character.js");

const characterId = createFixtureCharacter("chat-prune");

// 정리 함수가 쓰는 것과 같은 계산으로 n일 전 시각을 만든다 — 날짜 경계에서 어긋나지 않게.
const daysAgo = (n: number): string =>
  `${kstDateString(new Date(getKstNow().getTime() - n * 86400000))} 10:00:00`;

after(() => db.close());

// ── 본문 저장·사용량·스레드 부모 ──────────────────────────────────────────
// 아래 정리 검사보다 앞에 둔다 — 정리는 아무 호출도 안 가리키는 본문을 지운다.

test("같은 본문을 두 번 넣으면 해시가 같고 행은 하나이며 마지막으로 쓴 시각만 오른다", () => {
  const text = "같은 프롬프트 본문";
  const h1 = putBlob(text);
  db.prepare(
    `UPDATE prompt_blobs SET first_seen_at = '2026-01-01 00:00:00', last_seen_at = '2026-01-01 00:00:00' WHERE hash = ?`,
  ).run(h1);
  const h2 = putBlob(text);
  assert.equal(h2, h1);
  const rows = db
    .prepare(
      `SELECT first_seen_at, last_seen_at FROM prompt_blobs WHERE hash = ?`,
    )
    .all(h1) as { first_seen_at: string; last_seen_at: string }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.first_seen_at, "2026-01-01 00:00:00");
  assert.notEqual(rows[0]?.last_seen_at, "2026-01-01 00:00:00");
  assert.equal(getBlob(h1), text);
});

test("같은 논리일·모델로 두 번 적으면 호출 수와 토큰이 누적된다", () => {
  const model = "test-usage-model";
  recordLlmUsage(model, 100, 10, 1000, 20);
  recordLlmUsage(model, 50, 5, 500, 30);
  const row = db
    .prepare(
      `SELECT calls, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens
         FROM llm_usage WHERE model = ?`,
    )
    .get(model) as {
    calls: number;
    input_tokens: number;
    cache_write_tokens: number;
    cache_read_tokens: number;
    output_tokens: number;
  };
  assert.deepEqual(row, {
    calls: 2,
    input_tokens: 150,
    cache_write_tokens: 15,
    cache_read_tokens: 1500,
    output_tokens: 50,
  });
});

const traceIdOf = (dedupeKey: string): number =>
  (
    db
      .prepare(`SELECT id FROM trace_events WHERE dedupe_key = ?`)
      .get(dedupeKey) as { id: number }
  ).id;

const traceExists = (dedupeKey: string): boolean =>
  !!db
    .prepare(`SELECT 1 FROM trace_events WHERE dedupe_key = ?`)
    .get(dedupeKey);

const putTrace = (
  dedupeKey: string,
  p: { threadKey?: string; parentKey?: string; createdAt?: string } = {},
): number => {
  insertTraceEvent({
    characterId,
    kind: "test",
    dedupeKey,
    threadKey: p.threadKey ?? null,
    parentKey: p.parentKey ?? null,
    text: dedupeKey,
    createdAt: p.createdAt ?? daysAgo(0),
  });
  return traceIdOf(dedupeKey);
};

test("같은 스레드 키가 여럿이면 마지막 행의 상태와 슬랙 ts를 준다", () => {
  const first = putTrace("parent-first", { threadKey: "thread-dup" });
  markTraceEventSent(first, "111.000");
  const second = putTrace("parent-second", { threadKey: "thread-dup" });
  assert.deepEqual(traceParentOf("thread-dup"), {
    status: "pending",
    slack_ts: null,
  });
  markTraceEventSent(second, "222.000");
  assert.deepEqual(traceParentOf("thread-dup"), {
    status: "sent",
    slack_ts: "222.000",
  });
  assert.equal(traceParentOf("thread-none"), undefined);
});

// ── 게시함 정리 ───────────────────────────────────────────────────────────

test("기한이 지난 게시 행을 지우되 아직 못 올린 행은 남긴다", () => {
  putTrace("old-pending", { createdAt: daysAgo(40) });
  const oldSent = putTrace("old-sent-plain", { createdAt: daysAgo(40) });
  markTraceEventSent(oldSent, "1.0");
  const oldFailed = putTrace("old-failed", { createdAt: daysAgo(40) });
  db.prepare(`UPDATE trace_events SET status = 'failed' WHERE id = ?`).run(
    oldFailed,
  );
  const recentSent = putTrace("recent-sent", { createdAt: daysAgo(3) });
  markTraceEventSent(recentSent, "2.0");
  putTrace("recent-pending", { createdAt: daysAgo(1) });

  const removed = pruneTraceEvents(30);
  assert.equal(removed, 2);
  assert.equal(traceExists("old-pending"), true);
  assert.equal(traceExists("old-sent-plain"), false);
  assert.equal(traceExists("old-failed"), false);
  assert.equal(traceExists("recent-sent"), true);
  assert.equal(traceExists("recent-pending"), true);
});

test("스레드 키가 있어도 못 올린 자식이 없으면 지우고, 자식이 남아 있으면 부모를 남긴다", () => {
  const lonely = putTrace("old-parent-lonely", {
    threadKey: "thread-lonely",
    createdAt: daysAgo(40),
  });
  markTraceEventSent(lonely, "3.0");
  const doneChildParent = putTrace("old-parent-done", {
    threadKey: "thread-done",
    createdAt: daysAgo(40),
  });
  markTraceEventSent(doneChildParent, "4.0");
  const doneChild = putTrace("old-child-done", {
    parentKey: "thread-done",
    createdAt: daysAgo(40),
  });
  markTraceEventSent(doneChild, "4.1");
  const held = putTrace("old-parent-held", {
    threadKey: "thread-held",
    createdAt: daysAgo(40),
  });
  markTraceEventSent(held, "5.0");
  putTrace("old-child-held", {
    parentKey: "thread-held",
    createdAt: daysAgo(40),
  });

  const removed = pruneTraceEvents(30);
  assert.equal(removed, 3);
  assert.equal(traceExists("old-parent-lonely"), false);
  assert.equal(traceExists("old-parent-done"), false);
  assert.equal(traceExists("old-child-done"), false);
  assert.equal(traceExists("old-parent-held"), true);
  assert.equal(traceExists("old-child-held"), true);
});

test("스레드 키와 부모 키가 둘 다 NULL인 옛 행도 조용히 남지 않고 지워진다", () => {
  // NOT (거짓 OR NULL)은 NULL이라, 남길 조건이 NULL을 내면 이 행이 안 지워진다.
  // 어떤 pending 행의 parent_key가 NULL이어도 IN 절이 NULL을 내지 않아야 한다.
  putTrace("pending-no-parent", { createdAt: daysAgo(40) });
  const bare = putTrace("old-bare", { createdAt: daysAgo(40) });
  markTraceEventSent(bare, "6.0");
  assert.equal(pruneTraceEvents(30), 1);
  assert.equal(traceExists("old-bare"), false);
  assert.equal(traceExists("pending-no-parent"), true);
});

// ── 호출 정리 ─────────────────────────────────────────────────────────────

interface CallBody {
  system_hashes: string | null;
  turns_hash: string | null;
  output_hash: string | null;
  context_json: string | null;
  input_tokens: number | null;
  purpose: string;
}

const callOf = (id: number): CallBody =>
  db
    .prepare(
      `SELECT system_hashes, turns_hash, output_hash, context_json, input_tokens, purpose
         FROM llm_calls WHERE id = ?`,
    )
    .get(id) as CallBody;

const putCall = (
  tag: string,
  p: { system?: string; createdAt: string; output?: boolean },
): number => {
  const id = recordLlmCall({
    purpose: "reply",
    model: "test-model",
    characterId,
    system: [{ text: p.system ?? `SYS-${tag}`, cache: true }],
    turns: `TURNS-${tag}`,
    output: p.output === false ? undefined : `OUT-${tag}`,
    usage: { input: 10, cacheWrite: 0, cacheRead: 0, output: 5 },
    latencyMs: 100,
  });
  setCallContext(id, { tag });
  db.prepare(`UPDATE llm_calls SET created_at = ? WHERE id = ?`).run(
    p.createdAt,
    id,
  );
  return id;
};

const blobCount = (): number =>
  db.prepare(`SELECT COUNT(*) FROM prompt_blobs`).pluck().get() as number;

test("기한이 지난 호출은 본문 해시와 판단 근거만 비우고 메타는 남긴다", () => {
  const old = putCall("old", { createdAt: daysAgo(100) });
  const recent = putCall("recent", { createdAt: daysAgo(5) });
  const before = callOf(old);
  assert.ok(before.system_hashes && before.turns_hash && before.output_hash);
  assert.ok(before.context_json);

  const r = pruneLlmCalls(90);
  assert.equal(r.calls, 1);
  const after1 = callOf(old);
  assert.equal(after1.system_hashes, null);
  assert.equal(after1.turns_hash, null);
  assert.equal(after1.output_hash, null);
  assert.equal(after1.context_json, null);
  assert.equal(after1.input_tokens, 10);
  assert.equal(after1.purpose, "reply");
  const kept = callOf(recent);
  assert.ok(kept.system_hashes && kept.turns_hash && kept.output_hash);
  // 다시 돌려도 이미 비운 행은 세지 않는다.
  assert.equal(pruneLlmCalls(90).calls, 0);
});

test("사람이 표시를 남긴 호출은 기한이 지나도 본문을 비우지 않고, 뗀 표시면 비운다", () => {
  const marked = putCall("marked", { createdAt: daysAgo(100) });
  const unmarked = putCall("unmarked", { createdAt: daysAgo(100) });
  insertFeedback({
    characterId,
    callId: marked,
    slackTs: "700.001",
    traceKind: "reply",
    source: "reaction",
    kind: "tone",
    slackUser: "U1",
    text: null,
    replyTs: null,
    dedupeKey: "fb-marked",
    createdAt: daysAgo(99),
  });
  insertFeedback({
    characterId,
    callId: unmarked,
    slackTs: "700.002",
    traceKind: "reply",
    source: "reaction",
    kind: "tone",
    slackUser: "U1",
    text: null,
    replyTs: null,
    dedupeKey: "fb-unmarked",
    createdAt: daysAgo(99),
  });
  const removedId = (
    db
      .prepare(`SELECT id FROM call_feedback WHERE dedupe_key = 'fb-unmarked'`)
      .get() as { id: number }
  ).id;
  removeFeedback(removedId, daysAgo(98));

  // 해시는 정리 전에 받아 둔다 — putBlob은 없으면 다시 넣어서 정리 뒤에 부르면 검사가 안 된다.
  const markedTurns = putBlob("TURNS-marked");
  const unmarkedTurns = putBlob("TURNS-unmarked");
  assert.equal(pruneLlmCalls(90).calls, 1);
  assert.ok(callOf(marked).turns_hash);
  assert.equal(getBlob(markedTurns), "TURNS-marked");
  assert.equal(callOf(unmarked).turns_hash, null);
  assert.equal(getBlob(unmarkedTurns), null);
});

test("아무 호출도 가리키지 않게 된 본문만 지우고 아직 가리키는 본문은 남긴다", () => {
  const shared = "SYS-shared-layer";
  const oldA = putCall("blob-old", { system: shared, createdAt: daysAgo(100) });
  const recentB = putCall("blob-recent", {
    system: shared,
    createdAt: daysAgo(2),
  });
  const hashes = {
    shared: putBlob(shared),
    turnsOld: putBlob("TURNS-blob-old"),
    outOld: putBlob("OUT-blob-old"),
    turnsRecent: putBlob("TURNS-blob-recent"),
  };
  const before = blobCount();
  const r = pruneLlmCalls(90);
  assert.equal(r.calls, 1);
  assert.equal(r.blobs, before - blobCount());
  assert.equal(callOf(oldA).system_hashes, null);
  assert.ok(callOf(recentB).system_hashes);
  assert.equal(getBlob(hashes.turnsOld), null);
  assert.equal(getBlob(hashes.outOld), null);
  assert.equal(getBlob(hashes.shared), shared);
  assert.equal(getBlob(hashes.turnsRecent), "TURNS-blob-recent");
});
