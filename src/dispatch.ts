import {
  getPendingSends,
  markScheduledSend,
  hasUserMessageSince,
} from "./db.js";
import { sendProactive } from "./bot.js";
import { getKstNow, kstClock, kstDateString } from "./kst.js";

// 선톡 디스패처: LLM 콜 없이, 밤 정리가 준비해둔 문안을 발송 창 안에서 내보내는 틱.
// 유저가 오늘 이미 먼저 말을 걸었다면 보내지 않는다 — 선톡은 침묵을 여는 용도이고,
// 이미 열린 대화에서는 오픈 루프가 컨텍스트로 자연스럽게 이어지기 때문.

const stamp = (): string =>
  `${kstDateString()} ${getKstNow().toISOString().slice(11, 19)}`;

export const runDispatchTick = async (): Promise<void> => {
  const today = kstDateString();
  const now = kstClock();
  for (const r of getPendingSends(today)) {
    if (now > r.window_end) {
      markScheduledSend(r.id, "skipped", "발송 창 지남", null);
      continue;
    }
    if (now < r.window_start) continue;
    if (hasUserMessageSince(r.chat_id, `${today} 05:00:00`)) {
      markScheduledSend(r.id, "skipped", "유저가 오늘 먼저 연락함", null);
      continue;
    }
    try {
      await sendProactive(r.chat_id, r.character_id, r.text, "morning");
      markScheduledSend(r.id, "sent", null, stamp());
      console.log(`[dispatch] sent #${r.id} to ${r.chat_id}`);
    } catch (e) {
      console.error("[dispatch] send error:", e);
    }
  }
};
