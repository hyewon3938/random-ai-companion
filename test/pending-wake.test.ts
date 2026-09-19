// 연락 행(pending.ts)의 종류별 값 읽기·구간 끝 행 거두기·걸어 두기·이어받기·구간 끝 표시 걸기를 검사한다.
//
// 종류별 값(payload_json)은 깨져 있어도 예외 없이 빈 값으로 읽히는지, dropWakeRows가 구간 끝
// 행만 거두고 약속과 답장은 남기는지, schedulePendingReply가 적은 행이 입력과 같은지,
// resumePendingReplies가 남은 행을 다시 걸어 시각이 지난 행은 바로 울리고 먼 행은 기다리는지,
// 보낸 답장의 메모가 그 답장을 적은 기록 행 번호와 함께 남는지, armReturnRow가 지금 블록 끝에
// 구간 끝 행을 걸고 울릴 행이나 약속 행이 있거나 구간이 끝났으면 걸지 않는지 본다. 울리는 쪽은
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
const { db, getWaitingOutboxRows, insertOutboxRow, parsePayload } =
  await import("../src/db.js");
const { createFixtureCharacter } =
  await import("../src/eval/fixture-character.js");
const {
  armReturnRow,
  dropPendingReplies,
  dropPromiseRows,
  dropWakeRows,
  resumePendingReplies,
  schedulePendingReply,
  setPendingSender,
} = await import("../src/pending.js");
const { kstLogicalClock } = await import("../src/kst.js");
const { toMin } = await import("../src/context/day-progress.js");

// 분 수를 각본 표기 "HH:MM"으로 — 새벽은 24를 넘긴 채 둔다(kstLogicalClock과 같은 표기).
const clockAt = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

const AT = "2026-09-07 13:20:00";
const characterId = createFixtureCharacter("chat-wake");

// KST 벽시계 "YYYY-MM-DD HH:MM:SS" — pending.ts의 stampAfter와 같은 모양.
const stampAfter = (ms: number): string =>
  new Date(Date.now() + 9 * 3600_000 + ms)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");

let seq = 0;
const insert = (
  chatId: string,
  kind: "reply" | "block_end" | "promise",
  sendAt: string,
): number => {
  const id = insertOutboxRow({
    kind,
    chatId,
    characterId,
    dedupeKey: `test:${++seq}`,
    sendAt,
    payload:
      kind === "reply"
        ? { userMsgAt: AT, bubbles: ["다녀왔어요"] }
        : { activity: "통화", blockStart: "13:00", blockEnd: "14:00" },
    createdAt: AT,
  });
  assert.ok(id !== null);
  return id;
};

const statusOf = (id: number): string =>
  (
    db.prepare(`SELECT status FROM outbox WHERE id = ?`).get(id) as {
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
  for (const r of getWaitingOutboxRows()) {
    dropPendingReplies(r.chat_id);
    dropPromiseRows(r.chat_id);
    dropWakeRows(r.chat_id);
  }
  db.close();
});

test("종류별 값이 제대로 적힌 행은 활동·구간·약속을 그대로 읽는다", () => {
  const payload = {
    activity: "통화",
    blockStart: "13:00",
    blockEnd: "14:00",
    promise: "통화 끝나고 다시 연락",
    userMsgAt: AT,
  };
  assert.deepEqual(
    parsePayload({ payload_json: JSON.stringify(payload) }),
    payload,
  );
});

test("종류별 값이 비었거나 객체가 아니면 빈 객체로 읽는다", () => {
  assert.deepEqual(parsePayload({ payload_json: "{}" }), {});
  assert.deepEqual(parsePayload({ payload_json: "[1,2]" }), {});
  assert.deepEqual(parsePayload({ payload_json: "null" }), {});
});

test("종류별 값이 깨진 행도 예외 없이 빈 객체로 읽는다", () => {
  assert.deepEqual(parsePayload({ payload_json: "{깨진 json" }), {});
});

