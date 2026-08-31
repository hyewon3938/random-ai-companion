// 숫자로 관리하는 기준값.
//
// 설계 문서 time-and-memory.md 「고정된 기준값」 표와 1:1로 맞춘 상수 모듈이다. labels.ts가
// 닫힌 목록의 이름을 한곳에 모은 것과 같은 방식으로, 같은 성격의 값이 코드 여러 곳에 흩어져
// 하나만 고쳐지는 일을 막는다. 표의 값을 조정할 때 고칠 자리도 여기 한곳이 된다.
//
// 지금 이 모듈을 참조하는 곳은 memory.ts · context.ts · life-plan.ts · day-plan.ts와 선톡을
// 다루는 네 모듈(proactive-policy.ts · dispatch.ts · presence.ts · followup.ts)이다. 아직 옮기지 않은
// 모듈은 각자 다시 쓰는 세션에서 리터럴을 이 모듈 참조로 바꾼다. 스키마만 배포하는
// 회차에 실행 중인 모듈 여럿을 함께 건드리면 배포 위험만 커진다.
//
// 표에서 폐기·완료로 표시된 값(붙잡기 10분·12분, 답장 불가 대기 상한 35분, 밤 대화 판정
// 45분, 낮 근황 100~139분·2회)은 여기 두지 않는다.

// ── 답장 텀 ─────────────────────────────────────────────────────────────
// reply-timing.ts가 표 한 장으로 텀을 정할 때 쓰는 값이다. 같은 값을 그 모듈도 자기 파일 안에
// 다시 두고 있었는데, 하루의 경계를 새벽 5시로 통일하면서 이쪽 하나만 남겼다.

/** 유저가 나눠 보낸 말이 다 도착할 때까지 기다리는 하한과 상한. 답장 텀에는 포함하지 않는다. */
export const ARRIVAL_WAIT_MIN_MS = 20_000;
export const ARRIVAL_WAIT_MAX_MS = 40_000;

/** 즉답 블록의 답장 텀. 짧은 쪽으로 몰리게 뽑는다. */
export const INSTANT_MIN_MS = 0;
export const INSTANT_MAX_MS = 120_000;

/** 틈틈이 블록의 답장 텀 — 활동 성격이 개인 · 사회 · 공적일 때. */
export const INTERMITTENT_PERSONAL_MIN_MS = 20_000;
export const INTERMITTENT_PERSONAL_MAX_MS = 150_000;
export const INTERMITTENT_SOCIAL_MIN_MS = 30_000;
export const INTERMITTENT_SOCIAL_MAX_MS = 240_000;
export const INTERMITTENT_OFFICIAL_MIN_MS = 60_000;
export const INTERMITTENT_OFFICIAL_MAX_MS = 480_000;

/** 답장 불가 구간은 그 일이 끝날 때 답한다 — 끝나는 시각에 초 단위로 맞추지 않도록 흩뜨리는 폭. */
export const BLOCK_END_JITTER_MS = 60_000;

/** 자는 시간에 온 연락 — 진동에 깨서 폰을 볼 때까지. 한 번 깬 뒤로는 즉답 값으로 답한다. */
export const SLEEP_WAKE_MIN_MS = 3 * 60_000;
export const SLEEP_WAKE_MAX_MS = 25 * 60_000;

// ── 선톡 ────────────────────────────────────────────────────────────────

/** 침묵 백오프 — 무응답 이 일수부터 조용, 이 일수째에 안부 선톡 한 통. */
export const QUIET_AFTER_DAYS = 3;
export const RECONNECT_AT_DAYS = 14;

/** 안부 선톡을 보내는 시각 범위. */
export const RECONNECT_WINDOW = { start: "17:00", end: "19:59" } as const;

/** 무응답 2일째에 아침 대신 보내는 점심 시각 범위. */
export const LUNCH_WINDOW = { start: "12:05", end: "12:50" } as const;

