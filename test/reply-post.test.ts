// 답장 게시 준비(trace/reply-post.ts)가 아직 안 올린 호출을 순서대로 게시함에 쌓는지 검사한다 — 모델도 슬랙도 부르지 않는다.
//
// 호출 행은 recordLlmCall로 만들고 판단 근거는 setCallContext로 붙인다. 그날 첫 호출에 고정
// 두 덩이가 한 번만 오르는지, 층 하나가 바뀌면 그 층의 바뀐 줄만 오르는지, 근거가 아직 없는
// 방금 행에서 루프가 멈춰 뒤 행의 순서를 지키는지, 오래된 행은 표시만 하고 안 올리는지,
// 재생성 호출이 원래 답장 스레드에 달리는지 본다. 만든 시각을 과거로 돌릴 때는 created_at을
// 직접 고친다.
//
// DB는 임시 파일로 새로 만들고 슬랙 토큰은 가짜다 — 게시함에 쌓기까지만 보므로 밖으로
// 나가는 것은 없다.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmCallInput } from "../src/db.js";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";
process.env.SLACK_BOT_TOKEN = "test-slack-token";
process.env.SLACK_TRACE_CHANNEL = "C_TEST";

// DB 경로와 슬랙 값을 정한 뒤에 읽어야 임시 파일로 열리고 트레이스가 켜진다.
const { db, recordLlmCall, setCallContext } = await import("../src/db.js");
const { CONTEXT_GRACE_MS, enqueueReplyTraces, MAX_AGE_MS } =
  await import("../src/trace/reply-post.js");

after(() => {
  db.close();
});

// ── 재료 ────────────────────────────────────────────────────────────────

const newCharacter = (chatId: string): number =>
  Number(
    db
      .prepare(
        `INSERT INTO characters (chat_id, status, genesis_json, created_at)
         VALUES (?, 'active', '{}', '2026-09-01 12:00:00') RETURNING id`,
      )
      .pluck()
      .get(chatId),
  );

const FIXED = "[캐릭터]\n이름 하람\n[규칙]\n짧게 답한다";
const DAILY = "[오늘 각본]\n09:00~18:00 일\n[오늘 메모]\n- 없음";
const TAIL = "[지금]\n14:00 사무실";

const blocks = (daily = DAILY, fixed = FIXED): LlmCallInput["system"] => [
  { text: fixed, cache: true },
  { text: daily, cache: true },
  { text: TAIL },
];

// 답장 호출에 붙는 최소한의 판단 근거. 근거가 붙어야 유예 없이 바로 올라간다.
const CTX = { timing: { waitMs: 1000, path: "table", block: null } };

const call = (characterId: number, over: Partial<LlmCallInput> = {}): number =>
  recordLlmCall({
    purpose: "reply",
    model: "claude-sonnet-5",
    characterId,
    chatId: String(characterId),
    system: blocks(),
    turns: "[user] 지금 뭐 해?",
    output: '{"bubbles":["일하는 중"]}',
    usage: { input: 100, cacheWrite: 0, cacheRead: 900, output: 30 },
    latencyMs: 1200,
    ...over,
  });

interface EventRow {
  id: number;
  kind: string;
  dedupe_key: string | null;
  thread_key: string | null;
  parent_key: string | null;
  text: string;
}

const eventsOf = (characterId: number): EventRow[] =>
  db
    .prepare(
      `SELECT id, kind, dedupe_key, thread_key, parent_key, text
         FROM trace_events WHERE character_id = ? ORDER BY id`,
    )
    .all(characterId) as EventRow[];

const kinds = (rows: EventRow[]): string[] => rows.map((r) => r.kind);

const traced = (callId: number): number =>
  (
    db.prepare(`SELECT traced FROM llm_calls WHERE id = ?`).get(callId) as {
      traced: number;
    }
  ).traced;

// created_at은 KST 벽시계 문자열이라 지금 시각에 9시간을 더한 뒤 ms만큼 되돌린다.
const backdate = (callId: number, ms: number): void => {
  const stamp = new Date(Date.now() + 9 * 3600_000 - ms)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  db.prepare(`UPDATE llm_calls SET created_at = ? WHERE id = ?`).run(
    stamp,
    callId,
  );
};

// ── 하루 고정 두 덩이 ───────────────────────────────────────────────────

const charA = newCharacter("chat-post-a");

