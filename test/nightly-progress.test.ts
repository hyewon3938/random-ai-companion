// 새벽 정리가 어제 각본을 따라 진행 중인 일을 한 걸음 옮기는 경로를 검사한다 — 모델은 부르지 않는다.
//
// 대화가 없던 날에도 어제 각본에 source "ongoing"으로 들어간 블록을 찾아 그 일의 지금 값과
// 실제 기록을 재료로 넘기고(이슈 #276), 생성이 돌려준 새 값을 저장한다. 끝났다고 하면 사실
// 항목으로 옮기고, 태그는 그대로 잇는다. 남의 행이나 사실 행 번호는 받지 않는다.
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

const { db, saveDayPlan, recordDayActual, getMemoryItemById, getTags } =
  await import("../src/db.js");
const { saveMemory } = await import("../src/memory.js");
const { gatherNightlyInput, applyNightlyOutput, progressPrompt } =
  await import("../src/nightly.js");

const DIARY_DATE = "2026-09-03";

const character = db
  .prepare(
    `INSERT INTO characters (chat_id, status, genesis_json, created_at)
     VALUES ('1', 'active', '{}', '2026-08-30 12:00:00') RETURNING *`,
  )
  .get() as CharacterRow;

const bookId = saveMemory({
  characterId: character.id,
  itemType: "ongoing",
  owner: "char",
  area: "독서",
  subject: "당신 인생의 이야기",
  value: "9/1 시작했고 첫 단편을 읽는 중이다",
  tags: ["책", "테드 창"],
  userKnows: "known",
  endCondition: "완독",
});
const runId = saveMemory({
  characterId: character.id,
  itemType: "ongoing",
  owner: "char",
  area: "운동",
  subject: "달리기",
  value: "3km까지 뛴다",
  tags: ["달리기"],
  userKnows: "known",
  endCondition: "5km 완주",
});
const userFactId = saveMemory({
  characterId: character.id,
  itemType: "fact",
  owner: "user",
  area: "취미",
  subject: "독서",
  value: "소설을 좋아한다",
  tags: [],
});

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
      block("20:00", "21:00", "달리기", { source: "ongoing", source_id: runId }),
      block("21:00", "22:00", "책 이어 읽기", { source: "ongoing", source_id: bookId }),
      block("22:00", "29:00", "잠", { responsiveness: "unavailable" }),
    ],
  }),
  "nightly",
);
// 달리기는 유저가 붙잡아서 취소됐다 — 그날 몫이 없다.
recordDayActual(
  character.id,
  DIARY_DATE,
  "20:00",
  "달리기",
  "취소",
  "유저가 붙잡아서",
  `${DIARY_DATE} 20:05:00`,
);

const g = gatherNightlyInput(character, DIARY_DATE);

test("어제 각본의 진행 중인 일 블록이 실제 기록과 함께 재료에 실린다", () => {
  assert.equal(g.msgsCount, 0);
  assert.equal(g.ongoingTouched.length, 2);
  const joined = g.ongoingTouched.join("\n");
  assert.match(
    joined,
    new RegExp(
      `- \\[${bookId}\\] 독서/당신 인생의 이야기: 9/1 시작했고 첫 단편을 읽는 중이다 \\(끝나는 조건: 완독\\) — 어제 각본: 21:00 책 이어 읽기 → 각본대로`,
    ),
  );
  assert.match(
    joined,
    new RegExp(
      `- \\[${runId}\\] 운동/달리기: 3km까지 뛴다 \\(끝나는 조건: 5km 완주\\) — 어제 각본: 20:00 달리기 → 달라짐: 취소\\(유저가 붙잡아서\\)`,
    ),
  );
  assert.match(g.ongoingForPlan, new RegExp(`\\[${bookId}\\] 독서/`));
});

