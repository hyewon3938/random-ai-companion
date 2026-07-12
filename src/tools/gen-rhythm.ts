// 월 리듬(이벤트 + 매일 컨디션 시드) 생성·확인 도구.
// 인자로 "YYYY-MM"을 주면 그 달, 없으면 이번 달. 이미 있으면 생성은 건너뛰고 내용만 보여준다.
// 사용: docker exec random-ai-companion npx tsx src/tools/gen-rhythm.ts [YYYY-MM]
import {
  db,
  getMonthSeeds,
  getSchedulesInMonth,
  type CharacterRow,
} from "../db.js";
import { ensureMonthPlan } from "../life-plan.js";
import type { Bible } from "../character.js";
import { kstDateString } from "../kst.js";

const row = db
  .prepare(
    `SELECT * FROM characters WHERE status = 'active' ORDER BY id DESC LIMIT 1`,
  )
  .get() as CharacterRow | undefined;
if (!row) {
  console.log("no active character");
  process.exit(0);
}

const ym = process.argv[2] ?? kstDateString().slice(0, 7);
const bible = JSON.parse(row.bible_json) as Bible;

const made = await ensureMonthPlan(row.id, bible, ym);
console.log(made ? `생성함: ${ym}` : `이미 있음: ${ym} (내용만 표시)`);

const events = getSchedulesInMonth(row.id, ym, "char");
const seeds = getMonthSeeds(row.id, ym);

console.log(`\n=== ${ym} 이벤트 (${events.length}) ===`);
for (const e of events)
  console.log(
    `  ${e.date}${e.time_hint ? ` ${e.time_hint}` : ""} — ${e.content}`,
  );

console.log(`\n=== ${ym} 컨디션 시드 (${seeds.length}일) ===`);
const eventDates = new Set(events.map((e) => e.date));
for (const s of seeds) {
  const mark = eventDates.has(s.date) ? " ●이벤트" : "";
  console.log(
    `  ${s.date}  기력:${s.energy}  기상:${s.wake_hint}  기분:${s.mood}${s.note ? `  (${s.note})` : ""}${mark}`,
  );
}