test("구간 끝 행을 거두면 구간 끝 행만 닫히고 약속·답장은 그대로 기다린다", () => {
  const chat = "chat-drop";
  const far = stampAfter(6 * 3600_000);
  const wake = insert(chat, "block_end", far);
  const ret = insert(chat, "block_end", far);
  const promise = insert(chat, "promise", far);
  const reply = insert(chat, "reply", far);

  assert.equal(dropWakeRows(chat), 2);
  assert.equal(statusOf(wake), "dropped");
  assert.equal(statusOf(ret), "dropped");
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
  const armed = schedulePendingReply({
    chatId: chat,
    characterId,
    userMsgAt: AT,
    bubbles: ["안녕", "잘 지냈어요?"],
    notesToSave: ["메모 한 줄"],
    waitMs,
    kind: "reply",
    callId: 42,
  });
  assert.ok(armed);
  const { id, sendAt } = armed;
  const row = db.prepare(`SELECT * FROM outbox WHERE id = ?`).get(id) as {
    kind: string;
    dedupe_key: string;
    payload_json: string;
    call_id: number | null;
    status: string;
    send_at: string;
    expires_at: string | null;
  };
  assert.equal(row.kind, "reply");
  assert.equal(row.dedupe_key, `답장:${AT}`);
  assert.deepEqual(JSON.parse(row.payload_json), {
    userMsgAt: AT,
    bubbles: ["안녕", "잘 지냈어요?"],
    notes: ["메모 한 줄"],
  });
  assert.equal(row.call_id, 42);
  assert.equal(row.status, "waiting");
  assert.equal(row.send_at, sendAt);
  assert.equal(row.expires_at, null);
  const sendEpoch = new Date(`${sendAt.replace(" ", "T")}+09:00`).getTime();
  assert.ok(sendEpoch - before >= waitMs - 2000);
  assert.ok(sendEpoch - before <= waitMs + 2000);

  // 같은 유저 메시지에 답장을 또 걸면 키가 겹쳐 넣지 않는다.
  assert.equal(
    schedulePendingReply({
      chatId: chat,
      characterId,
      userMsgAt: AT,
      bubbles: ["또"],
      notesToSave: [],
      waitMs,
      kind: "reply",
    }),
    null,
  );

  // 걸린 타이머를 여기서 거둔다 — 안 거두면 프로세스가 여섯 시간 매달린다.
  assert.equal(dropPendingReplies(chat), 1);
  assert.equal(statusOf(id), "dropped");
});

test("이어받기는 시각이 지난 행을 바로 울리고 먼 행은 그대로 기다리게 건다", async () => {
  const fired: Array<{ id: number; bubbles: string[] }> = [];
  setPendingSender(async (row, bubbles) => {
    fired.push({ id: row.id, bubbles });
    return { messageId: null, delivered: bubbles.length };
  });
  const due = insert("chat-resume-due", "reply", "2026-01-01 09:00:00");
  const later = insert("chat-resume-later", "reply", stampAfter(6 * 3600_000));

  resumePendingReplies();
  await waitUntil(() => statusOf(due) === "sent");

  assert.deepEqual(fired, [{ id: due, bubbles: ["다녀왔어요"] }]);
  assert.equal(statusOf(later), "waiting");

  assert.equal(dropPendingReplies("chat-resume-later"), 1);
  assert.equal(statusOf(later), "dropped");
});