test("진행 반영 프롬프트에 한 걸음·취소 제외·끝남 규칙이 있다", () => {
  const p = progressPrompt(g);
  assert.match(p, /그 일을 한 걸음만 옮긴다/);
  assert.match(p, /취소되거나 미뤄진 블록은 그날 몫이 없던 것이다/);
  assert.match(p, new RegExp(`끝난 상태\\(${DIARY_DATE}에 끝났다는 것과`));
  assert.doesNotMatch(p, /\[어제 대화/);
});

test("새 값은 태그를 이은 채 저장되고, 끝난 일은 사실 항목으로 옮겨진다", () => {
  const result = applyNightlyOutput(g, {
    entry: {
      diary: "조용한 하루",
      plan_vs_actual: "",
      user_mood: "",
      closeness: "",
      tomorrow: [],
      tags: [],
    },
    progress: [
      { id: bookId, value: "9/3에 마지막 단편까지 읽고 다 읽었다", done: true },
      // 남의 행(유저 쪽 사실)과 없는 행은 받지 않는다.
      { id: userFactId, value: "덮어쓰기 시도", done: false },
      { id: 999999, value: "없는 행", done: false },
    ],
  });
  assert.match(result, /진행 중인 일 1건 \(끝남 1건\)/);

  const moved = db
    .prepare(
      `SELECT * FROM memory_items WHERE character_id = ? AND area = '독서' AND subject = '당신 인생의 이야기'`,
    )
    .all(character.id) as { id: number; item_type: string; value: string; end_condition: string | null }[];
  assert.equal(moved.length, 1);
  assert.equal(moved[0]?.item_type, "fact");
  assert.equal(moved[0]?.value, "9/3에 마지막 단편까지 읽고 다 읽었다");
  assert.equal(moved[0]?.end_condition, null);
  // 태그에는 영역·무엇이 같이 붙는다(memory.ts) — 앞 행에 있던 태그가 그대로 따라온다.
  assert.deepEqual(getTags("memory", moved[0]!.id).sort(), [
    "당신 인생의 이야기",
    "독서",
    "책",
    "테드 창",
  ]);

  assert.equal(getMemoryItemById(userFactId)?.value, "소설을 좋아한다");
  assert.equal(getMemoryItemById(runId)?.value, "3km까지 뛴다");
});

test("끝나지 않은 일은 값만 바뀌고 진행 중인 일로 남는다", () => {
  const g2 = gatherNightlyInput(character, "2026-09-02");
  applyNightlyOutput(g2, {
    entry: {
      diary: "",
      plan_vs_actual: "",
      user_mood: "",
      closeness: "",
      tomorrow: [],
      tags: [],
    },
    progress: [{ id: runId, value: "4km까지 늘렸다", done: false }],
  });
  const row = getMemoryItemById(runId);
  assert.equal(row?.item_type, "ongoing");
  assert.equal(row?.value, "4km까지 늘렸다");
  assert.equal(row?.end_condition, "5km 완주");
  assert.equal(row?.user_knows, "known");
  assert.deepEqual(getTags("memory", runId).sort(), ["달리기", "운동"]);
});

test("같은 키를 기억 정리가 쓴 날은 진행 반영이 그 값을 덮지 않는다", () => {
  const g3 = gatherNightlyInput(character, "2026-09-01");
  const result = applyNightlyOutput(g3, {
    entry: {
      diary: "",
      plan_vs_actual: "",
      user_mood: "",
      closeness: "",
      tomorrow: [],
      tags: [],
    },
    extract: {
      memories: [
        {
          item_type: "ongoing",
          owner: "char",
          area: "운동",
          subject: "달리기",
          value: "상대에게 말한 대로 오늘은 쉬었고 아직 4km다",
          tags: ["달리기"],
          user_knows: "known",
          end_condition: "5km 완주",
        },
      ],
      schedules: [],
    },
    progress: [{ id: runId, value: "5km를 채웠다", done: true }],
  });
  assert.match(result, /대화로 정리한 일 1건은 진행 반영 건너뜀/);
  const row = getMemoryItemById(runId);
  assert.equal(row?.item_type, "ongoing");
  assert.equal(row?.value, "상대에게 말한 대로 오늘은 쉬었고 아직 4km다");
});
