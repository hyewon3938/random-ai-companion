// 캐릭터를 끝낼 때 상태를 바꾸고 걸린 발송을 거두는 저장 함수를 검사한다 — 도구는 실행하지 않는다.
//
// 종료는 되돌릴 수 없어서 잘못 거두면 복구할 자리가 없다. 끝내는 함수가 활성 행에만 듣는지,
// 거두는 함수가 그 캐릭터의 대기 행만 집고 같은 대화방의 다른 캐릭터나 이미 끝난 행을
// 건드리지 않는지, 세는 함수가 거둘 것과 같은 수를 먼저 보여주는지를 본다.
//
// 도구는 봇과 다른 프로세스에서 도므로 봇이 걸어 둔 타이머를 지우지 못한다. 거둔 행이
// 그 타이머로 나가지 않는지도 여기서 본다.
//
// DB는 임시 파일로 새로 만들고 캐릭터는 평가용 고정 캐릭터로 세운다.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

// DB 경로를 정한 뒤에 읽어야 임시 파일로 열린다 — 정적 import는 이 줄들보다 먼저 돈다.
const {
  db,
  endCharacter,
  getActiveCharacter,
  getCharacterById,
  insertPendingReply,
  insertScheduledSend,
  getWaitingPendingReplies,
  getPendingSends,
  markPendingReply,
  waitingPendingReplyCount,
  supersedeCharacterPendingReplies,
  pendingScheduledSendCount,
  skipCharacterScheduledSends,
} = await import("../src/db.js");
const { createFixtureCharacter } =
  await import("../src/eval/fixture-character.js");
const { schedulePendingReply, setPendingSender } = await import(
  "../src/pending.js"
);

const CHAT = "chat-end";
const KEEP = "chat-keep";
const endingId = createFixtureCharacter(CHAT);
const keepId = createFixtureCharacter(KEEP);

const DATE = "2026-09-11";
const NOW = "2026-09-11 20:00:00";

const waiting = (characterId: number, chatId: string, kind: string): number =>
  insertPendingReply({
    chatId,
    characterId,
    userMsgAt: "2026-09-11 19:58:00",
    bubbles: ["곧 답할게"],
    noteToSave: null,
    sendAt: "2026-09-11 20:05:00",
    kind,
    createdAt: NOW,
  });

after(() => {
  db.close();
});

test("거두기 전에 세는 값이 실제로 걸린 행 수와 같다", () => {
  waiting(endingId, CHAT, "reply");
  waiting(endingId, CHAT, "wake");
  const sent = waiting(endingId, CHAT, "promise");
  markPendingReply(sent, "sent", NOW);
  waiting(keepId, KEEP, "reply");

  insertScheduledSend(
    endingId, CHAT, DATE, "07:00", "08:00", "잘 잤어?", NOW, "morning",
  );
  insertScheduledSend(
    keepId, KEEP, DATE, "07:00", "08:00", "좋은 아침", NOW, "morning",
  );

  assert.equal(waitingPendingReplyCount(endingId), 2);
  assert.equal(pendingScheduledSendCount(endingId), 1);
  assert.equal(waitingPendingReplyCount(keepId), 1);
});

test("거두는 함수는 그 캐릭터의 대기 행만 종류를 가리지 않고 집는다", () => {
  assert.equal(supersedeCharacterPendingReplies(endingId), 2);
  assert.equal(waitingPendingReplyCount(endingId), 0);
  // 이미 보낸 행은 그대로고, 다른 캐릭터의 대기 행은 남는다
  assert.deepEqual(
    getWaitingPendingReplies().map((r) => r.character_id),
    [keepId],
  );
  const statuses = db
    .prepare(
      `SELECT status, count(*) c FROM pending_replies WHERE character_id = ?
        GROUP BY status ORDER BY status`,
    )
    .all(endingId) as { status: string; c: number }[];
  assert.deepEqual(statuses, [
    { status: "sent", c: 1 },
    { status: "superseded", c: 2 },
  ]);
  // 두 번째로 불러도 더 거둘 것이 없다
  assert.equal(supersedeCharacterPendingReplies(endingId), 0);
});

test("예약 선톡은 폐기 사유와 함께 거두고 다른 캐릭터 것은 남긴다", () => {
  assert.equal(skipCharacterScheduledSends(endingId, "캐릭터 종료"), 1);
  assert.equal(pendingScheduledSendCount(endingId), 0);
  assert.deepEqual(
    getPendingSends(DATE).map((r) => r.character_id),
    [keepId],
  );
  const row = db
    .prepare(
      `SELECT status, skip_reason FROM scheduled_messages WHERE character_id = ?`,
    )
    .get(endingId) as { status: string; skip_reason: string };
  assert.equal(row.status, "skipped");
  assert.equal(row.skip_reason, "캐릭터 종료");
  assert.equal(skipCharacterScheduledSends(endingId, "캐릭터 종료"), 0);
});

test("끝내는 함수는 활성 행에만 듣고 두 번째 호출은 false", () => {
  assert.equal(endCharacter(endingId), true);
  assert.equal(getCharacterById(endingId)?.status, "ended");
  assert.equal(getActiveCharacter(CHAT), undefined);
  assert.equal(endCharacter(endingId), false);
  // 다른 대화방의 캐릭터는 그대로 활성이다
  assert.equal(getActiveCharacter(KEEP)?.id, keepId);
});

test("끝낸 대화방에 새 캐릭터를 만들면 그쪽이 활성이 된다", () => {
  const nextId = createFixtureCharacter(CHAT);
  assert.notEqual(nextId, endingId);
  assert.equal(getActiveCharacter(CHAT)?.id, nextId);
  assert.equal(waitingPendingReplyCount(nextId), 0);
  assert.equal(pendingScheduledSendCount(nextId), 0);
});

test("거둔 행은 걸어 둔 타이머가 울려도 나가지 않는다", async () => {
  const chatId = "chat-timer";
  const characterId = createFixtureCharacter(chatId);
  let sentCount = 0;
  setPendingSender(async () => {
    sentCount += 1;
    return null;
  });
  const { id } = schedulePendingReply({
    chatId,
    characterId,
    userMsgAt: "2026-09-11 19:58:00",
    bubbles: ["나가면 안 되는 말"],
    noteToSave: null,
    waitMs: 200,
    kind: "reply",
  });

  // 도구는 다른 프로세스라 이 프로세스의 타이머까지는 못 지운다 — DB만 바꾼 상황을 만든다
  assert.equal(supersedeCharacterPendingReplies(characterId), 1);
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal(sentCount, 0);
  assert.equal(
    (
      db.prepare(`SELECT status FROM pending_replies WHERE id = ?`).get(id) as {
        status: string;
      }
    ).status,
    "superseded",
  );
});
