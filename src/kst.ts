const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const DAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

// UTC 필드가 KST 값을 갖도록 시프트한 Date (서버 타임존 독립)
export const getKstNow = (): Date => new Date(Date.now() + KST_OFFSET_MS);

export const kstDateString = (d: Date = getKstNow()): string =>
  d.toISOString().slice(0, 10);

// '하루'의 경계는 자정이 아니라 새벽 5시다(밤 정리 컷오프와 동일 — 자정~04:59는 전날에 속한다).
// 하루 단위 판단(팔로업 대상·선제 발송 카운트)은 달력일(kstDateString)이 아니라 이 논리일을 쓴다.
// 달력일로 "오늘 05:00:00"을 만들면 자정~새벽엔 미래 시각이 되어 비교 가드가 전부 죽는다.
export const kstLogicalDate = (): string =>
  kstDateString(new Date(getKstNow().getTime() - 5 * 3600_000));

// 논리일의 시작 타임스탬프 — messages.ts(KST 벽시계 "YYYY-MM-DD HH:MM:SS")와 사전순 비교용
export const logicalDayStartTs = (): string => `${kstLogicalDate()} 05:00:00`;

export const kstDescription = (): string => {
  const now = getKstNow();
  const day = DAYS[now.getUTCDay()];
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  return `${now.getUTCFullYear()}년 ${now.getUTCMonth() + 1}월 ${now.getUTCDate()}일 (${day}) ${hh}:${mm}`;
};

// 2026 한국 공휴일 (양력 고정일. 음력·대체공휴일은 확정되면 추가) — YYYY-MM-DD
const KR_HOLIDAYS = new Set<string>([
  "2026-01-01",
  "2026-03-01",
  "2026-05-05",
  "2026-06-06",
  "2026-08-15",
  "2026-10-03",
  "2026-10-09",
  "2026-12-25",
]);

export const dayLabel = (d: Date): string => {
  const dow = d.getUTCDay();
  if (KR_HOLIDAYS.has(kstDateString(d))) return "공휴일(휴무)";
  if (dow === 0 || dow === 6) return "주말(휴무)";
  return "평일(근무일, 아침 일찍 출근)";
};

// 오늘/내일이 근무일인지 — 밤에 잠을 챙길지 판단하는 근거
export const workdayContext = (): string => {
  const now = getKstNow();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return `오늘은 ${dayLabel(now)}, 내일은 ${dayLabel(tomorrow)}`;
};

export const todayLabel = (): string => dayLabel(getKstNow());

export const kstClock = (): string => {
  const now = getKstNow();
  return `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
};
