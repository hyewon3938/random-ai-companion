// 답장 파이프라인(reply-compose.ts)이 무엇을 프롬프트에 넣고 어느 답을 버리는지 붙잡아 두는 검사.
//
// 모델을 부르지 않는다 — 정해 둔 답을 돌려주는 함수를 ask 자리에, 정해 둔 판정을 돌려주는
// 함수를 judge 자리에 끼운다. 검색 태그는 태그 이름이 하나도 없으면 호출 없이 비어 있는 결과를
// 돌려주고, 평가용 캐릭터는 태그가 없다.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "reply-compose-")), "t.db");
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

const {
  addSchedule,
  db,
  getActiveSchedulesOn,
  saveRelationshipIntent,
  getRelationshipSignals,
  getUnconfirmedFirsts,
  logMessage,
  recordLlmCall,
} = await import("../src/db.js");
const { createFixtureCharacter } = await import("../src/eval/fixture-character.js");
const { composeReply, heldSituation, pendingUserTurn } = await import(
  "../src/reply-compose.js"
);
const { askReply } = await import("../src/reply-ask.js");
const { userStateLabel } = await import("../src/user-state.js");
const { kstLogicalDate, kstStamp, kstStampBefore, logicalDateOf } = await import(
  "../src/kst.js"
);
type ReplyAsker = import("../src/reply-compose.js").ReplyAsker;
type SystemBlock = import("../src/llm.js").SystemBlock;
type ChatTurn = import("../src/llm.js").ChatTurn;
type UserStateVerdict = import("../src/user-state.js").UserStateVerdict;

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

/** 상대 상태를 그대로 두는 judge — 모델을 부르지 않는다. */
const noJudge = async (): Promise<UserStateVerdict> => ({
  changed: false, state: null, failed: false, callId: null, prev: null,
});

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
    assert.deepEqual(pendingUserTurn(CHAT, characterId), {
      at: "2026-09-06 19:02:30",
      firstAt: "2026-09-06 19:02:00",
      text: "뭐 먹었어\n나도 배고픈데",
      n: 2,
    });
  });

  it("마지막 말이 캐릭터 차례면 null", () => {
    clearMessages();
    logMessage(CHAT, characterId, "user", "안녕", "2026-09-06 19:00:00");
    logMessage(CHAT, characterId, "assistant", "안녕", "2026-09-06 19:01:00");
    assert.equal(pendingUserTurn(CHAT, characterId), null);
  });
});

