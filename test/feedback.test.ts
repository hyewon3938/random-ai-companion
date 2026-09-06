// 슬랙 게시에 붙은 리액션과 스레드 답글이 call_feedback 행으로 쌓이는지 검사한다 — 모델은 부르지 않는다.
//
// syncReactions와 recordThreadReplies에 손으로 만든 리액션·답글 목록을 넣고 어떤 행이 생기는지,
// 뗀 표시는 지우지 않고 뗀 시각만 적는지, 같은 표시를 다시 읽어도 행이 늘지 않는지 본다.
// 우리가 올린 글은 게시함(trace_events)에 행을 넣고 보낸 것으로 표시해 흉내 낸다.
// 슬랙을 읽어 오는 틱(runFeedbackTick)은 돌리지 않는다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

const { db, recordLlmCall, insertTraceEvent, markTraceEventSent } =
  await import("../src/db.js");
const { syncReactions, recordThreadReplies } = await import(
  "../src/feedback.js"
);
const { createFixtureCharacter } = await import(
  "../src/eval/fixture-character.js"
);

const CHAT_ID = "1";
const characterId = createFixtureCharacter(CHAT_ID);

interface FeedbackRow {
  id: number;
  character_id: number | null;
  call_id: number | null;
  slack_ts: string;
  trace_kind: string | null;
  source: string;
  kind: string | null;
  slack_user: string | null;
  text: string | null;
  reply_ts: string | null;
  dedupe_key: string;
  created_at: string;
  removed_at: string | null;
}

const rowsOf = (slackTs: string): FeedbackRow[] =>
  db
    .prepare(
      `SELECT id, character_id, call_id, slack_ts, trace_kind, source, kind, slack_user,
              text, reply_ts, dedupe_key, created_at, removed_at
         FROM call_feedback WHERE slack_ts = ? ORDER BY id`,
    )
    .all(slackTs) as FeedbackRow[];

// 우리가 슬랙에 올린 글 하나를 흉내 낸다 — 게시함에 행을 넣고 보낸 것으로 표시해 slack_ts를 단다.
const posted = (dedupeKey: string, kind: string, slackTs: string): void => {
  insertTraceEvent({
    characterId,
    kind,
    dedupeKey,
    threadKey: dedupeKey,
    parentKey: null,
    text: "게시 글",
    createdAt: "2025-09-06 04:00:00",
  });
  const row = db
    .prepare(`SELECT id FROM trace_events WHERE dedupe_key = ?`)
    .get(dedupeKey) as { id: number };
  markTraceEventSent(row.id, slackTs);
};

const newCall = (): number =>
  recordLlmCall({
    purpose: "reply",
    model: "claude-sonnet-5",
    characterId,
    chatId: CHAT_ID,
    system: [],
    turns: "",
    latencyMs: 100,
  });

const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

test("답장 게시에 붙은 리액션이 호출 번호와 함께 쌓인다", () => {
  const callId = newCall();
  const ts = "1757100000.000100";
  posted(`call:${callId}`, "reply", ts);

  const r = syncReactions(ts, [{ kind: "fact", user: "U1" }]);
  assert.deepEqual(r, { added: 1, restored: 0, removed: 0 });

  const rows = rowsOf(ts);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.call_id, callId);
  assert.equal(row.character_id, characterId);
  assert.equal(row.trace_kind, "reply");
  assert.equal(row.source, "reaction");
  assert.equal(row.kind, "fact");
  assert.equal(row.slack_user, "U1");
  assert.equal(row.dedupe_key, `react:${ts}:fact:U1`);
  assert.equal(row.text, null);
  assert.equal(row.reply_ts, null);
  assert.match(row.created_at, STAMP);
  assert.equal(row.removed_at, null);
});

test("같은 표시를 다시 읽으면 행이 늘지 않는다", () => {
  const callId = newCall();
  const ts = "1757100001.000100";
  posted(`call:${callId}`, "reply", ts);

  assert.deepEqual(syncReactions(ts, [{ kind: "tone", user: "U1" }]), {
    added: 1,
    restored: 0,
    removed: 0,
  });
  assert.deepEqual(syncReactions(ts, [{ kind: "tone", user: "U1" }]), {
    added: 0,
    restored: 0,
    removed: 0,
  });
  assert.equal(rowsOf(ts).length, 1);
});

