// 선톡 한 통을 보내는 공통 함수(proactive-send.ts)의 순서를 붙잡는 검사.
//
// 모델과 텔레그램은 부르지 않는다 — 정해 둔 응답을 주는 ask와 보낸 글을 적기만 하는 send를
// 끼운다. 잠금·보관 문안·발송 직전 재확인·실패 보관이 followup·presence에서 하던 대로 도는지 본다.
// 문안을 만든 호출 번호가 발송 기록에 실리는지, 보관했다 다시 보낸 문안도 처음 번호를 싣는지도 본다.
// 모델 호출이 실패하면 보관 없이 "failed"를 주는지, read가 준 발송 기록 값이 보관했다 다시 보낸
// 문안에도 실리고 같은 이름이면 호출 번호에 밀리는지, 나간 로그 끝에 붙는지 함께 본다(이슈 #471).

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "proactive-send-")),
  "t.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

const { db, logMessage } = await import("../src/db.js");
const { createFixtureCharacter } =
  await import("../src/eval/fixture-character.js");
const { acquireProactive, releaseProactive } = await import("../src/bot.js");
const { sendProactiveDraft, readText, readSendText, noOverlap } =
  await import("../src/proactive-send.js");
type Deps = import("../src/proactive-send.js").ProactiveDraftDeps;
type Spec<T> = import("../src/proactive-send.js").ProactiveDraftSpec<T>;
type CallMeta = import("../src/llm.js").CallMeta;

const CHAT = "chat-proactive";
const LAST = "2026-09-06 21:00:00";
let characterId = 0;

before(() => {
  characterId = createFixtureCharacter(CHAT);
  logMessage(CHAT, characterId, "assistant", "먼저 한 말", LAST);
});
after(() => {
  db.close();
});

interface Sent {
  text: string;
  kind: string | undefined;
  extra: Record<string, unknown> | undefined;
}

/** 정해 둔 응답을 주는 모델과, 보낸 글을 적는(또는 실패하는) 발송. */
const fake = (
  answer: unknown,
  opts: { fail?: boolean; askFail?: boolean; callId?: number } = {},
) => {
  const sent: Sent[] = [];
  let asks = 0;
  const deps: Deps = {
    ask: (async (
      _system: unknown,
      _user: unknown,
      _maxTokens: unknown,
      _model: unknown,
      meta?: CallMeta,
    ) => {
      asks += 1;
      // 실제 모델 호출은 호출 행을 남기고 그 번호를 meta에 적는다.
      if (meta && opts.callId) meta.callId = opts.callId;
      if (opts.askFail) throw new Error("model timeout");
      return answer;
    }) as Deps["ask"],
    send: (async (_chat, _cid, text, kind, extra) => {
      if (opts.fail) throw new Error("telegram down");
      sent.push({ text, kind, extra });
      return { delivered: 1, total: 1 };
    }) as Deps["send"],
  };
  return { deps, sent, asks: () => asks };
};

const spec = <T>(over: Partial<Spec<T>> & Pick<Spec<T>, "read">): Spec<T> => ({
  characterId,
  chatId: CHAT,
  kind: "goodnight",
  lastSentAt: LAST,
  situation: "[상황] 검사용 문단",
  maxTokens: 100,
  label: "[test] 문안",
  sentLog: "[test] sent",
  ...over,
});

test("모델이 준 문안을 그 종류로 보낸다", async () => {
  const f = fake({ text: "잘 자, 내일 봐" });
  const r = await sendProactiveDraft(spec({ read: readText }), f.deps);
  assert.equal(r, "sent");
  assert.equal(f.asks(), 1);
  assert.deepEqual(f.sent, [
    { text: "잘 자, 내일 봐", kind: "goodnight", extra: undefined },
  ]);
});

