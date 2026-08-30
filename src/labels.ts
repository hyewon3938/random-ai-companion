// 닫힌 목록의 값 이름표.
//
// 저장은 영어 식별자로 하고, 프롬프트·화면에 쓰는 한글 이름은 여기 한곳에서 붙인다.
// 값을 한글 리터럴로 저장하면 이름 하나를 바꿀 때 저장값·분기·프롬프트가 한꺼번에 걸린다
// ("짬짬이 → 틈틈이"가 코드 19곳에 흩어져 있었다). 식별자로 저장하면 이 표 한 줄만 고치면 된다.
//
// 키의 '무엇'·태그·영역·값 자체는 모델이 한국어로 짓는 자리라 한글 그대로 둔다.

/** 각본 블록의 답장 여건 — 그 시간에 메신저를 얼마나 볼 수 있는가. */
export type Responsiveness = "instant" | "intermittent" | "unavailable";

/** 각본 블록의 활동 성격 — 유저가 붙잡을 때 접을 수 있는가. 답장 여건과 직교한다. */
export type ActivityCategory = "personal" | "social" | "official";

export const RESPONSIVENESS_NAME: Record<Responsiveness, string> = {
  instant: "즉답",
  intermittent: "틈틈이",
  unavailable: "불가",
};

export const ACTIVITY_CATEGORY_NAME: Record<ActivityCategory, string> = {
  personal: "개인",
  social: "사회",
  official: "공적",
};

/** 각본 블록의 출처 — 이 블록이 무엇을 그날치로 펼친 사본인가. 원본이 있는 블록에만 붙는다. */
export type BlockSource = "schedule" | "routine";

export const BLOCK_SOURCE_NAME: Record<BlockSource, string> = {
  schedule: "예정된 일",
  routine: "매주 루틴",
};

/** 기억 한 건이 들어가는 저장 항목. 주인(캐릭터·유저)과 짝지어 여섯 조합이 된다. */
export type MemoryItemType = "fact" | "ongoing" | "person";

export const MEMORY_ITEM_TYPE_NAME: Record<MemoryItemType, string> = {
  fact: "사실",
  ongoing: "진행 중인 일",
  person: "주변 인물",
};

/** 이 기억이 누구 쪽 것인가 — 키의 나머지 절반. */
export type MemoryOwner = "char" | "user";

export const MEMORY_OWNER_NAME: Record<MemoryOwner, string> = {
  char: "캐릭터",
  user: "유저",
};

// 프롬프트에서 쓰는 이름은 따로 둔다 — 위 이름은 대시보드·트레이스가 읽고,
// 캐릭터가 읽는 글에서는 자기를 '너', 유저를 '상대'로 부른다.
export const MEMORY_OWNER_IN_PROMPT: Record<MemoryOwner, string> = {
  char: "너",
  user: "상대",
};

/** 캐릭터를 만들 때 정한 값인가, 대화로 쌓인 값인가. creation 행은 저장 함수가 고치지 않는다. */
export type MemoryOrigin = "creation" | "conversation";

export const MEMORY_ORIGIN_NAME: Record<MemoryOrigin, string> = {
  creation: "생성",
  conversation: "대화",
};

/** 이 사실을 유저가 아는가 — 캐릭터 쪽 기억에만 쓴다. */
export type UserKnows = "unknown" | "known" | "waiting";

/**
 * 일정 한 건을 만든 경로. memory_items.origin과 이름은 같지만 값이 다른 별개 컬럼이다
 * (기억은 creation·conversation 둘, 일정은 셋).
 *
 * 08-27 이관 전까지는 저장 코드가 이 값을 안 넣어 전부 기본값 conversation으로 들어갔고,
 * 지금 DB에 있는 rhythm 행은 그때 손으로 분류해 UPDATE한 것이다. 그래서 같은 일정이 두 줄로
 * 쌓였을 때 어느 경로가 넣었는지 가릴 수 없었다 — 넣는 자리에서 채우는 것이 이 타입의 목적.
 */
export type ScheduleOrigin = "conversation" | "rhythm" | "ongoing";

export const SCHEDULE_ORIGIN_NAME: Record<ScheduleOrigin, string> = {
  conversation: "대화",
  rhythm: "월 리듬",
  ongoing: "진행 중인 일",
};

/**
 * 일정 한 건의 상태. 지금 이 값을 바꿔 쓰는 코드는 없지만(붙잡혀 접은 일정은 day_actuals에
 * 남는다), 프롬프트에 일정을 실을 때 상태를 함께 적어 이미 없어진 일을 예정처럼 말하지 않게
 * 한다 — 나중에 status를 쓰는 코드가 생겨도 프롬프트 쪽은 그대로 맞는다.
 */
export type ScheduleStatus = "active" | "cancelled" | "deferred";

export const SCHEDULE_STATUS_NAME: Record<ScheduleStatus, string> = {
  active: "예정",
  cancelled: "취소",
  deferred: "미룸",
};

/** 유저가 이 주제에 보이는 관심 수준 — 캐릭터 쪽 기억에만 쓴다. */
export type Interest = "high" | "medium" | "low";

export const INTEREST_NAME: Record<Interest, string> = {
  high: "많음",
  medium: "보통",
  low: "적음",
};

/** 캐릭터와 유저가 지금 쓰는 말투. */
export type SpeechLevel = "polite" | "casual";

export const SPEECH_LEVEL_NAME: Record<SpeechLevel, string> = {
  polite: "존댓말",
  casual: "반말",
};