/** 전송에 실패해 시간대를 놓쳤을 때 늦게라도 보내는 유예와 시간대별 상한. */
export const SEND_GRACE_MIN = 90;
export const SEND_GRACE_CAPS = ["11:00", "14:00", "22:00"] as const;

/** 유저가 방금까지 대화 중이었다고 보는 창. 세 자리가 같은 값을 쓴다 — 근황 선톡을 보내는
 * 무응답 임계, 자리비움 선톡을 보낼 수 있는 마지막 경계, 아침 선톡이 유저가 먼저 연락했는지
 * 재는 창이다. */
export const RECENT_USER_MS = 4 * 60 * 60 * 1000;

/** 밤 인사 선톡 — 이만큼 답이 없고 이 시간대에 들어와 있으면 보낸다. */
export const GOODNIGHT_SILENCE_MS = 60 * 60 * 1000;
export const GOODNIGHT_WINDOW = { start: "00:00", end: "05:00" } as const;

/** 자리비움 선톡 — 알리고 나갈 일정의 최소 길이, 나갈 때와 끝난 뒤의 시간 창(분).
 * 미리 아는 일정(advance_known)은 시작 전에 예고하고, 닥친 일은 시작 시점에 알린다.
 * 복귀 알림은 창을 따로 두지 않는다 — 구간 끝의 깨우기 표시(pending의 wake 행)가 그 자리다.
 *
 * 최소 길이는 아래 하루 상한과 짝이다. 이 값이 낮으면 각본이 알릴 만한 구간을 상한보다 많이
 * 만들고, 넘친 구간은 예고 없이 지나가 유저가 이유를 모른 채 오래 기다리게 된다. 30분으로
 * 두면 운동·운전처럼 진짜 긴 것만 세게 되어 상한에 닿지 않는다. 이 값보다 짧은 불가 구간은
 * 예고도 복귀 인사도 없이 조용히 지나가므로, 각본이 그런 구간을 연달아 붙이지 않도록
 * day-plan.ts의 생성 프롬프트가 사이에 답할 수 있는 구간을 넣게 한다. */
export const AWAY_MIN_BLOCK_MIN = 30;
export const AWAY_BEFORE_MIN = 10;
export const AWAY_AFTER_MIN = 3;
export const AWAY_SUDDEN_AFTER_MIN = 12;
export const AWAY_BACK_TO_BACK_BEFORE_MIN = 2;
export const AWAY_BACK_TO_BACK_AFTER_MIN = 12;

/** 자리비움 선톡을 접는 침묵 길이(분). 캐릭터가 이만큼 안에 이미 말했으면 예고를 보내지 않는다.
 * 알릴 일정이 이미 시작했으면 그 시작 시각까지 거슬러 본다 — 불가 구간이 끝나는 자리에서
 * 몰아 답장이 나가는데(그 시각이 곧 다음 일정의 시작이다), 그 답장이 이미 방금 끝났다고
 * 말한 뒤라 같은 전환을 예고가 또 말하게 된다. */
export const AWAY_QUIET_MIN = 5;

/** 자리비움 선톡의 하루 상한. 나갈 때 알리는 것만 세고, 돌아와서 하는 인사는 빼고 센다.
 * 하루 각본을 만들 때도 이 값을 넘기지 않도록 알리고 나갈 만한 일정 수를 제한한다. */
export const AWAY_DAILY_MAX = 3;

/** 선톡 전체의 하루 상한. 자리비움은 이 상한에서 빼고 위 상한으로만 관리한다. */
export const PROACTIVE_DAILY_MAX = 6;

// ── 하루와 기록 ─────────────────────────────────────────────────────────

/** 하루의 경계. 날짜를 세는 모든 곳이 이 기준을 쓴다. */
export const DAY_BOUNDARY_HOUR = 5;

/** 새벽 정리를 실행하는 시각. */
export const NIGHTLY_RUN_AT = { hour: 5, minute: 40 } as const;

/** 다음 달 리듬을 미리 만들기 시작하는 기준 — 이번 달 남은 날이 이 값 이하일 때. */
export const RHYTHM_RUNWAY_DAYS = 6;

