// 답장 대기 행(pending.ts)의 meta 읽기·깨우기 행 거두기·걸어 두기·이어받기를 검사한다.
//
// meta는 깨져 있어도 예외 없이 빈 값으로 읽히는지, dropWakeRows가 wake·return만 거두고 promise와
// reply는 남기는지, schedulePendingReply가 적은 행이 입력과 같은지, resumePendingReplies가 남은
// 행을 다시 걸어 시각이 지난 행은 바로 울리고 먼 행은 기다리는지 본다. 울리는 쪽은
// setPendingSender로 가짜 발송기를 넣어 받는다 — bot.ts를 읽으면 그쪽 발송기가 등록되므로 여기서는
// 읽지 않는다.
//
// DB는 임시 파일로 새로 만든다. 먼 미래로 건 타이머는 끝에 전부 거둬 프로세스가 매달리지 않게 한다.
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
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";

// DB 경로를 정한 뒤에 읽어야 임시 파일로 열린다 — 정적 import는 이 줄들보다 먼저 돈다.
const { db, getWaitingPendingReplies, insertPendingReply } = await import(
  "../src/db.js"
);
const { createFixtureCharacter } = await import(
  "../src/eval/fixture-character.js"
);
const {
  dropPendingReplies,
  dropPromiseRows,
  dropWakeRows,
  parseWakeMeta,
  resumePendingReplies,
  schedulePendingReply,
  setPendingSender,
} = await import("../src/pending.js");
type PendingReplyRow = Parameters<typeof parseWakeMeta>[0];

const AT = "2026-09-07 13:20:00";
const characterId = createFixtureCharacter("chat-wake");

// KST 벽시계 "YYYY-MM-DD HH:MM:SS" — pending.ts의 stampAfter와 같은 모양.
const stampAfter = (ms: number): string =>
  new Date(Date.now() + 9 * 3600_000 + ms)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");

const rowOf = (over: Partial<PendingReplyRow>): PendingReplyRow => ({
  id: 1,
  chat_id: "chat-wake",
  character_id: characterId,
  user_msg_at: AT,
  bubbles_json: "[]",
  note_to_save: null,
  send_at: "2026-09-07 14:00:30",
  kind: "wake",
  meta_json: null,
  call_id: null,
  attempts: 0,
  created_at: AT,
  ...over,
});

const insert = (chatId: string, kind: string, sendAt: string): number =>
  insertPendingReply({
    chatId,
    characterId,
    userMsgAt: AT,
    bubbles: ["다녀왔어요"],
    noteToSave: null,
    sendAt,
    kind,
    metaJson: null,
    createdAt: AT,
  });

const statusOf = (id: number): string =>
  (
    db.prepare(`SELECT status FROM pending_replies WHERE id = ?`).get(id) as {
      status: string;
    }
  ).status;

const waitUntil = async (
  cond: () => boolean,
  timeoutMs = 3000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("기다린 조건이 오지 않았다");
    await new Promise((r) => setTimeout(r, 20));
  }
};

after(() => {
  // 아직 기다리는 행이 있으면 대화마다 세 갈래로 거둬 타이머를 모두 지운다.
  for (const r of getWaitingPendingReplies()) {
    dropPendingReplies(r.chat_id);
    dropPromiseRows(r.chat_id);
    dropWakeRows(r.chat_id);
  }
  db.close();
});

test("meta가 제대로 적힌 행은 활동·구간·약속·호출 번호를 그대로 읽는다", () => {
  const meta = parseWakeMeta(
    rowOf({
      kind: "promise",
      meta_json: JSON.stringify({
        activity: "통화",
        blockStart: "13:00",
        blockEnd: "14:00",
        promise: "통화 끝나고 다시 연락",
        callId: 42,
      }),
    }),
  );
  assert.deepEqual(meta, {
    activity: "통화",
    blockStart: "13:00",
    blockEnd: "14:00",
    promise: "통화 끝나고 다시 연락",
    callId: 42,
  });
});

test("meta가 없는 행은 빈 객체로 읽는다", () => {
  assert.deepEqual(parseWakeMeta(rowOf({ meta_json: null })), {});
});

test("meta가 깨진 행도 예외 없이 빈 객체로 읽는다", () => {
  assert.deepEqual(parseWakeMeta(rowOf({ meta_json: "{깨진 json" })), {});
});

test("깨우기 행을 거두면 wake·return만 지나가고 promise·reply는 그대로 기다린다", () => {
  const chat = "chat-drop";
  const far = stampAfter(6 * 3600_000);
  const wake = insert(chat, "wake", far);
  const ret = insert(chat, "return", far);
  const promise = insert(chat, "promise", far);
  const reply = insert(chat, "reply", far);

  assert.equal(dropWakeRows(chat), 2);
  assert.equal(statusOf(wake), "superseded");
  assert.equal(statusOf(ret), "superseded");
  assert.equal(statusOf(promise), "waiting");
  assert.equal(statusOf(reply), "waiting");

  // 다음 검사의 이어받기에 섞이지 않게 남은 둘도 거둔다.
  assert.equal(dropPromiseRows(chat), 1);
  assert.equal(dropPendingReplies(chat), 1);
});

test("답장을 걸어 두면 행의 종류·말풍선·호출 번호가 입력과 같고 시각은 대기만큼 뒤다", () => {
  const chat = "chat-sched";
  const waitMs = 6 * 3600_000;
  const before = Date.now();
  const { id, sendAt } = schedulePendingReply({
    chatId: chat,
    characterId,
    userMsgAt: AT,
    bubbles: ["안녕", "잘 지냈어요?"],
    noteToSave: "메모 한 줄",
    waitMs,
    kind: "reply",
    callId: 42,
  });
  const row = db
    .prepare(`SELECT * FROM pending_replies WHERE id = ?`)
    .get(id) as PendingReplyRow & { status: string };
  assert.equal(row.kind, "reply");
  assert.deepEqual(JSON.parse(row.bubbles_json), ["안녕", "잘 지냈어요?"]);
  assert.equal(row.call_id, 42);
  assert.equal(row.note_to_save, "메모 한 줄");
  assert.equal(row.meta_json, null);
  assert.equal(row.status, "waiting");
  assert.equal(row.send_at, sendAt);
  const sendEpoch = new Date(`${sendAt.replace(" ", "T")}+09:00`).getTime();
  assert.ok(sendEpoch - before >= waitMs - 2000);
  assert.ok(sendEpoch - before <= waitMs + 2000);

  // 걸린 타이머를 여기서 거둔다 — 안 거두면 프로세스가 여섯 시간 매달린다.
  assert.equal(dropPendingReplies(chat), 1);
  assert.equal(statusOf(id), "superseded");
});

test("이어받기는 시각이 지난 행을 바로 울리고 먼 행은 그대로 기다리게 건다", async () => {
  const fired: Array<{ id: number; bubbles: string[] }> = [];
  setPendingSender(async (row, bubbles) => {
    fired.push({ id: row.id, bubbles });
  });
  const due = insert("chat-resume-due", "reply", "2026-01-01 09:00:00");
  const later = insert("chat-resume-later", "reply", stampAfter(6 * 3600_000));

  resumePendingReplies();
  await waitUntil(() => statusOf(due) === "sent");

  assert.deepEqual(fired, [{ id: due, bubbles: ["다녀왔어요"] }]);
  assert.equal(statusOf(later), "waiting");

  assert.equal(dropPendingReplies("chat-resume-later"), 1);
  assert.equal(statusOf(later), "superseded");
});
