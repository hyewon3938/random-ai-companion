// 선톡 한 통을 보내는 공통 함수(proactive-send.ts)의 순서를 붙잡는 검사.
//
// 모델과 텔레그램은 부르지 않는다 — 정해 둔 응답을 주는 ask와 보낸 글을 적기만 하는 send를
// 끼운다. 잠금·보관 문안·발송 직전 재확인·실패 보관이 followup·presence에서 하던 대로 도는지 본다.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "proactive-send-")), "t.db");
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

const { db, logMessage } = await import("../src/db.js");
const { createFixtureCharacter } = await import("../src/eval/fixture-character.js");
const { acquireProactive, releaseProactive } = await import("../src/bot.js");
const { sendProactiveDraft, readText, readSendText, noOverlap } = await import(
  "../src/proactive-send.js"
);
type Deps = import("../src/proactive-send.js").ProactiveDraftDeps;
type Spec<T> = import("../src/proactive-send.js").ProactiveDraftSpec<T>;

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
const fake = (answer: unknown, opts: { fail?: boolean } = {}) => {
  const sent: Sent[] = [];
  let asks = 0;
  const deps: Deps = {
    ask: (async () => {
      asks += 1;
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
