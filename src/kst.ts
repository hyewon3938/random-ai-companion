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
  return "평일";
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

// 시각을 말로 풀어준다 — 모델이 "12:30" 같은 표기에서 시(12) 토큰에 끌려 분을 무시하는 오인이
// 있어서(12시 반인데 "곧 12시"라고 말하는 식), 반올림과 상대 표현을 코드가 미리 계산해 준다.
// 모델에게 시각 산수를 시키지 않는 것이 원칙이다.
export const kstVerbalTime = (): string => {
  const now = getKstNow();
  const h24 = now.getUTCHours();
  const m = now.getUTCMinutes();
  const label = (h: number): string =>
    h === 0
      ? "밤 12시"
      : h === 12
        ? "낮 12시"
        : `${h < 12 ? "오전" : "오후"} ${h % 12}시`;
  const cur = label(h24);
  const next = label((h24 + 1) % 24);
  const feel =
    m <= 5
      ? `${cur}가 막 지난 참`
      : m <= 20
        ? `${cur}대 초반`
        : m <= 39
          ? `${cur} 반쯤`
          : m <= 52
            ? `${next}가 가까워지는 때`
            : `거의 ${next}`;
  return `${cur} ${m}분 (${feel})`;
};

// messages.ts는 KST 벽시계 문자열("YYYY-MM-DD HH:MM:SS", bot.ts nowIso).
// UTC 필드가 KST 값을 갖는 Date로 되돌린다 — getKstNow()와 같은 좌표계라 이후 계산이 일관된다.
const kstDateOf = (ts: string): Date => new Date(`${ts.replace(" ", "T")}Z`);

// 임의 시각의 논리일(새벽 5시 경계). kstLogicalDate()의 '지금' 전용 버전을 일반화한 것.
export const logicalDateOf = (ts: string): string =>
  kstDateString(new Date(kstDateOf(ts).getTime() - 5 * 3600_000));

// 오늘(논리일)로부터 며칠 전인지. 자정이 아니라 새벽 5시가 경계라, 새벽 2시 대화는 아직 '오늘'이다.
export const logicalDaysAgo = (
  ts: string,
  todayLogical: string = kstLogicalDate(),
): number =>
  Math.round(
    (Date.parse(`${todayLogical}T00:00:00Z`) -
      Date.parse(`${logicalDateOf(ts)}T00:00:00Z`)) /
      86_400_000,
  );

// 마커를 새로 줄 만큼 시간이 벌어졌다고 보는 간격
const MARKER_GAP_MS = 60 * 60 * 1000;

// 대화 기록 턴 앞에 붙일 시간 표시. 앞 메시지와 시간이 벌어진 지점에만 준다(매 턴에 붙이면 노이즈).
// null이면 붙이지 않는다. 며칠 전인지는 코드가 세어 말로 준다 — 모델에게 날짜 뺄셈을 시키지 않는다.
export const timeMarkerFor = (
  ts: string,
  prevTs: string | null,
  todayLogical: string = kstLogicalDate(),
): string | null => {
  const newBlock =
    prevTs === null ||
    logicalDateOf(prevTs) !== logicalDateOf(ts) ||
    kstDateOf(ts).getTime() - kstDateOf(prevTs).getTime() >= MARKER_GAP_MS;
  if (!newBlock) return null;
  const clock = ts.slice(11, 16);
  const ago = logicalDaysAgo(ts, todayLogical);
  if (ago <= 0) return clock;
  if (ago === 1) return `어제 ${clock}`;
  if (ago === 2) return `그저께 ${clock}`;
  return `${ago}일 전(${DAYS[kstDateOf(ts).getUTCDay()]}) ${clock}`;
};

// 시스템 프롬프트용 — 마지막으로 대화한 날을 사람 말로. 마커와 달리 날짜를 함께 준다.
export const lastTalkedLabel = (
  ts: string,
  todayLogical: string = kstLogicalDate(),
): string => {
  const d = kstDateOf(ts);
  const date = `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${DAYS[d.getUTCDay()]}`;
  const ago = logicalDaysAgo(ts, todayLogical);
  const rel =
    ago <= 0
      ? "오늘"
      : ago === 1
        ? "어제"
        : ago === 2
          ? "그저께"
          : `${ago}일 전`;
  return `${rel}(${date}) ${ts.slice(11, 16)}`;
};
