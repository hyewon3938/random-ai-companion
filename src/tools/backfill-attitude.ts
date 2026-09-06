// 태도 두 칸(상대를 대하는 방식·애착 성향)을 이미 만들어 둔 캐릭터에 채운다. 새로 만드는
// 캐릭터는 생성 호출이 채우므로 이 도구는 그 전에 만들어진 캐릭터 몫이다.
//
// 값은 여태 규칙층이 지시문으로 들고 있던 내용을 그 캐릭터의 값으로 옮겨 적은 것이다 —
// 유저마다 다른 캐릭터를 만드는 이상 이 성향은 시스템 규칙이 아니라 캐릭터 값이어야 한다.
//
// 사용: docker exec random-ai-companion npx tsx src/tools/backfill-attitude.ts [--dry]
import { db } from "../db.js";
import { saveCreationMemory } from "../memory.js";

const dry = process.argv.slice(2).includes("--dry");

const ATTITUDE: { subject: string; value: string; tags: string[] }[] = [
  {
    subject: "상대를 대하는 방식",
    value:
      "상대가 마음을 열고 다가오면 아낌없이 받아준다. 곁에 있어달라거나 더 얘기하자고 하면 재지 않고 반기고, 훈수나 단서를 달아 눈치를 주지 않는다. 자기 피곤함보다 상대와 보내는 시간을 앞에 둔다. 먼저 다가가 자기 하루와 생각을 꺼내며 대화를 열고, 가벼운 장난과 놀림을 즐기되 선은 지킨다.",
    tags: ["태도", "관계"],
  },
  {
    subject: "애착 성향",
    value:
      "상대가 붙잡으면 곁에 남는다. 답이 오래 없으면 기다렸다고 말하고, 삐진 척이나 툭 쏘는 말은 다가와달라는 신호로 읽어 먼저 그 마음을 받아준 다음에 장난을 섞는다. 따지거나 미안하게 만들지는 않는다. 다만 얼버무리거나 대답이 짧아지며 정말 물러나는 신호면 더 캐지 않고 물러난다.",
    tags: ["태도", "관계"],
  },
];

const chars = db
  .prepare(`SELECT id, chat_id FROM characters WHERE status = 'active' ORDER BY id`)
  .all() as { id: number; chat_id: string }[];

if (!chars.length) {
  console.log("활성 캐릭터가 없다.");
  process.exit(0);
}

for (const c of chars) {
  console.log(`\n=== 캐릭터 ${c.id} (chat ${c.chat_id}) ===`);
  for (const a of ATTITUDE) {
    const had = db
      .prepare(
        `SELECT id, value FROM memory_items
          WHERE character_id = ? AND item_type = 'fact' AND owner = 'char'
            AND area = '태도' AND subject = ? AND origin = 'creation'`,
      )
      .get(c.id, a.subject) as { id: number; value: string } | undefined;
    if (had) {
      console.log(`  ${a.subject}: 이미 있다 (행 ${had.id}) — 그대로 둔다`);
      continue;
    }
    if (dry) {
      console.log(`  ${a.subject}: 넣을 값 — ${a.value.slice(0, 40)}…`);
      continue;
    }
    const id = saveCreationMemory({
      characterId: c.id,
      itemType: "fact",
      owner: "char",
      area: "태도",
      subject: a.subject,
      value: a.value,
      tags: a.tags,
      userKnows: "unknown",
      interest: "medium",
    });
    console.log(`  ${a.subject}: 넣었다 (행 ${id})`);
  }
}
