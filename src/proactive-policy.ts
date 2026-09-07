// 선제 발화 관제탑 — 오늘 먼저 연락해도 되는지, 무엇을 보낼지 한곳에서 정한다.
//
// silenceState가 유저가 답하지 않은 논리일 수를 세어 단계를 매긴다(normal·quiet·checkin·
// dormant). dailySendPlan은 그날 미리 만들어 둘 종류 하나를 고른다(morning·checkin·none) —
// 새벽에 문안을 준비할 때, 반영 게이트에서, 발송 직전 재확인에서 모두 이 함수를 부른다.
// 세 자리가 각자 판단하면 준비한 것과 보내는 것이 어긋난다.
//
// 유저 메시지가 오면 즉시 평상으로 돌아온다.
//
// 발송에 실패한 선톡 문안을 다음 틱까지 들고 있는 자리도 여기다(holdFailedDraft·
// takeHeldDraft). 무엇을 보낼지 정하는 곳과 같은 자리라, 조건이 아직 맞으면 모델을 다시
// 부르지 않고 만들어 둔 문안부터 보낸다.

import {
  countAssistantMeta,
  getCharacterById,
  hasAssistantMeta,
  hasUserScheduleOn,
  lastUserTs,
} from "./db.js";
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
// 캐릭터 서사와도 맞다: 매달리지 않는다는 공통 선(ADR-0012)의 자연스러운 행동.

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

// 선톡 메시지의 meta_json을 고르는 LIKE 패턴. 선톡은 전부 proactive를, 종류는 kind를 달고 저장된다.
const PROACTIVE = "%proactive%";
const AWAY = '%"kind":"away"%';
const kindPattern = (kind: string): string => `%"kind":"${kind}"%`;

export const silenceState = (
  chatId: string,
  characterId: number,
): SilenceState => {
  // 유저 메시지가 아직 없으면 관계 시작 시점을 기준으로 센다(첫 인사 후 무응답도 백오프 대상)
  const anchor = lastUserTs(chatId) ?? getCharacterById(characterId)?.created_at;
  if (!anchor) return { tier: "normal", days: 0 };

  const days = Math.max(
    0,
    daysBetween(logicalDateOf(anchor), kstLogicalDate()),
  );

  if (days < QUIET_AFTER_DAYS) return { tier: "normal", days };
  if (days < RECONNECT_AT_DAYS) return { tier: "quiet", days };
  // 안부 선톡이 실제로 나갔는가 — 마지막 유저 메시지 이후 kind=checkin 발화가 있으면 dormant
  const sent = hasAssistantMeta(chatId, anchor, {
    after: true,
    like: [kindPattern("checkin")],
  });
  return { tier: sent ? "dormant" : "checkin", days };
};

// 팔로업·자리비움 예고 등 일반 선제 발화가 허용되는가 — normal일 때만
export const proactiveAllowed = (
  chatId: string,
  characterId: number,
): boolean => silenceState(chatId, characterId).tier === "normal";


// 미리 만들어 두는 선톡(아침·안부)을 그날 무엇으로 보낼지 정한다. 새벽 정리의 문안 준비,
// 반영 직전 확인, 발송 직전 재확인이 같은 판정을 쓰도록 한곳에 둔다.
//
//   어제 대화함 · 1일째  아침에 한 통
//   2일째               아침에 한 통. 점심 한 통이 더 나가는데 그건 아래 lunchDueToday가 정한다
//   3~13일째            없음. 유저가 말해 둔 유저의 일정이 있는 날만 아침에 한 통
//   14일째              저녁에 안부 선톡 한 통
//   15일째부터          없음
//
// 14일째 한 통은 실제로 나갈 때까지 매일 다시 시도한다 — 그날 전송에 실패했다고 침묵으로
// 넘어가면 관계를 닫는 마지막 한 통이 통째로 사라진다.
export type PreparedSendKind = "morning" | "checkin" | "none";

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
  return { ...base, kind: "morning", reason: "아침에 한 통" };
};

