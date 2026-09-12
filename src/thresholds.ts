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
// 45분, 낮 근황 100~139분·2회, 자다 깨는 데 걸리는 3~25분)은 여기 두지 않는다.

import type { RelationshipStage } from "./labels.js";

// ── 답장 텀 ─────────────────────────────────────────────────────────────
// reply-timing.ts가 표 한 장으로 텀을 정할 때 쓰는 값이다. 같은 값을 그 모듈도 자기 파일 안에
// 다시 두고 있었는데, 하루의 경계를 새벽 5시로 통일하면서 이쪽 하나만 남겼다.

/**
 * 유저가 나눠 보낸 말이 다 도착할 때까지 기다리는 하한과 상한. 답장 텀에는 포함하지 않는다.
 * 하한은 짧게 치는 사람의 기본값(여기에 0~5초를 더한다)이고 이 아래로는 내려가지 않는다 —
 * 급히 친 짧은 텀에 대기를 더 줄이면 재촉 악순환이 된다. 상한은 길게 치는 사람도 이 이상은
 * 응답이 끊긴 듯 느끼는 값이다. bot.ts의 computeWait가 쓴다.
 */
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

/** 충분히 잔 것으로 치는 시간 — 어젯밤 잠든 시각에 이만큼을 더한 시각보다 늦게 일어나면
 *  늦게 잤어도 피곤해하지 않는다. 피곤함은 잠든 시각이 아니라 잔 시간으로 잰다(이슈 #289). */
export const ENOUGH_SLEEP_HOURS = 6;
/** 밤 잠 블록으로 치는 시작 시각의 하한(각본 표기). 새벽 5시부터 이어지는 아침 꼬리 잠은 제외. */
export const NIGHT_SLEEP_FROM = "20:00";
/** 캐릭터의 마지막 말을 잠든 시각의 후보로 치는 하한(각본 표기). 저녁에 끝난 대화는 취침이 아니다. */
export const LATE_TALK_FROM = "22:00";

/** 달래기 선톡 — 상대의 지금 상태가 나 때문에 안 좋은데 답이 끊긴 뒤 이만큼 지나면 한 통
 * 보낸다. 침묵 팔로업 틱이 15분 간격이라 실제 발송은 30~45분 사이에 흩어진다. */
export const MEND_SILENCE_MS = 30 * 60 * 1000;

/** 살피기 선톡 — 상대의 지금 상태가 상대의 다른 일로 안 좋은데 답이 끊긴 뒤 이만큼 지나면 한 통
 * 보낸다(이슈 #361). 달래기와 같은 30분이다. 틱이 15분 간격이라 실제로는 30~45분 뒤에 나가고,
 * 한 시간으로 두면 속상한 채로 나간 사람에게 첫 연락이 한 시간 넘어 닿아 늦다. */
export const CARE_SILENCE_MS = 30 * 60 * 1000;

/** 상대 상태 판정 호출에 넣는 최근 대화 수. 하루치 대화가 대개 이 안에 들어오고, 그보다
 * 오래된 말은 지난 판정 한 줄이 대신한다. */
export const USER_STATE_TURNS = 24;

/** 자리비움 선톡 — 알리고 나갈 일정의 최소 길이, 나갈 때와 끝난 뒤의 시간 창(분).
 * 미리 아는 일정(advance_known)은 시작 전에 예고하고, 닥친 일은 시작 시점에 알린다.
 * 복귀 알림은 창을 따로 두지 않는다 — 구간 끝의 깨우기 표시(pending의 wake 행)가 그 자리다.
 *
 * 최소 길이는 아래 하루 상한과 짝이다. 이 값이 낮으면 각본이 알릴 만한 구간을 상한보다 많이
 * 만들고, 넘친 구간은 예고 없이 지나가 유저가 이유를 모른 채 오래 기다리게 된다. 30분으로
 * 두면 운동·운전처럼 진짜 긴 것만 세게 되어 상한에 닿지 않는다. 이 값보다 짧은 불가 구간은
 * 예고도 복귀 인사도 없이 조용히 지나가므로, 각본은 그 개수와 합에 아래 상한을 두고 불가
 * 구간 사이에 답할 수 있는 시간을 AWAY_GAP_MIN 이상 넣는다. 생성 프롬프트가 이 값들을
 * 말하고, 만든 각본을 day-plan.ts의 awayStats가 다시 센다(이슈 #335). */
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
 * 하루 각본도 알리고 나갈 만한 긴 불가 구간(AWAY_MIN_BLOCK_MIN 이상, 잠 제외)을 이 수까지만
 * 둔다. 예고와 각본이 같은 값을 봐야 예고 없이 지나가는 긴 구간이 생기지 않는다. */
