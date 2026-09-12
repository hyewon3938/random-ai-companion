// 시각을 다루는 자리 — 한국 시간, 논리일 경계, 공휴일 달력.
//
// 하루의 경계가 자정이 아니라 새벽 5시다. 자정을 넘겨 나눈 대화는 어제의 연장이지 새 날이
// 아니어서, 자정으로 끊으면 그 대화가 두 날에 쪼개져 기록된다. 날짜를 묻는 코드가 전부 이
// 모듈을 지나게 해서 경계를 한곳에서만 정한다.
//
// 공휴일도 같은 이유로 여기 하나에 둔다. 하루가 근무일인지 묻는 자리(하루 각본·답장 프롬프트·
// 월 리듬)가 저마다 날짜를 판단하면 같은 날이 자리마다 다르게 읽힌다.
//
// getKstNow()가 돌려주는 값은 UTC에 9시간을 더한 Date라, 경과 시간을 잴 때 쓰면 9시간이
// 어긋난다. 시간 차 계산은 Date.now()로 한다.

import {
  CONTACT_GAP_NOTICE_MS,
  CONTACT_GAP_LONGING_MS,
  CONTACT_GAP_OVERNIGHT_MS,
  DAY_BOUNDARY_HOUR,
  ENOUGH_SLEEP_HOURS,
  LATE_TALK_FROM,
  NIGHT_SLEEP_FROM,
  TIME_MARKER_GAP_MS,
} from "./thresholds.js";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const DAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

// UTC 필드가 KST 값을 갖도록 시프트한 Date (서버 타임존 독립)
export const getKstNow = (): Date => new Date(Date.now() + KST_OFFSET_MS);

export const kstDateString = (d: Date = getKstNow()): string =>
  d.toISOString().slice(0, 10);

// '하루'의 경계는 자정이 아니라 새벽 5시다(밤 정리 컷오프와 동일 — 자정~04:59는 전날에 속한다).
// 하루 단위 판단(팔로업 대상·선제 발송 카운트)은 달력일(kstDateString)이 아니라 이 논리일을 쓴다.
// 달력일로 "오늘 05:00:00"을 만들면 자정~새벽엔 미래 시각이 되어 비교 가드가 전부 죽는다.
const LOGICAL_DAY_SHIFT_MS = DAY_BOUNDARY_HOUR * 3600_000;
const DAY_START_HHMM = `${String(DAY_BOUNDARY_HOUR).padStart(2, "0")}:00:00`;

export const kstLogicalDate = (): string =>
  kstDateString(new Date(getKstNow().getTime() - LOGICAL_DAY_SHIFT_MS));

// 논리일의 시작 타임스탬프 — messages.ts(KST 벽시계 "YYYY-MM-DD HH:MM:SS")와 사전순 비교용
export const logicalDayStartTs = (): string =>
  `${kstLogicalDate()} ${DAY_START_HHMM}`;

export const kstDescription = (): string => {
  const now = getKstNow();
  const day = DAYS[now.getUTCDay()];
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  return `${now.getUTCFullYear()}년 ${now.getUTCMonth() + 1}월 ${now.getUTCDate()}일 (${day}) ${hh}:${mm}`;
};

