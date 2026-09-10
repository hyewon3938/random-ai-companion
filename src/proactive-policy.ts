// 선제 발화 관제탑 — 오늘 먼저 연락해도 되는지, 무엇을 보낼지 한곳에서 정한다.
//
// silenceState가 유저가 답하지 않은 논리일 수를 세어 단계를 매긴다(normal·quiet·checkin·
// dormant). dailySendPlan은 그날 미리 만들어 둘 종류 하나를 고른다(morning·checkin·none) —
// 새벽에 문안을 준비할 때, 반영 게이트에서, 발송 직전 재확인에서 모두 이 함수를 부른다.
// 세 자리가 각자 판단하면 준비한 것과 보내는 것이 어긋난다.
//
// 선톡은 근거 종류 넷 가운데 하나를 반드시 갖는다(의도·일정·달래기·약속). 종류마다 어떤
// 근거로 나가는지는 PROACTIVE_BASIS가 갖고, 하루에 몇 통까지인지는 단계별 예산이 정한다
// (proactiveBudget·budgetAllows). 합계에 안 들어가는 종류는 상대가 이미 말을 걸었거나
// 캐릭터가 자리를 비우는 상황에 붙는 한 마디라 새로 거는 연락과 성격이 다르다.
//
// 유저 메시지가 오면 즉시 평상으로 돌아온다.
//
// 발송에 실패한 선톡 문안을 다음 틱까지 들고 있는 자리도 여기다(holdFailedDraft·
// takeHeldDraft). 무엇을 보낼지 정하는 곳과 같은 자리라, 조건이 아직 맞으면 모델을 다시
// 부르지 않고 만들어 둔 문안부터 보낸다.

import {
  countAssistantMeta,
  getAssistantMetaSince,
  getCharacterById,
  getStage,
  hasAssistantMeta,
  hasUserScheduleOn,
  lastUserTs,
} from "./db.js";
import { kstLogicalDate, logicalDateOf } from "./kst.js";
import {
  INTENT_LINE_NAME,
  PROACTIVE_KIND_NAME,
  type IntentLine,
  type ProactiveKind,
  type RelationshipStage,
} from "./labels.js";
import {
  PROACTIVE_STAGE_BUDGET,
  QUIET_AFTER_DAYS,
  RECONNECT_AT_DAYS,
} from "./thresholds.js";

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

// 하루 합계에서 빼는 종류의 meta_json 패턴. 무엇을 왜 빼는지는 아래 OFF_BUDGET이 갖는다 —
// 여기는 그 목록을 질의 조건으로 옮겨 적은 것이라 둘을 함께 고친다.
const OFF_BUDGET_META = [
  AWAY,
  kindPattern("promise"),
  kindPattern("mend"),
  kindPattern("care"),
  kindPattern("glance"),
];

