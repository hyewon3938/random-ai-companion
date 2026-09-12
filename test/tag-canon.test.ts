// 저장할 태그 이름을 이미 쓰는 이름으로 모으는 자리를 검사한다 — 모델은 부르지 않는다(#142).
//
// 판정 표는 tag-canon.ts가 모델에게 물어 만들지만, 검사에서는 표를 손으로 만들어 넘긴다.
// 볼 것은 셋이다. 모델 답을 표로 만들 때 무엇을 버리는지, 표가 저장 직전에 어떻게 걸리는지,
// 표를 넘긴 새벽 정리가 기억·일기·일정 세 자리에 같은 이름을 붙이는지.
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

const { db, getTags, listMemoryItems, listTagNames, getSchedulesFrom } =
  await import("../src/db.js");
const { canonTags, parseCanon, tidyTag } = await import("../src/tag-canon.js");
const { gatherNightlyInput, applyNightlyOutput } = await import(
  "../src/nightly.js"
);
const { searchMemories } = await import("../src/memory.js");
const { kstLogicalDate, shiftDate } = await import("../src/kst.js");

const DAY = (back: number) => shiftDate(kstLogicalDate(), -back);

const character = db
  .prepare(
    `INSERT INTO characters (chat_id, status, genesis_json, created_at)
     VALUES ('1', 'active', '{}', '2026-08-30 12:00:00') RETURNING *`,
  )
  .get() as CharacterRow;

test("이름을 다듬을 때 앞뒤 공백을 떼고 안쪽 공백을 하나로 줄인다", () => {
  assert.equal(tidyTag("  자격증  공부 "), "자격증 공부");
});

test("표에 없는 이름은 그대로 두고 같은 이름은 한 번만 붙인다", () => {
  const canon = new Map([["자격증 공부", "자격증"]]);
  assert.deepEqual(canonTags(canon, ["자격증 공부", "운동", "자격증"]), [
    "자격증",
    "운동",
  ]);
  assert.deepEqual(canonTags(undefined, [" 운동 ", "", "운동"]), ["운동"]);
});

test("모델 답에서 물어본 후보와 이미 쓰는 이름에 둘 다 걸린 줄만 받는다", () => {
  const canon = parseCanon(
    [
      "자격증 공부 -> 자격증",
      "- 러닝 크루 → 러닝",
      // 목록에 없는 이름으로 옮기라는 답. 받으면 이름이 하나 더 는다.
      "주말 등산 -> 등산 모임",
      // 물어보지 않은 후보.
      "회식 -> 일",
      "새 취미 -> 새로",
    ].join("\n"),
    ["자격증 공부", "러닝 크루", "주말 등산", "새 취미"],
    ["자격증", "러닝", "일"],
  );
  assert.deepEqual(
    [...canon],
    [
      ["자격증 공부", "자격증"],
      ["러닝 크루", "러닝"],
    ],
  );
});

const entry = {
  diary: "",
  plan_vs_actual: "",
  user_mood: "",
  closeness: "",
  tomorrow: [],
  tags: [] as string[],
};

// 첫 회차로 이름 셋을 심는다 — 판정이 대조할 이미 쓰는 이름이 여기서 생긴다.
test("첫 회차의 이름이 그대로 등록된다", () => {
  const g = gatherNightlyInput(character, DAY(3));
  applyNightlyOutput(g, {
    entry: { ...entry, tags: ["자격증"] },
    extract: {
      memories: [
        {
          item_type: "ongoing" as const,
          owner: "user" as const,
          area: "일",
          subject: "자격증",
          value: "정보처리기사를 준비한다",
          tags: ["공부"],
        },
      ],
      schedules: [],
    },
  });
  assert.deepEqual(listTagNames(character.id), ["공부", "일", "자격증"]);
});

test("표를 넘기면 기억·일기·일정이 같은 이름으로 모인다", () => {
  const g = gatherNightlyInput(character, DAY(2));
  const canon = new Map([
    ["자격증 공부", "자격증"],
    ["시험 공부", "공부"],
  ]);
  applyNightlyOutput(
    g,
    {
      entry: { ...entry, tags: ["자격증 공부"] },
      extract: {
        memories: [
          {
            item_type: "ongoing" as const,
            owner: "user" as const,
            // 키의 두 낱말도 태그로 복사되는 자리라 같은 판정을 지난다.
            area: "일",
            subject: "자격증 공부",
            value: "실기 시험이 다음 달이다",
            tags: ["시험 공부"],
          },
        ],
        schedules: [
          {
            who: "user" as const,
            date: DAY(-3),
            time_hint: null,
            content: "실기 시험",
            tags: ["자격증 공부"],
          },
        ],
      },
    },
    canon,
  );

  const mem = listMemoryItems(character.id).find(
    (r) => r.subject === "자격증 공부",
  );
  assert.ok(mem);
  assert.deepEqual(getTags("memory", mem.id), ["공부", "일", "자격증"]);

  const diaryId = (
    db
      .prepare(`SELECT id FROM diary_entries ORDER BY id DESC LIMIT 1`)
      .get() as { id: number }
  ).id;
  assert.deepEqual(getTags("diary", diaryId), ["자격증"]);

  const sched = getSchedulesFrom(character.id, DAY(-3), 10).find(
    (s) => s.content === "실기 시험",
  );
  assert.ok(sched);
  assert.deepEqual(getTags("schedule", sched.id), ["자격증"]);

  // 이름이 합쳐져도 그 기억은 검색에서 빠지지 않는다 — 키에 적힌 말 대신 합친 이름으로 걸린다.
  assert.ok(
    searchMemories(character.id, ["자격증"], { track: false }).some(
      (r) => r.id === mem.id,
    ),
  );
  assert.equal(
    searchMemories(character.id, ["자격증 공부"], { track: false }).length,
    0,
  );
  // 합칠 이름이 늘지 않았다는 것 — 첫 회차에서 쓰던 셋 그대로다.
  assert.deepEqual(listTagNames(character.id), ["공부", "일", "자격증"]);
});

test("표에 없는 후보는 새 이름으로 등록된다", () => {
  const g = gatherNightlyInput(character, DAY(1));
  applyNightlyOutput(
    g,
    {
      entry,
      extract: {
        memories: [
          {
            item_type: "fact" as const,
            owner: "user" as const,
            area: "취향",
            subject: "커피",
            value: "아메리카노를 마신다",
          },
        ],
        schedules: [],
      },
    },
    new Map([["자격증 공부", "자격증"]]),
  );
  const mem = listMemoryItems(character.id).find((r) => r.subject === "커피");
  assert.ok(mem);
  assert.deepEqual(getTags("memory", mem.id), ["취향", "커피"]);
});
