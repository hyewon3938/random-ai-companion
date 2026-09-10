// 새벽 정리가 오늘 각본의 작품을 찾을 목록으로 넘기고, 돌려받은 사실 카드를 걸러 저장하는지 검사한다 — 모델은 부르지 않는다.
//
// 찾을 목록은 각본 블록의 work 값에서 나오고 이미 카드가 있는 제목은 빠진다(#287). 저장은
// 오늘 각본에 그 제목이 실제로 있을 때만 받고, 장면이 없는 카드는 버린다 — 없는 장면을 말하지
// 않게 하려고 만드는 자리라 줄거리만 있으면 쓸모가 없다.
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

const { db, saveDayPlan, getWorkFactsByTitles, listWorkFactTitles } =
  await import("../src/db.js");
const { gatherNightlyInput, applyNightlyOutput } = await import(
  "../src/nightly.js"
);
const { kstLogicalDate, shiftDate } = await import("../src/kst.js");

const TODAY = kstLogicalDate();
const DIARY_DATE = shiftDate(TODAY, -1);

const character = db
  .prepare(
    `INSERT INTO characters (chat_id, status, genesis_json, created_at)
     VALUES ('1', 'active', '{}', '2026-08-30 12:00:00') RETURNING *`,
  )
  .get() as CharacterRow;

const block = (
  start: string,
  end: string,
  activity: string,
  work?: string,
) => ({
  start,
  end,
  activity,
  responsiveness: "instant",
  advance_known: true,
  category: "personal",
  ...(work ? { work } : {}),
});

saveDayPlan(
  character.id,
  TODAY,
  JSON.stringify({
    date: TODAY,
    blocks: [
      block("09:00", "18:00", "일"),
      block("20:00", "22:00", "영화 보기", "여름 언덕"),
      block("22:00", "23:00", "책 이어 읽기", "당신 인생의 이야기"),
    ],
  }),
  "nightly",
);

const entry = {
  diary: "",
  plan_vs_actual: "",
  user_mood: "",
  closeness: "",
  tomorrow: [],
  tags: [],
};

test("찾을 목록은 오늘 각본의 work 값에서 나온다", () => {
  const g = gatherNightlyInput(character, DIARY_DATE);
  assert.deepEqual(g.workFactsNeeded, ["여름 언덕", "당신 인생의 이야기"]);
  assert.deepEqual(g.workFactsKnown, []);
});

test("각본에 있는 작품의 카드만 저장하고 장면 없는 카드는 버린다", () => {
  const g = gatherNightlyInput(character, DIARY_DATE);
  const result = applyNightlyOutput(g, {
    entry,
    work_facts: [
      {
        title: "여름 언덕",
        summary: "이사 온 소년이 한 계절을 보내는 이야기.",
        scenes: ["둑길에서 자전거가 멈추는 장면", "여름이 끝나는 밤의 대화"],
        differences: "원작 소설과 결말이 다르다",
      },
      // 각본에 없는 작품 — 생성이 엉뚱한 걸 찾아와도 여기서 걸린다.
      { title: "없는 영화", summary: "줄거리", scenes: ["장면"] },
      // 장면이 없는 카드 — 이 자리가 하려는 일을 못 한다.
      { title: "당신 인생의 이야기", summary: "단편집.", scenes: [] },
    ],
  });
  assert.match(result, /작품 카드 1건/);

  assert.deepEqual(listWorkFactTitles(character.id), ["여름 언덕"]);
  const [card] = getWorkFactsByTitles(character.id, ["여름 언덕"]);
  assert.equal(card?.summary, "이사 온 소년이 한 계절을 보내는 이야기.");
  assert.deepEqual(card?.scenes, [
    "둑길에서 자전거가 멈추는 장면",
    "여름이 끝나는 밤의 대화",
  ]);
  assert.equal(card?.differences, "원작 소설과 결말이 다르다");
});

test("이미 카드가 있는 제목은 다음 회차의 찾을 목록에서 빠진다", () => {
  const g = gatherNightlyInput(character, DIARY_DATE);
  assert.deepEqual(g.workFactsNeeded, ["당신 인생의 이야기"]);
  assert.deepEqual(g.workFactsKnown, ["여름 언덕"]);
});
