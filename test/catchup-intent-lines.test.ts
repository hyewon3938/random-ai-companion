// 근황 선톡이 꺼낸 줄이 같은 날 의도 선톡 후보에서 빠지는 흐름을 이어서 본다(이슈 #475).
//
// 근황 틱이 하는 순서대로 catchupLines로 줄을 넘기고, readCatchupOnce로 모델 답을 읽어
// sendProactiveDraft가 보내게 한다. 모델과 텔레그램은 부르지 않는다 — 정해 둔 답을 주는 ask와,
// 봇의 sendProactive처럼 proactive·kind와 read가 준 값을 meta_json에 적는 send를 끼운다. 그 뒤
// 의도 틱이 하는 순서대로 usedIntentLines와 intentLineLastUse를 읽어 intentCandidates에 넘긴다.
// 1단계는 줄이 파고들 것과 이어갈 자리 둘뿐이라, 근황 선톡이 파고들 것을 쓰고 이어갈 자리가
// 비었으면 그날 의도 선톡 후보가 비는 것도 붙잡는다(ADR-0023 결과).
//
// followup.ts가 DB와 봇 모듈을 함께 읽으므로 DB는 임시 파일로 새로 만들고 토큰은 가짜다.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "catchup-intent-lines-")),
  "t.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";

const { db, logMessage } = await import("../src/db.js");
const { createFixtureCharacter } =
  await import("../src/eval/fixture-character.js");
const { catchupLines, declineSpot, readCatchupOnce } =
  await import("../src/followup.js");
const { sendProactiveDraft } = await import("../src/proactive-send.js");
const { intentCandidates, intentLineLastUse, rotationSince, usedIntentLines } =
  await import("../src/proactive-policy.js");
const { kstStamp, logicalDayStartTs } = await import("../src/kst.js");
type Deps = import("../src/proactive-send.js").ProactiveDraftDeps;
type IntentRow = import("../src/db.js").RelationshipIntentRow;

after(() => {
  db.close();
});

const intentRow = (over: Partial<IntentRow>): IntentRow => ({
  id: 1,
  character_id: 1,
  date: "2026-09-20",
  dig: null,
  share: null,
  move: null,
  move_note: null,
  lead_tone: null,
  thread: null,
  basis_json: null,
  created_at: "2026-09-20 05:00:00",
  ...over,
});

/** 정해 둔 답을 주는 모델과, 봇의 sendProactive가 적는 모양 그대로 발송 기록을 남기는 발송. */
const fakeDeps = (answer: unknown): Deps => ({
  ask: (async () => answer) as Deps["ask"],
  send: (async (chatId, characterId, text, kind, extra) => {
    logMessage(chatId, characterId, "assistant", text, kstStamp(), {
      proactive: true,
      kind,
      ...extra,
    });
    return { delivered: 1, total: 1 };
  }) as Deps["send"],
});

/** 근황 틱이 줄을 넘기고 모델 답을 읽어 보내는 데까지. 마지막 말은 캐릭터 차례로 둔다. */
const sendCatchup = async (
  chatId: string,
  characterId: number,
  intent: IntentRow,
  answer: unknown,
) => {
  const last = kstStamp();
  logMessage(chatId, characterId, "assistant", "먼저 한 말", last);
  const offered = catchupLines(
    intent,
    usedIntentLines(chatId, characterId, logicalDayStartTs()),
  ).map((x) => x.line);
  const result = await sendProactiveDraft(
    {
      characterId,
      chatId,
      kind: "catchup",
      lastSentAt: last,
      situation: "[상황] 검사용 문단",
      maxTokens: 100,
      read: readCatchupOnce(chatId, declineSpot("14:00", last), offered),
      label: "[test] 근황",
      sentLog: "[test] catchup sent",
    },
    fakeDeps(answer),
  );
  return { offered, result };
};

/** 의도 틱이 후보를 만드는 순서 그대로. */
const intentLinesNow = (
  chatId: string,
  characterId: number,
  intent: IntentRow,
  stage: 1 | 2,
) =>
  intentCandidates(
    intent,
    stage,
    usedIntentLines(chatId, characterId, logicalDayStartTs()),
    intentLineLastUse(chatId, characterId, rotationSince(logicalDayStartTs())),
  );

test("근황 선톡이 꺼낸 줄은 기록에 남고 같은 날 의도 선톡 후보에서 빠진다", async () => {
  const chat = "chat-catchup-intent";
  const characterId = createFixtureCharacter(chat);
  const intent = intentRow({
    dig: "지난주 면접 결과가 나왔는지",
    share: "요즘 배우는 요리",
    thread: "주말에 가려던 전시",
  });
  assert.deepEqual(intentLinesNow(chat, characterId, intent, 2), [
    "dig",
    "share",
    "thread",
  ]);

  const { offered, result } = await sendCatchup(chat, characterId, intent, {
    send: true,
    opening: "my_day",
    lines: ["dig"],
    text: "나 이제 점심 먹으러 가. 면접 결과 나왔을지 궁금하더라",
  });
  assert.deepEqual(offered, ["share", "dig"]);
  assert.equal(result, "sent");

  // 발송 기록에 꺼낸 줄과 여는 방식이 실렸다.
  const row = db
    .prepare(
      `SELECT meta_json FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(chat) as { meta_json: string };
  assert.deepEqual(JSON.parse(row.meta_json), {
    proactive: true,
    kind: "catchup",
    intent_lines: ["dig"],
    opening: "my_day",
  });

  // 같은 날 의도 선톡은 근황 선톡이 쓴 줄을 빼고 받는다. 쓴 시각도 14일 순서에 남는다.
  assert.deepEqual(usedIntentLines(chat, characterId, logicalDayStartTs()), [
    "dig",
  ]);
  assert.deepEqual(intentLinesNow(chat, characterId, intent, 2), [
    "share",
    "thread",
  ]);
  assert.ok(
    intentLineLastUse(chat, characterId, rotationSince(logicalDayStartTs()))
      .dig,
  );
  // 근황 선톡이 안 꺼낸 흘릴 내 얘기는 남아 있다.
  assert.deepEqual(
    catchupLines(
      intent,
      usedIntentLines(chat, characterId, logicalDayStartTs()),
    ).map((x) => x.line),
    ["share"],
  );
});

test("1단계에서 근황 선톡이 파고들 것을 쓰고 이어갈 자리가 비었으면 그날 의도 선톡 후보가 빈다", async () => {
  const chat = "chat-catchup-intent-stage1";
  const characterId = createFixtureCharacter(chat);
  const intent = intentRow({ dig: "어제 말한 병원 예약" });
  assert.deepEqual(intentLinesNow(chat, characterId, intent, 1), ["dig"]);

  const { result } = await sendCatchup(chat, characterId, intent, {
    send: true,
    opening: "my_day",
    lines: ["dig"],
    text: "나 지금 카페 왔어. 병원 예약은 잡았을까 궁금하더라",
  });
  assert.equal(result, "sent");
  assert.deepEqual(intentLinesNow(chat, characterId, intent, 1), []);
});
