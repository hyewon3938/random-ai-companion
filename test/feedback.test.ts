// 슬랙 게시에 붙은 리액션과 스레드 답글이 call_feedback 행으로 쌓이는지 검사한다 — 모델은 부르지 않는다.
//
// syncReactions와 recordThreadReplies에 손으로 만든 리액션·답글 목록을 넣고 어떤 행이 생기는지,
// 뗀 표시는 지우지 않고 뗀 시각만 적는지, 같은 표시를 다시 읽어도 행이 늘지 않는지 본다.
// 분류 밖 이모지도 이름으로 쌓이는지, 스레드 안 글에 단 표시가 게시 키·부모 글·호출 번호를 제대로
// 받는지, 선톡 발송 게시(call:N:send·scheduled:N:send)에 단 표시가 어느 문안인지 가리키는지도 본다.
// 우리가 올린 글은 트레이스 표(trace_events)에 행을 넣고 보낸 것으로 표시해 흉내 낸다.
// 슬랙을 읽어 오는 틱(runFeedbackTick)은 돌리지 않고, 슬랙 응답을 펴는 liveReactionsOf와 스레드를
// 열지 정하는 shouldOpenThread만 따로 부른다.
// 처리 표시(resolved_at·issue_no·resolution)는 사람이 찍는 값이라 저장 함수를 직접 부른다.

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

const {
  db,
  recordLlmCall,
  insertTraceEvent,
  markTraceEventSent,
  openFeedback,
  feedbackByIds,
  resolveFeedback,
  unresolveFeedback,
} = await import("../src/db.js");
const {
  syncReactions,
  recordThreadReplies,
  liveReactionsOf,
  shouldOpenThread,
} = await import("../src/feedback.js");
const { createFixtureCharacter } =
  await import("../src/eval/fixture-character.js");

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
  emoji: string | null;
  slack_user: string | null;
  text: string | null;
  reply_ts: string | null;
  dedupe_key: string;
  trace_key: string | null;
  thread_ts: string | null;
  created_at: string;
  removed_at: string | null;
}

const rowsOf = (slackTs: string): FeedbackRow[] =>
  db
    .prepare(
      `SELECT id, character_id, call_id, slack_ts, trace_kind, source, kind, emoji, slack_user,
              text, reply_ts, dedupe_key, trace_key, thread_ts, created_at, removed_at
         FROM call_feedback WHERE slack_ts = ? ORDER BY id`,
    )
    .all(slackTs) as FeedbackRow[];

// 우리가 슬랙에 올린 글 하나를 흉내 낸다 — 트레이스 표에 행을 넣고 보낸 것으로 표시해 slack_ts를 단다.
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

