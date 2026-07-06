import cron from "node-cron";
import { bot } from "./bot.js";

// 시스템의 심장 — 대화 밖 시간을 만드는 크론 2개
// TODO(밤 일기): 하루 대화 응고 → diary_entries + 관계 상태 패치 (오픈 루프·our_dict). 무대화 날에도 자기 하루 기록
cron.schedule(
  "30 23 * * *",
  () => {
    console.log("[cron] 밤 일기 — TODO");
  },
  { timezone: "Asia/Seoul" },
);

// TODO(아침 안부): 어제 일기의 ask_tomorrow / due 오픈 루프 있을 때만 선제 발송. 08:30~09:10 지터는 이 슬롯에서 setTimeout으로
cron.schedule(
  "30 8 * * *",
  () => {
    console.log("[cron] 아침 안부 — TODO");
  },
  { timezone: "Asia/Seoul" },
);

console.log("[bot] starting (long polling)...");
void bot.start();