// 한국의 관공서 공휴일 — 날짜(YYYY-MM-DD)마다 이름을 적는다. 설날·추석은 음력이고 대체공휴일은
// 요일에 따라 붙어서, 둘 다 규칙으로 계산할 수 없다. 선거일도 그해에 정해진다. 그래서 해마다
// 손으로 채우는 표이고, 안 채운 해가 오면 그해 공휴일이 통째로 빠진 채 평일로 읽힌다.
// 그것을 알리는 자리가 아래 holidayGapYear다.
//
// 이름까지 적는 것은 하루 이름표를 받는 쪽이 어느 공휴일인지 알아야 해서다. 월 리듬은 이 이름을
// 재료로 받아 명절 절차를 펼치고(이슈 #415), 하루 각본과 답장 프롬프트도 추석과 한글날을 같은
// 하루로 다루지 않는다.
//
// 근로자의날(5/1)은 넣지 않는다 — 관공서 공휴일이 아니라 근로자에게만 붙는 유급휴일이라,
// 직업이 자유 서술인 이 서비스에서 모든 캐릭터가 쉰다고 볼 수 없다.
const KR_HOLIDAYS: Record<string, string> = {
  "2026-01-01": "신정",
  "2026-02-16": "설날 연휴",
  "2026-02-17": "설날",
  "2026-02-18": "설날 연휴",
  "2026-03-01": "삼일절",
  "2026-03-02": "삼일절 대체공휴일",
  "2026-05-05": "어린이날",
  "2026-05-24": "부처님오신날",
  "2026-05-25": "부처님오신날 대체공휴일",
  "2026-06-03": "지방선거일",
  "2026-06-06": "현충일",
  "2026-07-17": "제헌절",
  "2026-08-15": "광복절",
  "2026-08-17": "광복절 대체공휴일",
  "2026-09-24": "추석 연휴",
  "2026-09-25": "추석",
  "2026-09-26": "추석 연휴",
  "2026-10-03": "개천절",
  "2026-10-05": "개천절 대체공휴일",
  "2026-10-09": "한글날",
  "2026-12-25": "성탄절",
};

const KR_HOLIDAY_YEARS = new Set(
  Object.keys(KR_HOLIDAYS).map((date) => date.slice(0, 4)),
);

export const dayLabel = (d: Date): string => {
  const dow = d.getUTCDay();
  const holiday = KR_HOLIDAYS[kstDateString(d)];
  if (holiday) return `${holiday}(휴무)`;
  if (dow === 0 || dow === 6) return "주말(휴무)";
  return "평일";
};

// "YYYY-MM"에 든 공휴일. 월 리듬이 달력만 아는 이벤트를 재료로 쓰는 자리다 — 명절은 아크나
// 진행 중인 일이 먼저 적어 주지 않아서, 이 목록이 없으면 추석이 든 달에도 명절 절차가 안 걸린다.
export const holidaysInMonth = (ym: string): { date: string; name: string }[] =>
  Object.entries(KR_HOLIDAYS)
    .filter(([date]) => date.startsWith(`${ym}-`))
    .map(([date, name]) => ({ date, name }));

// 공휴일 표가 그 달의 해를 안 덮으면 그 해를, 덮으면 null을 준다. 표를 손으로 채우다 보니
// 다음 해를 안 채운 채로 그 해의 달을 만들면 공휴일이 하나도 없는 한 달이 조용히 만들어진다.
// 월 리듬을 만드는 자리가 이 값을 보고 알린다.
export const holidayGapYear = (ym: string): string | null => {
  const year = ym.slice(0, 4);
  return KR_HOLIDAY_YEARS.has(year) ? null : year;
};

// 오늘/내일이 근무일인지 — 밤에 잠을 챙길지 판단하는 근거
export const workdayContext = (): string => {
  const now = getKstNow();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return `오늘은 ${dayLabel(now)}, 내일은 ${dayLabel(tomorrow)}`;
};

// 특정 날짜(YYYY-MM-DD)의 요일 표기. 각본은 만드는 시각이 아니라 각본이 담는 날짜를 기준으로
// 요일을 적어야 해서, 자정을 넘겨 만들 때도 이 함수를 쓴다.
export const dayLabelOf = (date: string): string =>
  dayLabel(new Date(`${date}T00:00:00Z`));