export const AWAY_DAILY_MAX = 2;

/** 관계 초반의 자리 비움. 관계 단계가 1이거나 만난 지 AWAY_EARLY_DAYS일이 안 됐으면 초반이다.
 * 이때 자리를 자주 오래 비우면 유저가 캐릭터에게 마음을 붙일 틈이 자꾸 끊겨서, 긴 불가 구간을
 * 하루 AWAY_EARLY_DAILY_MAX개까지로 줄인다. 두 상한 모두 최대치라 없는 날이 기본이고, 단계가
 * 오르고 날이 쌓이면 AWAY_DAILY_MAX로 풀어 가끔 비는 자리가 유저가 그리워할 틈이 되게 한다(이슈 #335). */
export const AWAY_EARLY_DAYS = 30;
export const AWAY_EARLY_DAILY_MAX = 1;

/** 긴 불가 구간 하나의 길이 상한(분). 국면과 상관없이 같다. 1시간짜리 운동처럼 더 길게 손이
 * 묶이는 일은 중간에 폰을 보는 틈을 넣어 나눈다. 시험·면접·발표처럼 자리를 뜰 수 없는 공적
 * 일은 언제나 실제 길이대로 두고, 영화관·공연처럼 확정 일정에서 나온 구간은 관계가 쌓인
 * 뒤에만 실제 길이대로 둔다(day-plan.ts의 awayLengthExempt). */
export const AWAY_BLOCK_MAX_MIN = 40;

/** 알리지 않고 다녀오는 짧은 불가 구간(AWAY_MIN_BLOCK_MIN 미만, 잠 제외)의 하루 개수와 합(분).
 * 하나하나는 예고할 만큼 길지 않지만, 많으면 유저가 이유를 모른 채 기다리는 시간만 쌓인다.
 * 긴 운동을 둘로 나눈 조각이 여기 들어오므로 씻기·통화까지 더해 4개·90분이다. */
export const AWAY_SHORT_DAILY_MAX = 4;
export const AWAY_SHORT_TOTAL_MAX_MIN = 90;

/** 불가 구간 둘 사이에 두는, 답할 수 있는 시간의 최소(분). 운동 뒤에 귀가 운전과 씻기를 바로
 * 붙이면 예고한 시간보다 훨씬 오래 답이 끊긴다. 짧은 구간끼리 붙어도 마찬가지다. */
export const AWAY_GAP_MIN = 5;

/** 틈새 한 줄(glance)의 조건 둘. 불가 구간 안에서 유저가 있는지·뭐 하는지 묻는 말을 남기고
 * GLANCE_AFTER_USER_MIN분 이상 지났고 구간 끝까지 GLANCE_MIN_LEFT_MIN분 넘게 남았을 때만,
 * 지금 하는 일과 끝나는 시각을 짧게 알린다. 한 구간이 AWAY_BLOCK_MAX_MIN(40분)까지인 것에 맞춘
 * 값이다 — 10분·30분으로 두면 40분짜리 구간에서는 한 번도 성립하지 않는다(이슈 #339). */
export const GLANCE_AFTER_USER_MIN = 5;
export const GLANCE_MIN_LEFT_MIN = 15;

