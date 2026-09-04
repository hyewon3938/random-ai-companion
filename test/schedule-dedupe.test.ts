// 새벽 정리가 이미 있는 일정을 다시 넣지 않는지 검사한다 — 모델은 부르지 않는다.
//
// 프롬프트가 [이미 저장된 일정] 목록을 보여주고 다시 적지 말라고 하는데도 같은 일이 날마다 한
// 줄씩 쌓였다(이슈 #267). 저장하는 자리에서 막는 분기와, 그 분기가 쓰는 견주기 함수를 본다.
//
// DB는 임시 파일로 새로 만든다. 슬랙 값은 넣지 않는다 — 트레이스는 값이 없으면 통째로 no-op다.
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
const { db, getTags } = await import("../src/db.js");
const { gatherNightlyInput, applyNightlyOutput } =
  await import("../src/nightly.js");
const { normalizeScheduleContent, isSameScheduleContent } =
  await import("../src/schedule-dedupe.js");

test("공백·기호만 다른 내용은 같은 일정으로 본다", () => {
  assert.equal(isSameScheduleContent("동아리 모임", " 동아리  모임! "), true);
  assert.equal(isSameScheduleContent("건강검진(오전)", "건강검진 오전"), true);
  assert.equal(normalizeScheduleContent("Ａ／Ｂ 회의"), "ab회의");
});

test("내용이 다르면 다른 일정이다", () => {
  assert.equal(isSameScheduleContent("동아리 모임", "동아리 뒤풀이"), false);
  // 뜻이 비슷한지는 보지 않는다 — 숫자가 다르면 다른 줄이다.
  assert.equal(isSameScheduleContent("14:00 미팅", "15:00 미팅"), false);
  // 글자·숫자가 하나도 없는 내용끼리는 한 줄로 뭉치지 않는다.
  assert.equal(isSameScheduleContent("!!!", "???"), false);
});

const DIARY_DATE = "2026-09-03";
const CHAT_ID = "1";

const character = db
  .prepare(
    `INSERT INTO characters (chat_id, status, genesis_json, created_at)
     VALUES (?, 'active', '{}', '2026-08-30 12:00:00') RETURNING *`,
  )
  .get(CHAT_ID) as CharacterRow;

const putSchedule = (
  owner: "char" | "user",
  date: string,
  content: string,
  status: "active" | "cancelled",
): number =>
  Number(
    db
      .prepare(
        `INSERT INTO schedules (character_id, owner, date, content, origin, status, created_at)
         VALUES (?, ?, ?, ?, 'rhythm', ?, '2026-08-30 05:10:00') RETURNING id`,
      )
      .pluck()
      .get(character.id, owner, date, content, status),
  );

// 이미 있는 두 줄 — 하나는 살아 있고(태그가 붙어 있다), 하나는 취소로 표시되어 있다.
const kept = putSchedule("char", "2026-09-18", "동아리 모임", "active");
db.prepare(
  `INSERT INTO tags (character_id, kind, ref_id, tag) VALUES (?, 'schedule', ?, '학교')`,
).run(character.id, kept);
putSchedule("user", "2026-09-20", "치과 예약(오전)", "cancelled");

const result = applyNightlyOutput(gatherNightlyInput(character, DIARY_DATE), {
  entry: {
    diary: "조용한 하루였다",
    plan_vs_actual: "",
    user_mood: "",
    closeness: "",
    tomorrow: [],
  },
  extract: {
    memories: [],
    schedules: [
      // 이미 있는 줄과 공백·기호만 다르다 → 건너뛴다
      {
        who: "char",
        date: "2026-09-18",
        time_hint: null,
        content: " 동아리  모임! ",
        tags: ["모임"],
      },
      // 같은 날이지만 다른 일 → 들어간다
      {
        who: "char",
        date: "2026-09-18",
        time_hint: "저녁",
        content: "동아리 뒤풀이",
      },
      // 같은 일이지만 다른 날 → 들어간다
      {
        who: "char",
        date: "2026-09-19",
        time_hint: null,
        content: "동아리 모임",
      },
      // 취소로 표시된 줄과 겹친다 → 접혔던 일이 다시 잡힌 것이므로 들어간다
      {
        who: "user",
        date: "2026-09-20",
        time_hint: null,
        content: "치과 예약 오전",
      },
    ],
  },
});

const contentsOn = (owner: string, date: string): string[] =>
  db
    .prepare(
      `SELECT content FROM schedules
       WHERE character_id = ? AND owner = ? AND date = ? AND status = 'active' ORDER BY id`,
    )
    .pluck()
    .all(character.id, owner, date) as string[];

test("이미 있는 일정은 다시 넣지 않는다", () => {
  assert.deepEqual(contentsOn("char", "2026-09-18"), [
    "동아리 모임",
    "동아리 뒤풀이",
  ]);
});

test("날짜가 다르거나 취소로 표시된 줄과 겹치는 일정은 그대로 들어간다", () => {
  assert.deepEqual(contentsOn("char", "2026-09-19"), ["동아리 모임"]);
  assert.deepEqual(contentsOn("user", "2026-09-20"), ["치과 예약 오전"]);
});

test("건너뛴 건수가 정리 결과에 남는다", () => {
  assert.match(result, /이미 있는 일정 1건 건너뜀/);
});

test("건너뛴 줄의 태그가 남아 있는 행의 태그를 덮지 않는다", () => {
  assert.deepEqual(getTags("schedule", kept), ["학교"]);
});
