// 운영 도구: 활성 캐릭터 전체에 밤 정리를 수동 실행한다 (누락분 소급 생성용).
// 사용: npx tsx src/tools/run-nightly.ts
import { db, type CharacterRow } from "../db.js";
import { runNightly } from "../nightly.js";

const rows = db
  .prepare(`SELECT * FROM characters WHERE status = 'active'`)
  .all() as CharacterRow[];

if (!rows.length) console.log("no active character");
for (const c of rows) {
  console.log(`#${c.id}`, await runNightly(c));
}