export const kstClock = (): string => {
  const now = getKstNow();
  return `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
};

// 하루 각본이 담는 하루는 05:00부터 다음 날 05:00까지다. 자정을 넘긴 시각은 24를 더해 적어서
// (02:30 → "26:30") 블록이 시간순으로 이어지게 만든다. 시가 늘 두 자리라 블록 경계와 문자열로
// 비교해도 순서가 맞고, 시 곱하기 60 더하기 분 계산도 그대로 이어진다.
export const kstLogicalClock = (): string => {
  const now = getKstNow();
  const h = now.getUTCHours();
  const hh = h < DAY_BOUNDARY_HOUR ? h + 24 : h;
  return `${String(hh).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
};

// 벽시계 문자열("YYYY-MM-DD HH:MM:SS")의 시각을 각본 표기로 옮긴다(02:30 → "26:30"). 각본 블록의
// 시작·끝과 같은 좌표로 놓고 뺄셈해야 자정을 넘긴 시각이 어긋나지 않는다.
export const logicalClockOf = (ts: string): string => {
  const h = Number(ts.slice(11, 13));
  const hh = h < DAY_BOUNDARY_HOUR ? h + 24 : h;
  return `${String(hh).padStart(2, "0")}:${ts.slice(14, 16)}`;
};

// 각본 표기를 사람이 읽는 시계 표기로 되돌린다(26:30 → 02:30). 프롬프트·슬랙처럼 사람이나
// 모델이 읽는 자리에만 쓰고, 저장 키로는 원래 표기를 그대로 둔다.
export const clockLabel = (hhmm: string): string => {
  const [h, m] = hhmm.split(":");
  const hn = Number(h);
  if (!Number.isFinite(hn) || hn < 24 || m === undefined) return hhmm;
  return `${String(hn - 24).padStart(2, "0")}:${m}`;
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
  kstDateString(new Date(kstDateOf(ts).getTime() - LOGICAL_DAY_SHIFT_MS));

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
    kstDateOf(ts).getTime() - kstDateOf(prevTs).getTime() >= TIME_MARKER_GAP_MS;
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

/** 유저 연락이 몇 만에 왔는지와, 기다렸다는 말을 얹어도 되는 텀인지. */
export interface ContactGap {
  /** 프롬프트에 그대로 들어가는 문구. */
  label: string;
  /** 오래 기다린 자리. 하루가 통째로 지난 텀과 날짜가 바뀐 텀이 여기 들어간다. */
  longing: boolean;
}

// 유저 연락이 캐릭터의 마지막 말에서 얼마 만에 온 건지 사람 말로. 짧은 틈은 화제가 아니라서
// 기준(CONTACT_GAP_NOTICE_MS) 이상일 때만 문구를 만든다(이슈 #284). 분 단위는 반 시간으로
// 뭉갠다 — 모델이 그 값을 그대로 말에 옮기는데, 4시간 27분 만이라고 하면 사람 말이 아니다.
//
// 날짜가 바뀐 자리는 잣대가 다르다(이슈 #316). 밤에 끝난 대화에 다음 날 아침 답이 오는 텀까지
// 화제로 삼으면 자고 일어날 때마다 기다렸다는 말이 나오므로, 하루가 통째로 지난 만큼
// (CONTACT_GAP_OVERNIGHT_MS) 벌어졌을 때만 적고 그 자리는 전부 긴 텀으로 친다.
export const contactGapOf = (
  lastCharTs: string,
  firstUserTs: string,
  minGapMs: number = CONTACT_GAP_NOTICE_MS,
): ContactGap | null => {
  const gap =
    kstDateOf(firstUserTs).getTime() - kstDateOf(lastCharTs).getTime();
  const halves = Math.round(gap / 1_800_000);
  const hours = Math.floor(halves / 2);
  const clock = firstUserTs.slice(11, 16);

  if (logicalDateOf(lastCharTs) !== logicalDateOf(firstUserTs)) {
    if (gap < CONTACT_GAP_OVERNIGHT_MS) return null;
    const days = logicalDaysAgo(lastCharTs, logicalDateOf(firstUserTs));
    const span = ["", "하루", "이틀", "사흘", "나흘"][days] ?? `${days}일`;
    return {
      label: `네가 ${lastTalkedLabel(lastCharTs, logicalDateOf(firstUserTs))}에 마지막으로 말한 뒤 상대 연락은 ${clock}에 왔다. ${span} 만이다.`,
      longing: true,
    };
  }

  if (gap < minGapMs) return null;
  const span = halves % 2 ? `${hours}시간 반` : `${hours}시간`;
  // 새벽에 온 연락은 캐릭터가 자던 시간이라 긴 텀으로 치지 않는다 — 논리일은 새벽 5시에 갈려서
  // 자정을 넘긴 연락도 같은 날로 들어온다.
  const daytime = firstUserTs.slice(11, 13) >= "05";
  return {
    label: `네가 ${lastCharTs.slice(11, 16)}에 마지막으로 말한 뒤 상대 연락은 ${clock}에 왔다. ${span} 만이다.`,
    longing: daytime && gap >= CONTACT_GAP_LONGING_MS,
  };
};

// 날짜 문자열을 며칠 옮긴다.
export const shiftDate = (date: string, days: number): string =>
  kstDateString(new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000));

// 각본 표기 시각을 그 논리일의 벽시계 문자열로 되돌린다. 24시 이상이면 다음 달력일이다.
export const logicalClockToTs = (date: string, hhmm: string): string => {
  const [h, m] = hhmm.split(":").map(Number);
  const day = h >= 24 ? shiftDate(date, 1) : date;
  return `${day} ${String(h % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
};

/** 어젯밤 잠 — 잠든 시각과, 거기서 충분히 잔 시간을 더한 시각. 둘 다 "HH:MM" 벽시계 표기. */
export interface NightSleep {
  bedtime: string;
  enoughSleepFrom: string;
}

// 어젯밤 몇 시에 잠들었는지와 몇 시 이후에 일어나야 충분히 잔 것인지. 피곤함은 늦게 잤는지가
// 아니라 잔 시간으로 정한다 — 평일에 2시에 자고 6시에 일어나면 피곤하고, 주말에 2시에 자도
// 10시에 일어나면 피곤하지 않다(이슈 #289). 잠든 시각은 어제 각본의 밤 잠 블록 시작과 어제
// 논리일 안 캐릭터의 마지막 말 중 늦은 쪽이다. 각본이 잠이라고 한 시각에 아직 대화 중이었으면
// 실제로는 그 뒤에 잔 것이고, 대화가 일찍 끝났으면 각본대로 잔 것이다. 저녁에 끝난 대화는 취침이
// 아니라 후보에서 뺀다. 둘 다 없으면 null이고, 부르는 쪽이 시드대로 간다.
export const nightSleepOf = (
  date: string,
  sleepStart: string | null,
  lastCharTs: string | null,
  hours: number = ENOUGH_SLEEP_HOURS,
): NightSleep | null => {
  const candidates: string[] = [];
  if (sleepStart && sleepStart >= NIGHT_SLEEP_FROM)
    candidates.push(logicalClockToTs(date, sleepStart));
  if (
    lastCharTs &&
    logicalDateOf(lastCharTs) === date &&
    logicalClockOf(lastCharTs) >= LATE_TALK_FROM
  )
    candidates.push(lastCharTs);
  if (!candidates.length) return null;
  const bedtime = candidates.sort().at(-1) as string;
  const wake = new Date(kstDateOf(bedtime).getTime() + hours * 3600_000);
  return {
    bedtime: bedtime.slice(11, 16),
    enoughSleepFrom: wake.toISOString().slice(11, 16),
  };
};

/**
 * 지금 시각을 저장용 문자열("YYYY-MM-DD HH:MM:SS", KST)로 만든다.
 *
 * messages·llm_calls·pending_replies가 같은 모양으로 시각을 적는다. 파일마다 따로 만들어
 * 쓰던 것을 한 자리로 모았다 — 모양이 어긋나면 문자열 비교로 순서를 매기는 자리가 깨진다.
 */
export const kstStamp = (): string =>
  getKstNow().toISOString().replace("T", " ").slice(0, 19);

/** 지금에서 ms만큼 앞선 시각을 같은 저장용 문자열로. 최근 몇 분·몇 시간 안의 기록을 찾는
 * 자리가 쓴다 — 경과 시간은 KST를 더한 Date로 재면 안 되고, 뺀 뒤에 문자열로 만들어야 한다. */
export const kstStampBefore = (ms: number): string =>
  new Date(getKstNow().getTime() - ms)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
