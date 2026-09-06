// 답장 파이프라인(reply-compose.ts)이 무엇을 프롬프트에 넣고 어느 답을 버리는지 붙잡아 두는 검사.
//
// 모델을 부르지 않는다 — 정해 둔 답을 돌려주는 함수를 ask 자리에 끼운다. 검색 태그는 태그
// 이름이 하나도 없으면 호출 없이 비어 있는 결과를 돌려주고, 평가용 캐릭터는 태그가 없다.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "reply-compose-")), "t.db");
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

const { db, logMessage, recordLlmCall } = await import("../src/db.js");
const { createFixtureCharacter } = await import("../src/eval/fixture-character.js");
const { composeReply, heldSituation, pendingUserTurn } = await import(
  "../src/reply-compose.js"
);
const { askReply } = await import("../src/reply-ask.js");
type ReplyAsker = import("../src/reply-compose.js").ReplyAsker;
type SystemBlock = import("../src/llm.js").SystemBlock;
type ChatTurn = import("../src/llm.js").ChatTurn;

const CHAT = "chat-compose";
let characterId = 0;

/** 정해 둔 객체 글을 돌려주는 ask. 몇 번 불렸는지와 받은 프롬프트를 남긴다. */
const canned = (
  texts: string[],
  hook?: (meta: { callId?: number }) => void,
): ReplyAsker & { calls: number; system: SystemBlock[]; turns: ChatTurn[] } => {
  const asker = (async (system, turns, meta) => {
    asker.system = system;
    asker.turns = turns;
    return askReply(async () => {
      asker.calls += 1;
      hook?.(meta);
      return {
        text: texts[Math.min(asker.calls, texts.length) - 1] ?? "",
        callId: meta.callId ?? null,
      };
    });
  }) as ReplyAsker & { calls: number; system: SystemBlock[]; turns: ChatTurn[] };
  asker.calls = 0;
  asker.system = [];
  asker.turns = [];
  return asker;
};

const reply = (bubbles: string[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ reply: bubbles, ...extra });

const clearMessages = (): void => {
  db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(CHAT);
};

before(() => {
  characterId = createFixtureCharacter(CHAT);
});
after(() => {
  db.close();
});

describe("pendingUserTurn", () => {
  it("마지막 캐릭터 말 뒤에 온 유저 메시지를 한 덩어리로 묶는다", () => {
    clearMessages();
    logMessage(CHAT, characterId, "user", "저녁 먹었어?", "2026-09-06 19:00:00");
    logMessage(CHAT, characterId, "assistant", "응 방금", "2026-09-06 19:01:00");
    logMessage(CHAT, characterId, "user", "뭐 먹었어", "2026-09-06 19:02:00");
    logMessage(CHAT, characterId, "user", "나도 배고픈데", "2026-09-06 19:02:30");
    assert.deepEqual(pendingUserTurn(CHAT), {
      at: "2026-09-06 19:02:30",
      text: "뭐 먹었어\n나도 배고픈데",
      n: 2,
    });
  });

  it("마지막 말이 캐릭터 차례면 null", () => {
    clearMessages();
    logMessage(CHAT, characterId, "user", "안녕", "2026-09-06 19:00:00");
    logMessage(CHAT, characterId, "assistant", "안녕", "2026-09-06 19:01:00");
    assert.equal(pendingUserTurn(CHAT), null);
  });
});

