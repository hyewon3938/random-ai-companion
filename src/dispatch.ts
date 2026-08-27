import {
  getPendingSends,
  markScheduledSend,
  recordSendAttempt,
  hasUserMessageSince,
} from "./db.js";
import {
  sendProactive,
  acquireProactive,
  releaseProactive,
  logErr,
} from "./bot.js";
import { silenceState } from "./proactive-policy.js";
import { getKstNow, kstClock, kstDateString } from "./kst.js";

// 선톡 디스패처: LLM 콜 없이, 밤 정리가 준비해둔 문안을 발송 창 안에서 내보내는 틱.
// 유저가 오늘 이미 먼저 말을 걸었다면 보내지 않는다 — 선톡은 침묵을 여는 용도이고,
// 이미 열린 대화에서는 오픈 루프가 컨텍스트로 자연스럽게 이어지기 때문.

const stamp = (): string =>
  `${kstDateString()} ${getKstNow().toISOString().slice(11, 19)}`;

// 유저가 방금까지 대화 중이었는지를 보는 창. 논리일(새벽 5시) 기준으로 재면 유저가 새벽 4시에
// 말을 걸었을 때 그 대화가 어제로 들어가, 세 시간 뒤 아침 선톡이 그대로 나간다.
const RECENT_USER_MS = 4 * 60 * 60 * 1000;

const stampBefore = (ms: number): string => {
  const t = new Date(getKstNow().getTime() - ms);
  return `${kstDateString(t)} ${t.toISOString().slice(11, 19)}`;
};

const addMin = (hhmm: string, m: number): string => {
  const [h, mm] = hhmm.split(":").map(Number);
  const t = Math.min(23 * 60 + 59, (h ?? 0) * 60 + (mm ?? 0) + m);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

// 유예: 네트워크 실패로 창을 놓쳐도 그날 안에 늦게라도 보낸다.
//
// 다만 문안은 '아침'이 아니라 특정 순간에 맞춰 쓰였다 — 밤 정리가 하루 각본의 기상·출근·자리
// 시각을 앵커로 잡고 "막 일어난 참" / "출근길" / "자리에 앉아 한숨 돌린 참" 중 하나로 쓰게 한다
// (nightly.ts의 morningAnchors). 그래서 무한정 늦출 수 없고 두 겹으로 잡는다:
//   - 창 종료 +90분: 앵커에서 너무 멀어지지 않게. 06:15 기상 문안은 아무리 늦어도 08:40까지.
//   - 시간대별 절대 상한: 늦은 앵커(09:50 시작)의 문안이 점심까지 밀리지 않게.
// 둘 중 이른 쪽이 마감이고, 넘기면 폐기하되 왜 폐기됐는지를 행에 남긴다.
const GRACE_MIN = 90;

const hardCap = (windowStart: string): string =>
  windowStart < "11:00" ? "11:00" : windowStart < "15:00" ? "14:00" : "22:00";

const graceUntil = (windowStart: string, windowEnd: string): string => {
  const soft = addMin(windowEnd, GRACE_MIN);
  const cap = hardCap(windowStart);
  const d = soft < cap ? soft : cap;
  // 디스패처 크론은 6시부터 돈다 — 아주 이른 기상 문안(새벽 창)이 첫 틱 전에 만료되지 않게 하한
  return d < "06:30" ? "06:30" : d;
};

// 틱이 겹치지 않게 — 재시도 봉투를 넓히면서 한 틱이 최대 ~100초까지 붙잡힐 수 있게 됐고,
// 틱 간격도 짧아졌다. 겹치면 같은 행을 두 틱이 집어 이중 발송이 된다.
let running = false;

export const runDispatchTick = async (): Promise<void> => {
  if (running) return;
  running = true;
  try {
    const today = kstDateString();
    const now = kstClock();
    for (const r of getPendingSends(today)) {
      if (now < r.window_start) continue;

      // 침묵 백오프(관제탑): 무응답이 길어진 유저에겐 아침 안부를 보내지 않는다.
      // 문안 생성 단계(밤 정리)에서 이미 걸러지지만, 경계일에 걸친 문안을 위한 이중 가드.
      // 안부 선톡(kind=checkin) 문안은 백오프 그 자체이므로 이 게이트를 지나간다.
      if (r.kind !== "checkin") {
        const st = silenceState(r.chat_id, r.character_id);
        if (st.tier !== "normal") {
          markScheduledSend(
            r.id,
            "skipped",
            `침묵 백오프 (무응답 ${st.days}일, ${st.tier})`,
            null,
          );
          continue;
        }
      }

      const deadline = graceUntil(r.window_start, r.window_end);
      if (now > deadline) {
        // 시도 흔적이 있으면 전송 실패로 죽은 것, 없으면 창 자체를 못 잡은 것 — 사유를 가른다.
        markScheduledSend(
          r.id,
          "skipped",
          r.attempts > 0
            ? `유예(${deadline})까지 전송 실패 — ${r.attempts}회 시도`
            : `발송 창 지남 (시도 없음, 유예 ${deadline})`,
          null,
        );
        console.warn(
          `[dispatch] 폐기 #${r.id} attempts=${r.attempts} deadline=${deadline}`,
        );
        continue;
      }

      if (hasUserMessageSince(r.chat_id, stampBefore(RECENT_USER_MS))) {
        markScheduledSend(r.id, "skipped", "유저가 먼저 연락함", null);
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
        );
        const notes = [
          late ? `유예 발송 (창 종료 ${r.window_end} 이후)` : null,
          delivered < total ? `부분 발송 ${delivered}/${total}` : null,
          r.attempts > 0 ? `${r.attempts}회 실패 후 성공` : null,
        ].filter(Boolean);
        markScheduledSend(
          r.id,
          "sent",
          notes.length ? notes.join(" / ") : null,
          stamp(),
        );
        console.log(
          `[dispatch] sent #${r.id} to ${r.chat_id}${late ? " (유예)" : ""}`,
        );
      } catch (e) {
        // 상태는 pending 그대로 — 마감 전이면 다음 틱이 다시 시도한다. 실패 흔적만 행에 남긴다.
        recordSendAttempt(r.id, e instanceof Error ? e.message : String(e));
        logErr(`[dispatch] send error #${r.id}:`, e);
      } finally {
        releaseProactive(r.chat_id);
      }
    }
  } finally {
    running = false;
  }
};
