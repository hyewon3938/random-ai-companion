// 운영 도구: 활성 캐릭터의 오늘 하루 각본을 생성(없을 때)하고 출력한다.
// 사용: npx tsx src/tools/gen-day-plan.ts
import { db, getDayPlan, type CharacterRow } from "../db.js";
import { ensureTodayPlan } from "../day-plan.js";
import type { Bible } from "../character.js";
import { kstDateString } from "../kst.js";

const row = db
  .prepare(
    `SELECT * FROM characters WHERE status = 'active' ORDER BY id DESC LIMIT 1`,
  )
  .get() as CharacterRow | undefined;

if (!row) {
  console.log("no active character");
} else {
  const bible = JSON.parse(row.bible_json) as Bible;
  await ensureTodayPlan(row.id, bible);
  console.log(getDayPlan(row.id, kstDateString()));
}
