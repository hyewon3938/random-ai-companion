// 새벽 정리 재료가 같은 키의 기억을 한 줄로 싣는지 검사한다 — 모델은 부르지 않는다.
//
// 캐릭터를 만들 때 정한 행과 대화로 쌓인 행이 같은 키에 나란히 있으면 재료에 두 줄이 실리고,
// 상대가 아는지 표시가 줄마다 달라 흘릴 내 얘기를 고르지 못했다(이슈 #456). 합친 값은 대화 행의
// 값이고 한쪽이라도 앎이면 앎이다. 각본·월 리듬·이미 있는 키 목록·진행 반영도 같은 값을 쓰는지,
// 정체성 줄에는 사실을 적는 줄에만 표시가 붙고 일기 프롬프트에는 표시를 떼고 들어가는지 함께 본다.
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
const { db, saveDayPlan, getMemoryItemById, getTags, listMemoryItems } =
  await import("../src/db.js");
const { saveMemory, saveCreationMemory, currentRows, existingKeys } =
  await import("../src/memory.js");
const { planOngoingRows } = await import("../src/day-plan.js");
const { rhythmMaterial } = await import("../src/life-plan.js");
const { gatherNightlyInput, applyNightlyOutput } =
  await import("../src/nightly.js");
const { diaryPrompt, quietDayPrompt, extractPrompt } =
  await import("../src/prompts/nightly.js");

const DIARY_DATE = "2026-09-13";

const character = db
  .prepare(
    `INSERT INTO characters (chat_id, status, genesis_json, created_at)
     VALUES ('1', 'active', '{}', '2026-09-01 12:00:00') RETURNING *`,
  )
  .get() as CharacterRow;

// 정체성 — 캐릭터를 만들 때 정한 행.
const identity = (
  area: string,
  subject: string,
  value: string,
  userKnows: "known" | "unknown",
): number =>
  saveCreationMemory({
    characterId: character.id,
    itemType: "fact",
    owner: "char",
    area,
    subject,
    value,
    tags: [],
    userKnows,
  });
identity("기본", "고향", "부산", "unknown");
identity("기본", "성별", "남성", "known");
identity("기본", "대화 성격", "말수가 적고 듣는 편", "unknown");
identity("기본", "그늘", "혼자 버틴 시간이 길다", "unknown");
identity("직업", "소속", "출판사 편집부", "known");
identity("가족", "구성", "부모님과 누나", "unknown");
identity("태도", "상대를 대하는 방식", "먼저 챙기고 티를 덜 낸다", "unknown");
identity("말투", "웃음", "짧게 웃는다", "unknown");
// 대화로 고향 값이 자세해졌고 상대도 알게 됐다.
saveMemory({
  characterId: character.id,
  itemType: "fact",
  owner: "char",
  area: "기본",
  subject: "고향",
  value: "부산 영도, 바다 옆 동네",
  tags: [],
  userKnows: "known",
});
// 대화로 새로 생긴 영역도 사실이라 표시가 붙는다.
saveMemory({
  characterId: character.id,
  itemType: "fact",
  owner: "char",
  area: "여행",
  subject: "지난 여름",
  value: "제주에서 일주일 지냈다",
  tags: [],
  userKnows: "unknown",
});

// 주변 인물 — 생성 때는 상대가 몰랐고 대화에서 말했다.
saveCreationMemory({
  characterId: character.id,
  itemType: "person",
  owner: "char",
  area: "가족",
  subject: "누나",
  value: "두 살 위",
  tags: [],
  relation: "누나",
  userKnows: "unknown",
});
saveMemory({
  characterId: character.id,
  itemType: "person",
  owner: "char",
  area: "가족",
  subject: "누나",
  value: "두 살 위, 가을에 결혼한다",
  tags: [],
  relation: "누나",
  userKnows: "known",
});

// 진행 중인 일 — 생성 때 상대가 알던 일인데 대화로 값이 바뀌며 대화 행은 모름으로 저장됐다.
const runCreationId = saveCreationMemory({
  characterId: character.id,
  itemType: "ongoing",
  owner: "char",
  area: "운동",
  subject: "달리기",
  value: "5km를 목표로 뛰기 시작했다",
  tags: ["목표"],
  userKnows: "known",
  endCondition: "5km 완주",
});
const runId = saveMemory({
  characterId: character.id,
  itemType: "ongoing",
  owner: "char",
  area: "운동",
  subject: "달리기",
  value: "3km까지 뛴다",
  tags: ["달리기"],
  userKnows: "unknown",
  endCondition: "5km 완주",
});
// 생성 때 모르던 일을 대화에서 말했다.
const bookCreationId = saveCreationMemory({
  characterId: character.id,
  itemType: "ongoing",
  owner: "char",
  area: "독서",
  subject: "소설",
  value: "첫 장을 폈다",
  tags: ["책"],
  userKnows: "unknown",
  endCondition: "완독",
});
const bookId = saveMemory({
  characterId: character.id,
  itemType: "ongoing",
  owner: "char",
  area: "독서",
  subject: "소설",
  value: "절반까지 읽었다",
  tags: ["장편"],
  userKnows: "known",
  endCondition: "완독",
});

