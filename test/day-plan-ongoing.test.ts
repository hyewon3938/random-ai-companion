// 각본이 진행 중인 일을 어떻게 싣고 되돌려 읽는지 검사한다 — 모델은 부르지 않는다.
//
// 각본에는 캐릭터 쪽이면서 유저가 아는 일만 행 번호를 붙여 들어가야 한다(이슈 #276). 유저가
// 모르는 일은 기억으로만 두고, 같은 키에 생성 행과 대화 행이 있으면 대화 행이 지금 값이다.
// 생성이 돌려준 블록의 source "ongoing"은 행 번호가 있을 때만 남는다.
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

const { db } = await import("../src/db.js");
const { saveMemory, saveCreationMemory } = await import("../src/memory.js");
const { planOngoingRows, planOngoingLines, normalizePlan, buildPlanPrompt } =
  await import("../src/day-plan.js");

const character = db
  .prepare(
    `INSERT INTO characters (chat_id, status, genesis_json, created_at)
     VALUES ('1', 'active', '{}', '2026-08-30 12:00:00') RETURNING *`,
  )
  .get() as CharacterRow;

// 유저가 아는 캐릭터 쪽 일 — 각본에 들어간다.
const bookId = saveMemory({
  characterId: character.id,
  itemType: "ongoing",
  owner: "char",
  area: "독서",
  subject: "당신 인생의 이야기",
  value: "9/1 시작했고 첫 단편을 읽는 중이다",
  tags: ["책"],
  userKnows: "known",
  endCondition: "완독",
});
// 유저가 모르는 캐릭터 쪽 일 — 기억으로만 둔다.
saveMemory({
  characterId: character.id,
  itemType: "ongoing",
  owner: "char",
  area: "일",
  subject: "이직 준비",
  value: "이력서를 고치는 중이다",
  tags: [],
  userKnows: "unknown",
  endCondition: "지원서를 낸다",
});
// 유저 쪽 일 — 캐릭터의 각본이 아니다.
saveMemory({
  characterId: character.id,
  itemType: "ongoing",
  owner: "user",
  area: "일",
  subject: "이직",
  value: "면접을 앞두고 있다",
  tags: [],
  endCondition: "합격 발표",
});
// 같은 키에 생성 행(모름)과 대화 행(앎)이 나란히 있으면 대화 행만 들어간다.
saveCreationMemory({
  characterId: character.id,
  itemType: "ongoing",
  owner: "char",
  area: "운동",
  subject: "달리기",
  value: "5km를 목표로 뛰기 시작했다",
  tags: [],
  userKnows: "unknown",
  endCondition: "5km 완주",
});
const runId = saveMemory({
  characterId: character.id,
  itemType: "ongoing",
  owner: "char",
  area: "운동",
  subject: "달리기",
  value: "3km까지 뛴다",
  tags: [],
  userKnows: "known",
  endCondition: "5km 완주",
});

test("유저가 아는 캐릭터 쪽 일만 행 번호를 붙여 각본 줄이 된다", () => {
  const rows = planOngoingRows(character.id);
  assert.deepEqual(
    rows.map((r) => r.id).sort(),
    [bookId, runId].sort(),
  );
  const lines = planOngoingLines(character.id);
  assert.match(
    lines,
    new RegExp(
      `^- \\[${bookId}\\] 독서/당신 인생의 이야기: 9/1 시작했고 첫 단편을 읽는 중이다 \\(끝나는 조건: 완독\\)$`,
      "m",
    ),
  );
  assert.match(lines, new RegExp(`\\[${runId}\\] 운동/달리기: 3km까지 뛴다`));
  assert.doesNotMatch(lines, /이직/);
  assert.doesNotMatch(lines, /5km를 목표로/);
});

test("각본 프롬프트에 그 줄과 출처 규칙이 들어간다", () => {
  const prompt = buildPlanPrompt(character.id, "2026-09-05");
  assert.match(prompt, new RegExp(`\\[${bookId}\\] 독서/당신 인생의 이야기`));
  assert.match(prompt, /"ongoing", source_id에 그 줄 앞 \[번호\]를 그대로 적는다/);
  assert.match(prompt, /"source":"ongoing","source_id":61/);
});

test("source ongoing은 행 번호가 있을 때만 남고, 번호는 문자열이어도 받는다", () => {
  const base = {
    end: "23:00",
    responsiveness: "intermittent",
    advance_known: true,
    category: "personal",
  } as const;
  const plan = normalizePlan({
    date: "2026-09-05",
    blocks: [
      { ...base, start: "21:00", activity: "책 읽기", source: "ongoing", source_id: bookId },
      { ...base, start: "22:00", activity: "달리기", source: "ongoing", source_id: String(runId) as unknown as number },
      { ...base, start: "23:00", activity: "책 읽기", source: "ongoing" },
      { ...base, start: "24:00", activity: "잠" },
    ],
  });
  assert.equal(plan.blocks[0]?.source, "ongoing");
  assert.equal(plan.blocks[0]?.source_id, bookId);
  assert.equal(plan.blocks[1]?.source, "ongoing");
  assert.equal(plan.blocks[1]?.source_id, runId);
  assert.equal(plan.blocks[2]?.source, undefined);
  assert.equal(plan.blocks[2]?.source_id, undefined);
  assert.equal(plan.blocks[3]?.source, undefined);
});