// 메모는 답장 하나에 딸린다 — 발송기가 돌려준 기록 행 번호를 그대로 적어야 대화 기록의
// 그 턴에 이 메모를 다시 실을 수 있다(이슈 #346).
test("보낸 답장의 메모는 그 답장을 적은 기록 행 번호와 함께 남는다", async () => {
  const chat = "chat-note-id";
  setPendingSender(async (_row, bubbles) => ({
    messageId: 777,
    delivered: bubbles.length,
  }));
  const armed = schedulePendingReply({
    chatId: chat,
    characterId,
    userMsgAt: AT,
    bubbles: ["다녀왔어요"],
    notesToSave: ["상대가 내일 이사한다고 했다"],
    waitMs: 50,
    kind: "reply",
  });
  assert.ok(armed);
  await waitUntil(() => statusOf(armed.id) === "sent");

  const note = db
    .prepare(
      `SELECT note, message_id FROM today_notes WHERE character_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(characterId) as { note: string; message_id: number | null };
  assert.deepEqual(note, {
    note: "상대가 내일 이사한다고 했다",
    message_id: 777,
  });
});

// 한 답장이 메모를 여럿 남긴다(이슈 #399). 종류별 값에 배열로 두었다가 보낼 때 한 줄씩
// 옮기는데, 그 왕복에서 한 건이 새면 그날 알게 된 사실이 사라진다.
test("한 답장에 메모가 여럿이면 같은 기록 행 번호로 여러 줄이 남는다", async () => {
  const chat = "chat-note-many";
  setPendingSender(async (_row, bubbles) => ({
    messageId: 778,
    delivered: bubbles.length,
  }));
  const armed = schedulePendingReply({
    chatId: chat,
    characterId,
    userMsgAt: AT,
    bubbles: ["나도 대전에서 컸어"],
    notesToSave: [
      "상대가 중학교까지 대전에서 살았다",
      "내가 자란 동네를 둔산동이라고 말했다",
    ],
    waitMs: 50,
    kind: "reply",
  });
  assert.ok(armed);
  await waitUntil(() => statusOf(armed.id) === "sent");

  const rows = db
    .prepare(
      `SELECT note, message_id FROM today_notes WHERE character_id = ? AND message_id = 778 ORDER BY id`,
    )
    .all(characterId) as { note: string; message_id: number }[];
  assert.deepEqual(rows, [
    { note: "상대가 중학교까지 대전에서 살았다", message_id: 778 },
    { note: "내가 자란 동네를 둔산동이라고 말했다", message_id: 778 },
  ]);
});

test("구간 끝 표시는 지금 블록이 끝나는 시각에 구간 끝 행으로 걸린다", () => {
  const chat = "chat-arm";
  const now = toMin(kstLogicalClock());
  const block = { activity: "씻기", start: clockAt(now - 5), end: clockAt(now + 10) };
  const armed = armReturnRow({ chatId: chat, characterId, block, userMsgAt: AT });
  assert.ok(armed);
  const row = db
    .prepare(
      `SELECT kind, status, dedupe_key, payload_json FROM outbox WHERE id = ?`,
    )
    .get(armed.id) as {
    kind: string;
    status: string;
    dedupe_key: string;
    payload_json: string;
  };
  assert.equal(row.kind, "block_end");
  assert.equal(row.status, "waiting");
  assert.equal(row.dedupe_key, `구간끝:${block.start}`);
  // 유저 첫 발화 시각은 비운 채 건다 — 유저가 구간 안에서 말을 걸 때 적힌다.
  assert.deepEqual(JSON.parse(row.payload_json), {
    activity: "씻기",
    blockStart: block.start,
    blockEnd: block.end,
  });
  // 블록 끝 시각에서 1분 안(지터)에 울린다 — 지금 시각은 분 단위라 앞뒤로 1분씩 여유를 둔다.
  const diffMin =
    (Date.parse(armed.sendAt.replace(" ", "T") + "+09:00") - Date.now()) /
    60_000;
  assert.ok(diffMin >= 9 && diffMin <= 11.1, `끝 시각과 ${diffMin}분 차이`);

  // 같은 대화에 울릴 행이 있으면 걸지 않는다. 울리는 중인 행을 빼라고 해도 같은 구간이면
  // 키가 겹쳐 넣지 않고, 다음 구간이면 새 행을 건다.
  assert.equal(
    armReturnRow({ chatId: chat, characterId, block, userMsgAt: AT }),
    null,
  );
  assert.equal(
    armReturnRow({
      chatId: chat,
      characterId,
      block,
      userMsgAt: AT,
      exceptRowId: armed.id,
    }),
    null,
  );
  const next = armReturnRow({
    chatId: chat,
    characterId,
    block: { ...block, start: clockAt(now - 1) },
    userMsgAt: AT,
    exceptRowId: armed.id,
  });
  assert.ok(next);
  assert.notEqual(next.id, armed.id);
  assert.equal(dropWakeRows(chat), 2);
});

test("연락 약속이 걸려 있으면 구간 끝 표시를 걸지 않는다", () => {
  const chat = "chat-arm-promise";
  const now = toMin(kstLogicalClock());
  insert(chat, "promise", stampAfter(3600_000));
  assert.equal(
    armReturnRow({
      chatId: chat,
      characterId,
      block: { activity: "씻기", start: clockAt(now - 5), end: clockAt(now + 10) },
      userMsgAt: AT,
    }),
    null,
  );
  assert.equal(dropPromiseRows(chat), 1);
});

test("블록이 이미 끝났으면 구간 끝 표시를 걸지 않는다", () => {
  const chat = "chat-arm-past";
  const now = toMin(kstLogicalClock());
  for (const end of [clockAt(now), clockAt(now - 1)])
    assert.equal(
      armReturnRow({
        chatId: chat,
        characterId,
        block: { activity: "씻기", start: clockAt(now - 20), end },
        userMsgAt: AT,
      }),
      null,
    );
  assert.equal(dropWakeRows(chat), 0);
});
