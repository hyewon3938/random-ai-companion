// 모델 응답 블록을 읽는 두 함수(llm.ts의 textOf·blockTypes)를 검사한다 — 모델은 부르지 않는다.
//
// 응답에 생각 블록이 섞여 와도 저장하는 본문은 텍스트 블록만 이어 붙인 것인지, 블록 종류별
// 개수가 로그와 llm_calls에 적는 모양 그대로 나오는지 본다. llm.ts는 읽을 때 db.js를 함께
// 읽어 DB를 열므로 경로를 임시 파일로 돌리고, 모델 주소는 닫힌 로컬 포트로 돌려 호출이 기계
// 밖으로 나가지 않게 한다. chat·chatJson은 다루지 않는다.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type Anthropic from "@anthropic-ai/sdk";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";
// 모델 클라이언트는 모듈을 읽을 때 이 주소를 잡는다. 아무것도 듣지 않는 포트라 연결이 바로 끊긴다.
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";

// DB 경로와 모델 주소를 정한 뒤에 읽어야 한다 — 정적 import는 이 줄들보다 먼저 돈다.
const { db } = await import("../src/db.js");
const { blockTypes, textOf } = await import("../src/llm.js");

after(() => {
  db.close();
});

// 코드가 받는 SDK 타입 그대로 최소 객체를 만든다 — as 없이 필수 필드만 채운다.
const text = (t: string): Anthropic.TextBlock => ({
  type: "text",
  text: t,
  citations: null,
});
const thinking = (t: string): Anthropic.ThinkingBlock => ({
  type: "thinking",
  thinking: t,
  signature: "sig",
});

// ── textOf ────────────────────────────────────────────────────────────

test("텍스트 블록 하나면 그 글이 그대로다", () => {
  assert.equal(textOf([text("안녕")]), "안녕");
});

test("생각 블록은 건너뛰고 텍스트 블록만 이어 붙인다", () => {
  assert.equal(
    textOf([thinking("고민"), text("앞"), thinking("더 고민"), text("뒤")]),
    "앞뒤",
  );
});

test("블록이 없으면 빈 문자열이다", () => {
  assert.equal(textOf([]), "");
});

test("생각 블록만 왔으면 본문은 비어 있다", () => {
  assert.equal(textOf([thinking("고민")]), "");
});

// ── blockTypes ────────────────────────────────────────────────────────

test("블록이 없으면 none이다", () => {
  assert.equal(blockTypes([]), "none");
});

test("종류 하나면 그 종류와 개수만 적는다", () => {
  assert.equal(blockTypes([text("a")]), "text:1");
  assert.equal(blockTypes([text("a"), text("b")]), "text:2");
});

test("종류별 개수를 처음 나온 순서로 적는다", () => {
  assert.equal(
    blockTypes([thinking("t"), text("a"), text("b")]),
    "thinking:1,text:2",
  );
  assert.equal(
    blockTypes([text("a"), thinking("t"), text("b")]),
    "text:2,thinking:1",
  );
});
