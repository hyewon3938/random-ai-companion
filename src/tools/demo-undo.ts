// 데모 원복 도구 (발표 시연용): demo-send.ts가 출력한 경계 id 이후의 메시지를 삭제해 데모 전 상태로 되돌린다.
// 유저의 데모 응답과 그 사이 봇의 응답까지, 경계 이후는 전부 제거된다.
// 파괴적 작업이므로 먼저 --dry로 삭제 대상을 확인한 뒤 실제 삭제한다.
// 사용: docker exec random-ai-companion npx tsx src/tools/demo-undo.ts <chat_id> <boundary> [--dry]
import { db } from "../db.js";

const chatId = process.argv[2];
const boundary = Number(process.argv[3]);
const dry = process.argv.includes("--dry");

if (!chatId || !Number.isFinite(boundary)) {
  console.error("사용법: demo-undo.ts <chat_id> <boundary_id> [--dry]");
  process.exit(1);
}

const rows = db
  .prepare(
    `SELECT id, role, substr(text, 1, 40) AS preview, sent_at FROM messages WHERE chat_id = ? AND id > ? ORDER BY id`,
  )
  .all(chatId, boundary) as {
  id: number;
  role: string;
  preview: string;
  sent_at: string;
}[];

for (const r of rows) console.log(`  #${r.id} ${r.role} ${r.sent_at} ${r.preview}`);
console.log(
  `[demo-undo] 대상 ${rows.length}건 (chat=${chatId}, id>${boundary})`,
);

if (dry) {
  console.log("[demo-undo] --dry: 삭제하지 않음");
  process.exit(0);
}

const info = db
  .prepare(`DELETE FROM messages WHERE chat_id = ? AND id > ?`)
  .run(chatId, boundary);
console.log(`[demo-undo] 삭제 완료: ${info.changes}건`);
process.exit(0);
