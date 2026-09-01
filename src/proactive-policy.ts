import { db, hasUserScheduleOn } from "./db.js";
import { kstLogicalDate, logicalDateOf } from "./kst.js";
import { QUIET_AFTER_DAYS, RECONNECT_AT_DAYS } from "./thresholds.js";

// 선제 발화 정책(관제탑): "지금 이 유저에게 먼저 말을 걸어도 되는가"의 단일 판단 지점.
// 채널(아침 안부·팔로업·자리비움 예고)은 각자의 트리거만 갖고, 발화 허가는 여기서 받는다.
//
// 첫 정책 = 침묵 백오프. 유저가 며칠째 무응답인데 매일 아침 안부에 자리비움 예고까지 이어지는 건
// 비용 낭비이자 사람 같지 않다 — 사람은 답 없는 상대에게 매일 같은 텐션으로 연락하지 않는다.
// (실측: 최근 19일 중 침묵일 10일, 그 날들에도 선톡이 평균 2.1통 나갔다)
//
//   normal    무응답 0~2일  — 대화 중에 보내는 선톡도 그대로 나간다
//   quiet     3~13일        — 조용. 그날 유저에게 일정이 있으면 아침 한 통만 예외
//   checkin 14일~           — "요새 많이 바빠?" 결의 저녁 안부 선톡 1통만
//   dormant   안부에도 무응답 — 유저가 돌아올 때까지 완전 침묵
//
// 유저 메시지가 오는 순간 어느 단계든 normal로 돌아간다(매번 새로 계산하므로 자동).
// 캐릭터 서사와도 맞다: 안정형·매달리지 않음 stance의 자연스러운 행동.

export type SilenceTier = "normal" | "quiet" | "checkin" | "dormant";

export interface SilenceState {
  tier: SilenceTier;
  days: number; // 마지막 유저 메시지 이후 경과 논리일 수
}

const daysBetween = (a: string, b: string): number =>
  Math.round(
    (new Date(`${b}T00:00:00Z`).getTime() -
      new Date(`${a}T00:00:00Z`).getTime()) /
      86_400_000,
  );

export const silenceState = (
  chatId: string,
  characterId: number,
): SilenceState => {
  const lastUser = db
    .prepare(
      `SELECT sent_at FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1`,
    )
    .get(chatId) as { sent_at: string } | undefined;
  // 유저 메시지가 아직 없으면 관계 시작 시점을 기준으로 센다(첫 인사 후 무응답도 백오프 대상)
  const anchor =
    lastUser?.sent_at ??
    (
      db
        .prepare(`SELECT created_at FROM characters WHERE id = ?`)
        .get(characterId) as { created_at: string } | undefined
    )?.created_at;
  if (!anchor) return { tier: "normal", days: 0 };

  const days = Math.max(
    0,
    daysBetween(logicalDateOf(anchor), kstLogicalDate()),
  );

  if (days < QUIET_AFTER_DAYS) return { tier: "normal", days };
  if (days < RECONNECT_AT_DAYS) return { tier: "quiet", days };
  // 안부 선톡이 실제로 나갔는가 — 마지막 유저 메시지 이후 kind=checkin 발화가 있으면 dormant
  const sent = db
    .prepare(
      `SELECT 1 FROM messages WHERE chat_id = ? AND sent_at > ? AND meta_json LIKE '%"kind":"checkin"%' LIMIT 1`,
    )
    .get(chatId, anchor);
  return { tier: sent ? "dormant" : "checkin", days };
};

// 팔로업·자리비움 예고 등 일반 선제 발화가 허용되는가 — normal일 때만
export const proactiveAllowed = (
  chatId: string,
  characterId: number,
): boolean => silenceState(chatId, characterId).tier === "normal";


// 미리 만들어 두는 선톡(아침·점심·안부)을 그날 무엇으로 보낼지 정한다. 새벽 정리의 문안
// 준비, 반영 직전 확인, 발송 직전 재확인이 같은 판정을 쓰도록 한곳에 둔다.
//
//   어제 대화함 · 1일째  아침에 한 통
//   2일째               아침은 거르고 점심에 한 통
//   3~13일째            없음. 유저가 말해 둔 유저의 일정이 있는 날만 아침에 한 통
//   14일째              저녁에 안부 선톡 한 통
//   15일째부터          없음
//
// 14일째 한 통은 실제로 나갈 때까지 매일 다시 시도한다 — 그날 전송에 실패했다고 침묵으로
// 넘어가면 관계를 닫는 마지막 한 통이 통째로 사라진다.
export type PreparedSendKind = "morning" | "lunch" | "checkin" | "none";

export interface DailySendPlan {
  kind: PreparedSendKind;
  reason: string; // 로그와 건너뛴 사유에 그대로 쓴다
  tier: SilenceTier;
  days: number;
}

export const dailySendPlan = (
  chatId: string,
  characterId: number,
  date: string,
): DailySendPlan => {
  const { tier, days } = silenceState(chatId, characterId);
  const base = { tier, days };
  if (tier === "checkin")
    return { ...base, kind: "checkin", reason: `무응답 ${days}일, 안부 선톡` };
  if (tier === "dormant")
    return {
      ...base,
      kind: "none",
      reason: `무응답 ${days}일, 안부 선톡에도 답이 없어 조용`,
    };
  if (tier === "quiet")
    return hasUserScheduleOn(characterId, date)
      ? {
          ...base,
          kind: "morning",
          reason: `무응답 ${days}일이지만 오늘 상대 일정이 있어 아침에 한 통`,
        }
      : { ...base, kind: "none", reason: `무응답 ${days}일, 조용` };
  if (days >= 2)
    return {
      ...base,
      kind: "lunch",
      reason: `무응답 ${days}일, 아침 대신 점심에 한 통`,
    };
  return { ...base, kind: "morning", reason: "아침에 한 통" };
};