export const silenceState = (
  chatId: string,
  characterId: number,
): SilenceState => {
  // 유저 메시지가 아직 없으면 관계 시작 시점을 기준으로 센다(첫 인사 후 무응답도 백오프 대상)
  const anchor =
    lastUserTs(chatId, characterId) ??
    getCharacterById(characterId)?.created_at;
  if (!anchor) return { tier: "normal", days: 0 };

  const days = Math.max(
    0,
    daysBetween(logicalDateOf(anchor), kstLogicalDate()),
  );

  if (days < QUIET_AFTER_DAYS) return { tier: "normal", days };
  if (days < RECONNECT_AT_DAYS) return { tier: "quiet", days };
  // 안부 선톡이 실제로 나갔는가 — 마지막 유저 메시지 이후 kind=checkin 발화가 있으면 dormant
  const sent = hasAssistantMeta(chatId, characterId, anchor, {
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

export type HeldDraftKind =
  | "goodnight"
  | "mend"
  | "care"
  | "catchup"
  | "lunch"
  | "away"
  | "glance"
  | "intent";

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

// 오늘(새벽 5시 이후) 캐릭터가 먼저 보낸 선톡 가운데 하루 합계에 드는 것의 수 — 단계별
// 합계 상한을 지키는 데 쓴다. followup·dispatch가 공유한다. 채널별 상한만 있으면 합이
// 통제되지 않아서, 각자 자기 몫을 다 쓰면 하루 10통까지 나갈 수 있었다.
//
// 무엇을 빼는지는 OFF_BUDGET이 갖는다. 여기서는 그 종류의 meta_json 패턴만 적는다 —
// 자리 비움은 나갈 때와 돌아왔을 때가 같은 kind라 패턴 하나가 둘을 함께 덮는다.
export const proactiveCountToday = (
  chatId: string,
  characterId: number,
  since: string,
): number =>
  countAssistantMeta(chatId, characterId, since, {
    like: [PROACTIVE],
    notLike: OFF_BUDGET_META,
  });

// 오늘 보낸 선톡을 종류별로 센다.
export const proactiveKindCountToday = (
  chatId: string,
  characterId: number,
  since: string,
  kind: string,
): number =>
  countAssistantMeta(chatId, characterId, since, { like: [kindPattern(kind)] });

/** 그 블록의 자리 비움 예고가 오늘 이미 나갔는가.
 *  두 자리가 같은 질의를 쓴다 — 예고를 두 번 보내지 않게 막는 presence, 예고한 일정으로
 *  곧 들어가는지 보는 bot의 배웅 답 판단. */
export const awayNoticeSent = (
  chatId: string,
  characterId: number,
  since: string,
  blockStart: string,
): boolean =>
  hasAssistantMeta(chatId, characterId, since, {
    like: [AWAY, `%"block":"${blockStart}"%`],
  });

/** 그 블록의 틈새 한 줄이 오늘 이미 나갔는가. 블록마다 한 번이다(이슈 #339). */
export const glanceSentForBlock = (
  chatId: string,
  characterId: number,
  since: string,
  blockStart: string,
): boolean =>
  hasAssistantMeta(chatId, characterId, since, {
    like: [kindPattern("glance"), `%"block":"${blockStart}"%`],
  });

// 오늘 알리고 나간 자리비움 선톡 수. 돌아와서 하는 인사와 이어지는 불가 구간 사이에 다음 일을
// 알리는 사이 예고는 이미 알린 자리를 잇는 말이라 빼고 센다.
export const awayNoticeCountToday = (
  chatId: string,
  characterId: number,
  since: string,
): number =>
  countAssistantMeta(chatId, characterId, since, {
    like: [AWAY],
    notLike: ['%"return"%', '%"between"%'],
  });

// 마지막 유저 발화 이후 구간의 시작. 유저가 한 번도 말한 적이 없으면 대화 전체를 본다.
const sinceLastUser = (chatId: string, characterId: number): string =>
  lastUserTs(chatId, characterId) ?? "0000-00-00 00:00:00";

// 마지막 유저 메시지 이후 캐릭터가 먼저 보낸(proactive) 수 — '연속 무응답'을 세어 매달림을 막는다.
export const proactiveSinceLastUser = (
  chatId: string,
  characterId: number,
): number =>
  countAssistantMeta(chatId, characterId, sinceLastUser(chatId, characterId), {
    after: true,
    like: [PROACTIVE],
  });

/**
 * 마지막 유저 발화 이후 하루 합계에 드는 선톡이 몇 통 나갔는지 — 답이 없는 위에 또 거는 것을
 * 막는다.
 *
 * 위 셈과 다른 자리다. 위는 자리 비움 예고·복귀 인사·틈새 한 줄까지 세는데, 그건 캐릭터가
 * 자리를 비우는 상황에 붙는 한 마디라 답을 안 했다고 다시 걸면 안 되는 종류가 아니다. 이유
 * 없이 먼저 거는 의도 선톡만 이 셈을 본다.
 */
export const budgetedSinceLastUser = (
  chatId: string,
  characterId: number,
): number =>
  countAssistantMeta(chatId, characterId, sinceLastUser(chatId, characterId), {
    after: true,
    like: [PROACTIVE],
    notLike: OFF_BUDGET_META,
  });

/** 상대 상태를 보고 나가는 선톡의 종류 — 달래기는 나 때문에 안 좋을 때, 살피기는 상대의 다른
 * 일로 안 좋을 때다(이슈 #361). 둘 다 상태 한 발현에 한 통이다. */
export type StateKind = "mend" | "care";

/** 그 시각 이후 그 종류의 상태 선톡이 이미 나갔는가 — 상대 상태 한 발현에 한 통이다. 기준
 * 시각은 관계 행의 상태 시작 시각(user_state_since)이고, 그 상태가 이어지는 동안 자리 비움
 * 예고가 끼어도 구간을 통째로 보므로 가려지지 않는다. 달래기와 살피기는 서로 세지 않는다 —
 * 원인이 갈리면 다른 통이라, 같은 상태 시작 시각 안에서 달래기가 나간 뒤 원인이 상대의 일로
 * 바뀌면 살피기가 또 나갈 수 있다. */
export const stateKindSentSince = (
  chatId: string,
  characterId: number,
  since: string,
  kind: StateKind,
): boolean =>
  hasAssistantMeta(chatId, characterId, since, {
    after: true,
    like: [kindPattern(kind)],
  });

// ── 선톡의 근거와 단계별 예산 ────────────────────────────────────────────
// 선톡은 근거 종류 넷 가운데 하나를 반드시 갖는다. 근거 없는 선톡은 코드가 보내지 않는다.
//
//   의도    오늘의 관계 의도 네 줄 가운데 아직 안 쓴 줄 하나로 건다
//   일정    각본 블록이 부르는 자리 — 아침·근황·점심·밤 인사·자리 비움·복귀·틈새 한 줄
//   달래기  상대 상태 판정이 안 좋게 나온 뒤 한 번 — 나 때문이면 달래기, 상대의 다른 일이면
//           살피기(이슈 #361). 근거의 출처가 같아서 근거 종류는 하나로 둔다
//   약속    답장에서 캐릭터가 하겠다고 말한 연락
//
// 상한은 둘이다. 의도 근거로 나가는 건수와 하루 전체 합계이고, 둘 다 관계 단계마다 다르다
// (thresholds.ts의 PROACTIVE_STAGE_BUDGET). 자리 비움·복귀·약속·달래기·살피기·틈새 한 줄은 합계에
// 넣지 않는다 — 전부 유저가 이미 말을 걸었거나 캐릭터가 자리를 비우는 상황에 붙는 한 마디라
// 새로 거는 연락과 성격이 다르다. 종류마다 붙어 있던 자기 상한과 시간 조건은 그대로다.

export type ProactiveBasis = "intent" | "schedule" | "mend" | "promise";

/** 선톡 종류가 무슨 근거로 나가는지. */
export const PROACTIVE_BASIS: Record<ProactiveKind, ProactiveBasis> = {
  intent: "intent",
  morning: "schedule",
  checkin: "schedule",
  catchup: "schedule",
  lunch: "schedule",
  goodnight: "schedule",
  away: "schedule",
  glance: "schedule",
  mend: "mend",
  care: "mend",
  promise: "promise",
};

// 하루 합계에 안 넣는 종류. 자리 비움은 나갈 때와 돌아왔을 때가 같은 종류라 복귀 인사도
// 여기에 함께 들어간다. 자리 비움은 AWAY_DAILY_MAX가, 달래기와 살피기는 상태 한 발현에 한 통이,
// 틈새 한 줄은 불가 블록마다 한 번이 따로 막는다. 약속은 답장에서 한 말을 지키는 연락이라
// 상한에 걸리면 약속을 어기는 쪽이 된다(이슈 #308).
const OFF_BUDGET: ProactiveKind[] = ["away", "promise", "mend", "care", "glance"];

/** 이 종류가 하루 합계에 드는가. */
export const onDailyBudget = (kind: ProactiveKind): boolean =>
  !OFF_BUDGET.includes(kind);

export interface ProactiveBudget {
  stage: RelationshipStage;
  /** 하루 합계 상한과 오늘 이미 쓴 수. */
  dailyMax: number;
  dailyUsed: number;
  /** 의도 근거 선톡의 하루 상한과 오늘 이미 쓴 수. */
  intentMax: number;
  intentUsed: number;
}

/** 오늘 남은 선톡 예산. since는 논리일 시작 시각이다. */
export const proactiveBudget = (
  chatId: string,
  characterId: number,
  since: string,
): ProactiveBudget => {
  const stage: RelationshipStage = getStage(characterId)?.stage_no ?? 1;
  const cap = PROACTIVE_STAGE_BUDGET[stage];
  return {
    stage,
    dailyMax: cap.daily,
    dailyUsed: proactiveCountToday(chatId, characterId, since),
    intentMax: cap.intent,
    intentUsed: proactiveKindCountToday(chatId, characterId, since, "intent"),
  };
};

/** 예산이 이 종류를 한 통 더 허락하는가. 종류마다 붙은 자기 조건은 부르는 쪽이 따로 본다. */
export const budgetAllows = (
  b: ProactiveBudget,
  kind: ProactiveKind,
): boolean => {
  if (kind === "intent" && b.intentUsed >= b.intentMax) return false;
  return !onDailyBudget(kind) || b.dailyUsed < b.dailyMax;
};

/** 로그와 게시에 적는 예산 표기 — 합계 2/5통, 의도 1/2. */
export const budgetLabel = (b: ProactiveBudget): string =>
  `${b.stage}단계 · 합계 ${b.dailyUsed}/${b.dailyMax}통 · 의도 ${b.intentUsed}/${b.intentMax}`;

/** 근거 줄에 적을 것. 종류마다 채우는 칸이 다르다. */
export interface BasisDetail {
  kind: ProactiveKind;
  /** 의도 근거로 나갈 때 쓴 줄. */
  intentLine?: IntentLine | null;
  /** 일정 근거일 때 그 각본 블록의 시작 시각(HH:MM). */
  block?: string | null;
  /** 약속 근거일 때 그 약속의 기록 행 번호. */
  promiseId?: number | null;
}

/** 슬랙 선톡 게시에 붙는 근거 줄 — 의도(이어갈 자리) · 일정(12:00 블록) · 달래기 · 살피기 ·
 * 약속(행 12). 상대 상태 근거는 종류 이름으로 갈라 적는다 — 어느 원인을 보고 나간 통인지가
 * 게시에서 바로 읽히게. */
export const basisLine = (d: BasisDetail): string => {
  const basis = PROACTIVE_BASIS[d.kind];
  if (basis === "intent")
    return d.intentLine ? `의도(${INTENT_LINE_NAME[d.intentLine]})` : "의도";
  if (basis === "schedule")
    return `일정(${d.block ? `${d.block} 블록` : PROACTIVE_KIND_NAME[d.kind]})`;
  if (basis === "promise")
    return d.promiseId ? `약속(행 ${d.promiseId})` : "약속";
  return d.kind === "care" ? "살피기" : "달래기";
};

/**
 * 발송 기록의 meta_json으로 근거 줄을 만든다 — 슬랙 선톡 게시가 부른다.
 *
 * 근거를 고른 자리(followup·presence·bot)와 게시하는 자리가 떨어져 있어서, 고를 때 적어 둔
 * 값을 그대로 읽는다. 선톡이 아닌 종류(답장·복구 발송)면 null을 준다.
 */
export const basisLineFromMeta = (
  kind: string,
  meta: Record<string, unknown> = {},
): string | null => {
  if (!(kind in PROACTIVE_BASIS)) return null;
  const line = meta.intent_line;
  const block = meta.block;
  const promise = meta.promise_row;
  return basisLine({
    kind: kind as ProactiveKind,
    intentLine:
      typeof line === "string" && line in INTENT_LINE_NAME
        ? (line as IntentLine)
        : null,
    block: typeof block === "string" ? block : null,
    promiseId: typeof promise === "number" ? promise : null,
  });
};

// ── 의도 선톡이 쓸 줄 고르기 ─────────────────────────────────────────────
// 1단계는 파고들 것과 이어갈 자리 둘만 의도 선톡이 된다. 흘릴 내 얘기는 근황 선톡에 얹고,
// 시도할 플러팅은 아직 먼저 걸 자리가 아니다. 2단계부터 네 줄 전부 열린다.
export const STAGE_INTENT_LINES: Record<RelationshipStage, IntentLine[]> = {
  1: ["dig", "thread"],
  2: ["dig", "share", "move", "thread"],
  3: ["dig", "share", "move", "thread"],
  4: ["dig", "share", "move", "thread"],
};

interface LineMeta {
  intent_line?: unknown;
  move?: unknown;
}

/**
 * 오늘 이미 쓴 의도 줄. 선톡은 meta_json의 intent_line에 줄 코드를 적고, 답장은 쓴 플러팅을
 * move에 적는다 — 플러팅을 이미 뒀으면 시도할 플러팅 줄은 오늘 쓴 것으로 본다.
 */
export const usedIntentLines = (
  chatId: string,
  characterId: number,
  since: string,
): IntentLine[] => {
  const out = new Set<IntentLine>();
  for (const row of getAssistantMetaSince(chatId, characterId, since)) {
    if (!row.meta_json) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.meta_json);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const m = parsed as LineMeta;
    if (typeof m.intent_line === "string" && m.intent_line in INTENT_LINE_NAME)
      out.add(m.intent_line as IntentLine);
    if (typeof m.move === "string" && m.move) out.add("move");
  }
  return [...out];
};

/** 오늘의 의도 행에서 문안에 넣을 줄 하나. 값이 있고 아직 안 쓴 줄 가운데 앞선 것이다. */
export interface IntentLineSource {
  dig?: string | null;
  share?: string | null;
  move?: string | null;
  move_note?: string | null;
  thread?: string | null;
}

export const pickIntentLine = (
  intent: IntentLineSource | null,
  stage: RelationshipStage,
  used: IntentLine[],
): IntentLine | null => {
  if (!intent) return null;
  // 고백 차례는 플러팅 코드 없이 자리만 적힌 날이라 move_note만 있어도 시도할 플러팅 줄이 산다.
  const filled: Record<IntentLine, boolean> = {
    dig: !!intent.dig,
    share: !!intent.share,
    move: !!(intent.move || intent.move_note),
    thread: !!intent.thread,
  };
  for (const line of STAGE_INTENT_LINES[stage])
    if (filled[line] && !used.includes(line)) return line;
  return null;
};
