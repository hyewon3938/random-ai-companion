// 답장 자리에서 관계 세 항목을 갱신하는 relationship-update.ts를 검사한다 — 모델은 부르지 않는다.
//
// 말투는 존댓말에서 반말로만 가고 되돌아오지 않는다는 규칙과, 표본이 모자라면 손대지 않는 경계를
// 본다. 답장 신호는 빈 값·공백·지금과 같은 값이면 저장도 기록도 없어야 하고, 달라진 항목만 골라
// 한 번에 저장하면서 나머지 컬럼은 그대로여야 한다. 관계 행은 평가용 캐릭터로 만들고, 저장된
// 값이 없던 관계는 캐릭터 행과 관계 행을 직접 넣어 본다.

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
const { db, logMessage, getRelationship } = await import("../src/db.js");
const { EMPTY_SIGNALS } = await import("../src/reply-signal.js");
const { currentSpeechLevel } = await import("../src/speech-level.js");
const { createFixtureCharacter } =
  await import("../src/eval/fixture-character.js");
const { speechRatchet, applyReplySignals } =
  await import("../src/relationship-update.js");

const reply = (
  chatId: string,
  characterId: number,
  text: string,
  at: string,
): void =>
  logMessage(chatId, characterId, "assistant", text, at, { kind: "reply" });

const rel = (characterId: number) => {
  const row = getRelationship(characterId);
  assert.ok(row, "관계 행이 있어야 한다");
  return row;
};

const RATCHET = "chat-ratchet";
const POLITE = "chat-polite";
const SIGNALS = "chat-signals";
const ratchetId = createFixtureCharacter(RATCHET);
const politeId = createFixtureCharacter(POLITE);
const signalsId = createFixtureCharacter(SIGNALS);

const NOW1 = "2026-09-06 14:00:00";
const NOW2 = "2026-09-06 15:00:00";

after(() => {
  db.close();
});

test("표본이 모자라거나 존댓말이면 말투를 건드리지 않는다", () => {
  const before = rel(ratchetId);
  assert.equal(before.speech_level, "polite");
  assert.deepEqual(speechRatchet(ratchetId, RATCHET, NOW1), []);
  reply(RATCHET, ratchetId, "응 잘 지냈어", "2026-09-06 10:00:10");
  reply(RATCHET, ratchetId, "밥 먹었어?", "2026-09-06 10:01:00");
  assert.equal(currentSpeechLevel(RATCHET), null);
  assert.deepEqual(speechRatchet(ratchetId, RATCHET, NOW1), []);
  assert.deepEqual(rel(ratchetId), before);

  const politeBefore = rel(politeId);
  reply(POLITE, politeId, "잘 지내세요?", "2026-09-06 10:00:10");
  reply(POLITE, politeId, "저는 괜찮아요", "2026-09-06 10:01:00");
  reply(POLITE, politeId, "네 그렇죠", "2026-09-06 10:02:00");
  assert.equal(currentSpeechLevel(POLITE), "존댓말");
  assert.deepEqual(speechRatchet(politeId, POLITE, NOW1), []);
  assert.deepEqual(rel(politeId), politeBefore);
});

test("최근 답장이 반말이면 말투를 반말로 옮기고 바뀐 기록을 돌려준다", () => {
  reply(RATCHET, ratchetId, "나는 아직이야", "2026-09-06 10:02:00");
  assert.equal(currentSpeechLevel(RATCHET), "반말");
  assert.deepEqual(speechRatchet(ratchetId, RATCHET, NOW1), [
    { field: "말투", from: "polite", to: "casual" },
  ]);
  const row = rel(ratchetId);
  assert.equal(row.speech_level, "casual");
  assert.equal(row.updated_at, NOW1);
});

