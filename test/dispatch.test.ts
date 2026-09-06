// 선톡 디스패처(dispatch.ts)가 발송 전에 DB만 보고 내리는 판단을 검사한다 — 모델은 부르지 않는다.
//
// 창이 아직 안 열린 행은 두는지, 관제탑이 지목하지 않은 종류·유예를 넘긴 행·유저가 먼저 연락한
// 대화의 행은 어떤 사유로 건너뛰는지 본다. 유예는 창 종료 뒤 90분, 시간대별 상한, 06:30 하한
// 셋이 겹치므로 각각 한 번씩 짚는다. 시계는 Date.now를 고정해 KST 벽시계를 정한다.
//
// 텔레그램은 부르지 않는다 — 모든 판단을 통과해 발송 직전까지 간 행은 이 대화의 선톡 잠금을
// 미리 쥐어 다음 틱으로 미뤄지게 한다. DB는 임시 파일로 새로 만든다.
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

// DB 경로를 정한 뒤에 읽어야 임시 파일로 열린다 — 정적 import는 이 줄들보다 먼저 돈다.
const {
  db,
  insertScheduledSend,
  logMessage,
  markScheduledSend,
  recordSendAttempt,
} = await import("../src/db.js");
const { createFixtureCharacter } =
  await import("../src/eval/fixture-character.js");
const { acquireProactive, releaseProactive } = await import("../src/bot.js");
const { runDispatchTick } = await import("../src/dispatch.js");

const DAY = "2026-09-06";
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const realNow = Date.now;

// kst.ts는 Date.now에 9시간을 더해 KST 벽시계를 만든다. 그 자리를 고정해 오늘과 지금을 정한다.
const setClock = (hhmm: string): void => {
  const fixed = Date.parse(`${DAY}T${hhmm}:00Z`) - KST_OFFSET_MS;
  Date.now = () => fixed;
};

before(() => {
  setClock("06:00");
});
after(() => {
  Date.now = realNow;
  db.close();
});

interface Planted {
  chatId: string;
  characterId: number;
  id: number;
}

let seq = 0;

// 캐릭터 하나에 오늘 문안 한 행. 같은 캐릭터·날짜에는 한 통만 들어가므로 검사마다 캐릭터를 새로 둔다.
const plant = (
  kind: "morning" | "checkin",
  windowStart: string,
  windowEnd: string,
): Planted => {
  seq += 1;
  const chatId = `chat-dispatch-${seq}`;
  const characterId = createFixtureCharacter(chatId);
  insertScheduledSend(
    characterId,
    chatId,
    DAY,
    windowStart,
    windowEnd,
    "잘 잤어요?",
    `${DAY} 05:45:00`,
    kind,
  );
  const id = Number(
    db
      .prepare(`SELECT id FROM scheduled_messages WHERE character_id = ?`)
      .pluck()
      .get(characterId),
  );
  return { chatId, characterId, id };
};

interface RowState {
  status: string;
  skip_reason: string | null;
  attempts: number;
  sent_at: string | null;
}

const stateOf = (id: number): RowState =>
  db
    .prepare(
      `SELECT status, skip_reason, attempts, sent_at FROM scheduled_messages WHERE id = ?`,
    )
    .get(id) as RowState;

const PENDING: RowState = {
  status: "pending",
  skip_reason: null,
  attempts: 0,
  sent_at: null,
};

test("발송 창이 아직 열리지 않은 행은 그대로 둔다", async () => {
  setClock("09:00");
  const row = plant("morning", "10:00", "10:30");
  await runDispatchTick();
  assert.deepEqual(stateOf(row.id), PENDING);
});

test("관제탑이 그날 보낼 종류로 지목하지 않은 행은 보내지 않는 날 사유로 건너뛴다", async () => {
  setClock("09:00");
  // 어제 대화한 적 없는 첫날은 아침 한 통이 답이라 안부 종류는 통과하지 못한다.
  const row = plant("checkin", "08:00", "08:40");
  await runDispatchTick();
  assert.deepEqual(stateOf(row.id), {
    ...PENDING,
    status: "skipped",
    skip_reason: "보내지 않는 날 (아침에 한 통)",
  });
});

test("창 종료 뒤 90분을 넘긴 행은 시도 없음 사유로 폐기한다", async () => {
  setClock("09:00");
  const row = plant("morning", "06:00", "06:30");
  await runDispatchTick();
  assert.deepEqual(stateOf(row.id), {
    ...PENDING,
    status: "skipped",
    skip_reason: "발송 창 지남 (시도 없음, 유예 08:00)",
  });
});

test("전송을 시도한 흔적이 있으면 전송 실패 사유로 폐기한다", async () => {
  setClock("09:00");
  const row = plant("morning", "06:00", "06:30");
  recordSendAttempt(row.id, "telegram down");
  recordSendAttempt(row.id, "telegram down");
  await runDispatchTick();
  assert.deepEqual(stateOf(row.id), {
    ...PENDING,
    status: "skipped",
    skip_reason: "유예(08:00)까지 전송 실패 — 2회 시도",
    attempts: 2,
  });
});

test("점심 창의 문안은 90분이 남았어도 두 시를 넘기면 폐기한다", async () => {
  setClock("14:10");
  const row = plant("morning", "12:05", "12:50");
  await runDispatchTick();
  assert.deepEqual(stateOf(row.id), {
    ...PENDING,
    status: "skipped",
    skip_reason: "발송 창 지남 (시도 없음, 유예 14:00)",
  });
});

test("유저가 네 시간 안에 먼저 연락한 대화에는 보내지 않는다", async () => {
  setClock("09:00");
  const row = plant("morning", "08:30", "09:30");
  logMessage(
    row.chatId,
    row.characterId,
    "user",
    "일어났어요",
    `${DAY} 07:30:00`,
  );
  await runDispatchTick();
  assert.deepEqual(stateOf(row.id), {
    ...PENDING,
    status: "skipped",
    skip_reason: "유저가 먼저 연락함",
  });
});

test("새벽 창의 문안은 06:30까지 살아 있다가 넘기면 폐기한다", async () => {
  const row = plant("morning", "04:00", "04:30");
  assert.equal(acquireProactive(row.chatId), true);
  try {
    setClock("06:20");
    await runDispatchTick();
    assert.deepEqual(stateOf(row.id), PENDING);
  } finally {
    releaseProactive(row.chatId);
  }
  setClock("06:40");
  await runDispatchTick();
  assert.deepEqual(stateOf(row.id), {
    ...PENDING,
    status: "skipped",
    skip_reason: "발송 창 지남 (시도 없음, 유예 06:30)",
  });
});

test("다른 틱이 이 대화의 잠금을 쥐고 있으면 다음 틱으로 미룬다", async () => {
  setClock("09:00");
  const row = plant("morning", "08:30", "09:30");
  assert.equal(acquireProactive(row.chatId), true);
  try {
    await runDispatchTick();
    assert.deepEqual(stateOf(row.id), PENDING);
  } finally {
    releaseProactive(row.chatId);
    // 잠금을 풀고 나면 이 행은 다음 틱에서 실제 발송으로 간다. 뒤에 검사가 붙어도 안 나가게 닫는다.
    markScheduledSend(row.id, "skipped", "검사 뒤 정리", null);
  }
});
