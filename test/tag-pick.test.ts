// 이번 발화의 검색 태그를 고르는 자리(tag-pick.ts)를 검사한다 — 모델은 부르지 않는다.
//
// 모델 답을 저장된 목록에 대조해 글자 일치와 합치는 mergeTags, 태그가 없거나 발화가 비어
// 부르지 않는 none 경로, 호출이 실패해 글자 일치만으로 이어 가는 match 경로를 본다. 모델
// 주소를 닫힌 로컬 포트로 돌려 호출이 기계 밖으로 나가기 전에 실패하게 한다. 모델이 답을
// 준 경로는 보지 않는다. DB는 임시 파일로 새로 만든다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TAG_PICK_MAX } from "../src/thresholds.js";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";
// 모델 클라이언트는 모듈을 읽을 때 이 주소를 잡는다. 아무것도 듣지 않는 포트라 연결이 바로 끊긴다.
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";

// DB 경로와 모델 주소를 정한 뒤에 읽어야 한다 — 정적 import는 이 줄들보다 먼저 돈다.
const { db, setTags } = await import("../src/db.js");
const { mergeTags, pickTags } = await import("../src/tag-pick.js");

const makeCharacter = (chatId: string): number =>
  Number(
    db
      .prepare(
        `INSERT INTO characters (chat_id, status, genesis_json, created_at)
         VALUES (?, 'active', '{}', '2026-08-30 12:00:00') RETURNING id`,
      )
      .pluck()
      .get(chatId),
  );

const bare = makeCharacter("1");
const tagged = makeCharacter("2");
setTags(tagged, "memory", 1, ["운동", "집"]);
setTags(tagged, "memory", 2, ["일", "돈"]);

const callRowsOf = (characterId: number) =>
  db
    .prepare(
      `SELECT purpose, error FROM llm_calls WHERE character_id = ? ORDER BY id`,
    )
    .all(characterId) as { purpose: string; error: string | null }[];

// 호출이 실패하는 경로는 한 번만 돌리고 두 검사가 나눠 본다 — 재시도 백오프로 1초 남짓 걸린다.
const failed = await pickTags(tagged, "일요일에 운동 갔다가 집에 들렀어.");

test("모델 답에서 목록에 있는 이름만 남기고 글자 일치와 합친다", () => {
  assert.deepEqual(
    mergeTags(
      "운동, 없는말\n집·돈",
      ["운동", "집", "돈", "일"],
      ["일", "운동"],
    ),
    ["운동", "집", "돈", "일"],
  );
});

test("없음이라는 답은 목록에 없어 버려지고 글자 일치만 남는다", () => {
  assert.deepEqual(mergeTags("없음", ["운동", "집"], ["집"]), ["집"]);
  assert.deepEqual(mergeTags("없음", ["운동", "집"], []), []);
});

test("모델이 고른 것과 글자 일치를 합쳐도 상한을 넘지 않는다", () => {
  const names = Array.from({ length: 10 }, (_, i) => `태그${i + 1}`);
  const merged = mergeTags(names.slice(0, 6).join(","), names, names.slice(5));
  assert.equal(merged.length, TAG_PICK_MAX);
  assert.deepEqual(merged, names.slice(0, TAG_PICK_MAX));
});

test("태그가 하나도 없는 캐릭터는 모델을 부르지 않고 none으로 답한다", async () => {
  assert.deepEqual(await pickTags(bare, "운동 갔다 왔어"), {
    tags: [],
    pool: 0,
    by: "none",
    callId: null,
  });
  assert.deepEqual(callRowsOf(bare), []);
});

test("빈 발화는 태그가 있어도 모델을 부르지 않고 none으로 답한다", async () => {
  assert.deepEqual(await pickTags(tagged, "   "), {
    tags: [],
    pool: 4,
    by: "none",
    callId: null,
  });
});

test("모델 호출이 실패하면 글자 일치만으로 match로 이어 간다", () => {
  assert.equal(failed.by, "match");
  assert.deepEqual(failed.tags, ["운동", "집"]);
  assert.equal(failed.pool, 4);
  assert.equal(typeof failed.callId, "number");
});

test("실패한 호출도 주제 고르기 행으로 남고 실패 사유가 적힌다", () => {
  const rows = callRowsOf(tagged);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].purpose, "tags");
  assert.ok(rows[0].error && rows[0].error.length > 0);
});
