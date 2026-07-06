const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const DAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

// UTC 필드가 KST 값을 갖도록 시프트한 Date (서버 타임존 독립)
export const getKstNow = (): Date => new Date(Date.now() + KST_OFFSET_MS);

export const kstDateString = (d: Date = getKstNow()): string =>
  d.toISOString().slice(0, 10);

export const kstDescription = (): string => {
  const now = getKstNow();
  const day = DAYS[now.getUTCDay()];
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  return `${now.getUTCFullYear()}년 ${now.getUTCMonth() + 1}월 ${now.getUTCDate()}일 (${day}) ${hh}:${mm}`;
};