/** 선톡의 단계별 하루 상한 두 가지 — 의도 근거로 나가는 선톡 건수와 하루 전체 합계다.
 * 합계에는 자리비움·복귀·약속·달래기·틈새 한 줄을 넣지 않는다. 전부 유저가 이미 말을 걸었거나
 * 캐릭터가 자리를 비우는 상황에 붙는 한 마디라 새로 거는 연락과 성격이 다르다. 1단계의 4는
 * 아침·근황·의도·밤 인사 하나씩이고, 단계가 오르면 이유 없는 연락이 열려 상한이 늘어난다. */
export const PROACTIVE_STAGE_BUDGET: Record<
  RelationshipStage,
  { intent: number; daily: number }
> = {
  1: { intent: 1, daily: 4 },
  2: { intent: 2, daily: 5 },
  3: { intent: 2, daily: 6 },
  4: { intent: 3, daily: 6 },
};

/** 의도 선톡을 보낼 수 있는 시간대와, 그 앞에 두는 조용한 시간(밀리초). 유저와 캐릭터의 마지막
 * 말이 둘 다 이만큼 지났을 때만 오늘 의도 줄 하나를 꺼내 먼저 말을 건다 — 대화가 이어지는
 * 중에 끼어들면 선톡이 아니라 답장을 재촉하는 말이 된다. */
export const INTENT_QUIET_MS = 2 * 60 * 60 * 1000;
export const INTENT_WINDOW = { start: "09:00", end: "23:00" } as const;

// ── 하루와 기록 ─────────────────────────────────────────────────────────

/** 하루의 경계. 날짜를 세는 모든 곳이 이 기준을 쓴다. */
export const DAY_BOUNDARY_HOUR = 5;

/** 새벽 정리를 실행하는 시각. */
export const NIGHTLY_RUN_AT = { hour: 5, minute: 40 } as const;

/** 다음 달 리듬을 미리 만들기 시작하는 기준 — 이번 달 남은 날이 이 값 이하일 때. */
export const RHYTHM_RUNWAY_DAYS = 6;

/** 주제와 상관없이 프롬프트에 넣는 최근 일기 일수. */
export const RECENT_DIARY_DAYS = 3;

/** [다가오는 일정] 슬롯이 싣는 앞일의 범위 — 오늘부터 며칠까지. 건수만으로 자르면 캐릭터가
 * 아는 앞일의 끝이 달마다 달라진다(일정이 촘촘한 달은 2주, 드문 달은 두 달 뒤까지). 범위를
 * 날짜로 먼저 정하고 건수 상한은 그 안에서만 둔다(이슈 #398). */
export const UPCOMING_SCHEDULE_DAYS = 14;

/** 그 범위 안에서 싣는 최대 행 수. 범위 안에 일정이 몰린 주에만 걸린다. */
export const UPCOMING_SCHEDULE_MAX = 12;

/** 프롬프트에 원문 그대로 넣는 최근 대화 턴 수. 한 사람이 연달아 보낸 말은 몇 통이든
 * 한 턴으로 센다 — 행으로 세면 남는 대화 길이가 유저가 말을 끊어 보내는 습관에 딸려 간다. */
export const RECENT_TURN_COUNT = 40;

/** 위 턴 수를 채우려고 DB에서 한 번에 읽는 행 수 상한. 이어 보내기가 길어도 턴이 채워지게
 * 넉넉히 잡되, 오래된 기록까지 훑지 않도록 막는 값이다. */
export const RECENT_MESSAGE_FETCH_MAX = 200;

/** 선톡 문안 프롬프트에 넣는 최근 대화 줄 수. 답장 경로는 RECENT_TURN_COUNT로 대화 기록을
 * 통째로 넘기지만, 선톡은 대화를 잇는 자리가 아니라 먼저 거는 말의 사물을 상대가 전에 한 말에서
 * 가져오는 자리다. 여기는 턴이 아니라 줄로 센다 — 무엇을 말했는지 훑는 자리라 이어 보낸 말도
 * 한 줄씩 보인다. */
export const PROACTIVE_RECENT_LINES = 12;

