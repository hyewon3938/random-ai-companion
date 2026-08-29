// 유저 입력 캐릭터 생성 도구 — 봇 연결 전까지 생성 두 콜을 돌려 보는 자리.
// 입력 JSON 파일에 선택지 둘(gender·ageBand)과 서술형 셋(personality·relationship·wish)을 적고,
// profile을 함께 주면 그 값을, 없으면 user_profile 행을 읽는다.
// 사용: npx tsx src/tools/create-character.ts <chatId> <input.json>
// 입력 예: {"gender":"남성","ageBand":"30대 초반","personality":"...","profile":{"preferredName":"..."}}
import { readFileSync } from "node:fs";
import { db, getArcs, type UserProfileFull } from "../db.js";
import { createUserCharacter, type CharacterInput } from "../character.js";

const [chatId, inputPath] = process.argv.slice(2);
if (!chatId || !inputPath) {
  console.log(
    "사용: npx tsx src/tools/create-character.ts <chatId> <input.json>",
  );
  process.exit(1);
}

const raw = JSON.parse(readFileSync(inputPath, "utf8")) as CharacterInput & {
  profile?: UserProfileFull;
};
const { profile, ...input } = raw;

const { id, output } = await createUserCharacter(chatId, input, profile);

console.log(`캐릭터 생성됨: id=${id}, chatId=${chatId}`);

const counts = db
  .prepare(
    `SELECT item_type, COUNT(*) AS n FROM memory_items
     WHERE character_id = ? AND origin = 'creation' GROUP BY item_type`,
  )
  .all(id) as { item_type: string; n: number }[];
console.log(`\n=== 기억 행 (origin=creation) ===`);
for (const c of counts) console.log(`  ${c.item_type}: ${c.n}`);

const rel = db
  .prepare(
    `SELECT stage, speech_level, speech_note, address_terms, history, feelings
     FROM relationships WHERE character_id = ?`,
  )
  .get(id) as Record<string, string | null> | undefined;
console.log(`\n=== 관계 첫 값 ===`);
for (const [k, v] of Object.entries(rel ?? {}))
  console.log(`  ${k}: ${v ?? "(비움)"}`);

console.log(`\n=== 아크 ===`);
for (const [period, content] of Object.entries(getArcs(id)))
  console.log(`  ${period}: ${content}`);

console.log(`\n=== 첫 인사 ===`);
console.log(`  ${output.firstGreeting}`);
