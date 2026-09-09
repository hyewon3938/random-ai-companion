// 유저 입력 캐릭터 생성 도구 — 생성 두 콜을 파일 입력으로 돌려 보는 자리.
// 입력 JSON 파일에 선택지 다섯(gender·ageBand·speechLevel·leadTone·flaw, 섞는 결은 mixTones)과
// 서술형 셋(personality·relationship·wish)을 적고, profile을 함께 주면 그 값을, 없으면
// user_profile 행을 읽는다. --prompt를 붙이면 모델을 부르지 않고 생성 프롬프트 문안만 찍는다.
// 사용: npx tsx src/tools/create-character.ts <chatId> <input.json> [--prompt]
// 입력 예: {"gender":"남성","ageBand":"30대 초반","speechLevel":"casual","leadTone":"direct",
//          "mixTones":["tease_sincere"],"flaw":"jealousy","personality":"...","profile":{"preferredName":"..."}}
import { readFileSync } from "node:fs";
import { db, getArcs, getStage, getUserProfileFull, type UserProfileFull } from "../db.js";
import {
  FLAW_KEY,
  WANTED_WAY_KEY,
  createUserCharacter,
  genesisPromptText,
  inputProblem,
  type CharacterInput,
} from "../character.js";

const argv = process.argv.slice(2);
const promptOnly = argv.includes("--prompt");
const [chatId, inputPath] = argv.filter((a) => !a.startsWith("--"));
if (!chatId || !inputPath) {
  console.log(
    "사용: npx tsx src/tools/create-character.ts <chatId> <input.json> [--prompt]",
  );
  process.exit(1);
}

const raw = JSON.parse(readFileSync(inputPath, "utf8")) as CharacterInput & {
  profile?: UserProfileFull;
};
const { profile, ...input } = raw;

if (promptOnly) {
  const bad = inputProblem(input);
  if (bad) {
    console.error(`입력이 형식에 맞지 않는다: ${bad}`);
    process.exit(1);
  }
  const { system, user } = genesisPromptText(
    input,
    profile ?? getUserProfileFull(chatId),
  );
  console.log(`=== system ===\n${system}\n\n=== user ===\n${user}`);
  process.exit(0);
}

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

console.log(`\n=== 원하는 방식과 결점 (코드가 적은 정체성 행) ===`);
for (const key of [WANTED_WAY_KEY, FLAW_KEY]) {
  const value = db
    .prepare(
      `SELECT value FROM memory_items
       WHERE character_id = ? AND origin = 'creation' AND area = ? AND subject = ?`,
    )
    .pluck()
    .get(id, key.area, key.subject);
  console.log(`  ${key.area}/${key.subject}: ${String(value ?? "(없음)")}`);
}

const rel = db
  .prepare(
    `SELECT stage, speech_level, speech_note, address_terms, history, feelings
     FROM relationships WHERE character_id = ?`,
  )
  .get(id) as Record<string, string | null> | undefined;
const stage = getStage(id);
console.log(`\n=== 관계 첫 값 ===`);
console.log(
  `  단계: ${stage ? `${stage.stage_no}단계 (${stage.stage_since}부터)` : "(없음)"}`,
);
for (const [k, v] of Object.entries(rel ?? {}))
  console.log(`  ${k}: ${v ?? "(비움)"}`);

console.log(`\n=== 아크 ===`);
for (const [period, content] of Object.entries(getArcs(id)))
  console.log(`  ${period}: ${content}`);

console.log(`\n=== 첫 인사 ===`);
console.log(`  ${output.firstGreeting}`);