/** 선톡 문안 프롬프트에 넣는 유저 기억 줄 수. 선톡은 지금 얘기가 없어 태그로 기억을 찾을 수
 * 없으므로, 최근에 말한 것과 진행 중인 일 순으로 이만큼 골라 상황 문단에 넣는다. */
export const PROACTIVE_USER_MEMORY_LINES = 4;

/** 대화 기록에 시간 표시를 붙이는 간격. 이만큼 벌어진 자리에만 붙인다 — 주고받는 동안 매
 * 턴에 시각이 찍히면 노이즈이고, 모델이 그 표기를 흉내 내 말풍선에 시각을 적는다. 자리를
 * 비운 구간처럼 간격이 이보다 짧아도 표시가 필요한 자리는 toTurns의 markFrom으로 따로 준다. */
export const TIME_MARKER_GAP_MS = 60 * 60 * 1000;

/** 유저 연락이 이만큼 만에 왔을 때 답장 프롬프트에 그 텀을 적는다. 캐릭터의 마지막 말과 그 뒤
 * 처음 온 유저 말 사이를 재고, 같은 논리일 안일 때만 쓴다 — 날짜가 바뀐 자리는 직전 대화 절이
 * 다룬다(이슈 #284). 시간 표시 간격(1시간)보다 길게 잡는 이유는 밥 먹고 온 정도의 틈까지
 * 화제로 삼으면 매번 보고받는 느낌이 나기 때문이다. */
export const CONTACT_GAP_NOTICE_MS = 3 * 60 * 60 * 1000;

/** 같은 논리일 안에서 이만큼 벌어지면 긴 텀으로 본다. 답장 프롬프트가 기다렸다는 말을 한 마디
 * 얹으라고 적는 구간이다(이슈 #316). 아침에 보낸 말에 저녁에 답이 오는 하루가 여기 들어간다. */
export const CONTACT_GAP_LONGING_MS = 6 * 60 * 60 * 1000;

/** 날짜가 바뀐 연락은 이만큼 벌어졌을 때만 연락 텀을 적고, 그 자리는 전부 긴 텀이다. 밤에
 * 끝난 대화에 다음 날 아침 답이 오는 텀(길어야 열몇 시간)과 하루가 통째로 지난 텀을 가르는
 * 값이다 — 낮은 값으로 잡으면 자고 일어난 아침마다 기다렸다는 말이 나온다. */
export const CONTACT_GAP_OVERNIGHT_MS = 20 * 60 * 60 * 1000;

/** 연락 텀 절을 붙들어 두는 시간. 유저가 다시 말을 건 시점이 이 안이면 몇 마디 주고받는
 * 동안에도 절이 남아서, 첫 답장에 바로 말하지 않고 뒤에 꺼낼 수 있다(이슈 #316). */
