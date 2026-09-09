// 캐릭터가 상대에게 말한 일정에 그 사실이 적히는지 검사한다 — 모델은 부르지 않는다.
//
// 일정의 user_knows는 쓰는 코드가 없어서 모든 줄이 기본값 unknown에 머물렀고, 답장 텀 판정의
// '상대가 안다' 갈래는 운영에서 한 번도 닿지 않았다(이슈 #345). 새벽 정리가 새 일정에 값을
// 적고 이미 있는 줄을 뒤집는 경로를 넣었으니, 뒤집히는 줄과 뒤집히면 안 되는 줄을 함께 본다 —
// 남의 캐릭터 줄, 이미 상대가 아는 줄, known 말고 다른 값이 온 줄이 그것이다.
//
// 추출 프롬프트가 지금 값을 보여 주는지도 여기서 본다. 모델이 지금 값을 못 보면 오늘 말한
// 것만 골라 뒤집을 수가 없다.
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
const { db, addSchedule, markScheduleKnown } = await import("../src/db.js");
const { saveMemory } = await import("../src/memory.js");
const { gatherNightlyInput, applyNightlyOutput } =
  await import("../src/nightly.js");
const { extractPrompt } = await import("../src/prompts/nightly.js");

const DIARY_DATE = "2026-09-09";

const makeCharacter = (chatId: string): CharacterRow =>
  db
    .prepare(
      `INSERT INTO characters (chat_id, status, genesis_json, created_at)
       VALUES (?, 'active', '{}', '2026-09-01 12:00:00') RETURNING *`,
    )
    .get(chatId) as CharacterRow;

const character = makeCharacter("1");
const other = makeCharacter("2");

const knowsOf = (id: number): string =>
  db.prepare(`SELECT user_knows FROM schedules WHERE id = ?`).pluck().get(id) as string;

// 월 리듬이 미리 깔아 둔 캐릭터 쪽 일정. 아직 말하지 않은 일이라 모르는 것으로 들어간다.
const report = addSchedule(
  character.id,
  "char",
  "2026-09-15",
  "오후",
  "팀 보고",
  "2026-09-08 22:57:19",
  "rhythm",
);
const told = addSchedule(
  character.id,
  "char",
  "2026-09-16",
  null,
  "건강검진",
  "2026-09-08 22:57:19",
  "rhythm",
  "known",
);
const cancelled = addSchedule(
  character.id,
  "char",
  "2026-09-19",
  "저녁",
  "동창 모임",
  "2026-09-08 22:57:19",
  "rhythm",
);
db.prepare(`UPDATE schedules SET status = 'cancelled' WHERE id = ?`).run(
  cancelled,
);
const alien = addSchedule(
  other.id,
  "char",
  "2026-09-15",
  "오후",
  "팀 보고",
  "2026-09-08 22:57:19",
  "rhythm",
);
// 상대 쪽 일정 — 제 일정을 모를 리 없으니 넘긴 값과 상관없이 아는 것으로 들어간다.
const userTrip = addSchedule(
  character.id,
  "user",
  "2026-09-20",
  null,
  "출장",
  "2026-09-08 22:57:19",
  "conversation",
);

// 반영이 값을 바꾸기 전의 모습. node:test는 모듈 본문을 다 돌고 나서 test를 실행하므로,
// 넣은 직후의 값과 프롬프트를 여기서 잡아 두고 아래 test는 잡아 둔 것을 본다.
const insertedKnows = {
  report: knowsOf(report),
  told: knowsOf(told),
  userTrip: knowsOf(userTrip),
};

test("월 리듬이 넣은 내 일정은 상대가 모르는 것으로 들어간다", () => {
  assert.equal(insertedKnows.report, "unknown");
});

test("말했다고 넘긴 일정은 아는 것으로 들어간다", () => {
  assert.equal(insertedKnows.told, "known");
});

test("상대 쪽 일정은 넘긴 값과 상관없이 아는 것으로 들어간다", () => {
  assert.equal(insertedKnows.userTrip, "known");
});

