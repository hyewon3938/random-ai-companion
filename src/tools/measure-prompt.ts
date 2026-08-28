// 운영 도구: 시스템 프롬프트 3층(불변/일간/실시간) 크기를 측정하고,
// --live를 주면 같은 프롬프트로 2회 실호출해 캐시 히트(cr>0)를 검증한다.
// 사용: npx tsx src/tools/measure-prompt.ts [--live]
import { db, type CharacterRow } from "../db.js";
import { buildSystemBlocks } from "../context.js";
import { chat } from "../llm.js";

const row = db
  .prepare(
    `SELECT * FROM characters WHERE status = 'active' ORDER BY id DESC LIMIT 1`,
  )
  .get() as CharacterRow | undefined;

if (!row) {
  console.log("no active character");
} else {
  const blocks = buildSystemBlocks(row.id, row.chat_id);
  const names = ["불변층", "일간층", "실시간 꼬리"];
  blocks.forEach((b, i) =>
    console.log(
      `${names[i]} ${b.cache ? "(캐시)" : "(캐시 밖)"}: ${b.text.length}자`,
    ),
  );
  console.log(
    "합계:",
    blocks.reduce((a, b) => a + b.text.length, 0),
    "자",
  );

  if (process.argv.includes("--live")) {
    // 1회차 cw(캐시 쓰기)>0, 2회차 cr(캐시 읽기)>0 이어야 정상
    for (let i = 1; i <= 2; i++) {
      console.log(`--- ${i}회차 ---`);
      await chat(
        blocks,
        [{ role: "user", content: "(캐시 검증용 — 한 단어로만 답해)" }],
        8,
      );
    }
  }
}