// 오늘 점심에도 한 통 보내는 날인가 — 무응답 이틀째. 아침 한 통은 예약 행으로 나가고 이 한
// 통이 더 붙어, 그날 연락은 아침·점심 둘이다(이슈 #314).
//
// 이 통은 미리 만들어 두지 않고 팔로업 틱이 점심 창 안에서 그때의 각본을 보고 만든다. 새벽에
// 써 두면 점심에 무엇을 하고 있는지 계획으로만 알고 쓰게 되고, 예약 행은 하루 한 통이라
// 아침 문안과 자리를 다툰다.
export const lunchDueToday = (chatId: string, characterId: number): boolean => {
  const { tier, days } = silenceState(chatId, characterId);
  return tier === "normal" && days >= 2;
};

// 발송에 실패한 선톡 문안을 다음 틱까지 들고 있는 자리.
//
// 문안을 만든 직후에 발송이 실패하면 지금까지는 그 문안을 버렸다. 그러면 다음 틱이 같은 조건을
// 다시 만나 모델을 한 번 더 부르고, 길이 아직 안 열렸으니 또 실패한다 — 밤 인사가 15분 간격으로
// 세 번 그렇게 나갔다. 만들어 둔 것을 들고 있다가 그 자리가 아직 유효하면 모델 없이 그대로 다시
// 보낸다. 아침 선톡만 이런 날 살아남는 이유가 문안을 행에 적어 두고 틱마다 다시 보내서다.
//
// 표를 새로 만들지 않고 메모리에 채팅별로 마지막 하나만 든다. 프로세스가 다시 뜨면 잊는데,
// 그때는 조건도 대개 지나 있고 잃는 것은 문안 하나다.
//
// 자리가 유효한지는 두 겹으로 본다. 하나는 종류다 — 같은 종류의 자리에 다시 왔을 때만 꺼내
// 쓴다. 밤 인사처럼 창이 닫히는 문안은 부르는 쪽(followup·presence)이 창·침묵 조건을 이미
// 다시 확인한 뒤라, 그 자리에 다시 왔다는 것 자체가 창 안이라는 뜻이다. 자리 비움 예고는
// 활동 블록까지 같아야 한다 — 다음 블록의 예고를 앞 블록 문안으로 보내면 엉뚱한 말이 나간다.
// 다른 하나는 나이다. 만든 지 오래된 문안은 지금 상황을 더 이상 말하지 못하므로 버린다.

export type HeldDraftKind = "goodnight" | "mend" | "catchup" | "lunch" | "away";

export interface HeldDraft {
  kind: HeldDraftKind;
  /** 보낼 문안 본문. 말풍선 나누기는 발송하는 쪽이 한다. */
  text: string;
  /** 자리 비움 예고만 채운다 — 같은 활동 블록에서만 다시 보낸다(블록 시작 시각). */
  block?: string;
  /** 문안을 만든 시각(ms). 오래되면 버린다. */
  madeAt: number;
}

// 들고 있는 시간의 상한. 팔로업 틱이 15분이라 한 번, 자리 비움 틱이 10분이라 두 번까지
// 다시 보내고 그 뒤로는 버린다. 더 늘리면 "지금 ~하는 중"이라고 쓴 문안이 지난 일을 말한다.
const HELD_DRAFT_MAX_MS = 20 * 60_000;

const heldDrafts = new Map<string, HeldDraft>();

/** 발송에 실패한 문안을 다음 틱까지 들고 있는다. 만든 시각은 그대로 둔다 — 나이로 버리므로. */
export const holdFailedDraft = (chatId: string, draft: HeldDraft): void => {
  heldDrafts.set(chatId, draft);
  console.log(`[proactive] ${draft.kind} 문안 보관 — 다음 틱에 다시 보낸다`);
};

/**
 * 이 자리에서 다시 보낼 문안을 꺼낸다. 없거나 조건이 지났으면 null이고, 꺼낸 것은 지운다.
 *
 * 같은 종류인데 자리가 달라졌으면(자리 비움 예고의 블록이 바뀌었으면) 그 문안은 이제 쓸 데가
 * 없으니 버린다. 다른 종류의 자리에서 물어본 것이면 그대로 둔다 — 자리 비움 틱(10분)이
 * 밤 인사 문안을 대신 버리면, 정작 그 문안을 보낼 팔로업 틱(15분)이 빈손으로 온다.
 */