test("read가 문안을 안 주면 보내지 않는다 — 근황의 send=false", async () => {
  const f = fake({ send: false });
  const r = await sendProactiveDraft(
    spec({ kind: "catchup", read: readSendText }),
    f.deps,
  );
  assert.equal(r, "skipped");
  assert.equal(f.sent.length, 0);
});

test("문안을 만드는 사이 마지막 메시지가 바뀌었으면 접고 onMoved를 부른다", async () => {
  const f = fake({ text: "지금 뭐 해" });
  let movedPurpose = "";
  const r = await sendProactiveDraft(
    spec({
      lastSentAt: "2026-09-06 20:00:00",
      read: readText,
      onMoved: (meta) => {
        movedPurpose = meta.purpose;
      },
    }),
    f.deps,
  );
  assert.equal(r, "moved");
  assert.equal(movedPurpose, "goodnight");
  assert.equal(f.sent.length, 0);
});

test("발송에 실패하면 문안을 보관하고, 다음 호출은 모델 없이 그것을 보낸다", async () => {
  const down = fake({ text: "아까 내가 좀 심했지" }, { fail: true });
  const r1 = await sendProactiveDraft(
    spec({ kind: "mend", read: readText }),
    down.deps,
  );
  assert.equal(r1, "held");
  assert.equal(down.sent.length, 0);

  const up = fake({ text: "이 글은 안 쓰여야 한다" });
  const r2 = await sendProactiveDraft(
    spec({ kind: "mend", read: readText }),
    up.deps,
  );
  assert.equal(r2, "sent");
  assert.equal(up.asks(), 0);
  assert.equal(up.sent[0]?.text, "아까 내가 좀 심했지");
  assert.equal(up.sent[0]?.kind, "mend");
});

test("자리 비움 예고는 같은 블록에서만 보관 문안을 다시 쓰고, 블록을 발송 기록에 싣는다", async () => {
  const down = fake({ text: "이제 회의 들어가" }, { fail: true });
  const r1 = await sendProactiveDraft(
    spec({ kind: "away", block: "14:00", read: readText }),
    down.deps,
  );
  assert.equal(r1, "held");

  const up = fake({ text: "운동 갔다 올게" });
  const r2 = await sendProactiveDraft(
    spec({ kind: "away", block: "15:00", read: readText }),
    up.deps,
  );
  assert.equal(r2, "sent");
  assert.equal(up.asks(), 1);
  assert.deepEqual(up.sent, [
    { text: "운동 갔다 올게", kind: "away", extra: { block: "15:00" } },
  ]);
});

test("문안을 만든 호출 번호를 발송 기록에 call_id로 싣는다", async () => {
  const f = fake({ text: "밥은 챙겨 먹었어?" }, { callId: 41 });
  const r = await sendProactiveDraft(
    spec({ kind: "mend", read: readText }),
    f.deps,
  );
  assert.equal(r, "sent");
  assert.deepEqual(f.sent, [
    { text: "밥은 챙겨 먹었어?", kind: "mend", extra: { call_id: 41 } },
  ]);
});

test("보관했다 다시 보내는 문안은 처음 만든 호출 번호를 싣는다", async () => {
  const down = fake(
    { text: "오늘 좀 지쳐 보이더라" },
    { fail: true, callId: 42 },
  );
  const r1 = await sendProactiveDraft(
    spec({ kind: "care", read: readText }),
    down.deps,
  );
  assert.equal(r1, "held");

  const up = fake({ text: "이 글은 안 쓰여야 한다" }, { callId: 99 });
  const r2 = await sendProactiveDraft(
    spec({ kind: "care", read: readText }),
    up.deps,
  );
  assert.equal(r2, "sent");
  assert.equal(up.asks(), 0);
  assert.deepEqual(up.sent, [
    { text: "오늘 좀 지쳐 보이더라", kind: "care", extra: { call_id: 42 } },
  ]);
});

