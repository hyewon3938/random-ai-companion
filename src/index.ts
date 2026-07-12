import cron from "node-cron";
import { bot, recoverMissedReplies } from "./bot.js";
import { db, type CharacterRow } from "./db.js";
import { runNightly } from "./nightly.js";
import { runDispatchTick } from "./dispatch.js";
import { runFollowupTick } from "./followup.js";
import { runPresenceTick } from "./presence.js";

// 이 프로세스는 실시간 대화(반응형)와 선톡 발송을 담당한다.
//
// 밤 정리(새벽 5시 컷오프)는 기본적으로 외부 scheduled task(구독)가 수행한다 —
// VM의 수집/적용 도구(src/tools/nightly-read·write)를 ssh로 호출해 일기·기억·각본·선톡 문안을 만든다.
// 아래 05:40 크론은 그게 안 돌았을 때만 실제로 일하는 API 폴백이다(일기 중복 체크로 이중 실행 방지).
cron.schedule(
  "40 5 * * *",
  () => {
    const rows = db
      .prepare(`SELECT * FROM characters WHERE status = 'active'`)
      .all() as CharacterRow[];
    for (const c of rows)
      runNightly(c)
        .then((r) => console.log(`[nightly-fallback] #${c.id} ${r}`))
        .catch((e) => console.error(`[nightly-fallback] #${c.id} error:`, e));
  },
  { timezone: "Asia/Seoul" },
);

// 선톡 디스패처: 10분 틱, LLM 콜 없음. 밤 정리가 준비한 아침 안부를 발송 창 안에서 내보낸다
// (기상 직후 안부가 6시대일 수 있어 6시부터 돈다)
cron.schedule(
  "*/10 6-22 * * *",
  () => {
    runDispatchTick().catch((e) => console.error("[dispatch] tick error:", e));
  },
  { timezone: "Asia/Seoul" },
);

// 침묵 팔로업: 15분 틱. 낮엔 각본 전환점 근황, 밤(늦게~새벽 3시)엔 유저가 잠든 듯하면 굿나잇 챙김
cron.schedule(
  "*/15 0-3,8-23 * * *",
  () => {
    runFollowupTick().catch((e) => console.error("[followup] tick error:", e));
  },
  { timezone: "Asia/Seoul" },
);

// 자리 비움 예고: 10분 틱. 관계 초반, 곧 긴 불가(운동·샤워·외출)로 들어가기 직전/연속 불가 경계에서
// "이제 ~하러 가요, 답 늦어요"를 먼저 남겨 막연한 침묵을 '알고 하는 기다림'으로 바꾼다.
cron.schedule(
  "*/10 7-23 * * *",
  () => {
    runPresenceTick().catch((e) => console.error("[presence] tick error:", e));
  },
  { timezone: "Asia/Seoul" },
);

console.log("[bot] starting (long polling)...");
void bot.start();

// 재시작(배포)으로 놓친 답장 복구: 디바운스 대기 중 프로세스가 죽으면 그 답장은 영영 사라지므로,
// 부팅 후 한 번 확인해 이어서 답한다. 폴링이 밀린 메시지를 먼저 받도록 잠깐 기다렸다가 실행.
setTimeout(() => {
  recoverMissedReplies().catch((e) => console.error("[recover] error:", e));
}, 8000);