export const takeHeldDraft = (
  chatId: string,
  kind: HeldDraftKind,
  block?: string,
): HeldDraft | null => {
  const d = heldDrafts.get(chatId);
  if (!d) return null;
  if (Date.now() - d.madeAt > HELD_DRAFT_MAX_MS) {
    heldDrafts.delete(chatId);
    console.log(`[proactive] ${d.kind} 보관 문안 버림 — 만든 지 오래됐다`);
    return null;
  }
  if (d.kind !== kind) return null;
  if (d.block !== block) {
    heldDrafts.delete(chatId);
    console.log(`[proactive] ${d.kind} 보관 문안 버림 — 그 자리가 지났다`);
    return null;
  }
  heldDrafts.delete(chatId);
  return d;
};

// ── 선제 발화 카운터 ──────────────────────────────────────────────────────
// 캐릭터 말의 meta_json으로 무엇이 선톡이고 어떤 종류인지 가른다. 패턴은 여기서만 정하고
// db 쪽은 패턴을 받아 세기만 한다.


// 오늘(새벽 5시 이후) 캐릭터가 먼저 보낸 선톡 수 — 하루 총량 상한을 지키는 데 쓴다.
// followup·dispatch가 공유한다. 채널별 상한만 있으면 합이 통제되지 않아서, 각자 자기 몫을
// 다 쓰면 하루 10통까지 나갈 수 있었다.
//
// 자리비움 선톡은 여기서 뺀다 — 캐릭터가 나갔다 오는 일정 수만큼 나가는 말이라 성격이
// 다르고, 그쪽은 AWAY_DAILY_MAX가 따로 막는다. 약속 연락도 뺀다 — 답장에서 한 약속을
// 지키는 말이라 상한에 막히면 약속을 어기는 쪽이 된다(이슈 #308).
export const proactiveCountToday = (chatId: string, since: string): number =>
  countAssistantMeta(chatId, since, {
    like: [PROACTIVE],
    notLike: [AWAY, kindPattern("promise")],
  });

// 오늘 보낸 선톡을 종류별로 센다.
export const proactiveKindCountToday = (
  chatId: string,
  since: string,
  kind: string,
): number => countAssistantMeta(chatId, since, { like: [kindPattern(kind)] });

/** 그 블록의 자리 비움 예고가 오늘 이미 나갔는가.
 *  두 자리가 같은 질의를 쓴다 — 예고를 두 번 보내지 않게 막는 presence, 예고한 일정으로
 *  곧 들어가는지 보는 bot의 배웅 답 판단. */
export const awayNoticeSent = (
  chatId: string,
  since: string,
  blockStart: string,
): boolean =>
  hasAssistantMeta(chatId, since, {
    like: [AWAY, `%"block":"${blockStart}"%`],
  });

// 오늘 알리고 나간 자리비움 선톡 수. 돌아와서 하는 인사는 이미 알린 구간을 마무리하는
// 말이라 빼고 센다.
export const awayNoticeCountToday = (chatId: string, since: string): number =>
  countAssistantMeta(chatId, since, { like: [AWAY], notLike: ['%"return"%'] });

// 마지막 유저 발화 이후 구간의 시작. 유저가 한 번도 말한 적이 없으면 대화 전체를 본다.
const sinceLastUser = (chatId: string): string =>
  lastUserTs(chatId) ?? "0000-00-00 00:00:00";

// 마지막 유저 메시지 이후 캐릭터가 먼저 보낸(proactive) 수 — '연속 무응답'을 세어 매달림을 막는다.
export const proactiveSinceLastUser = (chatId: string): number =>
  countAssistantMeta(chatId, sinceLastUser(chatId), {
    after: true,
    like: [PROACTIVE],
  });

/** 그 시각 이후 달래기 선톡이 이미 나갔는가 — 상대 상태 한 발현에 한 통이다. 기준 시각은
 * 관계 행의 상태 시작 시각(user_state_since)이고, 그 상태가 이어지는 동안 자리 비움 예고가
 * 끼어도 구간을 통째로 보므로 가려지지 않는다. */
export const mendSentSince = (chatId: string, since: string): boolean =>
  hasAssistantMeta(chatId, since, {
    after: true,
    like: [kindPattern("mend")],
  });