/** 모델을 부른 자리 — 호출 원본(llm_calls)에 무슨 일로 부른 것인지 적는다. */
export type CallPurpose =
  | "reply"
  | "hold"
  | "tags"
  | "day_plan"
  | "life_plan"
  | "arc"
  | "diary"
  | "extract"
  | "genesis"
  | "bible"
  | "morning"
  | "lunch"
  | "reconnect"
  | "catchup"
  | "goodnight"
  | "away"
  | "comeback"
  | "tool";

export const CALL_PURPOSE_NAME: Record<CallPurpose, string> = {
  reply: "답장",
  hold: "붙잡기 판정",
  tags: "주제 고르기",
  day_plan: "하루 각본",
  life_plan: "월 리듬",
  arc: "아크",
  diary: "일기",
  extract: "기억 정리",
  genesis: "캐릭터 생성",
  bible: "옛 랜덤 생성",
  morning: "아침 선톡",
  lunch: "점심 선톡",
  reconnect: "안부 선톡",
  catchup: "근황 선톡",
  goodnight: "밤 인사 선톡",
  away: "자리비움 선톡",
  comeback: "복귀 선톡",
  tool: "개발 도구",
};

// 각본 블록의 닫힌 목록 값(답장 여건·활동 성격·출처)은 plan_json 안에 있어 DB CHECK가 닿지
// 않는다. 저장된 옛 각본과 외부 생성분에는 한글 값이 남아 있으므로, 읽는 자리에서 식별자로 되돌린다.
const RESPONSIVENESS_BY_TEXT: Record<string, Responsiveness> = {
  instant: "instant",
  intermittent: "intermittent",
  unavailable: "unavailable",
  즉답: "instant",
  틈틈이: "intermittent",
  짬짬이: "intermittent",
  불가: "unavailable",
};

const ACTIVITY_CATEGORY_BY_TEXT: Record<string, ActivityCategory> = {
  personal: "personal",
  social: "social",
  official: "official",
  개인: "personal",
  사회: "social",
  공적: "official",
};

const BLOCK_SOURCE_BY_TEXT: Record<string, BlockSource> = {
  schedule: "schedule",
  routine: "routine",
  "예정된 일": "schedule",
  "매주 루틴": "routine",
};

export const toResponsiveness = (v: unknown): Responsiveness | null =>
  typeof v === "string" ? (RESPONSIVENESS_BY_TEXT[v.trim()] ?? null) : null;

export const toActivityCategory = (v: unknown): ActivityCategory | null =>
  typeof v === "string" ? (ACTIVITY_CATEGORY_BY_TEXT[v.trim()] ?? null) : null;

export const toBlockSource = (v: unknown): BlockSource | null =>
  typeof v === "string" ? (BLOCK_SOURCE_BY_TEXT[v.trim()] ?? null) : null;

// 유저가 붙잡아 일정을 접었을 때 오늘 실제 기록에 남기는 결말. 코드가 적고 프롬프트가 그대로 읽는다.
// day_actuals.outcome은 자유 서술이라 CHECK가 없다 — 코드가 판정에 쓰는 두 값만 여기서 고정한다.
export const HOLD_OUTCOME = { cancelled: "취소", deferred: "미룸" } as const;

export type HoldOutcome = (typeof HOLD_OUTCOME)[keyof typeof HOLD_OUTCOME];

export const isHoldOutcome = (v: string): boolean =>
  (Object.values(HOLD_OUTCOME) as string[]).includes(v.trim());

/**
 * 자는 시간에 온 연락을 받고 깨어 답한 기록. 각본에는 자는 것으로 되어 있던 시간이라
 * 오늘 실제 기록에 남겨, 그날 새벽 정리가 일기와 다음 날 각본에 함께 놓고 본다.
 * 붙잡혀 접은 일정과는 다른 값이라 isHoldOutcome에는 걸리지 않는다.
 */
export const WOKE_OUTCOME = "깸";

/**
 * 슬랙 트레이스 채널에 사람이 남기는 표시 — 그 답장의 무엇이 잘못됐는가.
 * 채널을 읽다가 리액션 하나로 분류를 고르고, 이유는 스레드 답글로 적는다(feedback.ts).
 */
export type FeedbackKind = "fact" | "tone" | "timing" | "good";

export const FEEDBACK_KIND_NAME: Record<FeedbackKind, string> = {
  fact: "사실 오류",
  tone: "말투",
  timing: "타이밍",
  good: "좋음",
};

// 분류를 고르는 이모지. 슬랙이 돌려주는 이름을 그대로 키로 쓴다 — 👍는 :thumbsup:으로 눌러도
// :+1:로 오는 것이 보통이지만, 클라이언트에 따라 누른 이름이 그대로 오기도 해서 둘 다 받는다.
const FEEDBACK_BY_EMOJI: Record<string, FeedbackKind> = {
  x: "fact",
  speech_balloon: "tone",
  alarm_clock: "timing",
  "+1": "good",
  thumbsup: "good",
};

/** 리액션 이름을 분류로. 목록에 없는 이모지는 표시가 아니라 잡담이므로 null. */
export const toFeedbackKind = (name: string): FeedbackKind | null => {
  // 살색 변형(:+1::skin-tone-3:)은 앞부분만 본다.
  const base = name.split("::")[0].trim();
  return FEEDBACK_BY_EMOJI[base] ?? null;
};
