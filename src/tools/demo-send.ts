// 데모 발송 도구 (발표 시연용): 활성 캐릭터로 선톡 문안을 실제 발송 경로(sendProactive)로 보낸다.
// 각 인자 = 말풍선 하나(줄바꿈으로 합쳐 splitBubbles가 나눈다). 발송 직전 message 최대 id(경계)를 출력한다.
// 촬영이 끝나면 demo-undo.ts <chat_id> <boundary>로 경계 이후를 삭제해 데모 전 상태로 원복한다.
// bot.ts는 import해도 폴링(bot.start)이 뜨지 않으므로(그건 index.ts) 발신 API만 쓰는 이 스크립트는
// 실행 중 컨테이너와 충돌하지 않는다.
// 사용: docker exec random-ai-companion npx tsx src/tools/demo-send.ts "버블1" "버블2" "버블3"
import { db, type CharacterRow } from "../db.js";
import { sendProactive } from "../bot.js";

const main = async (): Promise<void> => {
  const bubbles = process.argv.slice(2).filter((s) => s.trim());
  if (bubbles.length === 0) {
    console.error('사용법: demo-send.ts "버블1" "버블2" ...');
    process.exit(1);
  }
  const text = bubbles.join("\n");

  const char = db
    .prepare(
      `SELECT * FROM characters WHERE status = 'active' ORDER BY id LIMIT 1`,
    )
    .get() as CharacterRow | undefined;
  if (!char) {
    console.error("활성 캐릭터가 없습니다.");
    process.exit(1);
  }

  const boundary = (
    db
      .prepare(
        `SELECT COALESCE(max(id), 0) AS m FROM messages WHERE chat_id = ?`,
      )
      .get(char.chat_id) as { m: number }
  ).m;

  console.log(
    `[demo-send] chat=${char.chat_id} char=${char.id} boundary=${boundary} bubbles=${bubbles.length}`,
  );
  await sendProactive(char.chat_id, char.id, text, "morning");
  console.log(
    `[demo-send] 완료. 촬영 후 원복: demo-undo.ts ${char.chat_id} ${boundary}`,
  );
};

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