test("그날 첫 호출은 고정 두 덩이 한 벌과 답장 한 장을 쌓는다", () => {
  const id = call(charA);
  setCallContext(id, CTX);
  enqueueReplyTraces();
  const rows = eventsOf(charA);
  assert.deepEqual(kinds(rows), [
    "prompt_day",
    "prompt_day_body",
    "prompt_day_body",
    "call_reply",
    "call_tail",
  ]);
  const [day, fixedBody, dailyBody, reply, tail] = rows;
  assert.match(
    day.dedupe_key ?? "",
    new RegExp(`^prompt_full:${charA}:\\d{4}-\\d{2}-\\d{2}$`),
  );
  assert.equal(day.thread_key, day.dedupe_key);
  assert.ok(day.text.startsWith(":page_facing_up: *"));
  assert.ok(day.text.includes(`호출 #${id}부터 이 내용으로 답한다`));
  assert.equal(fixedBody.parent_key, day.dedupe_key);
  assert.equal(
    fixedBody.text,
    `잘 바뀌지 않는 데이터\n\`\`\`\n${FIXED}\n\`\`\``,
  );
  assert.equal(dailyBody.parent_key, day.dedupe_key);
  assert.equal(
    dailyBody.text,
    `하루 동안 같은 데이터\n\`\`\`\n${DAILY}\n\`\`\``,
  );
  assert.equal(reply.dedupe_key, `call:${id}`);
  assert.equal(reply.thread_key, `call:${id}`);
  assert.equal(tail.parent_key, `call:${id}`);
  assert.equal(tail.text, `실시간 꼬리\n\`\`\`\n${TAIL}\n\`\`\``);
  assert.equal(traced(id), 1);
});

test("같은 날 같은 해시의 두 번째 호출은 답장 한 장만 더 쌓는다", () => {
  const before = eventsOf(charA).length;
  const id = call(charA);
  setCallContext(id, CTX);
  enqueueReplyTraces();
  const rows = eventsOf(charA).slice(before);
  assert.deepEqual(kinds(rows), ["call_reply", "call_tail"]);
  assert.equal(rows[0].dedupe_key, `call:${id}`);
  assert.equal(traced(id), 1);
});

test("앞 두 층 중 하나만 바뀌면 그 층의 바뀐 줄만 쌓는다", () => {
  // 하루 동안 같은 데이터(1층)의 오늘 메모만 바뀐 호출.
  let before = eventsOf(charA).length;
  const id = call(charA, {
    system: blocks("[오늘 각본]\n09:00~18:00 일\n[오늘 메모]\n- 두 시 반 병원"),
  });
  setCallContext(id, CTX);
  enqueueReplyTraces();
  let rows = eventsOf(charA).slice(before);
  assert.deepEqual(kinds(rows), [
    "prompt_change",
    "prompt_change_body",
    "call_reply",
    "call_tail",
  ]);
  const [change, body] = rows;
  assert.ok(change.dedupe_key?.startsWith(`prompt_change:${charA}:daily:`));
  assert.equal(change.thread_key, change.dedupe_key);
  assert.ok(change.text.startsWith(":pencil2: *바뀐 부분 — 오늘 메모* · "));
  assert.ok(change.text.endsWith(`호출 #${id}부터`));
  assert.equal(body.parent_key, change.dedupe_key);
  assert.ok(body.text.includes("두 시 반 병원"));
  assert.ok(!rows.some((r) => r.dedupe_key?.includes(":fixed:")));

  // 이어서 잘 바뀌지 않는 데이터(0층)만 바뀌면 fixed 쪽 하나만 쌓인다.
  before = eventsOf(charA).length;
  const next = call(charA, {
    system: blocks(
      "[오늘 각본]\n09:00~18:00 일\n[오늘 메모]\n- 두 시 반 병원",
      "[캐릭터]\n이름 하람\n[규칙]\n길게 답한다",
    ),
  });
  setCallContext(next, CTX);
  enqueueReplyTraces();
  rows = eventsOf(charA).slice(before);
  assert.deepEqual(kinds(rows), [
    "prompt_change",
    "prompt_change_body",
    "call_reply",
    "call_tail",
  ]);
  assert.ok(rows[0].dedupe_key?.startsWith(`prompt_change:${charA}:fixed:`));
  assert.ok(rows[0].text.startsWith(":pencil2: *바뀐 부분 — 규칙* · "));
  assert.ok(!rows.some((r) => r.dedupe_key?.includes(":daily:")));
});

// ── 루프의 멈춤과 건너뜀 ───────────────────────────────────────────────

