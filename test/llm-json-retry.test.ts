// JSON 응답을 읽고 한 번 더 부르는 자리(llm.ts의 askJson)를 검사한다 — 모델은 부르지 않는다.
//
// 모델을 한 번 부르는 일을 넘겨받는 함수라, 정해 둔 응답을 차례로 주는 가짜를 넣고 몇 번째에
// 어떤 문구와 선택지로 불렸는지 적는다. 읽지 못한 응답이 생각 블록을 갖고 출력 상한에 닿아
// 멈췄으면 같은 문구로 생각 과정만 끄고 다시 부르고, 생각 블록 없이 상한에 닿았거나 형식 때문에
// 못 읽었으면 형식을 다시 일러 부르는지 본다. 상한에 닿았어도 JSON을 읽었으면 다시 부르지
// 않는다(이슈 #471).
//
// llm.ts는 읽을 때 db.js를 함께 읽어 DB를 열므로 경로를 임시 파일로 돌리고, 모델 주소는 닫힌
// 로컬 포트로 돌려 호출이 기계 밖으로 나가지 않게 한다.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "llm-json-retry-")),
  "t.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";

const { db } = await import("../src/db.js");
const { askJson, JSON_ASK, JSON_RETRY_ASK } = await import("../src/llm.js");
type ChatStop = import("../src/llm.js").ChatStop;
type ChatOptions = import("../src/llm.js").ChatOptions;

after(() => {
  db.close();
});

interface Call {
  extra: string;
  attempt: number;
  opts: ChatOptions | undefined;
}

/** 정해 둔 응답을 차례로 주고, 불린 문구·차례·선택지를 적는 가짜 호출. */
const fake = (...answers: ChatStop[]) => {
  const calls: Call[] = [];
  const once = async (
    extra: string,
    attempt: number,
    opts?: ChatOptions,
  ): Promise<ChatStop> => {
    calls.push({ extra, attempt, opts });
    const next = answers[calls.length - 1];
    if (!next) throw new Error("정해 둔 응답보다 많이 불렀다");
    return next;
  };
  return { once, calls };
};

const done = (text: string): ChatStop => ({
  text,
  stopReason: "end_turn",
  thought: true,
});
/** 생각 과정에 출력 상한을 쓰고 멈춘 응답. */
const capped = (text: string): ChatStop => ({
  text,
  stopReason: "max_tokens",
  thought: true,
});

test("첫 응답을 읽으면 다시 부르지 않는다", async () => {
  const f = fake(done('{"send":true,"text":"뭐 해"}'));
  const out = await askJson<{ send: boolean; text: string }>(f.once);
  assert.deepEqual(out, { send: true, text: "뭐 해" });
  assert.deepEqual(f.calls, [{ extra: JSON_ASK, attempt: 1, opts: undefined }]);
});

test("생각 과정에 상한을 써서 못 읽었으면 같은 문구로 생각 과정만 끄고 다시 부른다", async () => {
  // 생각 과정이 상한을 거의 다 써서 본문이 비었거나 중간에 잘린 경우다.
  const f = fake(capped(""), done('{"send":false}'));
  const out = await askJson<{ send: boolean }>(f.once);
  assert.deepEqual(out, { send: false });
  assert.deepEqual(f.calls, [
    { extra: JSON_ASK, attempt: 1, opts: undefined },
    { extra: JSON_ASK, attempt: 2, opts: { think: false } },
  ]);
});

test("형식 때문에 못 읽었으면 형식을 다시 일러 부르고 생각 과정은 그대로 둔다", async () => {
  const f = fake(
    done("보낼게요: {send:true}"),
    done('{"send":true,"text":"잘 자"}'),
  );
  const out = await askJson<{ send: boolean; text: string }>(f.once);
  assert.deepEqual(out, { send: true, text: "잘 자" });
  assert.deepEqual(f.calls, [
    { extra: JSON_ASK, attempt: 1, opts: undefined },
    { extra: JSON_RETRY_ASK, attempt: 2, opts: undefined },
  ]);
});

test("생각 블록 없이 상한에 닿아 못 읽었으면 생각 과정은 두고 형식을 다시 일러 부른다", async () => {
  // 생각을 켜지 않는 모델이 긴 글을 쓰다 잘린 경우라, 생각을 끄고 불러도 같은 요청이 된다.
  const f = fake(
    { text: '{"text":"잘', stopReason: "max_tokens", thought: false },
    done('{"text":"잘 자"}'),
  );
  const out = await askJson<{ text: string }>(f.once);
  assert.deepEqual(out, { text: "잘 자" });
  assert.deepEqual(f.calls, [
    { extra: JSON_ASK, attempt: 1, opts: undefined },
    { extra: JSON_RETRY_ASK, attempt: 2, opts: undefined },
  ]);
});

test("상한에 닿았어도 JSON을 읽었으면 그대로 쓴다", async () => {
  const f = fake(capped('{"text":"오늘 좀 늦었지"}'));
  const out = await askJson<{ text: string }>(f.once);
  assert.deepEqual(out, { text: "오늘 좀 늦었지" });
  assert.equal(f.calls.length, 1);
});

test("코드펜스로 감싼 JSON도 읽는다", async () => {
  const f = fake(done('```json\n{"send":false}\n```'));
  assert.deepEqual(await askJson<{ send: boolean }>(f.once), { send: false });
  assert.equal(f.calls.length, 1);
});

test("다시 불러도 못 읽으면 던진다", async () => {
  const f = fake(capped('{"text":"잘'), capped('{"text":"또 잘'));
  await assert.rejects(askJson(f.once), SyntaxError);
  assert.equal(f.calls.length, 2);
});