test("뗀 표시는 지우지 않고 뗀 시각을 적고 다시 붙이면 되살린다", () => {
  const callId = newCall();
  const ts = "1757100002.000100";
  posted(`call:${callId}`, "reply", ts);
  syncReactions(ts, [{ kind: "timing", user: "U1" }]);

  assert.deepEqual(syncReactions(ts, []), {
    added: 0,
    restored: 0,
    removed: 1,
  });
  let rows = rowsOf(ts);
  assert.equal(rows.length, 1);
  assert.match(rows[0].removed_at ?? "", STAMP);

  assert.deepEqual(syncReactions(ts, [{ kind: "timing", user: "U1" }]), {
    added: 0,
    restored: 1,
    removed: 0,
  });
  rows = rowsOf(ts);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].removed_at, null);
});

test("스레드 자식 글에 붙은 표시도 같은 호출로 이어진다", () => {
  const callId = newCall();
  const ts = "1757100003.000100";
  posted(`call:${callId}:sent`, "reply_sent", ts);

  assert.deepEqual(syncReactions(ts, [{ kind: "good", user: null }]), {
    added: 1,
    restored: 0,
    removed: 0,
  });
  const rows = rowsOf(ts);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].call_id, callId);
  assert.equal(rows[0].trace_kind, "reply_sent");
  assert.equal(rows[0].slack_user, null);
  assert.equal(rows[0].dedupe_key, `react:${ts}:good:?`);
});

test("지워진 호출을 가리키는 글의 표시는 호출 번호 없이 쌓인다", () => {
  const ts = "1757100004.000100";
  posted("call:999999", "reply", ts);

  assert.deepEqual(syncReactions(ts, [{ kind: "fact", user: "U3" }]), {
    added: 1,
    restored: 0,
    removed: 0,
  });
  const rows = rowsOf(ts);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].call_id, null);
  assert.equal(rows[0].character_id, characterId);
  assert.equal(rows[0].trace_kind, "reply");
});

test("우리가 올린 글이 아니면 표시도 답글도 쌓지 않는다", () => {
  const ts = "1757100005.000100";

  assert.deepEqual(syncReactions(ts, [{ kind: "fact", user: "U1" }]), {
    added: 0,
    restored: 0,
    removed: 0,
  });
  assert.equal(
    recordThreadReplies(ts, [
      { ts: "1757100006.000100", user: "U1", text: "여기는 남의 글" },
    ]),
    0,
  );
  assert.equal(rowsOf(ts).length, 0);
});

test("스레드 답글은 적힌 시각으로 쌓이고 빈 글과 이미 모은 글은 거른다", () => {
  const callId = newCall();
  const ts = "1757100007.000100";
  posted(`call:${callId}`, "reply", ts);
  const replies = [
    { ts: "1757120000.000300", user: "U2", text: "  말투가 딱딱하다  " },
    { ts: "1757120001.000400", user: "U2", text: "   " },
  ];

  assert.equal(recordThreadReplies(ts, replies), 1);
  const rows = rowsOf(ts);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.call_id, callId);
  assert.equal(row.source, "reply");
  assert.equal(row.kind, null);
  assert.equal(row.slack_user, "U2");
  assert.equal(row.text, "말투가 딱딱하다");
  assert.equal(row.reply_ts, "1757120000.000300");
  assert.equal(row.dedupe_key, "reply:1757120000.000300");
  // 슬랙 ts 1757120000초를 KST로 옮긴 값. 만든 시각이 아니라 답글이 적힌 시각이다.
  assert.equal(row.created_at, "2025-09-06 09:53:20");

  assert.equal(recordThreadReplies(ts, replies), 0);
  assert.equal(rowsOf(ts).length, 1);

  // 리액션 동기화는 답글 행을 건드리지 않는다.
  assert.deepEqual(syncReactions(ts, []), {
    added: 0,
    restored: 0,
    removed: 0,
  });
  assert.equal(rowsOf(ts)[0].removed_at, null);
});
