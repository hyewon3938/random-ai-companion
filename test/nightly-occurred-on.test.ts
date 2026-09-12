// 새벽 정리가 기억을 다시 적을 때 있었던 날이 어떻게 되는지 검사한다 — 모델은 부르지 않는다(#388).
//
// 며칠 전 일을 오늘 다시 말하면 그 기억의 갱신 날짜만 오늘로 바뀌고 있었던 날은 처음 적힌 날로
// 남아야 한다. 추출은 저장된 값을 못 보기 때문에 프롬프트가 이 칸을 빼라고 이르고, 빠진 칸을
// 앞 행의 날로 메우는 것이 저장 쪽 몫이다. 그 두 자리가 맞물리는지가 여기서 볼 것이다.
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

const { db, listMemoryItems } = await import("../src/db.js");
const { gatherNightlyInput, applyNightlyOutput } = await import(
  "../src/nightly.js"
);
const { kstLogicalDate, shiftDate } = await import("../src/kst.js");

// 새벽 정리는 하루에 한 번만 반영된다(같은 날 일기가 있으면 건너뛴다) — 회차마다 날짜를 가른다.
const DAY = (back: number) => shiftDate(kstLogicalDate(), -back);

const character = db
  .prepare(
    `INSERT INTO characters (chat_id, status, genesis_json, created_at)
     VALUES ('1', 'active', '{}', '2026-08-30 12:00:00') RETURNING *`,
  )
  .get() as CharacterRow;

const entry = {
  diary: "",
  plan_vs_actual: "",
  user_mood: "",
  closeness: "",
  tomorrow: [],
  tags: [],
};

// 같은 키를 두 회차가 이어 쓴다 — 이사 이야기가 며칠에 걸쳐 두 번 나온 자리다.
const memory = (value: string, occurredOn?: string) => ({
  item_type: "ongoing" as const,
  owner: "user" as const,
  area: "일",
  subject: "이사",
  value,
  ...(occurredOn ? { occurred_on: occurredOn } : {}),
});

const row = () =>
  listMemoryItems(character.id).find((r) => r.subject === "이사");

test("추출이 적은 있었던 날이 그대로 저장된다", () => {
  const g = gatherNightlyInput(character, DAY(4));
  applyNightlyOutput(g, {
    entry,
    extract: {
      memories: [memory("9/10 저녁에 이사했다", "2026-09-10")],
      schedules: [],
    },
  });
  assert.equal(row()?.occurred_on, "2026-09-10");
});

test("같은 기억을 다시 적을 때 칸을 빼면 처음 적힌 날이 남는다", () => {
  const g = gatherNightlyInput(character, DAY(3));
  applyNightlyOutput(g, {
    entry,
    // 오늘 대화에서 이사 이야기가 또 나왔지만 언제 이사했는지는 안 나온 회차다.
    extract: { memories: [memory("이사한 집 정리를 하고 있다")], schedules: [] },
  });
  const r = row();
  assert.equal(r?.value, "이사한 집 정리를 하고 있다");
  assert.equal(r?.occurred_on, "2026-09-10");
});

test("추출이 다른 날을 적으면 그 날로 바뀐다", () => {
  const g = gatherNightlyInput(character, DAY(2));
  applyNightlyOutput(g, {
    entry,
    extract: {
      memories: [memory("이사한 집 정리를 끝냈다", "2026-09-11")],
      schedules: [],
    },
  });
  assert.equal(row()?.occurred_on, "2026-09-11");
});

test("있었던 날을 한 번도 안 적은 기억은 비어 있다", () => {
  const g = gatherNightlyInput(character, DAY(1));
  applyNightlyOutput(g, {
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
  });
  assert.equal(
    listMemoryItems(character.id).find((r) => r.subject === "커피")
      ?.occurred_on,
    null,
  );
});
