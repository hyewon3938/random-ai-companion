import { db } from "./db.js";
import { kstDateString } from "./kst.js";

// 선제 발화 정책(관제탑): "지금 이 유저에게 먼저 말을 걸어도 되는가"의 단일 판단 지점.
// 채널(아침 안부·팔로업·자리비움 예고)은 각자의 트리거만 갖고, 발화 허가는 여기서 받는다.
//
// 첫 정책 = 침묵 백오프. 유저가 며칠째 무응답인데 매일 아침 안부에 자리비움 예고까지 이어지는 건
// 비용 낭비이자 사람 같지 않다 — 사람은 답 없는 상대에게 매일 같은 텐션으로 연락하지 않는다.
// (실측: 최근 19일 중 침묵일 10일, 그 날들에도 선톡이 평균 2.1통 나갔다)
//
//   normal    무응답 0~2일  — 현행 그대로 (낮 팔로업은 taper가 이미 조인다)
//   quiet     3~13일        — 전면 조용. 문안 생성도 발송도 하지 않는다
//   checkin 14일~           — "요새 많이 바빠?" 결의 저녁 안부 선톡 1통만
//   dormant   재연결도 무응답 — 유저가 돌아올 때까지 완전 침묵
//
// 유저 메시지가 오는 순간 어느 단계든 normal로 돌아간다(매번 새로 계산하므로 자동).
// 캐릭터 서사와도 맞다: 안정형·매달리지 않음 stance의 자연스러운 행동.

export type SilenceTier = "normal" | "quiet" | "checkin" | "dormant";

export interface SilenceState {
  tier: SilenceTier;
  days: number; // 마지막 유저 메시지 이후 경과 논리일 수
}

const QUIET_AFTER_DAYS = 3; // 무응답 3일차부터 조용
const RECONNECT_AT_DAYS = 14; // 14일차부터 재연결 1통 (발송될 때까지 매일 재시도)

// ts(KST 벽시계 "YYYY-MM-DD HH:MM:SS")의 논리일(새벽 5시 컷오프)
const logicalDayOf = (ts: string): string => {
  const epoch = new Date(ts.replace(" ", "T") + "+09:00").getTime();
  return kstDateString(new Date(epoch + 9 * 3600_000 - 5 * 3600_000));
};

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

  const nowLogical = kstDateString(
    new Date(Date.now() + 9 * 3600_000 - 5 * 3600_000),
  );
  const days = Math.max(0, daysBetween(logicalDayOf(anchor), nowLogical));

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