// 어제 각본에 같은 일이 생성 행 번호와 대화 행 번호로 한 번씩 들어갔다.
const block = (
  start: string,
  end: string,
  activity: string,
  extra: Record<string, unknown> = {},
) => ({
  start,
  end,
  activity,
  responsiveness: "intermittent",
  advance_known: true,
  category: "personal",
  ...extra,
});
saveDayPlan(
  character.id,
  DIARY_DATE,
  JSON.stringify({
    date: DIARY_DATE,
    blocks: [
      block("05:00", "07:00", "잠", { responsiveness: "unavailable" }),
      block("07:00", "20:00", "일", { category: "official" }),
      block("20:00", "21:00", "소설 읽기", {
        source: "ongoing",
        source_id: bookCreationId,
      }),
      block("21:00", "22:00", "소설 이어 읽기", {
        source: "ongoing",
        source_id: bookId,
      }),
      block("22:00", "29:00", "잠", { responsiveness: "unavailable" }),
    ],
  }),
  "nightly",
);

const g = gatherNightlyInput(character, DIARY_DATE);
const MARK = /\[상대가 앎\]|\[상대는 모름\]/;

test("같은 키의 두 행은 대화 행 값으로 합치고 한쪽이라도 알면 아는 것으로 둔다", () => {
  const rows = listMemoryItems(character.id, "ongoing");
  const merged = currentRows(rows);
  assert.equal(merged.length, 2);
  const run = merged.find((r) => r.subject === "달리기");
  assert.equal(run?.id, runId);
  assert.equal(run?.value, "3km까지 뛴다");
  assert.equal(run?.user_knows, "known");
  const book = merged.find((r) => r.subject === "소설");
  assert.equal(book?.id, bookId);
  assert.equal(book?.value, "절반까지 읽었다");
  assert.equal(book?.user_knows, "known");
  // 들어온 순서가 바뀌어도 같은 값이다.
  assert.deepEqual(
    new Map(currentRows([...rows].reverse()).map((r) => [r.id, r.user_knows])),
    new Map(merged.map((r) => [r.id, r.user_knows])),
  );
  // 합치기는 저장된 행을 고치지 않는다.
  assert.equal(getMemoryItemById(runId)?.user_knows, "unknown");
});

test("새벽 정리 재료의 주변 인물과 진행 중인 일은 키마다 한 줄이다", () => {
  const sister = g.people.split("\n").filter((l) => l.includes("누나 ("));
  assert.equal(sister.length, 1);
  assert.match(sister[0]!, /: 두 살 위, 가을에 결혼한다 \[상대가 앎\]$/);

  const run = g.ongoing.split("\n").filter((l) => l.includes("운동/달리기"));
  assert.equal(run.length, 1);
  assert.equal(
    run[0],
    "- 운동/달리기: 3km까지 뛴다 (끝나는 조건: 5km 완주) [상대가 앎]",
  );
  const book = g.ongoing.split("\n").filter((l) => l.includes("독서/소설"));
  assert.equal(book.length, 1);
  assert.equal(
    book[0],
    "- 독서/소설: 절반까지 읽었다 (끝나는 조건: 완독) [상대가 앎]",
  );
  assert.doesNotMatch(g.ongoing, /5km를 목표로|첫 장을 폈다/);
});

test("정체성은 키마다 한 줄이고 사실을 적는 줄에만 표시가 붙는다", () => {
  const lines = g.identity.split("\n");
  assert.equal(lines.length, 9);
  const lineOf = (key: string): string => {
    const hit = lines.filter((l) => l.startsWith(`- ${key}: `));
    assert.equal(hit.length, 1, key);
    return hit[0]!;
  };
  assert.match(
    lineOf("기본 · 고향"),
    /: 부산 영도, 바다 옆 동네 \(.*\) \[상대가 앎\]$/,
  );
  assert.match(lineOf("직업 · 소속"), /\[상대가 앎\]$/);
  assert.match(lineOf("가족 · 구성"), /\[상대는 모름\]$/);
  assert.match(lineOf("여행 · 지난 여름"), /\[상대는 모름\]$/);
  for (const key of [
    "기본 · 성별",
    "기본 · 대화 성격",
    "기본 · 그늘",
    "태도 · 상대를 대하는 방식",
    "말투 · 웃음",
  ])
    assert.doesNotMatch(lineOf(key), MARK, key);
});