test("모델 호출이 실패하면 보관하지 않고 failed를 준다", async () => {
  const down = fake({ text: "안 쓰여야 한다" }, { askFail: true });
  const r1 = await sendProactiveDraft(
    spec({ kind: "lunch", read: readText }),
    down.deps,
  );
  assert.equal(r1, "failed");
  assert.equal(down.sent.length, 0);

  // 보관한 문안이 없으니 다음 호출은 모델을 다시 부른다.
  const up = fake({ text: "점심 먹었어?" });
  const r2 = await sendProactiveDraft(
    spec({ kind: "lunch", read: readText }),
    up.deps,
  );
  assert.equal(r2, "sent");
  assert.equal(up.asks(), 1);
});

test("read가 준 발송 기록 값을 호출 번호와 함께 싣는다", async () => {
  const f = fake(
    { send: true, line: "dig", text: "그 팀 얘기 궁금해졌어" },
    { callId: 51 },
  );
  const r = await sendProactiveDraft(
    spec({
      kind: "intent",
      read: (d: { text: string }) => ({
        text: d.text,
        meta: { intent_line: "dig" },
      }),
    }),
    f.deps,
  );
  assert.equal(r, "sent");
  assert.deepEqual(f.sent, [
    {
      text: "그 팀 얘기 궁금해졌어",
      kind: "intent",
      extra: { call_id: 51, intent_line: "dig" },
    },
  ]);
});

test("read가 같은 이름으로 준 값은 호출 번호가 덮어쓰고, 준 값은 나간 로그 끝에 붙는다", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "log", (line: string) => {
    logs.push(line);
  });
  const f = fake({ text: "그 얘기 더 해줘" }, { callId: 53 });
  const r = await sendProactiveDraft(
    spec({
      kind: "intent",
      sentLog: "[test] intent",
      read: (d: { text: string }) => ({
        text: d.text,
        meta: { call_id: 999, intent_line: "dig" },
      }),
    }),
    f.deps,
  );
  assert.equal(r, "sent");
  assert.deepEqual(f.sent[0]?.extra, { call_id: 53, intent_line: "dig" });
  assert.ok(logs.includes("[test] intent · call_id=53 intent_line=dig"));
});

test("보관했다 다시 보내는 문안도 read가 준 발송 기록 값을 싣는다", async () => {
  const read = (d: { text: string }) => ({
    text: d.text,
    meta: { intent_line: "thread" },
  });
  const down = fake(
    { text: "발표 준비는 좀 됐어?" },
    { fail: true, callId: 52 },
  );
  const r1 = await sendProactiveDraft(
    spec({ kind: "intent", read }),
    down.deps,
  );
  assert.equal(r1, "held");

  const up = fake({ text: "이 글은 안 쓰여야 한다" });
  const r2 = await sendProactiveDraft(spec({ kind: "intent", read }), up.deps);
  assert.equal(r2, "sent");
  assert.equal(up.asks(), 0);
  assert.deepEqual(up.sent, [
    {
      text: "발표 준비는 좀 됐어?",
      kind: "intent",
      extra: { call_id: 52, intent_line: "thread" },
    },
  ]);
});

test("다른 틱이 이 chat의 잠금을 쥐고 있으면 모델을 부르지 않고 물러난다", async () => {
  assert.equal(acquireProactive(CHAT), true);
  try {
    const f = fake({ text: "안 나가야 한다" });
    const r = await sendProactiveDraft(spec({ read: readText }), f.deps);
    assert.equal(r, "busy");
    assert.equal(f.asks(), 0);
  } finally {
    releaseProactive(CHAT);
  }
});

test("noOverlap은 앞 틱이 도는 동안의 호출을 흘려보내고, 끝난 뒤에는 다시 돈다", async () => {
  let runs = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const tick = noOverlap(async () => {
    runs += 1;
    await gate;
  });
  const first = tick();
  await tick();
  assert.equal(runs, 1);
  open();
  await first;
  await tick();
  assert.equal(runs, 2);
});
