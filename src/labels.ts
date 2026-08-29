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

/** 캐릭터를 만들 때 정한 값인가, 대화로 쌓인 값인가. creation 행은 저장 함수가 고치지 않는다. */
export type MemoryOrigin = "creation" | "conversation";

export const MEMORY_ORIGIN_NAME: Record<MemoryOrigin, string> = {
  creation: "생성",
  conversation: "대화",
};

/** 이 사실을 유저가 아는가 — 캐릭터 쪽 기억에만 쓴다. */
export type UserKnows = "unknown" | "known" | "waiting";

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