describe("composeReply", () => {
  it("상황 문단을 프롬프트 끝에 넣고 유저 발화를 기록 마지막에 두고 말풍선을 돌려준다", async () => {
    clearMessages();
    logMessage(CHAT, characterId, "user", "오늘 뭐 했어", "2026-09-06 19:00:00");
    const turn = pendingUserTurn(CHAT);
    assert.ok(turn);
    const ask = canned([reply(["집에 있었어", "너는?"], { note: "상대가 하루를 물었다" })]);
    const out = await composeReply({
      characterId,
      chatId: CHAT,
      turn,
      situation: "[검사용 상황 문단] 방금 돌아왔다.",
      context: { gathered: { activity: "저녁", blockStart: "18:00", waitedMs: 1 } },
      logTag: "[test]",
      ask,
    });
    assert.ok(out);
    assert.deepEqual(out.bubbles, ["집에 있었어", "너는?"]);
    assert.equal(out.signals.note, "상대가 하루를 물었다");
    assert.equal(out.callId, null);
    assert.equal(ask.calls, 1);
    const last = ask.system[ask.system.length - 1];
    assert.ok(last && last.text.includes("[검사용 상황 문단] 방금 돌아왔다."));
    const lastTurn = ask.turns[ask.turns.length - 1];
    assert.equal(lastTurn?.role, "user");
    assert.ok(lastTurn?.content.includes("오늘 뭐 했어"));
  });

  it("붙잡기 판정이 있으면 그 결과를 상황 문단으로 프롬프트 끝에 넣는다", async () => {
    clearMessages();
    logMessage(CHAT, characterId, "user", "가지 마", "2026-09-06 13:05:00");
    const turn = pendingUserTurn(CHAT);
    assert.ok(turn);
    const ask = canned([reply(["알았어 안 갈게"])]);
    await composeReply({
      characterId,
      chatId: CHAT,
      turn,
      situation: "[검사용 상황 문단] 자리를 비우려던 참이다.",
      heldActual: { blockStart: "13:00", activity: "운동", outcome: "취소" },
      context: {},
      logTag: "[test]",
      ask,
    });
    const last = ask.system[ask.system.length - 1]?.text ?? "";
    assert.ok(last.includes("[검사용 상황 문단] 자리를 비우려던 참이다."));
    assert.ok(last.includes("[붙잡기 판정 — 이미 정해진 것]"));
    assert.ok(last.includes('"운동"을(를) 취소하고 남기로 했다'));
    // 미룬 일정은 나중에 한다는 결로만 말하게 한다
    assert.ok(
      heldSituation({ activity: "팀 회식", outcome: "미룸" }).includes(
        "미루고 지금은 상대 곁에 남기로 했다",
      ),
    );
  });

  it("markFrom을 주면 그 시각 이후 첫 메시지에 시간 표시가 붙는다", async () => {
    clearMessages();
    logMessage(CHAT, characterId, "assistant", "잠깐 씻고 올게", "2026-09-06 21:00:00");
    logMessage(CHAT, characterId, "user", "응 다녀와", "2026-09-06 21:10:00");
    const turn = pendingUserTurn(CHAT);
    assert.ok(turn);
    const plain = canned([reply(["나 왔어"])]);
    await composeReply({
      characterId, chatId: CHAT, turn, context: {}, logTag: "[test]", ask: plain,
    });
    const marked = canned([reply(["나 왔어"])]);
    await composeReply({
      characterId, chatId: CHAT, turn, markFrom: "2026-09-06 21:05:00",
      context: {}, logTag: "[test]", ask: marked,
    });
    const plainLast = plain.turns[plain.turns.length - 1]?.content ?? "";
    const markedLast = marked.turns[marked.turns.length - 1]?.content ?? "";
    assert.ok(plainLast.includes("응 다녀와"));
    assert.notEqual(plainLast, markedLast);
    assert.ok(markedLast.length > plainLast.length);
  });

  it("두 번 불러도 비어 있으면 null", async () => {
    clearMessages();
    logMessage(CHAT, characterId, "user", "야", "2026-09-06 19:00:00");
    const turn = pendingUserTurn(CHAT);
    assert.ok(turn);
    const ask = canned([reply([]), reply([])]);
    const out = await composeReply({
      characterId, chatId: CHAT, turn, context: {}, logTag: "[test]", ask,
    });
    assert.equal(out, null);
    assert.equal(ask.calls, 2);
  });

  it("만드는 동안 새 유저 메시지가 오면 null", async () => {
    clearMessages();
    logMessage(CHAT, characterId, "user", "야", "2026-09-06 19:00:00");
    const turn = pendingUserTurn(CHAT);
    assert.ok(turn);
    const ask = canned([reply(["응"])], () => {
      logMessage(CHAT, characterId, "user", "아 잠깐", "2026-09-06 19:00:20");
    });
    const out = await composeReply({
      characterId, chatId: CHAT, turn, context: {}, logTag: "[test]", ask,
    });
    assert.equal(out, null);
  });

  it("호출 번호가 있으면 근거를 호출 기록에 붙이고 attach로 덧붙일 수 있다", async () => {
    clearMessages();
    logMessage(CHAT, characterId, "user", "잘 잤어?", "2026-09-06 08:00:00");
    logMessage(CHAT, characterId, "user", "나 오늘 쉬는 날", "2026-09-06 08:00:10");
    const turn = pendingUserTurn(CHAT);
    assert.ok(turn);
    const ask = canned([reply(["응 푹 잤어", "좋겠다"])], (meta) => {
      meta.callId = recordLlmCall({
        purpose: "reply", model: "test", characterId, chatId: CHAT,
        system: [], turns: "", latencyMs: 1,
      });
    });
    const out = await composeReply({
      characterId, chatId: CHAT, turn,
      context: { timing: { waitMs: 3000, path: "table" } },
      heldActual: { blockStart: "08:00", activity: "운동", outcome: "cancel" },
      logTag: "[test]", ask,
    });
    assert.ok(out);
    assert.ok(out.callId);
    out.attach({ sendAt: "2026-09-06 08:01:00" });
    const row = db
      .prepare(`SELECT context_json FROM llm_calls WHERE id = ?`)
      .get(out.callId) as { context_json: string };
    const ctx = JSON.parse(row.context_json) as Record<string, unknown>;
    assert.deepEqual(ctx.timing, { waitMs: 3000, path: "table" });
    assert.equal(ctx.userMsgs, 2);
    assert.equal(typeof ctx.turns, "number");
    assert.ok(ctx.search && typeof ctx.search === "object");
    assert.equal(ctx.outputParse, "json");
    assert.deepEqual(ctx.dayActual, {
      blockStart: "08:00", activity: "운동", outcome: "cancel", by: "judge",
    });
    assert.equal(ctx.bubbles, 2);
    assert.deepEqual(ctx.bubbleLens, [6, 3]);
    assert.equal(ctx.sendAt, "2026-09-06 08:01:00");
  });
});