test("판단 근거가 아직 없는 방금 행에서 멈춰 뒤 행을 먼저 올리지 않는다", () => {
  const charB = newCharacter("chat-post-b");
  const first = call(charB);
  const second = call(charB);
  setCallContext(second, CTX);
  enqueueReplyTraces();
  assert.equal(eventsOf(charB).length, 0);
  assert.equal(traced(first), 0);
  assert.equal(traced(second), 0);

  // 근거가 붙으면 다음 틱에 앞 행부터 차례로 올라간다.
  setCallContext(first, CTX);
  enqueueReplyTraces();
  const rows = eventsOf(charB);
  assert.deepEqual(kinds(rows), [
    "prompt_day",
    "prompt_day_body",
    "prompt_day_body",
    "call_reply",
    "call_tail",
    "call_reply",
    "call_tail",
  ]);
  assert.deepEqual(
    rows.filter((r) => r.kind === "call_reply").map((r) => r.dedupe_key),
    [`call:${first}`, `call:${second}`],
  );
  assert.equal(traced(first), 1);
  assert.equal(traced(second), 1);
});

test("근거 없이 유예가 지난 행은 근거가 없다는 표시로 올린다", () => {
  const charE = newCharacter("chat-post-e");
  const id = call(charE);
  backdate(id, CONTEXT_GRACE_MS + 60_000);
  enqueueReplyTraces();
  const reply = eventsOf(charE).find((r) => r.kind === "call_reply");
  assert.ok(reply);
  assert.equal(reply.dedupe_key, `call:${id}`);
  assert.ok(reply.text.includes("_판단 근거가 붙지 않았다"));
  assert.equal(traced(id), 1);
});

test("너무 오래된 행은 표시만 하고 게시함에 쌓지 않는다", () => {
  const charC = newCharacter("chat-post-c");
  const id = call(charC);
  setCallContext(id, CTX);
  backdate(id, MAX_AGE_MS + 60_000);
  enqueueReplyTraces();
  assert.equal(traced(id), 1);
  assert.deepEqual(eventsOf(charC), []);
});

test("올리는 목적이 아닌 호출은 건드리지 않는다", () => {
  const charF = newCharacter("chat-post-f");
  const id = call(charF, { purpose: "tags", output: '["일"]' });
  enqueueReplyTraces();
  assert.equal(traced(id), 0);
  assert.deepEqual(eventsOf(charF), []);
});

// ── 재생성과 붙잡기 판정 ───────────────────────────────────────────────

test("재생성 호출은 원래 답장 스레드에 달리고 고정 두 덩이는 다시 견주지 않는다", () => {
  const charD = newCharacter("chat-post-d");
  const parent = call(charD);
  setCallContext(parent, CTX);
  enqueueReplyTraces();
  const before = eventsOf(charD).length;
  assert.ok(before > 0);

  // 앞 두 층이 달라도 재생성은 바뀐 줄을 올리지 않는다.
  const retry = call(charD, {
    attempt: 2,
    system: blocks("[오늘 각본]\n09:00~18:00 일\n[오늘 메모]\n- 다른 값"),
    output: "다시 쓴 답",
  });
  setCallContext(retry, { partOf: parent });
  enqueueReplyTraces();
  const rows = eventsOf(charD).slice(before);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "call_retry");
  assert.equal(rows[0].dedupe_key, `call:${retry}`);
  assert.equal(rows[0].parent_key, `call:${parent}`);
  assert.ok(rows[0].text.startsWith(`:repeat: *재생성* · 호출 #${retry} · `));
  assert.ok(
    rows[0].text.includes(`답장 #${parent}의 첫 답이 비어 다시 불렀다`),
  );
  assert.ok(rows[0].text.includes("> 다시 쓴 답"));
  assert.equal(traced(retry), 1);
});

test("붙잡기 판정 호출은 고정 두 덩이를 견주지 않고 한 장만 쌓는다", () => {
  const charG = newCharacter("chat-post-g");
  const id = call(charG, {
    purpose: "hold",
    system: [{ text: "붙잡을지 yes/no로만 답한다" }],
    turns: "[user] 지금 통화 돼?",
    output: "no",
    usage: { input: 40, cacheWrite: 0, cacheRead: 0, output: 1 },
  });
  enqueueReplyTraces();
  const rows = eventsOf(charG);
  assert.deepEqual(kinds(rows), ["call_hold"]);
  assert.equal(rows[0].dedupe_key, `call:${id}`);
  assert.ok(rows[0].text.startsWith(`:mag: *붙잡기 판정* · 호출 #${id} · `));
  assert.ok(rows[0].text.includes("> 지금 통화 돼?"));
  assert.equal(traced(id), 1);
});