describe("composeReply", () => {
  it("상황 문단을 프롬프트 끝에 넣고 유저 발화를 기록 마지막에 두고 말풍선을 돌려준다", async () => {
    clearMessages();
    logMessage(CHAT, characterId, "user", "오늘 뭐 했어", "2026-09-06 19:00:00");
    const turn = pendingUserTurn(CHAT, characterId);
    assert.ok(turn);
    const ask = canned([reply(["집에 있었어", "너는?"], { note: ["상대가 하루를 물었다"] })]);
    const out = await composeReply({
      judge: noJudge,
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
    assert.deepEqual(out.signals.note, ["상대가 하루를 물었다"]);
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
    const turn = pendingUserTurn(CHAT, characterId);
    assert.ok(turn);
    const ask = canned([reply(["알았어 안 갈게"])]);
    await composeReply({
      judge: noJudge,
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
    const turn = pendingUserTurn(CHAT, characterId);
    assert.ok(turn);
    const plain = canned([reply(["나 왔어"])]);
    await composeReply({
      judge: noJudge,
      characterId, chatId: CHAT, turn, context: {}, logTag: "[test]", ask: plain,
    });
    const marked = canned([reply(["나 왔어"])]);
    await composeReply({
      judge: noJudge,
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
    const turn = pendingUserTurn(CHAT, characterId);
    assert.ok(turn);
    const ask = canned([reply([]), reply([])]);
    const out = await composeReply({
      judge: noJudge,
      characterId, chatId: CHAT, turn, context: {}, logTag: "[test]", ask,
    });
    assert.equal(out, null);
    assert.equal(ask.calls, 2);
  });

  it("만드는 동안 새 유저 메시지가 오면 null", async () => {
    clearMessages();
    logMessage(CHAT, characterId, "user", "야", "2026-09-06 19:00:00");
    const turn = pendingUserTurn(CHAT, characterId);
    assert.ok(turn);
    const ask = canned([reply(["응"])], () => {
      logMessage(CHAT, characterId, "user", "아 잠깐", "2026-09-06 19:00:20");
    });
    const out = await composeReply({
      judge: noJudge,
      characterId, chatId: CHAT, turn, context: {}, logTag: "[test]", ask,
    });
    assert.equal(out, null);
  });

  it("호출 번호가 있으면 근거를 호출 기록에 붙이고 attach로 덧붙일 수 있다", async () => {
    clearMessages();
    logMessage(CHAT, characterId, "user", "잘 잤어?", "2026-09-06 08:00:00");
    logMessage(CHAT, characterId, "user", "나 오늘 쉬는 날", "2026-09-06 08:00:10");
    const turn = pendingUserTurn(CHAT, characterId);
    assert.ok(turn);
    const ask = canned([reply(["응 푹 잤어", "좋겠다"])], (meta) => {
      meta.callId = recordLlmCall({
        purpose: "reply", model: "test", characterId, chatId: CHAT,
        system: [], turns: "", latencyMs: 1,
      });
    });
    const out = await composeReply({
      judge: noJudge,
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
  it("상대 상태 판정이 바뀌면 저장하고 그 줄을 캐시 밖 블록에 넣고 관계 변경으로 남긴다", async () => {
    clearMessages();
    logMessage(CHAT, characterId, "user", "왜 연락 안 했어", "2026-09-06 21:30:00");
    const turn = pendingUserTurn(CHAT, characterId);
    assert.ok(turn);
    const record = (meta: { callId?: number }): void => {
      meta.callId = recordLlmCall({
        purpose: "reply", model: "test", system: [], turns: "", latencyMs: 1,
      });
    };
    const ask = canned([reply(["미안 진짜"])], record);
    const judge = async (): Promise<UserStateVerdict> => ({
      changed: true,
      state: {
        state: "연락한다던 말을 안 지켜 서운함",
        cause: "char",
        tone: "bad",
        since: "2026-09-06 21:30:00",
      },
      failed: false,
      callId: null,
      prev: null,
    });
    const out = await composeReply({
      judge, characterId, chatId: CHAT, turn, context: {}, logTag: "[test]", ask,
    });
    assert.ok(out);
    const row = db
      .prepare(
        `SELECT user_state, user_state_cause, user_state_tone, user_state_since
           FROM relationships WHERE character_id = ?`,
      )
      .get(characterId) as Record<string, string | null>;
    assert.deepEqual(row, {
      user_state: "연락한다던 말을 안 지켜 서운함",
      user_state_cause: "char",
      user_state_tone: "bad",
      user_state_since: "2026-09-06 21:30:00",
    });
    // 표기는 실제 오늘 날짜에 따라 9/6이 앞에 붙기도 한다 — 같은 함수로 기대값을 만든다
    const label = userStateLabel(
      {
        user_state: row.user_state,
        user_state_cause: "char",
        user_state_tone: "bad",
        user_state_since: row.user_state_since,
      },
      logicalDateOf(kstStamp()),
    );
    assert.ok(label && label.endsWith("21:30부터 · 나 때문 · 안 좋음)"));
    const all = ask.system.map((b) => b.text).join("\n");
    assert.ok(all.includes("[상대의 지금 상태 — 답장마다 판정해 둔 것]"));
    assert.ok(all.includes(label));
    // 상태 줄은 캐시하지 않는 마지막 블록에만 있어야 한다
    const cached = ask.system.filter((b) => b.cache).map((b) => b.text).join("\n");
    assert.ok(!cached.includes("[상대의 지금 상태 — 답장마다 판정해 둔 것]"));
    assert.ok(out.callId);
    out.attach({});
    const ctx = JSON.parse(
      (db.prepare(`SELECT context_json FROM llm_calls WHERE id = ?`).get(out.callId) as {
        context_json: string;
      }).context_json,
    ) as Record<string, unknown>;
    assert.deepEqual(ctx.relUpdate, [{ field: "상대 상태", from: null, to: label }]);
    assert.deepEqual(ctx.userState, { changed: true, failed: false, callId: null, label, prev: null });

    // 같은 값이 다시 오면 저장도 관계 변경 기록도 없다
    clearMessages();
    logMessage(CHAT, characterId, "user", "응", "2026-09-06 21:40:00");
    const turn2 = pendingUserTurn(CHAT, characterId);
    assert.ok(turn2);
    const out2 = await composeReply({
      judge, characterId, chatId: CHAT, turn: turn2, context: {}, logTag: "[test]",
      ask: canned([reply(["…"])], record),
    });
    assert.ok(out2);
    assert.ok(out2.callId);
    out2.attach({});
    const ctx2 = JSON.parse(
      (db.prepare(`SELECT context_json FROM llm_calls WHERE id = ?`).get(out2.callId) as {
        context_json: string;
      }).context_json,
    ) as Record<string, unknown>;
    assert.equal(ctx2.relUpdate, undefined);
    assert.deepEqual(ctx2.userState, { changed: true, failed: false, callId: null, label, prev: null });
    db.prepare(
      `UPDATE relationships SET user_state = NULL, user_state_cause = NULL,
         user_state_tone = NULL, user_state_since = NULL WHERE character_id = ?`,
    ).run(characterId);
  });

  it("관계 신호 — 처음은 미확정 행, 일정을 말했으면 안다는 표시, 열림은 턴마다 1행, 쓴 플러팅은 replyMeta", async () => {
    clearMessages();
    const today = kstLogicalDate();
    const scheduleId = addSchedule(
      characterId, "char", today, "19:00", "저녁에 헬스", kstStamp(), "rhythm",
    );
    logMessage(CHAT, characterId, "user", "오늘 뭐 해?", kstStamp());
    const turn = pendingUserTurn(CHAT, characterId);
    assert.ok(turn);
    const judge = async (): Promise<UserStateVerdict> => ({
      changed: false, state: null, failed: false, callId: null, prev: null,
      signals: {
        openedSelf: false, askedAboutChar: true, saidAffection: false,
        prevMove: "nickname", moveReaction: "accepted",
      },
    });
    const out = await composeReply({
      judge, characterId, chatId: CHAT, turn, context: {}, logTag: "[test]",
      ask: canned([
        reply(["저녁에 헬스 가", "너는?"], {
          move: "nickname", first: "first_laugh", first_by: "user", told_plan: true,
        }),
      ]),
    });
    assert.ok(out);
    assert.deepEqual(out.replyMeta, { move: "nickname", told_plan: true });
    // 처음 — 미확정 행으로 적히고 누가 먼저였는지가 남는다
    const firsts = getUnconfirmedFirsts(characterId);
    assert.deepEqual(
      firsts.map((f) => [f.kind, f.by, f.confirmed]),
      [["first_laugh", "user", 0]],
    );
    // 오늘 캐릭터 일정 — 상대가 안다는 표시
    const known = db
      .prepare(`SELECT user_knows FROM schedules WHERE id = ?`)
      .get(scheduleId) as { user_knows: string };
    assert.equal(known.user_knows, "known");
    assert.equal(getActiveSchedulesOn(characterId, "char", today).length, 1);
    // 열림 — 이 턴의 1행
    const sigs = getRelationshipSignals(characterId, "2000-01-01", "2100-01-01");
    assert.equal(sigs.length, 1);
    assert.deepEqual(
      [sigs[0]!.opened_self, sigs[0]!.asked_about_char, sigs[0]!.said_affection,
        sigs[0]!.prev_move, sigs[0]!.move_reaction],
      [0, 1, 0, "nickname", "accepted"],
    );

    // 같은 처음이 다시 와도 행은 하나, 열림 칸이 없는 판정이면 행을 더 적지 않는다
    clearMessages();
    logMessage(CHAT, characterId, "user", "ㅋㅋㅋ", kstStamp());
    const turn2 = pendingUserTurn(CHAT, characterId);
    assert.ok(turn2);
    const out2 = await composeReply({
      judge: noJudge, characterId, chatId: CHAT, turn: turn2, context: {}, logTag: "[test]",
      ask: canned([reply(["웃었네"], { first: "first_laugh" })]),
    });
    assert.ok(out2);
    assert.equal(out2.replyMeta, null);
    assert.equal(getUnconfirmedFirsts(characterId).length, 1);
    assert.equal(
      getRelationshipSignals(characterId, "2000-01-01", "2100-01-01").length,
      1,
    );
    db.prepare(`DELETE FROM firsts WHERE character_id = ?`).run(characterId);
    db.prepare(`DELETE FROM relationship_signals WHERE character_id = ?`).run(characterId);
    db.prepare(`DELETE FROM schedules WHERE id = ?`).run(scheduleId);
  });

  it("일정 말함 — 오늘 캐릭터 일정이 둘 이상이면 어느 것인지 몰라 표시하지 않는다", async () => {
    clearMessages();
    const today = kstLogicalDate();
    const ids = [
      addSchedule(characterId, "char", today, "12:00", "점심 약속", kstStamp(), "rhythm"),
      addSchedule(characterId, "char", today, "19:00", "저녁에 헬스", kstStamp(), "rhythm"),
    ];
    logMessage(CHAT, characterId, "user", "오늘 뭐 해?", kstStamp());
    const turn = pendingUserTurn(CHAT, characterId);
    assert.ok(turn);
    const out = await composeReply({
      judge: noJudge, characterId, chatId: CHAT, turn, context: {}, logTag: "[test]",
      ask: canned([reply(["저녁에 헬스 가"], { told_plan: true })]),
    });
    assert.ok(out);
    assert.deepEqual(out.replyMeta, { told_plan: true });
    const knows = db
      .prepare(`SELECT user_knows FROM schedules WHERE id IN (?, ?) ORDER BY id`)
      .all(...ids) as { user_knows: string }[];
    assert.deepEqual(knows.map((k) => k.user_knows), ["unknown", "unknown"]);
    db.prepare(`DELETE FROM schedules WHERE id IN (?, ?)`).run(...ids);
  });

  it("열림 신호 — 폐기된 답장의 행은 다시 만든 답장의 행으로 바뀌고, 나간 답장 뒤의 턴은 새 행이다", async () => {
    clearMessages();
    const judge = async (): Promise<UserStateVerdict> => ({
      changed: false, state: null, failed: false, callId: null, prev: null,
      signals: {
        openedSelf: true, askedAboutChar: false, saidAffection: false,
        prevMove: null, moveReaction: "none",
      },
    });
    const count = (): number =>
      getRelationshipSignals(characterId, "2000-01-01", "2100-01-01").length;
    const compose = async (text: string): Promise<void> => {
      const turn = pendingUserTurn(CHAT, characterId);
      assert.ok(turn);
      const out = await composeReply({
        judge, characterId, chatId: CHAT, turn, context: {}, logTag: "[test]",
        ask: canned([reply([text])]),
      });
      assert.ok(out);
    };
    // 앞서 나간 답장은 1분 전, 유저 말이 온 뒤 답장을 만든다
    logMessage(CHAT, characterId, "assistant", "먼저 보낸 말", kstStampBefore(60_000));
    logMessage(CHAT, characterId, "user", "나 오늘 좀 힘들었어", kstStamp());
    await compose("힘들었구나");
    assert.equal(count(), 1);
    // 그 답장이 나가기 전에 유저가 말을 더 보내 폐기하고 다시 만든다 — 행은 그대로 1
    logMessage(CHAT, characterId, "user", "아니 그냥", kstStamp());
    await compose("무슨 일인데");
    assert.equal(count(), 1);
    // 답장이 나간 뒤에 온 턴은 새 행이다
    logMessage(CHAT, characterId, "assistant", "무슨 일인데", kstStamp());
    logMessage(CHAT, characterId, "user", "회사에서", kstStamp());
    await compose("아이고");
    assert.equal(count(), 2);
    db.prepare(`DELETE FROM relationship_signals WHERE character_id = ?`).run(characterId);
  });

  // 오늘 의도로 둔 것을 이번 답장이 썼는지가 남아야, 몇 시간 뒤 선톡이 같은 물음을 다시
  // 던지지 않는다(이슈 #390). 앞일의 근거로 쓴 일정 줄은 게시가 참고한 일정 옆에 적는다(#397).
  it("답장이 쓴 의도 줄은 replyMeta로 나가고 오늘 둔 플러팅·앞일 근거는 판단 근거에 남는다", async () => {
    clearMessages();
    const today = kstLogicalDate();
    saveRelationshipIntent(
      characterId,
      today,
      { dig: "왜 그 팀을 그만뒀는지", move: "nickname", leadTone: "tease_sincere" },
      kstStamp(),
    );
    logMessage(CHAT, characterId, "user", "요즘 어때?", kstStamp());
    const turn = pendingUserTurn(CHAT, characterId);
    assert.ok(turn);
    const record = (meta: { callId?: number }): void => {
      meta.callId = recordLlmCall({
        purpose: "reply", model: "test", system: [], turns: "", latencyMs: 1,
      });
    };
    const out = await composeReply({
      judge: noJudge, characterId, chatId: CHAT, turn, context: {}, logTag: "[test]",
      ask: canned(
        [
          reply(["그 팀이랑은 좀 괜찮아졌어?", "나는 금요일에 워크샵 가"], {
            intent_lines: ["dig", "thread"],
            plan_ref: ["9/18 팀 워크샵"],
          }),
        ],
        record,
      ),
    });
    assert.ok(out);
    assert.deepEqual(out.replyMeta, { intent_lines: ["dig", "thread"] });
    out.attach({});
    const ctx = JSON.parse(
      (db.prepare(`SELECT context_json FROM llm_calls WHERE id = ?`).get(out.callId) as {
        context_json: string;
      }).context_json,
    ) as Record<string, unknown>;
    const rel = ctx.relationship as Record<string, unknown>;
    assert.equal(rel.todayMove, "별명 부르기. 앞세울 결은 장난 속에 진심");
    assert.deepEqual(rel.intentLines, ["dig", "thread"]);
    assert.deepEqual(ctx.planRef, ["9/18 팀 워크샵"]);
    db.prepare(`DELETE FROM relationship_intents WHERE character_id = ?`).run(characterId);
  });
});
