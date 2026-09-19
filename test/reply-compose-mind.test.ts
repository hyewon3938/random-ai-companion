// 답장 파이프라인이 캐릭터의 마음 판정을 저장하고 [네 마음] 블록으로 싣는 자리를 검사한다 — 모델은 부르지 않는다(#473).
//
// 정해 둔 판정을 돌려주는 함수를 judge 자리에, 정해 둔 답을 돌려주는 함수를 ask 자리에 끼운다.
// 마음이 조립 전에 저장돼 이번 답장의 캐시 밖 블록에 상대 상태 뒤로 실리는지, 오늘 기분이 같은
// 블록에 붙는지, 호출 기록의 관계 갱신과 마음 칸에 남는지 본다. 상대 상태 칸이 깨져도 마음은
// 반영되고, 판정 호출 자체가 실패하면 저장된 마음을 그대로 두고 실패로 적는지도 본다.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "reply-compose-mind-")),
  "t.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

const { db, logMessage, recordLlmCall, saveDaySeed } =
  await import("../src/db.js");
const { createFixtureCharacter } =
  await import("../src/eval/fixture-character.js");
const { composeReply, pendingUserTurn } =
  await import("../src/reply-compose.js");
const { askReply } = await import("../src/reply-ask.js");
const { kstLogicalDate, kstStamp } = await import("../src/kst.js");
type ReplyAsker = import("../src/reply-compose.js").ReplyAsker;
type SystemBlock = import("../src/llm.js").SystemBlock;
type UserStateVerdict = import("../src/user-state.js").UserStateVerdict;

const CHAT = "chat-compose-mind";
let characterId = 0;

/** 정해 둔 답 한 통을 돌려주고 받은 프롬프트와 호출 번호를 남기는 ask. */
const canned = (): ReplyAsker & { system: SystemBlock[] } => {
  const asker = (async (system, _turns, meta) => {
    asker.system = system;
    return askReply(async () => {
      meta.callId = recordLlmCall({
        purpose: "reply",
        model: "test",
        system: [],
        turns: "",
        latencyMs: 1,
      });
      return { text: JSON.stringify({ reply: ["응"] }), callId: meta.callId };
    });
  }) as ReplyAsker & { system: SystemBlock[] };
  asker.system = [];
  return asker;
};

const compose = async (
  judge: () => Promise<UserStateVerdict>,
): Promise<{ system: SystemBlock[]; ctx: Record<string, unknown> }> => {
  const turn = pendingUserTurn(CHAT, characterId);
  assert.ok(turn);
  const ask = canned();
  const out = await composeReply({
    judge,
    characterId,
    chatId: CHAT,
    turn,
    context: {},
    logTag: "[test]",
    ask,
  });
  assert.ok(out?.callId);
  out.attach({});
  const row = db
    .prepare(`SELECT context_json FROM llm_calls WHERE id = ?`)
    .get(out.callId) as { context_json: string };
  return {
    system: ask.system,
    ctx: JSON.parse(row.context_json) as Record<string, unknown>,
  };
};

const mindCols = (): Record<string, unknown> =>
  db
    .prepare(
      `SELECT mind_kind, mind_level, mind_reason FROM relationships WHERE character_id = ?`,
    )
    .get(characterId) as Record<string, unknown>;

before(() => {
  characterId = createFixtureCharacter(CHAT);
  saveDaySeed(characterId, {
    date: kstLogicalDate(),
    energy: "보통",
    wake_hint: "보통",
    mood: "조금 가라앉음",
    reason: "어제 늦게까지 도면을 봤다",
  });
});
beforeEach(() => {
  db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(CHAT);
  logMessage(CHAT, characterId, "user", "나 오늘 동기랑 저녁 먹어", kstStamp());
});
after(() => {
  db.close();
});