/** 유저에 대해 알게 된 것을 뽑는 주기(턴). */
export const USER_FACT_EVERY_TURNS = 15;

/** 주제와 상관없이 프롬프트에 넣는 최근 일기 일수. */
export const RECENT_DIARY_DAYS = 3;

/** 프롬프트에 원문 그대로 넣는 최근 메시지 수. */
export const RECENT_MESSAGE_COUNT = 40;

/** 선톡 문안 프롬프트에 넣는 최근 대화 줄 수. 답장 경로는 위 값으로 대화 기록을 통째로
 * 넘기지만, 선톡은 대화를 잇는 자리가 아니라 방금 한 말을 다시 하지 않을 만큼만 본다. */
export const PROACTIVE_RECENT_LINES = 6;

/** 대화 기록에 시간 표시를 붙이는 간격. */
export const TIME_MARKER_GAP_MS = 60 * 60 * 1000;

/** 한 답장에 나눠 보내는 말풍선 상한. */
export const MAX_BUBBLES = 6;

/** 프롬프트 재사용이 유지되는 시간. 모델 쪽에서 정한 값이라 5분과 1시간 중에 고른다. */
export const PROMPT_CACHE_TTL = "1h" as const;

/**
 * 하루 각본을 만들 때 프롬프트에 넣는 진행 중인 일의 개수 상한.
 *
 * 최근에 손댄 것부터 이만큼만 넣는다. 며칠에 걸쳐 하는 일이 늘어도 각본 프롬프트에서
 * 다른 데이터가 밀리지 않게 두는 장치다. 태그로 검색해 넣는 상한과 같은 값으로 잡았다.
 */
export const PLAN_ONGOING_MAX = 3;

/**
 * 태그로 검색한 결과를 저장 항목마다 프롬프트에 넣는 상한.
 *
 * 진행 3 · 예정 3 · 사실 5 · 일기 2 · 인물 3. 전부 초기값이라 실제 프롬프트 길이를 보면서
 * 표와 함께 조절한다.
 */
export const SEARCH_LIMIT = {
  ongoing: 3,
  schedule: 3,
  fact: 5,
  diary: 2,
  person: 3,
} as const;

/**
 * 새벽 정리가 일기 한 편에 붙이는 주제 태그의 개수 상한.
 *
 * 일기는 하루 한 편씩 쌓이므로 상한이 없으면 한 편이 태그 어휘를 통째로 늘리고, 그렇게 늘어난
 * 이름은 답장 전 태그 고르기 프롬프트와 글자 대조에 매일 얹힌다. 초기값이라 실제로 걸리는
 * 일기 수를 보면서 조절한다.
 */
export const DIARY_TAG_MAX = 8;

/**
 * 새벽 정리 추출 프롬프트에 '이미 저장된 일정'으로 싣는 행 수 상한.
 *
 * 이 목록이 같은 일정을 두 줄로 쌓지 않게 막는 주된 장치다 — 모델이 이미 있는 줄을 보고
 * 다시 적지 않는다. 상한이 낮으면 가려진 일정이 그대로 다시 들어오므로 넉넉히 잡되,
 * 매일 밤 프롬프트에 통째로 실리는 값이라 무한정 두지는 않는다. 일정이 이 수를 넘기기
 * 시작하면 날짜 창을 좁히는 쪽으로 바꾼다.
 */
export const EXTRACT_SCHEDULE_MAX = 40;

/**
 * 모델이 한 번에 고를 수 있는 주제 태그 수.
 *
 * 초기값이다. 저장 항목별 상한(SEARCH_LIMIT)이 뒤에서 한 번 더 줄이므로 이 값은 검색을
 * 얼마나 넓게 시작할지만 정한다.
 */
export const TAG_PICK_MAX = 8;

// 기억 응축을 시작하는 캐릭터당 항목 수는 아직 정하지 않았다. 지금 규모에서는 필요 없어
// 항목 수가 실제로 커질 때 정한다.
