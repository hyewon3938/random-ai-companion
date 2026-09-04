// 새벽 정리의 기억 정리 프롬프트가 앞 값을 싣는지 검사한다 — 모델은 부르지 않는다.
//
// 같은 키를 다시 쓸 때 앞 값이 프롬프트에 없으면 모델은 그날 들은 것만 적고, 앞 값에 있던
// 원인 추정이나 장소 이름이 지워진다(이슈 #264). 상대 쪽 사실은 키만 들어가던 자리라, 그날
// 대화에 태그가 걸린 것의 지금 값이 재료에 실리는지와 합치라는 규칙이 프롬프트에 있는지 본다.
//
// DB는 임시 파일로 새로 만든다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CharacterRow } from "../src/db.js";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

// DB 경로를 정한 뒤에 읽어야 임시 파일로 열린다 — 정적 import는 이 줄들보다 먼저 돈다.
const { db } = await import("../src/db.js");
const { saveMemory } = await import("../src/memory.js");
const { gatherNightlyInput, extractPrompt, touchedUserFactLines } =
  await import("../src/nightly.js");

const DIARY_DATE = "2026-09-03";
const CHAT_ID = "1";

const character = db
  .prepare(
    `INSERT INTO characters (chat_id, status, genesis_json, created_at)
     VALUES (?, 'active', '{}', '2026-08-30 12:00:00') RETURNING *`,
  )
  .get(CHAT_ID) as CharacterRow;

const say = (role: "user" | "assistant", hhmm: string, text: string): void => {
  db.prepare(
    `INSERT INTO messages (chat_id, character_id, sent_at, role, text) VALUES (?, ?, ?, ?, ?)`,
  ).run(CHAT_ID, character.id, `${DIARY_DATE} ${hhmm}:00`, role, text);
};

// 상대 쪽 사실 둘 — 하나는 그날 대화에 태그가 걸리고, 하나는 걸리지 않는다.
saveMemory({
  characterId: character.id,
  itemType: "fact",
  owner: "user",
  area: "취미",
  subject: "독서",
  value:
    "8/28 동네 서점에서 산 소설을 읽기 시작했다. 표지가 마음에 들어 골랐다고 했다",
  tags: ["소설", "서점"],
});
saveMemory({
  characterId: character.id,
  itemType: "fact",
  owner: "user",
  area: "건강",
  subject: "무릎",
  value: "계단을 오르면 오른쪽 무릎이 시리다",
  tags: ["계단"],
});
// 캐릭터 쪽 사실은 정체성 절이 값까지 싣는다 — 이 절에 또 들어가면 같은 줄이 두 번 보인다.
saveMemory({
  characterId: character.id,
  itemType: "fact",
  owner: "char",
  area: "취미",
  subject: "소설",
  value: "자기 전에 소설을 몇 장씩 읽는다",
  tags: [],
});

say("user", "21:10", "어제 산 소설 드디어 다 읽었어");
say("assistant", "21:12", "오 어땠어?");

const g = gatherNightlyInput(character, DIARY_DATE);
const prompt = extractPrompt(g);

test("그날 대화에 태그가 걸린 상대 쪽 사실은 지금 값째로 재료에 실린다", () => {
  assert.equal(g.touchedUserFacts.length, 1);
  assert.match(
    g.touchedUserFacts[0] ?? "",
    /^- 취미\/독서: 8\/28 동네 서점에서 산 소설을 읽기 시작했다\. 표지가 마음에 들어 골랐다고 했다 \(\d{4}-\d{2}-\d{2} 갱신\)$/,
  );
});

test("대화에 안 나온 키와 캐릭터 쪽 사실은 이 절에 들어가지 않는다", () => {
  const lines = g.touchedUserFacts.join("\n");
  assert.doesNotMatch(lines, /무릎/);
  assert.doesNotMatch(lines, /자기 전에 소설을/);
});

test("프롬프트에 앞 값 절이 들어간다", () => {
  assert.match(
    prompt,
    /\[상대에 대해 이미 아는 것 — 오늘 대화와 겹치는 키의 지금 값\]\n- 취미\/독서: 8\/28 동네 서점에서 산 소설을/,
  );
});

test("합치기·사건 날짜·장면 배제 규칙이 프롬프트에 있다", () => {
  assert.match(
    prompt,
    /앞 값에 있던 원인 추정·장소·이름·숫자 같은 세부를 그대로 두고/,
  );
  assert.match(prompt, /앞 값과 모순되는 부분만 새 값으로 바꾼다/);
  assert.match(prompt, /한 번 지우면 되찾을 수 없는 것은 남긴다/);
  assert.match(
    prompt,
    new RegExp(`날짜를 붙인 사건으로 적는다\\(예: ${DIARY_DATE} `),
  );
  assert.match(
    prompt,
    /누가 무엇을 묻고 어떻게 답했는지 같은 장면은 넣지 않는다/,
  );
});

test("겹치는 태그가 없으면 빈 절로 남는다", () => {
  assert.deepEqual(touchedUserFactLines(character.id, "오늘 날씨 좋다"), []);
  const quiet = gatherNightlyInput(character, "2026-09-01");
  assert.deepEqual(quiet.touchedUserFacts, []);
  assert.match(
    extractPrompt(quiet),
    /\[상대에 대해 이미 아는 것 — 오늘 대화와 겹치는 키의 지금 값\]\n\(없음\)/,
  );
});