describe("캐릭터의 마음 — 답장 경로", () => {
  it("판정한 마음을 조립 전에 저장해 캐시 밖 블록에 상대 상태 뒤로 싣고 호출 기록에 남긴다", async () => {
    const reason = "동기랑 둘이 저녁 먹는다고 했다";
    const { system, ctx } = await compose(async () => ({
      changed: true,
      state: {
        state: "동기와 저녁 약속이 있어 들떠 있다",
        cause: "other",
        tone: "good",
        since: kstStamp(),
      },
      failed: false,
      callId: null,
      prev: null,
      mind: { changed: true, kind: "hurt", level: 2, reason },
    }));
    assert.deepEqual(mindCols(), {
      mind_kind: "hurt",
      mind_level: 2,
      mind_reason: reason,
    });
    const live = system
      .filter((b) => !b.cache)
      .map((b) => b.text)
      .join("\n");
    const cached = system
      .filter((b) => b.cache)
      .map((b) => b.text)
      .join("\n");
    // 규칙층(PERSON)도 [네 마음]을 가리키는 줄이 있어 블록 머리는 줄바꿈까지 본다
    assert.ok(!cached.includes("[네 마음]\n"));
    assert.ok(!cached.includes("오늘 대화에서 생긴 마음"));
    const state = live.indexOf("[상대의 지금 상태");
    assert.ok(state >= 0);
    assert.ok(live.indexOf("[네 마음]\n") > state);
    assert.ok(live.includes("- 오늘 대화에서 생긴 마음: 서운함, 세기 2/3. "));
    assert.ok(live.includes(`계기: ${reason}.`));
    // 1단계 서운함 줄 — 상대 상태가 좋음이라 단계 줄을 쓴다
    assert.ok(
      live.includes(
        "- 드러내는 정도: 말투와 답장 길이에만 반영하고 말로 꺼내지 않는다.",
      ),
    );
    assert.ok(
      live.includes(
        "- 오늘 기분: 조금 가라앉음 (어제 늦게까지 도면을 봤다). 상대를 대하는 태도는",
      ),
    );
    assert.deepEqual(
      (ctx.relUpdate as { field: string }[]).filter(
        (c) => c.field === "캐릭터 마음",
      ),
      [{ field: "캐릭터 마음", from: null, to: "서운함 2" }],
    );
    assert.deepEqual(ctx.mind, {
      changed: true,
      failed: false,
      label: "서운함 2",
      prev: null,
      reason,
    });
  });

  it("상대 상태 칸이 깨진 턴에도 읽은 마음은 반영하고 마음은 실패로 적지 않는다", async () => {
    const { ctx } = await compose(async () => ({
      changed: false,
      state: null,
      failed: true,
      callId: null,
      prev: null,
      mind: {
        changed: true,
        kind: "jealous",
        level: 1,
        reason: "동기 얘기를 길게 했다",
      },
    }));
    assert.equal(mindCols().mind_kind, "jealous");
    assert.equal((ctx.userState as { failed: boolean }).failed, true);
    assert.deepEqual(ctx.mind, {
      changed: true,
      failed: false,
      label: "질투 1",
      prev: "서운함 2",
      reason: "동기 얘기를 길게 했다",
    });
  });

  it("판정 호출이 실패한 턴은 저장된 마음을 그대로 두고 블록에도 그 값을 싣는다", async () => {
    const { system, ctx } = await compose(async () => ({
      changed: false,
      state: null,
      failed: true,
      callId: null,
      prev: null,
      mindFailed: true,
    }));
    assert.equal(mindCols().mind_kind, "jealous");
    assert.equal(ctx.relUpdate, undefined);
    assert.deepEqual(ctx.mind, {
      changed: false,
      failed: true,
      label: "질투 1",
      prev: null,
      reason: null,
    });
    const live = system
      .filter((b) => !b.cache)
      .map((b) => b.text)
      .join("\n");
    assert.ok(live.includes("- 오늘 대화에서 생긴 마음: 질투, 세기 1/3."));
  });

  it("평소로 판정되면 마음 줄이 빠지고 오늘 기분만 남는다", async () => {
    const { system, ctx } = await compose(async () => ({
      changed: false,
      state: null,
      failed: false,
      callId: null,
      prev: null,
      mind: { changed: true, kind: null, level: null, reason: null },
    }));
    assert.equal(mindCols().mind_kind, null);
    assert.deepEqual(ctx.mind, {
      changed: true,
      failed: false,
      label: null,
      prev: "질투 1",
      reason: null,
    });
    const live = system
      .filter((b) => !b.cache)
      .map((b) => b.text)
      .join("\n");
    assert.ok(live.includes("[네 마음]\n- 오늘 기분: 조금 가라앉음"));
    assert.ok(!live.includes("오늘 대화에서 생긴 마음"));
  });
});