export const CONTACT_GAP_HOLD_MS = 30 * 60 * 1000;

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
 * 새벽 정리 추출 프롬프트에 '상대에 대해 이미 아는 것'으로 싣는 상대 쪽 사실의 행 수 상한.
 *
 * 캐릭터 쪽 사실은 정체성이라 전부 싣지만, 상대 쪽 사실은 그날 대화·메모에 태그가 걸린 것만
 * 최신순으로 이만큼 싣는다. 같은 키를 다시 쓸 때 모델이 앞 값을 보고 합치게 하는 장치라,
 * 상한이 낮으면 가려진 키가 그날 대화만으로 다시 쓰여 앞 값의 세부가 지워진다(이슈 #264).
 */
export const EXTRACT_USER_FACT_MAX = 20;

/**
 * 새벽 정리 한 회차가 새로 만들 수 있는 작품 사실 카드 수와 카드 하나의 장면 수 상한(#287).
 *
 * 카드는 작품마다 한 번만 만들면 되고 새벽마다 웹 검색이 붙으므로, 하루에 여러 편을 몰아
 * 찾지 않게 회차당 수를 묶는다. 각본에 작품이 더 있으면 다음 새벽이 이어 만든다. 장면은
 * 답장 프롬프트의 일간층에 매일 실리는 값이라 카드 하나가 길어지지 않게 함께 묶는다.
 */
export const WORK_FACT_MAX_PER_NIGHT = 3;
export const WORK_FACT_SCENE_MAX = 5;

/**
 * 모델이 한 번에 고를 수 있는 주제 태그 수.
 *
 * 초기값이다. 저장 항목별 상한(SEARCH_LIMIT)이 뒤에서 한 번 더 줄이므로 이 값은 검색을
 * 얼마나 넓게 시작할지만 정한다.
 */
export const TAG_PICK_MAX = 8;

/**
 * 새벽 정리 한 회차에 태그 이름 판정으로 물어보는 후보 수 상한.
 *
 * 답은 후보 한 줄씩 오므로 후보가 많으면 상한에 잘려 뒤쪽 줄이 통째로 버려진다. 넘친 후보는
 * 그대로 새 이름으로 등록되고 다음 회차에 다시 후보가 된다. 하루치 기억·일기·일정에서 나오는
 * 새 이름을 덮는 초기값이라, 실제로 몇 개가 오는지 보면서 조절한다.
 */
export const TAG_CANON_MAX = 30;

// 기억 응축을 시작하는 캐릭터당 항목 수는 아직 정하지 않았다. 지금 규모에서는 필요 없어
// 항목 수가 실제로 커질 때 정한다.

// ── 관계 단계 문턱 — relationship.md 「단계 전이 절차」가 원본 ─────────────────
// 코드가 어제까지의 값을 세어 문턱을 재고, 넘길지는 모델이 정한다. 세는 자리와 판정 함수는
// relationship-stage.ts에 있다. 여기는 값만 둔다.

/** 1→2. 최소 체류와 대화한 날, 유저가 자기 얘기를 연 날. 유저가 먼저 건 날은 캐릭터가 매일
 * 아침 먼저 말을 거는 설계와 부딪혀 조건에서 뺐다(#393). */
export const STAGE_1_TO_2 = {
  stayDays: 5,
  talkedDays: 5,
  selfStoryDays: 3,
} as const;

/** 2→3. 최소 체류와 상대가 캐릭터 근황을 먼저 물은 날, 2단계에서 열린 플러팅의 반응 점수 평균
 * 하한, 호감 표현 횟수. 점수 표본이 하나도 없으면 평균 조건은 미충족이다. */
export const STAGE_2_TO_3 = {
  stayDays: 7,
  askedCharDays: 3,
  moveAvgMin: 0,
  affectionCount: 1,
} as const;

/** 3→4는 마음 확인 사건 하나가 조건이다. 사건이 없으면 3단계에서 이만큼 지나고 점수가
 * 양수일 때, 또는 점수와 무관하게 이만큼 지났을 때 고백 차례 표시를 새벽 정리 입력에 넣는다. */
export const STAGE_3_TO_4 = {
  confessionDueDays: 10,
  confessionDueDaysAnyScore: 20,
} as const;

/** 시도할 플러팅 추천에서 빼는 점수 하한과 그 판단에 필요한 표본 수. 표본이 이만큼 모이기 전에는
 * 점수가 낮아도 추천에서 빼지 않는다. */
export const MOVE_DROP_SCORE = -0.3;
export const MOVE_SAMPLE_MIN = 3;

/** 잘 통하는 플러팅으로 관계 표에 옮기는 점수 하한. 표본 수 조건은 MOVE_SAMPLE_MIN과 같다. */
export const RAPPORT_MOVE_SCORE = 0.3;

/** 탐색일 주기. 날짜 일련번호가 이 값으로 나누어떨어지는 날은 표본이 가장 적은 플러팅을 추천
 * 맨 앞에 둔다 — 점수가 좋은 플러팅만 되풀이해 나머지 플러팅의 표본이 영영 안 모이는 것을 막는다. */
export const MOVE_EXPLORE_EVERY = 5;
