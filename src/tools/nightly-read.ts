// 새벽 정리 수집 도구: 활성 캐릭터의 새벽 정리 입력(어제 대화·기억·관계·각본·아크 등)을 JSON으로 출력한다.
// 외부 scheduled task가 ssh로 호출해 이 출력을 읽고, 자체 지능으로 일기·추출·각본·선톡 문안을
// 생성한 뒤 nightly-write.ts로 반영한다.
// 사용: docker exec random-ai-companion npx tsx src/tools/nightly-read.ts
import { db, type CharacterRow } from "../db.js";
import { gatherNightlyInput } from "../nightly.js";

const rows = db
  .prepare(`SELECT * FROM characters WHERE status = 'active'`)
  .all() as CharacterRow[];

console.log(JSON.stringify(rows.map((c) => gatherNightlyInput(c))));