test("반말이 된 뒤에는 존댓말 답장이 쌓여도 되돌리지 않고 다시 저장하지도 않는다", () => {
  for (let i = 0; i < 6; i++)
    reply(RATCHET, ratchetId, `${i}번째 답도 알겠습니다`, `2026-09-06 11:0${i}:00`);
  assert.equal(currentSpeechLevel(RATCHET), "존댓말");
  assert.deepEqual(speechRatchet(ratchetId, RATCHET, NOW2), []);
  const row = rel(ratchetId);
  assert.equal(row.speech_level, "casual");
  assert.equal(row.updated_at, NOW1);
});

test("신호가 비어 있거나 공백뿐이면 저장도 기록도 하지 않는다", () => {
  const before = rel(signalsId);
  assert.deepEqual(applyReplySignals(signalsId, EMPTY_SIGNALS, NOW1), []);
  assert.deepEqual(
    applyReplySignals(
      signalsId,
      { ...EMPTY_SIGNALS, stage: "   ", addressTerms: "\n\t" },
      NOW1,
    ),
    [],
  );
  assert.deepEqual(rel(signalsId), before);
});

test("지금 값과 같은 단계와 호칭은 앞뒤 공백이 달라도 다시 저장하지 않는다", () => {
  const before = rel(signalsId);
  assert.equal(before.stage, "알게 된 지 얼마 안 된 사이");
  assert.equal(before.address_terms, "서로 존칭을 쓴다");
  assert.deepEqual(
    applyReplySignals(
      signalsId,
      {
        ...EMPTY_SIGNALS,
        stage: `  ${before.stage}  `,
        addressTerms: before.address_terms,
      },
      NOW1,
    ),
    [],
  );
  assert.deepEqual(rel(signalsId), before);
});

test("달라진 단계만 저장하고 나머지 항목은 그대로 둔다", () => {
  const before = rel(signalsId);
  assert.deepEqual(
    applyReplySignals(
      signalsId,
      { ...EMPTY_SIGNALS, stage: " 말을 놓기 시작한 사이 " },
      NOW1,
    ),
    [
      {
        field: "지금 어떤 사이",
        from: "알게 된 지 얼마 안 된 사이",
        to: "말을 놓기 시작한 사이",
      },
    ],
  );
  assert.deepEqual(rel(signalsId), {
    ...before,
    stage: "말을 놓기 시작한 사이",
    updated_at: NOW1,
  });
});

test("단계와 호칭이 함께 달라지면 둘 다 한 번에 저장한다", () => {
  const before = rel(signalsId);
  assert.deepEqual(
    applyReplySignals(
      signalsId,
      { ...EMPTY_SIGNALS, stage: "친구", addressTerms: "이름을 부른다" },
      NOW2,
    ),
    [
      { field: "지금 어떤 사이", from: "말을 놓기 시작한 사이", to: "친구" },
      { field: "서로 부르는 말", from: "서로 존칭을 쓴다", to: "이름을 부른다" },
    ],
  );
  assert.deepEqual(rel(signalsId), {
    ...before,
    stage: "친구",
    address_terms: "이름을 부른다",
    updated_at: NOW2,
  });
});

test("저장된 호칭이 없던 관계는 앞 값을 null로 기록한다", () => {
  const bareId = Number(
    db
      .prepare(
        `INSERT INTO characters (chat_id, status, genesis_json, created_at)
         VALUES ('chat-bare', 'active', '{}', '2026-09-06 09:00:00') RETURNING id`,
      )
      .pluck()
      .get(),
  );
  db.prepare(
    `INSERT INTO relationships (character_id, met_at) VALUES (?, '2026-09-06 09:00:00')`,
  ).run(bareId);
  assert.deepEqual(
    applyReplySignals(bareId, { ...EMPTY_SIGNALS, addressTerms: "누나" }, NOW1),
    [{ field: "서로 부르는 말", from: null, to: "누나" }],
  );
  const row = rel(bareId);
  assert.equal(row.address_terms, "누나");
  assert.equal(row.stage, null);
  assert.equal(row.updated_at, NOW1);
});