// 진행 중인 일과 주변 인물도 지금 값이 프롬프트에 보여야 한다.
saveMemory({
  characterId: character.id,
  itemType: "ongoing",
  owner: "char",
  area: "가족",
  subject: "누나 결혼",
  value: "누나가 내년 봄에 결혼한다",
  userKnows: "unknown",
});
saveMemory({
  characterId: character.id,
  itemType: "person",
  owner: "char",
  area: "가족",
  subject: "서지영",
  value: "두 살 위 누나",
  relation: "누나",
  userKnows: "known",
});

const prompt = extractPrompt(gatherNightlyInput(character, DIARY_DATE));

test("추출 프롬프트의 재료 줄에 상대가 아는지의 지금 값이 붙는다", () => {
  assert.match(prompt, /누나 결혼: .*\[상대는 모름\]/);
  assert.match(prompt, /서지영 \(.*\): .*\[상대가 앎\]/);
  assert.match(prompt, new RegExp(`\\[${report}\\].*팀 보고 \\[상대는 모름\\]`));
  assert.match(prompt, new RegExp(`\\[${told}\\].*건강검진 \\[상대가 앎\\]`));
  // 상대 쪽 일정에는 표시를 붙이지 않는다 — 줄마다 같은 말이 반복될 뿐이다.
  assert.match(prompt, new RegExp(`\\[${userTrip}\\][^\\n]*출장$`, "m"));
});

const result = applyNightlyOutput(gatherNightlyInput(character, DIARY_DATE), {
  entry: {
    diary: "발표 이야기를 했다",
    plan_vs_actual: "",
    user_mood: "",
    closeness: "",
    tomorrow: [],
  },
  extract: {
    memories: [],
    schedules: [
      // 오늘 대화에서 상대에게 말한 새 일정
      {
        who: "char",
        date: "2026-09-23",
        time_hint: "10:00",
        content: "면접",
        user_knows: "known",
      },
      // 아직 말하지 않은 새 일정
      {
        who: "char",
        date: "2026-09-24",
        time_hint: null,
        content: "정기 점검",
      },
    ],
    schedule_updates: [
      // 오늘 말한 일정 — 모름에서 앎으로
      { id: report, user_knows: "known" },
      // 취소로 표시된 줄이라도 말한 것은 말한 것이다
      { id: cancelled, user_knows: "known" },
      // 이미 아는 줄은 바뀔 것이 없다
      { id: told, user_knows: "known" },
      // 남의 캐릭터 줄은 db가 막는다
      { id: alien, user_knows: "known" },
      // known 말고 다른 값은 받지 않는다 — 되돌리는 쓰기를 막는다
      { id: userTrip, user_knows: "unknown" },
    ],
  },
});

const idOf = (content: string): number =>
  db
    .prepare(
      `SELECT id FROM schedules WHERE character_id = ? AND content = ?`,
    )
    .pluck()
    .get(character.id, content) as number;

test("말했다고 적힌 새 일정만 아는 것으로 들어간다", () => {
  assert.equal(knowsOf(idOf("면접")), "known");
  assert.equal(knowsOf(idOf("정기 점검")), "unknown");
});

test("오늘 말한 일정이 모름에서 앎으로 바뀐다", () => {
  assert.equal(knowsOf(report), "known");
});

test("취소로 표시된 줄도 말한 것으로 바뀐다", () => {
  assert.equal(knowsOf(cancelled), "known");
});

test("남의 캐릭터 줄은 그대로다", () => {
  assert.equal(knowsOf(alien), "unknown");
});

test("known 말고 다른 값으로는 되돌리지 않는다", () => {
  assert.equal(knowsOf(userTrip), "known");
});

test("바뀐 줄만 세어 정리 결과에 남는다", () => {
  assert.match(result, /상대에게 말한 일정 2건 표시/);
});

test("이미 아는 줄에 다시 쓰면 바뀐 것이 없다고 답한다", () => {
  assert.equal(markScheduleKnown(character.id, told), false);
});

test("없는 번호를 넘기면 아무 줄도 고치지 않았다고 답한다", () => {
  assert.equal(markScheduleKnown(character.id, 99999), false);
});