test("일기 프롬프트에는 표시를 뗀 정체성이 들어간다", () => {
  for (const p of [diaryPrompt(g), quietDayPrompt(g)]) {
    assert.match(p, /- 기본 · 고향: 부산 영도, 바다 옆 동네 \(/);
    assert.match(p, /- 가족 · 구성: 부모님과 누나 \(/);
    assert.doesNotMatch(p, MARK);
  }
});

test("추출 프롬프트는 표시가 없는 정체성 줄을 흘릴 사실 후보에서 뺀다", () => {
  const p = extractPrompt(g);
  assert.match(p, /- 가족 · 구성: 부모님과 누나 \(.*\) \[상대는 모름\]/);
  assert.match(
    p,
    /태도·말투와 대화 성격·그늘·성별 줄은 상대에게 흘릴 사실이 아니라서 표시가 없다/,
  );
  assert.match(
    p,
    /share: [^\n]*줄 끝이 \[상대는 모름\]인 줄 가운데 고른다\. 표시가 없는 정체성 줄과 \[상대가 앎\] 줄은 고르지 않는다/,
  );
  assert.match(
    p,
    /정체성에서 표시가 없는 줄을 같은 키로 다시 쓸 때는 user_knows를 넣지 않는다/,
  );
});

test("이미 있는 키 목록에 같은 키가 한 번만 나온다", () => {
  const keys = existingKeys(character.id).map(
    (k) => `${k.itemType} ${k.owner} ${k.key}`,
  );
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(keys.filter((k) => k.includes("달리기")).length, 1);
  assert.equal(keys.filter((k) => k.includes("고향")).length, 1);
});

test("각본에 넣을 진행 중인 일은 합친 값으로 거른다", () => {
  const plan = planOngoingRows(character.id);
  const run = plan.filter((r) => r.subject === "달리기");
  assert.equal(run.length, 1);
  assert.equal(run[0]?.id, runId);
  assert.equal(run[0]?.value, "3km까지 뛴다");
  assert.match(g.ongoingForPlan, new RegExp(`\\[${runId}\\] 운동/달리기`));
  assert.doesNotMatch(g.ongoingForPlan, new RegExp(`\\[${runCreationId}\\]`));
});

test("월 리듬 재료의 진행 중인 일도 키마다 한 줄이다", () => {
  const { ongoing } = rhythmMaterial(character.id, "2026-09");
  const run = ongoing.split("\n").filter((l) => l.includes("운동 · 달리기"));
  assert.deepEqual(run, [`- [${runId}] 운동 · 달리기: 3km까지 뛴다`]);
});

test("어제 각본이 생성 행 번호를 가져도 진행 반영 재료는 지금 값 한 줄이다", () => {
  assert.deepEqual(g.ongoingTouched, [
    `- [${bookId}] 독서/소설: 절반까지 읽었다 (끝나는 조건: 완독) — 어제 각본: 20:00 소설 읽기 → 각본대로 / 21:00 소설 이어 읽기 → 각본대로`,
  ]);
});

test("진행 반영과 추출이 상대가 아는 일을 모름으로 되돌리지 않는다", () => {
  applyNightlyOutput(g, {
    entry: {
      diary: "조용한 하루",
      plan_vs_actual: "",
      user_mood: "",
      closeness: "",
      tomorrow: [],
      tags: [],
    },
    extract: {
      // 같은 키를 다시 쓰면서 user_knows를 넣지 않았다 — 합친 앞 값이 이어진다.
      memories: [
        {
          item_type: "ongoing",
          owner: "char",
          area: "운동",
          subject: "달리기",
          value: "4km까지 늘렸다",
          tags: ["달리기"],
        },
      ],
      schedules: [],
    },
    // 생성 행 번호가 왔다 — 대화 행의 앎과 태그를 잇는다.
    progress: [
      { id: bookCreationId, value: "마지막 장만 남았다", done: false },
    ],
  });

  const book = getMemoryItemById(bookId);
  assert.equal(book?.value, "마지막 장만 남았다");
  assert.equal(book?.user_knows, "known");
  const bookTags = getTags("memory", bookId);
  assert.ok(bookTags.includes("장편"));
  assert.ok(!bookTags.includes("책"));
  assert.equal(getMemoryItemById(bookCreationId)?.value, "첫 장을 폈다");

  const run = getMemoryItemById(runId);
  assert.equal(run?.value, "4km까지 늘렸다");
  assert.equal(run?.user_knows, "known");
});
