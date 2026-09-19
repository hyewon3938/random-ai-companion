// 아침·안부 선톡을 창 안에 내보내는 자리(3분 틱).
//
// 밤에 준비해 둔 문안을 발송 창 안에서 보낸다. 모델을 부르지 않는다. 유저가 최근 4시간 안에
// 먼저 연락했으면 보내지 않고, 관제탑이 그날 보낼 종류로 지목하지 않아도 보내지 않는다.
//
// 문안은 연락 예약 표(outbox)의 아침·안부 행이다(이슈 #476). 창을 놓치면 행의 만료 시각까지
// 보내고(창 종료 +90분, 시간대별 상한 11·14·22시, kst.ts의 sendDeadline), 넘기면 시도했는지에
// 따라 실패나 폐기로 닫는다. 보내지 않은 행은 상태와 사유를 함께 적는다. 보낼 때는 행 번호를
// 발송 기록의 scheduled_id로 함께 적는다.
//
// 이 한 통의 근거는 일정이고, 오늘의 관계 의도는 문안을 쓸 때 이미 들어갔다 — 새벽 정리가
// 아침 문안의 상황 문단에 네 줄을 넣고 이어갈 자리나 파고들 것 하나만 엮게 한다
// (prompts/nightly의 morningSituation, 설계 원본 §4). 여기서는 그 문안을 내보내기만 한다.
//
// 하루 합계 상한은 따로 보지 않는다. 논리일이 새벽 5시에 시작하니 이 한 통이 그날의 첫
// 선톡이고, 유예로 낮까지 밀린 날에도 그 앞에 올 수 있는 합계 종류는 점심 한 통뿐이라
// (의도·근황은 발송 대기 중인 문안이 있으면 물러난다) 가장 낮은 상한 4에도 닿지 않는다.

import {
  bumpOutboxAttempt,
  closeOutboxRow,
  getPendingSends,
  hasUserMessageSince,
  markOutboxDelivered,
} from "./db.js";
import {
  sendProactive,
  acquireProactive,
  releaseProactive,
  logErr,
} from "./bot.js";
import { dailySendPlan } from "./proactive-policy.js";
import { noOverlap } from "./proactive-send.js";
import {
  kstClock,
  kstDateString,
  kstStamp,
  kstStampBefore,
  sendDeadline,
} from "./kst.js";
import { RECENT_USER_MS } from "./thresholds.js";

// 선톡 디스패처: LLM 콜 없이, 밤 정리가 준비해둔 문안을 발송 창 안에서 내보내는 틱.
// 유저가 오늘 이미 먼저 말을 걸었다면 보내지 않는다 — 선톡은 침묵을 여는 용도이고,
// 이미 열린 대화에서는 오픈 루프가 컨텍스트로 자연스럽게 이어지기 때문.

// 유저가 방금까지 대화 중이었는지는 RECENT_USER_MS 창으로 본다. 논리일(새벽 5시) 기준으로
// 재면 유저가 새벽 4시에 말을 걸었을 때 그 대화가 어제로 들어가, 세 시간 뒤 아침 선톡이
// 그대로 나간다.

// 틱이 겹치지 않게 — 재시도 간격을 넓히면서 한 틱이 최대 ~130초까지 붙잡힐 수 있게 됐고,
// 틱 간격도 짧아졌다. 겹치면 같은 행을 두 틱이 집어 이중 발송이 된다.
export const runDispatchTick = noOverlap(async () => {
  const today = kstDateString();
  const now = kstClock();
  for (const r of getPendingSends(today)) {
    if (now < r.window_start) continue;

    // 발송 직전 재확인(관제탑): 밤에 정한 종류가 지금도 맞는지 본다. 문안 준비 단계에서
    // 이미 같은 판정을 거쳤지만, 날짜 경계를 넘긴 문안을 거르는 이중 가드다.
    const plan = dailySendPlan(r.chat_id, r.character_id, today);
    const allowed =
      r.kind === "checkin" ? plan.kind === "checkin" : plan.kind === "morning";
    if (!allowed) {
      closeOutboxRow(r.id, "skipped", "off_day", plan.reason, null);
      continue;
    }

    // 마감은 문안을 적을 때 행의 만료 시각으로 넣어 둔다. 비어 있는 행은 없지만, 있으면 같은
    // 계산으로 채운다.
    const deadline = r.expires_at
      ? r.expires_at.slice(11, 16)
      : sendDeadline(r.window_start, r.window_end);
    if (now > deadline) {
      // 시도 흔적이 있으면 전송 실패로 죽은 것, 없으면 창 자체를 못 잡은 것 — 상태를 가른다.
      if (r.attempts > 0)
        closeOutboxRow(
          r.id,
          "failed",
          "retries_exhausted",
          `마감(${deadline})까지 전송 실패 — ${r.attempts}회 시도`,
          null,
        );
      else
        closeOutboxRow(
          r.id,
          "dropped",
          "expired",
          `발송 창 지남 (시도 없음, 마감 ${deadline})`,
          null,
        );
      console.warn(
        `[dispatch] 폐기 #${r.id} attempts=${r.attempts} deadline=${deadline}`,
      );
      continue;
    }

    if (
      hasUserMessageSince(
        r.chat_id,
        r.character_id,
        kstStampBefore(RECENT_USER_MS),
      )
    ) {
      closeOutboxRow(r.id, "skipped", "user_first", null, null);
      continue;
    }

    const late = now > r.window_end;
    // 다른 선톡 틱·답장이 이 chat에 진행 중이면 다음 틱으로 미룬다(겹쳐 나가지 않게)
    if (!acquireProactive(r.chat_id)) continue;
    try {
      const { delivered, total } = await sendProactive(
        r.chat_id,
        r.character_id,
        r.text,
        r.kind === "checkin" ? "checkin" : "morning",
        // 예약 행 번호를 발송 기록에 남긴다. 슬랙 발송 게시가 이 번호를 키로 달아서, 그 게시에
        // 남긴 피드백이 어느 예약 문안이었는지 되짚는다(이슈 #451).
        { scheduled_id: r.id },
      );
      const notes = [
        late ? `유예 발송 (창 종료 ${r.window_end} 이후)` : null,
        delivered < total ? `부분 발송 ${delivered}/${total}` : null,
        r.attempts > 0 ? `${r.attempts}회 실패 후 성공` : null,
      ].filter(Boolean);
      markOutboxDelivered(
        r.id,
        delivered < total ? "partial" : "sent",
        notes.length ? notes.join(" / ") : null,
        kstStamp(),
      );
      console.log(
        `[dispatch] sent #${r.id} to ${r.chat_id}${late ? " (유예)" : ""}`,
      );
    } catch (e) {
      // 상태는 대기 그대로 — 마감 전이면 다음 틱이 다시 시도한다. 실패 흔적만 행에 남긴다.
      bumpOutboxAttempt(r.id, e instanceof Error ? e.message : String(e));
      logErr(`[dispatch] send error #${r.id}:`, e);
    } finally {
      releaseProactive(r.chat_id);
    }
  }
});
