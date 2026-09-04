// 새벽 정리가 이미 있는 일정 줄의 시각만 고쳐 적는지 검사한다 — 모델은 부르지 않는다.
//
// 캐릭터가 대화에서 정한 시각은 새 줄로 들어가지 못한다. 같은 일로 걸러지기 때문이다(이슈
// #267). 걸러진 자리에서 원본 줄의 time_hint를 고치는 경로를 넣었으니(이슈 #278), 고쳐지는
// 줄과 고쳐지면 안 되는 줄을 함께 본다 — 남의 캐릭터 줄, 취소로 표시된 줄, 번호나 시각이
// 성하지 않은 줄이 그것이다.
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
const { db, setScheduleTimeHint } = await import("../src/db.js");
const { gatherNightlyInput, applyNightlyOutput } =
  await import("../src/nightly.js");

const DIARY_DATE = "2026-09-03";

const makeCharacter = (chatId: string): CharacterRow =>
  db
    .prepare(
      `INSERT INTO characters (chat_id, status, genesis_json, created_at)
       VALUES (?, 'active', '{}', '2026-08-30 12:00:00') RETURNING *`,
    )
    .get(chatId) as CharacterRow;

const character = makeCharacter("1");
const other = makeCharacter("2");

const putSchedule = (
  characterId: number,
  date: string,
  content: string,
  timeHint: string | null,
  status: "active" | "cancelled",
): number =>
  Number(
    db
      .prepare(
        `INSERT INTO schedules (character_id, owner, date, content, time_hint, origin, status, created_at)
         VALUES (?, 'char', ?, ?, ?, 'rhythm', ?, '2026-08-30 05:10:00') RETURNING id`,
      )
      .pluck()
      .get(characterId, date, content, timeHint, status),
  );

const movie = putSchedule(
  character.id,
  "2026-09-04",
  "영화 보기",
  "오후",
  "active",
);
const dinner = putSchedule(
  character.id,
  "2026-09-05",
  "저녁 약속",
  null,
  "active",
);
const cancelled = putSchedule(
  character.id,
  "2026-09-06",
  "치과",
  "오전",
  "cancelled",
);
const alien = putSchedule(
  other.id,
  "2026-09-04",
  "영화 보기",
  "오후",
  "active",
);

const hintOf = (id: number): string | null =>
  (db.prepare(`SELECT time_hint FROM schedules WHERE id = ?`).pluck().get(id) ??
    null) as string | null;

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
    schedules: [],
    schedule_updates: [
      // 오후라고만 적혀 있던 줄에 대화에서 정해진 시각이 붙는다
      { id: movie, time_hint: "14:30" },
      // 취소로 표시된 줄과 남의 캐릭터 줄은 db가 막는다
      { id: cancelled, time_hint: "11:00" },
      { id: alien, time_hint: "20:00" },
      // 번호나 시각이 성하지 않은 줄은 반영 자리에서 버린다
      { id: 0, time_hint: "09:00" },
      { id: dinner, time_hint: "   " },
    ],
  },
});

test("대화에서 정해진 시각이 이미 있는 줄에 적힌다", () => {
  assert.equal(hintOf(movie), "14:30");
});

test("취소로 표시된 줄과 남의 캐릭터 줄은 그대로다", () => {
  assert.equal(hintOf(cancelled), "오전");
  assert.equal(hintOf(alien), "오후");
});

test("번호나 시각이 성하지 않으면 아무것도 고치지 않는다", () => {
  assert.equal(hintOf(dinner), null);
});

test("고친 건수가 정리 결과에 남는다", () => {
  assert.match(result, /일정 시각 1건 고침/);
});

test("시각 말고는 아무것도 바뀌지 않는다", () => {
  const row = db
    .prepare(`SELECT owner, date, content, status FROM schedules WHERE id = ?`)
    .get(movie) as {
    owner: string;
    date: string;
    content: string;
    status: string;
  };
  assert.deepEqual(row, {
    owner: "char",
    date: "2026-09-04",
    content: "영화 보기",
    status: "active",
  });
});

test("없는 번호를 넘기면 아무 줄도 고치지 않았다고 답한다", () => {
  assert.equal(setScheduleTimeHint(character.id, 99999, "10:00"), false);
});