// 부모 글 스레드에 우리가 올린 글 하나. 실시간 꼬리처럼 제 키 없이 부모 키만 갖는 자식도 있다.
const postedChild = (
  dedupeKey: string | null,
  parentKey: string,
  kind: string,
  slackTs: string,
): void => {
  insertTraceEvent({
    characterId,
    kind,
    dedupeKey,
    threadKey: null,
    parentKey,
    text: "스레드 글",
    createdAt: "2025-09-06 04:00:01",
  });
  const row = db
    .prepare(
      `SELECT id FROM trace_events WHERE kind = ? AND parent_key = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(kind, parentKey) as { id: number };
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

  const r = syncReactions(ts, [{ kind: "fact", emoji: "x", user: "U1" }]);
  assert.deepEqual(r, { added: 1, restored: 0, removed: 0 });

  const rows = rowsOf(ts);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.call_id, callId);
  assert.equal(row.character_id, characterId);
  assert.equal(row.trace_kind, "reply");
  assert.equal(row.source, "reaction");
  assert.equal(row.kind, "fact");
  assert.equal(row.emoji, "x");
  assert.equal(row.slack_user, "U1");
  assert.equal(row.dedupe_key, `react:${ts}:fact:U1`);
  assert.equal(row.trace_key, `call:${callId}`);
  assert.equal(row.thread_ts, null);
  assert.equal(row.text, null);
  assert.equal(row.reply_ts, null);
  assert.match(row.created_at, STAMP);
  assert.equal(row.removed_at, null);
});

test("같은 표시를 다시 읽으면 행이 늘지 않는다", () => {
  const callId = newCall();
  const ts = "1757100001.000100";
  posted(`call:${callId}`, "reply", ts);
  const live = [{ kind: "tone" as const, emoji: "speech_balloon", user: "U1" }];

  assert.deepEqual(syncReactions(ts, live), {
    added: 1,
    restored: 0,
    removed: 0,
  });
  assert.deepEqual(syncReactions(ts, live), {
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
  const live = [{ kind: "timing" as const, emoji: "alarm_clock", user: "U1" }];
  syncReactions(ts, live);

  assert.deepEqual(syncReactions(ts, []), {
    added: 0,
    restored: 0,
    removed: 1,
  });
  let rows = rowsOf(ts);
  assert.equal(rows.length, 1);
  assert.match(rows[0].removed_at ?? "", STAMP);

  assert.deepEqual(syncReactions(ts, live), {
    added: 0,
    restored: 1,
    removed: 0,
  });
  rows = rowsOf(ts);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].removed_at, null);
});

test("스레드 자식 글에 붙은 표시도 같은 호출로 이어지고 부모 글을 적는다", () => {
  const callId = newCall();
  const parentTs = "1757100003.000100";
  const ts = "1757100003.000200";
  posted(`call:${callId}`, "reply", parentTs);
  postedChild(`call:${callId}:sent`, `call:${callId}`, "reply_sent", ts);

  assert.deepEqual(
    syncReactions(ts, [{ kind: "good", emoji: "+1", user: null }]),
    { added: 1, restored: 0, removed: 0 },
  );
  const rows = rowsOf(ts);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].call_id, callId);
  assert.equal(rows[0].trace_kind, "reply_sent");
  assert.equal(rows[0].slack_user, null);
  assert.equal(rows[0].dedupe_key, `react:${ts}:good:?`);
  assert.equal(rows[0].trace_key, `call:${callId}:sent`);
  assert.equal(rows[0].thread_ts, parentTs);
});

test("지워진 호출을 가리키는 글의 표시는 호출 번호 없이 쌓인다", () => {
  const ts = "1757100004.000100";
  posted("call:999999", "reply", ts);

  assert.deepEqual(
    syncReactions(ts, [{ kind: "fact", emoji: "x", user: "U3" }]),
    { added: 1, restored: 0, removed: 0 },
  );
  const rows = rowsOf(ts);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].call_id, null);
  assert.equal(rows[0].character_id, characterId);
  assert.equal(rows[0].trace_kind, "reply");
  // 호출은 없어도 어느 게시였는지는 남는다.
  assert.equal(rows[0].trace_key, "call:999999");
});

test("우리가 올린 글이 아니면 표시도 답글도 쌓지 않는다", () => {
  const ts = "1757100005.000100";

  assert.deepEqual(
    syncReactions(ts, [{ kind: "fact", emoji: "x", user: "U1" }]),
    { added: 0, restored: 0, removed: 0 },
  );
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
  assert.equal(row.emoji, null);
  assert.equal(row.slack_user, "U2");
  assert.equal(row.text, "말투가 딱딱하다");
  assert.equal(row.reply_ts, "1757120000.000300");
  assert.equal(row.dedupe_key, "reply:1757120000.000300");
  assert.equal(row.trace_key, `call:${callId}`);
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

// ── 모든 이모지와 스레드 안 글 ─────────────────────────────────────────

test("분류 밖 이모지도 이름으로 쌓이고 같은 사람의 분류 표시와 따로 남는다", () => {
  const callId = newCall();
  const ts = "1757100020.000100";
  posted(`call:${callId}`, "reply", ts);

  assert.deepEqual(
    syncReactions(ts, [
      { kind: null, emoji: "eyes", user: "U1" },
      { kind: "fact", emoji: "x", user: "U1" },
    ]),
    { added: 2, restored: 0, removed: 0 },
  );
  const rows = rowsOf(ts);
  assert.deepEqual(
    rows.map((r) => [r.kind, r.emoji, r.dedupe_key, r.call_id]),
    [
      [null, "eyes", `react:${ts}:emoji:eyes:U1`, callId],
      ["fact", "x", `react:${ts}:fact:U1`, callId],
    ],
  );

  // 분류 밖 이모지를 떼도 뗀 시각이 적힌다.
  assert.deepEqual(
    syncReactions(ts, [{ kind: "fact", emoji: "x", user: "U1" }]),
    { added: 0, restored: 0, removed: 1 },
  );
  assert.match(rowsOf(ts)[0].removed_at ?? "", STAMP);
});

test("슬랙 리액션은 사람마다 한 건으로 펴고 처리 체크는 뺀다", () => {
  assert.deepEqual(
    liveReactionsOf({
      reactions: [
        { name: "x", users: ["U1", "U2"] },
        { name: "+1::skin-tone-2", users: ["U1"] },
        { name: "thumbsup", users: ["U3"] },
        { name: "white_check_mark", users: ["U1"] },
        { name: "eyes" },
      ],
    }),
    [
      { kind: "fact", emoji: "x", user: "U1" },
      { kind: "fact", emoji: "x", user: "U2" },
      { kind: "good", emoji: "+1", user: "U1" },
      { kind: "good", emoji: "thumbsup", user: "U3" },
      { kind: null, emoji: "eyes", user: null },
    ],
  );
  assert.deepEqual(liveReactionsOf({}), []);
});

test("제 키 없는 스레드 자식에 단 표시는 부모 키와 부모 글로 쌓인다", () => {
  const callId = newCall();
  const parentTs = "1757100021.000100";
  const ts = "1757100021.000200";
  posted(`call:${callId}`, "reply", parentTs);
  postedChild(null, `call:${callId}`, "call_tail", ts);

  syncReactions(ts, [{ kind: "tone", emoji: "speech_balloon", user: "U1" }]);
  const [row] = rowsOf(ts);
  assert.equal(row.call_id, callId);
  assert.equal(row.trace_kind, "call_tail");
  assert.equal(row.trace_key, `call:${callId}`);
  assert.equal(row.thread_ts, parentTs);
});

test("선톡 발송 게시에 단 표시는 문안 호출 번호로 이어진다", () => {
  const callId = newCall();
  const ts = "1757100022.000100";
  posted(`call:${callId}:send`, "proactive_send", ts);

  syncReactions(ts, [{ kind: null, emoji: "thinking_face", user: "U1" }]);
  const [row] = rowsOf(ts);
  assert.equal(row.call_id, callId);
  assert.equal(row.trace_kind, "proactive_send");
  assert.equal(row.trace_key, `call:${callId}:send`);
  // 발송 게시는 독립 글이라 부모 글이 없다.
  assert.equal(row.thread_ts, null);
});

test("예약 선톡 발송 게시에 단 표시는 호출 번호 없이 예약 행 키로 남는다", () => {
  const ts = "1757100023.000100";
  posted("scheduled:58:send", "proactive_send", ts);

  assert.equal(
    recordThreadReplies(ts, [
      { ts: "1757100023.000900", user: "U1", text: "아침 인사가 너무 길다" },
    ]),
    1,
  );
  const [row] = rowsOf(ts);
  assert.equal(row.call_id, null);
  assert.equal(row.trace_key, "scheduled:58:send");
  assert.equal(row.thread_ts, null);
});

test("사람이 새 답글을 적은 스레드와 최근 스레드는 바로 열고 오래된 스레드는 한 시간에 한 번 연다", () => {
  const ts = "1757100000.000100";
  const postedMs = 1757100000_000;
  const later = postedMs + 24 * 3600_000;

  // 스레드가 없으면 열 것도 없다.
  assert.equal(
    shouldOpenThread({ ts, replyCount: 0, unread: true, nowMs: later }),
    false,
  );
  assert.equal(
    shouldOpenThread({ ts, replyCount: 3, unread: true, nowMs: later }),
    true,
  );
  assert.equal(
    shouldOpenThread({
      ts,
      replyCount: 3,
      unread: false,
      nowMs: postedMs + 3600_000,
    }),
    true,
  );

  // 10분 회차 여섯 번 가운데 정확히 한 번 연다.
  const opened = Array.from({ length: 6 }, (_, i) =>
    shouldOpenThread({
      ts,
      replyCount: 3,
      unread: false,
      nowMs: later + i * 600_000,
    }),
  ).filter(Boolean).length;
  assert.equal(opened, 1);
});

// ── 처리 표시 ──────────────────────────────────────────────────────────
//
// 여기서부터는 앞 테스트가 쌓아 둔 행을 함께 본다 — 남은 것만 보여주는 함수라 표 전체가 대상이다.

const idsOf = (slackTs: string): number[] => rowsOf(slackTs).map((r) => r.id);

test("처리 표시를 찍으면 남은 목록에서 빠지고 이슈 번호가 함께 적힌다", () => {
  const callId = newCall();
  const ts = "1757100010.000100";
  posted(`call:${callId}`, "reply", ts);
  syncReactions(ts, [{ kind: "fact", emoji: "x", user: "U1" }]);
  const [id] = idsOf(ts);

  assert.ok(openFeedback().some((r) => r.id === id));

  assert.equal(resolveFeedback([id], "fixed", 400, "2025-09-11 12:00:00"), 1);

  const [row] = feedbackByIds([id]);
  assert.equal(row.resolved_at, "2025-09-11 12:00:00");
  assert.equal(row.resolution, "fixed");
  assert.equal(row.issue_no, 400);
  assert.equal(
    openFeedback().some((r) => r.id === id),
    false,
  );
});

test("이미 찍힌 표시는 다시 찍어도 처음 적은 값이 남는다", () => {
  const callId = newCall();
  const ts = "1757100011.000100";
  posted(`call:${callId}`, "reply", ts);
  syncReactions(ts, [{ kind: "tone", emoji: "speech_balloon", user: "U1" }]);
  const [id] = idsOf(ts);

  resolveFeedback([id], "fixed", 400, "2025-09-11 12:00:00");
  assert.equal(resolveFeedback([id], "wontfix", 401, "2025-09-11 13:00:00"), 0);

  const [row] = feedbackByIds([id]);
  assert.equal(row.resolution, "fixed");
  assert.equal(row.issue_no, 400);
});

test("잘못 찍은 표시를 되돌리면 남은 목록으로 돌아온다", () => {
  const callId = newCall();
  const ts = "1757100012.000100";
  posted(`call:${callId}`, "reply", ts);
  syncReactions(ts, [{ kind: "timing", emoji: "alarm_clock", user: "U1" }]);
  const [id] = idsOf(ts);

  resolveFeedback([id], "dup", null, "2025-09-11 12:00:00");
  assert.equal(unresolveFeedback([id]), 1);

  const [row] = feedbackByIds([id]);
  assert.equal(row.resolved_at, null);
  assert.equal(row.resolution, null);
  assert.equal(row.issue_no, null);
  assert.ok(openFeedback().some((r) => r.id === id));
});

test("슬랙에서 뗀 표시는 처리 표시를 찍지 않아도 남은 목록에 없다", () => {
  const callId = newCall();
  const ts = "1757100013.000100";
  posted(`call:${callId}`, "reply", ts);
  syncReactions(ts, [{ kind: "good", emoji: "+1", user: "U1" }]);
  const [id] = idsOf(ts);

  syncReactions(ts, []);
  assert.equal(
    openFeedback().some((r) => r.id === id),
    false,
  );
});

test("이슈 없이 넘긴 표시도 찍히고 빈 목록은 아무것도 바꾸지 않는다", () => {
  const callId = newCall();
  const ts = "1757100014.000100";
  posted(`call:${callId}`, "reply", ts);
  syncReactions(ts, [{ kind: "fact", emoji: "x", user: "U9" }]);
  const [id] = idsOf(ts);

  assert.equal(resolveFeedback([], "fixed", 400, "2025-09-11 12:00:00"), 0);
  assert.equal(unresolveFeedback([]), 0);
  assert.deepEqual(feedbackByIds([]), []);

  assert.equal(
    resolveFeedback([id], "wontfix", null, "2025-09-11 12:00:00"),
    1,
  );
  const [row] = feedbackByIds([id]);
  assert.equal(row.issue_no, null);
  assert.equal(row.resolution, "wontfix");
});

test("남은 목록은 쌓인 순서로 나온다", () => {
  const rows = openFeedback();
  const stamps = rows.map(
    (r) => `${r.created_at}:${String(r.id).padStart(6, "0")}`,
  );
  assert.deepEqual(stamps, [...stamps].sort());
});
