// 새벽 정리 적용 도구: stdin으로 받은 생성 결과(JSON)를 DB에 반영한다.
// 입력 형식: {"characterId": n, "output": {"entry": {...},
//            "extract": {"memories":[...], "relationship":{...}|null, "schedules":[...]}|null,
//            "plan": {...}|null, "send": {"window_start","window_end","text","kind"?}|null,
//            "arcs": {...}|null, "rhythm": [...]|null}}
// 사용: cat out.json | docker exec -i random-ai-companion npx tsx src/tools/nightly-write.ts
import { db, type CharacterRow } from "../db.js";
import {
  gatherNightlyInput,
  applyNightlyOutput,
  type NightlyOutput,
} from "../nightly.js";

const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
  characterId: number;
  output: NightlyOutput;
};

const row = db
  .prepare(`SELECT * FROM characters WHERE id = ?`)
  .get(input.characterId) as CharacterRow | undefined;

if (!row) {
  console.log(`error: character ${input.characterId} not found`);
} else {
  const g = gatherNightlyInput(row);
  console.log(applyNightlyOutput(g, input.output));
}
