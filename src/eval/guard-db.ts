// 평가가 운영 DB를 열지 못하게 막는다. db.ts는 불러오는 순간 DB 파일을 열고 마이그레이션까지
// 돌리므로, 이 검사는 db.ts보다 먼저 평가돼야 한다 — run.ts에서 가장 위에 import한다.
//
// yarn eval은 DB_PATH를 넣어 주지만 tsx src/eval/run.ts를 직접 치면 기본값이 잡힌다.
// 서버에서 그러면 운영 DB에 평가용 캐릭터가 만들어지고 실제 모델 호출까지 나간다.
import { config } from "../config.js";

if (!/eval/.test(config.dbPath)) {
  console.error(
    `평가 전용 DB가 아니다: ${config.dbPath}\n` +
      `운영 DB를 열지 않도록 여기서 멈춘다. yarn eval로 실행할 것.`,
  );
  process.exit(1);
}
