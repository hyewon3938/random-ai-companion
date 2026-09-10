// 답장 경로가 작품 사실 카드 가운데 무엇을 싣는지 검사한다 — 모델은 부르지 않는다.
//
// 카드는 오늘 각본 블록의 work 값에 있거나 진행 중인 일에 제목이 나온 작품만 싣는다(#287).
// 진행 중인 일 쪽은 자유 서술이라 제목을 뽑아내지 않고, 이미 카드가 있는 제목이 그 글에
// 나오는지만 본다 — 없는 제목을 지어 읽는 경로를 만들지 않으려는 것이다.
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

const { db, saveDayPlan, saveWorkFact } = await import("../src/db.js");
const { saveMemory } = await import("../src/memory.js");
const { readContextInput } = await import("../src/context/input.js");
const { kstLogicalDate } = await import("../src/kst.js");

const TODAY = kstLogicalDate();

const character = db
  .prepare(
    `INSERT INTO characters (chat_id, status, genesis_json, created_at)
     VALUES ('1', 'active', '{}', '2026-08-30 12:00:00') RETURNING *`,
  )
  .get() as CharacterRow;
db.prepare(
  `INSERT INTO relationships (character_id, met_at, stage_no, stage_since)
   VALUES (?, '2026-08-30 12:00:00', 1, '2026-08-30')`,
).run(character.id);

saveDayPlan(
  character.id,
  TODAY,
  JSON.stringify({
    date: TODAY,
    blocks: [
      {
        start: "20:00",
        end: "22:00",
        activity: "영화 보기",
        responsiveness: "instant",
        advance_known: true,
        category: "personal",
        work: "여름 언덕",
      },
    ],
  }),
  "nightly",
);

// 진행 중인 일에 제목이 나오는 작품 — 각본에는 없다.
saveMemory({
  characterId: character.id,
  itemType: "ongoing",
  owner: "char",
  area: "독서",
  subject: "당신 인생의 이야기",
  value: "세 번째 단편을 읽는 중이다",
  tags: ["책"],
  endCondition: "완독",
});

const card = (title: string) => ({
  title,
  summary: `${title} 줄거리`,
  scenes: [`${title} 장면`],
  differences: null,
});
for (const t of ["여름 언덕", "당신 인생의 이야기", "지난달에 본 영화"])
  saveWorkFact(character.id, card(t), "2026-09-10 05:00:00");

test("각본의 work와 진행 중인 일에 나온 작품의 카드만 싣는다", () => {
  const input = readContextInput(character.id, character.chat_id);
  assert.deepEqual(
    input.workFacts.map((f) => f.title).sort(),
    ["당신 인생의 이야기", "여름 언덕"],
  );
  assert.deepEqual(input.workFacts[0]?.scenes, ["당신 인생의 이야기 장면"]);
});

test("각본에도 진행 중인 일에도 없는 작품은 안 싣는다", () => {
  const input = readContextInput(character.id, character.chat_id);
  assert.ok(!input.workFacts.some((f) => f.title === "지난달에 본 영화"));
});
