import cron from "node-cron";
import {
  bot,
  recoverMissedReplies,
  keepConnectionWarm,
  logErr,
} from "./bot.js";
import { db, type CharacterRow } from "./db.js";
import { runNightly } from "./nightly.js";
import { runDispatchTick } from "./dispatch.js";
import { runFollowupTick } from "./followup.js";
import { runPresenceTick } from "./presence.js";
import { resumePendingReplies } from "./pending.js";
import { runVizTick } from "./viz.js";

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
        .catch((e) => logErr(`[nightly-fallback] #${c.id} error:`, e));
  },
  { timezone: "Asia/Seoul" },
);

// 선톡 디스패처: 3분 틱, LLM 콜 없음. 밤 정리가 준비한 아침 안부를 발송 창 안에서 내보낸다
// (기상 직후 안부가 6시대일 수 있어 6시부터 돈다)
//
// 10분 틱이었을 땐 발송 창이 20~30분인 날 시도가 2~3회뿐이라, 짧은 네트워크 장애 한 번에
// 그날 안부가 통째로 폐기됐다. 창 안에서 여러 번 두드리게 3분으로 줄인다(LLM 콜이 없어 공짜).
cron.schedule(
  "*/3 6-22 * * *",
  () => {
    runDispatchTick().catch((e) => logErr("[dispatch] tick error:", e));
  },
  { timezone: "Asia/Seoul" },
);

// 침묵 팔로업: 15분 틱. 낮엔 각본 전환점 근황, 새벽(2~5시)엔 유저가 잠든 듯하면 굿나잇 챙김
cron.schedule(
  "*/15 0-4,8-23 * * *",
  () => {
    runFollowupTick().catch((e) => logErr("[followup] tick error:", e));
  },
  { timezone: "Asia/Seoul" },
);

// 자리 비움 예고: 10분 틱. 곧 긴 불가(운동·샤워·외출)로 들어가기 직전/연속 불가 경계에서
// "이제 ~하러 가요, 답 늦어요"를 먼저 남겨 막연한 침묵을 '알고 하는 기다림'으로 바꾼다.
cron.schedule(
  "*/10 7-23 * * *",
  () => {
    runPresenceTick().catch((e) => logErr("[presence] tick error:", e));
  },
  { timezone: "Asia/Seoul" },
);

// 답장 전송이 네트워크 블립으로 실패하면(프로세스는 살아 있어 부팅 복구가 안 걸린다) 그 답장이 유실된다.
// 2분마다 놓친 답장을 점검해, 네트워크가 돌아오면 이어서 보낸다. 처리 중이거나 이미 답한 건 스킵(워터마크로 중복 방지).
cron.schedule(
  "*/2 * * * *",
  () => {
    recoverMissedReplies().catch((e) => logErr("[recover] tick error:", e));
  },
  // 매 2분이라 지금은 시간대 무관하지만, 다른 크론과 같은 기준으로 명시(패턴 바뀔 때 함정 방지)
  { timezone: "Asia/Seoul" },
);

// 슬랙 트레이스 게시: 1분 틱. 파이프라인이 게시함(viz_events)에 쌓아 둔 기록을
// 슬랙 채널로 내보낸다. 토큰·채널 설정이 없으면 아무것도 하지 않는다(viz.ts 참고).
cron.schedule(
  "* * * * *",
  () => {
    runVizTick().catch((e) => logErr("[viz] tick error:", e));
  },
  { timezone: "Asia/Seoul" },
);

console.log("[bot] starting (long polling)...");
void bot.start();

// 텔레그램 API 연결 보온. 이게 없으면 몇 시간 만에 나가는 선톡이 매번 새 연결을 맺게 되는데,
// 이 VM에서는 그 '새 연결 수립'이 간헐적으로 죽어 선톡만 골라 유실됐다(bot.ts 참고).
keepConnectionWarm();

// 만들어 두고 기다리던 답장을 이어받는다. 회의가 세 시간이면 답장도 세 시간을 기다리므로,
// 그 사이에 배포가 한 번만 있어도 타이머는 사라진다 — 행으로 남겨 둔 것을 다시 건다.
resumePendingReplies();

// 재시작(배포)으로 놓친 답장 복구: 디바운스 대기 중 프로세스가 죽으면 그 답장은 영영 사라지므로,
// 부팅 후 한 번 확인해 이어서 답한다. 폴링이 밀린 메시지를 먼저 받도록 잠깐 기다렸다가 실행.
setTimeout(() => {
  recoverMissedReplies().catch((e) => logErr("[recover] error:", e));
}, 8000);
