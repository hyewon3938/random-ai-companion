// 하루 각본 — 캐릭터가 그날 무엇을 하는지 블록으로 만든다.
//
// 새벽 정리가 다음 날 것을 미리 만들고, 없는 상태에서 대화가 먼저 오면 그 자리에서 만든다.
// 담는 하루는 논리일 05:00~28:59다. 자정을 넘긴 시각은 24를 더해 적고(00:30은 24:30),
// 사람이 읽는 자리에서 clockLabel이 되돌린다.
//
// 블록마다 답장 여건(instant·intermittent·unavailable)과 활동 성격(personal·social·official)이
// 붙는다. 두 축은 직교한다. 저장은 영어 식별자로 하고 한국어 이름은 labels.ts가 붙인다.
// 성격이 비어 있거나 정해진 세 값 밖이면 blockCategory가 활동 이름으로 추론한다 — 회의·시험·
// 발표·업무는 공적, 친구·가족·병원·학원·회식은 사회, 나머지 혼자 하는 일은 개인.
//
// 그날 컨디션은 월 리듬에 미리 정해 둔 시드를 읽어 기상 시각과 활동으로 잇는다.
// 어제 일기에 남은 실제 여파가 시드보다 우선한다.
//
// 며칠에 걸쳐 하는 일(진행 중인 일)은 캐릭터 쪽이면서 유저가 이미 아는 것만 각본에 넣는다.
// 프롬프트 줄 앞에 기억 행 번호를 붙이고, 그 줄에서 펼친 블록은 source "ongoing"과 그 번호를
// 갖는다 — 새벽 정리가 어제 각본에서 이 블록을 찾아 그 일의 값을 한 걸음 옮긴다(이슈 #276).
// 유저에게 한 번도 말하지 않은 일은 기억으로만 두고 각본으로 굴리지 않는다.
//
// 유저와는 메시지로만 이어진 사이라 유저와 만나는 블록은 만들지 않는다. 유저가 하루에 들어오는
// 자리는 메시지를 보내거나 답하는 시간뿐이다(이슈 #322).
//
// 자리를 비우는 불가 구간(잠 제외)은 밀도를 관계 국면으로 조절한다(이슈 #335). 알리고 나가는 긴
// 구간은 없는 날이 기본이고, 관계 단계가 1이거나 만난 지 한 달이 안 된 초반에는 출퇴근처럼 뺄 수
// 없는 것만 하루 1개까지 둬 유저가 마음을 붙일 틈을 끊지 않는다. 그 뒤에는 하루 0~2개로 날마다
// 달라 가끔 비는 자리가 그리워할 틈이 된다. 한 구간은 40분까지이고 더 긴 운동은 중간에 폰을 보는
// 틈으로 나눈다. 시험·면접·발표 같은 공적 일은 길이 제한이 없고, 영화관·공연 같은 확정 일정은
// 관계가 쌓인 뒤에만 실제 길이대로 둔다. 짧은 구간의 개수·합과 구간 사이 간격에도 상한이 있다.
// 프롬프트가 그날 국면의 값을 말하고, 만든 각본은 awayStats로 다시 세어 봇 안 생성은 어기면 한 번
// 더 만들고, 외부 생성분은 기록만 남긴다. 아침 게시가 그 셈을 보인다.

import { chatJson } from "./llm.js";
import { config } from "./config.js";
import {
  getDayPlan,
  getDayPlanMadeBy,
  saveDayPlan,
  getUpcomingSchedules,
  getArcs,
  getRecentDiaries,
  getDaySeed,
  getCharacterChatId,
  getMetAt,
  getStage,
  lastCharMessageTsBetween,
  listMemoryItems,
  type DaySeed,
  type MemoryRow,
  type ScheduleRow,
} from "./db.js";
import {
  alwaysIncluded,
  orderedIdentity,
  identityValue,
  memoryLine,
} from "./memory.js";
import { ensureRhythmRunway } from "./life-plan.js";
import {
  kstLogicalDate,
  dayLabelOf,
  logicalDaysAgo,
  shiftDate,
  nightSleepOf,
  type NightSleep,
} from "./kst.js";
import {
  AWAY_BLOCK_MAX_MIN,
  AWAY_DAILY_MAX,
  AWAY_EARLY_DAILY_MAX,
  AWAY_EARLY_DAYS,
  AWAY_GAP_MIN,
  AWAY_MIN_BLOCK_MIN,
  AWAY_SHORT_DAILY_MAX,
  AWAY_SHORT_TOTAL_MAX_MIN,
  PLAN_ONGOING_MAX,
} from "./thresholds.js";
import {
  toResponsiveness,
  toActivityCategory,
  toBlockSource,
  type Responsiveness,
  type ActivityCategory,
  type BlockSource,
} from "./labels.js";

// 하루 각본: 시스템이 캐릭터의 하루를 시간 블록으로 미리 짜둔다.
// 캐릭터는 이걸 계획표로 의식하지 않고, 그 시간이 되면 자기가 하고 싶어서 하는 일로 산다.
// 지금은 그날 첫 대화 때 생성(lazy). 밤 응고가 생기면 전날 새벽에 다음날 각본을 미리 생성하는 방식으로 이관.

export interface PlanBlock {
  start: string; // "HH:MM"
  end: string;
  activity: string;
  responsiveness: Responsiveness;
  advance_known: boolean; // 미리 아는 일정(회식 약속 등) vs 닥쳐야 아는 일(급 바빠짐 등)
  // 활동 성격: 유저가 찾을 때 얼마나 조정 가능한가. '답장 여건'과 직교하는 별개 축.
  //   개인 = 혼자 자의로 하는 일(운동·집 여가·영화·장보기·혼밥). 쉽게 접거나 미룬다.
  //   사회 = 남이 엮인 사적 일(친구 약속·가족·병원·학원·친목 회식). 즉시는 아니어도 양해 구해 조정 가능.
  //   공적 = 미룰 수 없는 공적 의무(업무·회의·시험·발표·공적 회식). 접을 수 없다.
  // 옵셔널 — 없거나 모르는 값이면 activity로 추론(blockCategory). 구 각본·외부 생성분과 호환.
  category?: ActivityCategory;
  // 출처: 이 블록이 어느 원본을 그날치로 펼친 것인가.
  //   schedule = 예정된 일 한 건(source_id가 그 행 번호) / routine = 매주 루틴(되짚을 행이 없어 번호 없음)
  // 유저가 붙잡을 때 붙잡기 판정이 이 값을 따라 원본 일정을 읽고, 유저가 아는 일인지 본다.
  // 옵셔널 — 어느 원본에서도 나오지 않은 블록(잠·식사·그날 갑자기 생긴 일)에는 붙지 않고,
  // 필드가 없는 구 각본·외부 생성분과도 호환된다(없으면 무시).
  source?: BlockSource;
  source_id?: number; // source="schedule"인 블록에만. schedules.id
  // 각본에 이 시각을 덮는 블록이 없어 코드가 메운 자리(context.ts의 dayProgress). 저장된
  // 각본에는 들어가지 않고 읽는 자리에서만 붙어서, 트레이스가 각본에 있던 일과 갈라 볼 수 있다.
  fallback?: boolean;
}

// 공적 의무(못 미룸, 대개 폰도 불가) 키워드.
const OFFICIAL_HINT =
  /회의|미팅|근무|업무|출근|출장|발표|시험|면접|세미나|공적/;
// 남이 엮인 사적 일(조정 가능·연락은 틈틈이) 키워드.
const SOCIAL_HINT =
  /친구|약속|동기|동료|가족|부모|엄마|아빠|형|누나|언니|동생|병원|학원|모임|회식|데이트|만남|결혼식|장례|전화/;

// 이 블록의 활동 성격. 명시값 우선, 없으면 activity로 추론. 공적 > 사회 > 개인 순으로 본다.
// 잠·기상·준비 등 혼자 하는 일은 개인.
// 명시값도 정해진 세 값일 때만 앞선다 — 각본은 모델이 만들고 plan_json은 DB가 검사하지 않아
// 저장된 블록에도 세 값 밖의 글자가 들어 있을 수 있다. 그대로 돌려주면 답장 텀 표와 이름표가
// 모르는 값을 받는다(이슈 #319). 그래서 여기서도 toActivityCategory로 거르고, 못 알아보면
// 활동 이름 추론으로 내려간다. 받는 타입을 string으로 열어 둔 것도 같은 이유다.
export const blockCategory = (b: {
  activity: string;
  category?: string;
}): ActivityCategory => {
  const named = toActivityCategory(b.category);
  if (named) return named;
  const a = b.activity;
  if (OFFICIAL_HINT.test(a)) return "official";
  if (SOCIAL_HINT.test(a)) return "social";
  return "personal";
};

export interface DayPlan {
  date: string;
  blocks: PlanBlock[];
}

// 자리 비움 예고·구간 끝 몰아 답장의 대상이 되는 불가 블록 — 실제로 자리를 비우거나 손이
// 묶이는 일. 잠은 제외(굿나잇·잠 정책이 따로 담당한다).
export const isAwayUnavail = (b: PlanBlock): boolean =>
  b.responsiveness === "unavailable" && !/잠|수면|숙면/.test(b.activity);

// 잠 블록 — 답장 텀 판정(reply-timing)과 지금 상황 문단(context)이 같은 기준으로 잠을 가린다.
// 활동 이름이 "잠·수면·숙면"이고 답장 여건이 불가면 잠이다. "잘 준비"처럼 준비 단계는 아직 깨어 있다.
export const isSleeping = (b: {
  activity: string;
  responsiveness: string;
}): boolean =>
  toResponsiveness(b.responsiveness) === "unavailable" &&
  /잠|수면|숙면/.test(b.activity) &&
  !/준비/.test(b.activity);

// ── 자리 비움 밀도(이슈 #335) ───────────────────────────────────────────────

/** 자리 비움 상한을 정하는 관계 국면. 단계가 1이거나 만난 지 AWAY_EARLY_DAYS일이 안 됐으면
 * 초반이다. days는 만난 날을 0으로 센 날수다. */
export interface AwayPhase {
  early: boolean;
  stage: number;
  days: number;
}

export const awayPhaseOf = (characterId: number, date: string): AwayPhase => {
  const stage = getStage(characterId)?.stage_no ?? 1;
  const metAt = getMetAt(characterId);
  const days = metAt ? Math.max(0, logicalDaysAgo(metAt, date)) : 0;
  return { early: stage <= 1 || days < AWAY_EARLY_DAYS, stage, days };
};

/** 그 국면에서 각본이 지킬 상한. 긴 구간(AWAY_MIN_BLOCK_MIN 이상)은 알리고 나가는 자리라
 * 개수를 국면으로 조절한다. 개수는 최대치이고 없는 날이 기본이다. 한 구간의 길이, 짧은 구간,
 * 간격은 국면과 상관없다. */
export interface AwayCaps {
  longMax: number;
  longBlockMaxMin: number;
  shortMax: number;
  shortTotalMaxMin: number;
  gapMin: number;
}

export const awayCapsOf = (phase: AwayPhase): AwayCaps => ({
  longMax: phase.early ? AWAY_EARLY_DAILY_MAX : AWAY_DAILY_MAX,
  longBlockMaxMin: AWAY_BLOCK_MAX_MIN,
  shortMax: AWAY_SHORT_DAILY_MAX,
  shortTotalMaxMin: AWAY_SHORT_TOTAL_MAX_MIN,
  gapMin: AWAY_GAP_MIN,
});

/** 길이 상한을 받지 않는 불가 구간. 시험·면접·발표처럼 자리를 뜰 수 없는 공적 일은 언제나
 * 실제 길이대로 두고, 영화관·공연처럼 확정 일정에서 나온 구간은 관계가 쌓인 뒤에만 그렇다.
 * 초반에는 상대가 먼저 권한 것이 아니면 그런 일정을 각본에 넣지 않는 것이 규칙이라 상한을 받는다.
 * 개수 상한은 예외 없이 다 센다. */
export const awayLengthExempt = (b: PlanBlock, phase: AwayPhase): boolean =>
  blockCategory(b) === "official" || (!phase.early && b.source === "schedule");

/** 각본 하나의 자리 비움 셈. 잠은 빼고 센다. longCapped는 길이 상한을 받는 긴 구간의 이름과
 * 길이, longExempt는 상한을 안 받는 긴 구간의 수다. minGapMin은 불가 구간 사이에 있는 답할 수
 * 있는 시간 중 가장 짧은 것이고, 불가 구간이 하나 이하면 null이다. */
export interface AwayStats {
  long: number;
  longestMin: number;
  longCapped: { activity: string; min: number }[];
  longExempt: number;
  short: number;
  shortMin: number;
  awayMin: number;
  minGapMin: number | null;
}

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const durationOf = (b: PlanBlock): number =>
  Math.max(0, minutesOf(b.end) - minutesOf(b.start));

export const awayStats = (plan: DayPlan, phase: AwayPhase): AwayStats => {
  const s: AwayStats = {
    long: 0,
    longestMin: 0,
    longCapped: [],
    longExempt: 0,
    short: 0,
    shortMin: 0,
    awayMin: 0,
    minGapMin: null,
  };
  // 마지막 불가 구간 뒤로 쌓인 답할 수 있는 시간. 아직 불가 구간을 못 만났으면 null.
  let gap: number | null = null;
  for (const b of plan.blocks) {
    const dur = durationOf(b);
    if (!isAwayUnavail(b)) {
      if (gap !== null) gap += dur;
      continue;
    }
    if (gap !== null)
      s.minGapMin = s.minGapMin === null ? gap : Math.min(s.minGapMin, gap);
    gap = 0;
    s.awayMin += dur;
    if (dur >= AWAY_MIN_BLOCK_MIN) {
      s.long += 1;
      s.longestMin = Math.max(s.longestMin, dur);
      if (awayLengthExempt(b, phase)) s.longExempt += 1;
      else s.longCapped.push({ activity: b.activity, min: dur });
    } else {
      s.short += 1;
      s.shortMin += dur;
    }
  }
  return s;
};

/** 상한을 어긴 것을 사람이 읽는 줄로. 비어 있으면 다 지킨 것이다. 다시 만들 때 프롬프트에
 * 그대로 붙이고, 아침 게시에도 올린다. */
export const awayViolations = (stats: AwayStats, caps: AwayCaps): string[] => {
  const out: string[] = [];
  if (stats.long > caps.longMax)
    out.push(
      `${AWAY_MIN_BLOCK_MIN}분 이상 불가 구간이 ${stats.long}개 (상한 ${caps.longMax}개)`,
    );
  const over = stats.longCapped.filter((c) => c.min > caps.longBlockMaxMin);
  if (over.length)
    out.push(
      `한 구간이 ${caps.longBlockMaxMin}분을 넘는 불가 구간: ${over.map((c) => `${c.activity} ${c.min}분`).join(", ")} (중간에 폰을 보는 틈을 넣어 나눈다)`,
    );
  if (stats.short > caps.shortMax)
    out.push(
      `${AWAY_MIN_BLOCK_MIN}분 미만 불가 구간이 ${stats.short}개 (상한 ${caps.shortMax}개)`,
    );
  if (stats.shortMin > caps.shortTotalMaxMin)
    out.push(
      `${AWAY_MIN_BLOCK_MIN}분 미만 불가 구간의 합이 ${stats.shortMin}분 (상한 ${caps.shortTotalMaxMin}분)`,
    );
  if (stats.minGapMin !== null && stats.minGapMin < caps.gapMin)
    out.push(
      `불가 구간 사이에 답할 수 있는 시간이 ${stats.minGapMin}분 (최소 ${caps.gapMin}분)`,
    );
  return out;
};

export interface AwayCheck {
  phase: AwayPhase;
  caps: AwayCaps;
  stats: AwayStats;
  violations: string[];
}

/** 정규화한 각본이 그날 국면의 상한을 지켰는지. 저장하는 두 자리(봇 안 생성·외부 생성분)와
 * 아침 게시가 같은 셈을 쓴다. */
export const checkPlanAway = (
  characterId: number,
  date: string,
  plan: DayPlan,
): AwayCheck => {
  const phase = awayPhaseOf(characterId, date);
  const caps = awayCapsOf(phase);
  const stats = awayStats(plan, phase);
  return { phase, caps, stats, violations: awayViolations(stats, caps) };
};

/** 아침 게시와 로그에 올리는 한 줄. */
export const awaySummary = (c: AwayCheck): string => {
  const phase = c.phase.early
    ? `관계 초반(${c.phase.stage}단계, 만난 지 ${c.phase.days}일째)`
    : `${c.phase.stage}단계, 만난 지 ${c.phase.days}일째`;
  const longCap = `상한 ${c.caps.longMax}개·한 구간 ${c.caps.longBlockMaxMin}분${c.stats.longExempt ? `, 길이 제한 없는 공적·일정 구간 ${c.stats.longExempt}개` : ""}`;
  const longest = c.stats.long ? ` · 가장 긴 것 ${c.stats.longestMin}분` : "";
  return `자리 비움: ${AWAY_MIN_BLOCK_MIN}분 이상 ${c.stats.long}개(${longCap})${longest} · 미만 ${c.stats.short}개 ${c.stats.shortMin}분(상한 ${c.caps.shortMax}개 ${c.caps.shortTotalMaxMin}분) · 잠 빼고 ${c.stats.awayMin}분 · ${phase}`;
};

/** 생성 프롬프트의 자리 비움 규칙. 국면에 따라 상한 숫자와 까닭이 달라진다. 봇 안 생성은
 * planPrompt에 넣고, 외부 생성 경로는 새벽 수집 입력의 awayRule로 같은 줄을 받는다. */
export const awayRuleLines = (phase: AwayPhase): string => {
  const caps = awayCapsOf(phase);
  const phaseLine = phase.early
    ? `지금은 ${phase.stage}단계이고 만난 지 ${phase.days}일째인 관계 초반이라 상대가 부르면 답할 수 있는 시간이 중요하다. 운전 출퇴근처럼 정해져 있어 뺄 수 없는 일이 있으면 하루 ${caps.longMax}개까지 두고, 쉬는 날에는 그것도 없어도 된다. 영화관·공연처럼 오래 묶이는 여가는 상대가 먼저 권한 것이 아니면 초반에는 각본에 넣지 않는다. 생활을 없애라는 뜻은 아니고, 하던 일은 그대로 두되 폰을 볼 수 있는 방식으로 한다.`
    : `${phase.stage}단계이고 만난 지 ${phase.days}일째라 관계가 쌓였으니, 상대가 그리워할 틈이 생기도록 가끔 자리를 비우는 날이 있어도 된다. 그래도 매일 두지는 않고, 하나도 없는 날과 ${caps.longMax}개까지 있는 날이 섞이게 한다. 영화관·공연처럼 오래 묶이는 확정 일정은 실제 길이대로 둔다.`;
  const exempt = phase.early
    ? "시험·면접·발표처럼 자리를 뜰 수 없는 공적 일만"
    : "시험·면접·발표처럼 자리를 뜰 수 없는 공적 일과 확정 일정의 영화관·공연만";
  return [
    `- 하루의 기본은 답할 수 있는 상태다. 근무·이동·집안일·식사·장보기·집에서 하는 여가는 폰을 곁에 두고 하는 일이라 "intermittent"이고, "unavailable"은 손이나 정신이 진짜로 묶인 때만이다. 저녁이 즉답으로만 이어지는 것을 피하려고 불가 구간을 만들지 않는다. 저녁의 변화는 "intermittent"로 준다.`,
    `- ${AWAY_MIN_BLOCK_MIN}분 이상 자리를 비우는 불가 구간(잠 제외)은 나가기 전에 상대에게 알리고 가는 자리라, 없는 날이 기본이다. ${phaseLine}`,
    `- 긴 불가 구간이라도 한 구간은 ${caps.longBlockMaxMin}분을 넘기지 않는다. 1시간짜리 운동이나 수업처럼 더 길게 손이 묶이는 일은 중간에 폰을 보는 틈("intermittent", ${caps.gapMin}분 이상)을 넣어 두 구간으로 나눈다. ${exempt} 실제 길이대로 둔다.`,
    `- ${AWAY_MIN_BLOCK_MIN}분 미만의 짧은 불가 구간(씻기·운전·통화, 나눈 운동의 조각)은 알리지 않고 다녀오는 자리라, 하루 ${caps.shortMax}개, 합쳐서 ${caps.shortTotalMaxMin}분까지만 둔다.`,
    `- 불가 구간끼리 붙이지 않는다. 짧든 길든 두 불가 구간 사이에는 답할 수 있는 구간("instant" 또는 "intermittent")을 최소 ${caps.gapMin}분 둔다. 운동 뒤에 귀가 운전과 씻기를 바로 이어 붙이면 상대는 알린 시간보다 훨씬 오래 기다린다. 도착해서 정리하는 시간을 사이에 넣는다.`,
  ].join("\n");
};

// trace.ts가 슬랙에 각본 생성 프롬프트를 올릴 때도 이 시스템 문장을 함께 보여준다.
export const PLAN_SYSTEM = `너는 한 인물의 하루 흐름을 짜는 작가다. 과장 없이, 실제 그 직업과 성격의 사람이 보낼 법한 평범한 하루를 시간 블록으로 만든다. 루틴이 기본이고 변화는 잔잔하게 준다.`;

// 그날 확정 일정 한 줄. 줄 앞에 그 일정의 행 번호를 붙인다 — 생성이 그 줄을 블록으로 펼치면
// source_id에 이 번호를 그대로 적어, 나중에 블록에서 원본 일정을 되짚을 수 있다.
const scheduleLine = (s: ScheduleRow): string =>
  `- [${s.id}] ${s.time_hint ? `${s.time_hint} ` : ""}${s.content}`;

// 며칠에 걸쳐 하는 일 한 줄. 각본에는 캐릭터 쪽 항목만 들어가서 누구 일인지 적을 자리가 없다.
// 줄 앞의 행 번호는 일정 줄과 같은 구실이다 — 이 줄에서 펼친 블록이 source_id에 그대로 적는다.
// 끝나는 조건을 값과 함께 적는다 — 조건이 이미 채워진 일을 오늘 또 하는 각본이 나오지 않게.
const ongoingLine = (r: MemoryRow): string =>
  `- [${r.id}] ${r.area}/${r.subject}: ${r.value}${r.end_condition ? ` (끝나는 조건: ${r.end_condition})` : ""}`;

/**
 * 각본에 넣을 진행 중인 일. 캐릭터 쪽이면서 유저가 이미 아는 것만, 최근에 손댄 것부터
 * PLAN_ONGOING_MAX까지. 같은 키에 생성 행과 대화 행이 나란히 있으면 대화 행이 지금 값이다.
 * 새벽 정리가 봇 밖 경로에 같은 목록을 넘길 때도 이 함수를 쓴다.
 */
export const planOngoingRows = (characterId: number): MemoryRow[] => {
  const byKey = new Map<string, MemoryRow>();
  for (const r of listMemoryItems(characterId, "ongoing")) {
    if (r.owner !== "char" || r.user_knows !== "known") continue;
    const k = `${r.area}/${r.subject}`;
    const cur = byKey.get(k);
    if (cur && !(cur.origin !== "conversation" && r.origin === "conversation"))
      continue;
    byKey.set(k, r);
  }
  return [...byKey.values()].slice(0, PLAN_ONGOING_MAX);
};

export const planOngoingLines = (characterId: number): string =>
  planOngoingRows(characterId).map(ongoingLine).join("\n");

// 진행 중인 일 절. 없는 날에는 머리말째로 빠진다 — 다른 절처럼 "(없음)"을 적어 두면
// 며칠에 한 번 손대는 일이 오늘은 없다는 것과 아예 없다는 것이 같은 글자로 보인다.
const ongoingSection = (ongoing: string): string =>
  ongoing
    ? `\n[진행 중인 일 — 며칠에 걸쳐 이어 하는 일. 오늘 손댈 만한 것이 있으면 그 다음 한 걸음을 블록으로 넣는다. 끝나는 조건이 이미 채워진 일은 넣지 않는다. 매일 손대는 일은 아니니 오늘 몫이 없으면 넣지 않아도 된다. 넣은 블록에는 source "ongoing"과 줄 앞 [번호]를 적는다]\n${ongoing}\n`
    : "";

// 어젯밤 잠 절. 잠든 시각과 충분히 잔 기준 시각을 주고, 기상 시각을 그 기준과 견줘 피곤한지
// 정하게 한다. 시각 산수는 코드가 끝냈고 모델은 견주기만 한다.
const nightSleepLine = (n: NightSleep | null): string =>
  n
    ? `- 어젯밤 ${n.bedtime}에 잠들었다. 오늘 기상 시각이 ${n.enoughSleepFrom}보다 이르면 잠이 모자란 아침이라 피곤하고, ${n.enoughSleepFrom} 이후면 늦게 잤어도 충분히 잔 것이라 피곤해하지 않는다.`
    : "(어젯밤 기록 없음 — 시드대로)";

const seedLine = (seed: DaySeed | undefined): string => {
  if (!seed) return "(없음 — 평범한 컨디션으로)";
  return `기력=${seed.energy}, 기상 성향=${seed.wake_hint}, 기분=${seed.mood}${seed.reason ? ` (이유: ${seed.reason})` : ""}`;
};

const planPrompt = (
  persona: string,
  sleep: string | null,
  weeklyRoutine: string | null,
  date: string,
  label: string,
  schedules: string,
  ongoing: string,
  arcs: string,
  diary: string,
  seed: DaySeed | undefined,
  lastNight: NightSleep | null,
  phase: AwayPhase,
): string => `아래 인물의 ${date} (${label}) 하루를 시간 블록으로 짜줘.

[인물 — 같은 항목이 두 줄이면 아래쪽이 최신]
${persona || "(없음)"}

[생활 리듬 — 시간표의 기준. 여기 없는 시각·습관을 지어내지 않는다]
- 잠: ${sleep ?? "(값 없음 — 무리 없는 일반적인 수면으로)"}
- 매주 루틴: ${weeklyRoutine ?? "(없음)"}

[오늘의 컨디션 시드 — 미리 정해진 오늘의 몸 상태·기상 성향]
${seedLine(seed)}

[어젯밤 잠 — 오늘 피곤한지는 이 값으로 정한다]
${nightSleepLine(lastNight)}

[이 날의 확정 일정 — 있으면 반드시 하루에 자연스럽게 반영 (advance_known=true). 줄 앞의 [번호]는 그 일정의 번호다]
${schedules || "(없음)"}
${ongoingSection(ongoing)}
[삶의 큰 흐름 — 하루의 결에 은은하게 반영]
${arcs || "(없음)"}

[어제의 일기 — 여운·컨디션이 자연스럽게 이어지게. 어제 이미 한 구체적인 것(특정 영화·책 제목 등)은 오늘 또 반복하지 않는다 — 봤던 건 봤고, 오늘은 다른 걸 하거나 새 제목으로]
${diary || "(없음)"}

[컨디션→기상→활동을 하나로 잇기]
- 위 컨디션 시드가 오늘의 바탕이다. 기력이 낮으면 기상이 흐트러지고(못 자서 너무 일찍 깨거나, 뻗어서 늦잠) 활동량이 준다(운동 거름·저녁 일찍 뻗음). 기력이 높으면 개운하게 제때 일어나 활동이 는다(운동 챙김·저녁도 활기).
- 단, 어제 일기에 회식·술 같은 실제 여파가 있으면 그게 시드보다 우선이다. 늦게 잔 것은 위 [어젯밤 잠]의 시각으로만 잰다 — 기상 시각이 그 기준보다 이르면 시드가 '보통'이어도 피곤한 아침이고, 기준 이후면 늦게 잤어도 피곤하지 않다. 일기에 새벽까지 대화했다고 적혀 있어도 이 시각 비교가 우선이다.

[원칙]
- 근무일이면: 기상·취침 시각은 위 [생활 리듬]의 잠 값이 기준이고, 컨디션 시드가 그날의 시각을 정한다 — '보통'이면 기준대로, '이른'이면 기준보다 일찍 눈이 떠지고, '늦잠'이면 기준을 놓쳐 허둥지둥한 아침. 출퇴근 방식·근무 형태·점심·퇴근 시각 같은 하루의 뼈대는 [인물]의 직업·생활 값에서 뽑는다. 저녁은 [생활 리듬]의 매주 루틴 중 그 요일 몫과 [인물]의 취향에서 — 루틴 활동도 그날 컨디션·사정에 따라 건너뛰거나 시간이 밀린다.
- 쉬는 날(주말·공휴일)이면: 늦잠, 밀린 잠·집안일과 이 사람 취향의 여가로 여유로운 흐름. 매주 루틴 중 그 요일 것이 있으면 넣는다.
- 이벤트 1~3개를 배치(들쭉날쭉하게 — 이벤트 많은 날도 없는 날도 있다). 두 종류가 있다:
  - 미리 아는 일정 (advance_known=true): 점심 회식, 팀원과 저녁 약속, 퇴근 후 서점 들르기 같은 예정된 일
  - 닥쳐야 아는 일 (advance_known=false): 오후에 갑자기 바빠짐, 급한 업무, 예정에 없던 호출, 갑자기 마트에 감, 친구의 급한 전화 같은 그때 가서야 겪는 일 — 이런 갑작스러운 일을 하루 한둘은 자연스럽게 껴 넣는다.
  - 그래도 아무 이벤트 없는 평범한 날도 가끔은 자연스럽다.
- 상대(메시지를 주고받는 사람)와는 메시지로만 이어진 사이라 실제로 만날 수 없다. 상대와 만나는 블록(같이 밥·영화·산책, 상대 집 방문, 상대가 오는 자리)은 만들지 않는다. 상대가 하루에 들어오는 자리는 메시지를 보내거나 답하는 시간뿐이다. 위 [이 날의 확정 일정]에 상대와 만나는 줄이 있으면 그건 대화에서 잡힌 것이니 그 줄만 따르고, 여기서 새로 지어내지 않는다.
${awayRuleLines(phase)}
- 각 블록의 responsiveness = 그 시간에 메신저 답장을 얼마나 할 수 있는가. 값은 셋 중 하나:
  - "instant"(즉답 — 쉬는 중·대화 시간) / "intermittent"(틈틈이 — 근무·이동·집안일·장보기처럼 틈틈이 볼 수 있음) / "unavailable"(불가 — 손이나 정신이 묶여 못 봄).
  - "unavailable"은 손이나 정신이 진짜로 묶인 때만: 통화(전화 받는 중)·운전·공식 회의·운동·씻기·영화관·잠.
  - **공적 "unavailable"은 회의·시험·면접·발표처럼 자리를 뜰 수 없는 일에만 쓴다.** 회의·급한 처리처럼 쉬는 틈을 낼 수 있는 일은 한 블록 최대 1시간이고, 더 길면 블록을 쪼개 사이에 "intermittent"(잠깐 폰 보는 틈) 구간을 넣는다. 시험·면접·발표는 실제 길이대로 둔다. (원래 틈틈이 폰을 볼 수 있는 업무는 해당 없음.)
  - **성격이 다른 일을 한 "unavailable" 블록으로 묶지 않는다.** 두 일 사이에 폰을 볼 수 있는 시간이 있으면 블록을 나누고 그 사이를 "instant"로 둔다. 예를 들어 퇴근 운전과 집에 와서 씻기는 사이에 도착해서 짐을 내려놓는 시간이 있으므로 "퇴근 운전"(unavailable) / "집 도착해서 정리"(instant, 10분쯤) / "씻기"(unavailable) 세 블록이다. 통째로 묶으면 상대가 "집 도착하면 연락 줘"라고 해도 답할 시간이 하루 안에 없어진다. 활동 이름에 '~하고 ~하기'처럼 두 일이 들어가면 나눠야 하는 신호다.
  - **사교 자리(친구 약속·회식·모임)는 "unavailable"이 아니라 "intermittent"다** — 사람들과 있어도 폰은 틈틈이 본다. 다만 회식은 텀이 더 길고(자리를 오래 못 뜸), 친구 약속은 대체로 틈틈이 보지만 가끔 텀이 길어진다.
  - **집에서 하는 여가는 "unavailable"이 아니라 "intermittent"다** — 집에서 영화·드라마(OTT)·독서·집안일·가계부는 폰을 곁에 두고 하므로 틈틈이 답할 수 있다. 영화라도 '영화관에 감'만 "unavailable"이고 '집에서 봄'은 "intermittent".
  - **실제로 자는 시간(잠)만 밤의 "unavailable"이다. '취침 준비·잠자리에 들기'(누워서 폰 보며 뒹굴대는 시간)는 "instant".** 저녁~취침 전은 대화 시간이라 대체로 "instant".
- 하루는 새벽 5시에 시작해 다음 날 새벽 5시에 끝난다. 블록은 05:00~28:59 안에서 시간순으로 빈틈 없이 채운다.
  - 자정을 넘긴 시각은 24를 더해 적는다: 00:30은 "24:30", 새벽 2시는 "26:00", 하루의 끝은 "29:00".
  - 전날 밤부터 이어지는 잠이 아직 안 끝났으면 05:00부터 기상 시각까지 잠 블록으로 시작한다.
  - 밤에 잠드는 시각부터 다음 날 새벽 5시까지도 잠 블록으로 채운다(예: 24:20~29:00).

- 각 블록의 category = 활동의 성격(답장 여건과 별개의 축 — 유저가 찾을 때 얼마나 조정 가능한가). 값은 셋 중 하나:
  - "personal"(개인) = 혼자 자의로 하는 일(운동·집 여가·영화·독서·장보기·산책·혼밥·낮잠). 쉽게 취소하거나 미룰 수 있다. 답장은 물리적으로 가능하면 한다(집 활동=intermittent, 영화관·운전·운동·씻기만 unavailable).
  - "social"(사회) = 남이 엮인 사적 일(친구 약속·저녁·전화, 가족 만남, 병원, 학원, 친목 회식). 즉시는 아니어도 양해를 구해 미루거나 조정할 수 있다. 연락은 대체로 intermittent, 전화 받는 중만 잠깐 unavailable.
  - "official"(공적) = 미룰 수 없는 공적 의무(회사 업무·회의·시험·발표·공적 회식). 미룰 수 없다. 업무·공적 회식은 intermittent로 답할 수 있으나, 회의·시험·발표는 폰을 볼 수 없어 "unavailable".
  - 잠·기상·준비는 "personal".

- 각 블록의 source = 이 블록이 어느 원본에서 나왔는가. 원본이 있는 블록에만 적는다.
  - 위 [이 날의 확정 일정]의 한 줄을 그날치로 펼친 블록이면 "schedule", source_id에 그 줄 앞 [번호]를 그대로 적는다. 한 일정이 두 블록으로 쪼개졌으면 두 블록에 같은 번호를 적는다.
  - 위 [생활 리듬]의 매주 루틴에서 나온 블록이면 "routine". 되짚을 원본 행이 없으니 source_id는 적지 않는다.
  - 위 [진행 중인 일]의 한 줄에서 오늘 몫을 펼친 블록이면 "ongoing", source_id에 그 줄 앞 [번호]를 그대로 적는다. 이 번호로 그 일이 오늘 어디까지 갔는지 되짚는다.
  - 어느 쪽도 아닌 블록(잠·식사·이동·그날 갑자기 생긴 일)에는 두 값을 적지 않는다.

[JSON 형식 — 이 구조 그대로]
{"date":"${date}","blocks":[{"start":"05:00","end":"06:03","activity":"잠","responsiveness":"unavailable","advance_known":true,"category":"personal"},{"start":"08:00","end":"08:40","activity":"업무 회의","responsiveness":"unavailable","advance_known":true,"category":"official"},{"start":"12:00","end":"13:10","activity":"동료와 점심","responsiveness":"intermittent","advance_known":true,"category":"social","source":"schedule","source_id":12},{"start":"15:00","end":"16:00","activity":"급한 업무","responsiveness":"intermittent","advance_known":false,"category":"official"},{"start":"19:00","end":"19:40","activity":"저녁 산책","responsiveness":"intermittent","advance_known":true,"category":"personal","source":"routine"},{"start":"20:00","end":"20:20","activity":"씻기","responsiveness":"unavailable","advance_known":true,"category":"personal"},{"start":"22:00","end":"23:00","activity":"책 이어 읽기","responsiveness":"intermittent","advance_known":true,"category":"personal","source":"ongoing","source_id":61},{"start":"24:10","end":"29:00","activity":"잠","responsiveness":"unavailable","advance_known":true,"category":"personal"}]}
위 블록의 활동 이름은 형식을 보여주는 예시다. 실제 활동은 [인물]의 직업·생활·취향에서 뽑는다. source_id의 12와 61도 예시이니, 실제 번호는 위 [이 날의 확정 일정]과 [진행 중인 일]에 적힌 것을 쓴다.`;

// 행 번호로 쓸 수 있는 값인가. 생성이 숫자를 따옴표에 넣어 답하는 일이 있어 문자열도 받는다.
const toSourceId = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v.trim()) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
};

// 출처 두 칸을 함께 판정한다 — 둘은 한 쌍이라 따로 살아남으면 뜻이 없다.
// "schedule"과 "ongoing"은 되짚을 행 번호가 있어야 원본을 찾을 수 있으니 번호가 없으면
// 출처째로 버리고, "routine"은 되짚을 행이 없는 게 정상이라 번호 없이 남긴다.
const normalizeSource = (
  b: PlanBlock,
): Pick<PlanBlock, "source" | "source_id"> => {
  const source = toBlockSource(b.source);
  if (source === "schedule" || source === "ongoing") {
    const id = toSourceId(b.source_id);
    return id === null ? {} : { source, source_id: id };
  }
  if (source === "routine") return { source };
  return {};
};

// 세 값(답장 여건·활동 성격·출처)은 plan_json 안에 있어 DB가 값을 검사해 주지 않는다. 생성이
// 한글 이름으로 답하거나 모르는 값을 내면 여기서 식별자로 되돌리고, 그래도 못 알아보면
// 앞 둘은 무난한 쪽으로 채우고 출처는 지운다(없어도 되는 값이라 아무거나 채우면 거짓이 된다).
// 내보내는 이유: 모델을 부르지 않고도 이 방어선을 검증할 수 있어야 한다. 부르는 곳은 아직
// ensureTodayPlan 한 곳뿐이다.
// 자정을 넘긴 블록을 24시 이후 표기로 되돌린다. 생성에 "24:30"으로 적으라고 일러 두었지만
// 새벽 시각을 "00:30"으로 적어 오는 일이 있고, 그러면 블록이 하루의 맨 앞으로 튀어 순서가
// 뒤집힌다. 앞 시각보다 이른 값이 나오는 지점부터 뒤쪽 전부에 24시간을 더해 순서를 되살린다.
const shiftPastMidnight = (blocks: PlanBlock[]): PlanBlock[] => {
  let prev = -1;
  let crossed = false;
  return blocks.map((b) => {
    const fix = (hhmm: string): string => {
      const [h, m] = hhmm.split(":").map(Number);
      if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
      let min = (h ?? 0) * 60 + (m ?? 0);
      if (crossed && min < 24 * 60) min += 24 * 60;
      else if (!crossed && min < prev) {
        crossed = true;
        min += 24 * 60;
      }
      prev = min;
      return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
    };
    const start = fix(b.start);
    return { ...b, start, end: fix(b.end) };
  });
};

export const normalizePlan = (plan: DayPlan): DayPlan => ({
  ...plan,
  blocks: shiftPastMidnight(plan.blocks ?? []).map((b) => {
    // 출처 두 칸은 스프레드로 딸려 오면 모르는 값이 그대로 살아남는다 —
    // 빼 두고 판정 결과만 얹는다.
    const { source: _source, source_id: _sourceId, ...rest } = b;
    return {
      ...rest,
      responsiveness: toResponsiveness(b.responsiveness) ?? "intermittent",
      category: blockCategory(b),
      ...normalizeSource(b),
    };
  }),
});

// 각본 생성 프롬프트 조립 — 재료는 전부 DB에서 읽는다: 정체성(생활/잠·생활/매주 루틴 포함),
// 컨디션 시드, 그날 일정, 아크, 어제 일기. ensureTodayPlan이 쓰고, 검증 도구가 조립 결과를
// 눈으로 확인할 때도 부른다.
export const buildPlanPrompt = (characterId: number, date: string): string => {
  const identity = orderedIdentity(alwaysIncluded(characterId));
  const seed = getDaySeed(characterId, date);
  // 일정 슬롯에서 이 날의 캐릭터 예정을 가져와 각본에 반영한다. 한 줄에 하나씩 —
  // 줄마다 앞에 붙는 행 번호가 슬래시로 이어 붙이면 어느 일정 것인지 흐려진다.
  const todays = getUpcomingSchedules(characterId, date)
    .filter((s) => s.date === date && s.owner === "char")
    .map(scheduleLine)
    .join("\n");
  // 며칠에 걸쳐 이어 하는 일. 이걸 각본이 모르면 캐릭터가 여러 날에 나눠 하는 일이 하루
  // 흐름에 한 번도 드러나지 않는다. 유저가 아는 캐릭터 쪽 항목만, 최근에 손댄 것부터 상한까지.
  const ongoing = planOngoingLines(characterId);
  const arcs = Object.entries(getArcs(characterId))
    .map(([h, c]) => `${h}: ${c}`)
    .join(" / ");
  const lastDiary = getRecentDiaries(characterId, 1)
    .map((d) => {
      try {
        return `${d.date}: ${(JSON.parse(d.entry_json) as { diary?: string }).diary ?? ""}`;
      } catch {
        return "";
      }
    })
    .join("");
  return planPrompt(
    identity.map(memoryLine).join("\n"),
    identityValue(identity, "생활", "잠"),
    identityValue(identity, "생활", "매주 루틴"),
    date,
    dayLabelOf(date),
    todays,
    ongoing,
    arcs,
    lastDiary,
    seed,
    lastNightSleep(characterId, date),
    awayPhaseOf(characterId, date),
  );
};

// 어젯밤 잠 — 오늘 피곤한지는 시드가 아니라 이 값으로 정한다(이슈 #289). 어제 각본의 밤 잠 블록
// 시작과 어제 논리일 안 캐릭터의 마지막 말을 재료로 넘기고, 어느 쪽이 잠든 시각인지와 충분히 잔
// 기준 시각은 nightSleepOf가 정한다. 어제 각본이 없고 대화도 없으면 null.
export const lastNightSleep = (
  characterId: number,
  date: string,
): NightSleep | null => {
  const yesterday = shiftDate(date, -1);
  let sleepStart: string | null = null;
  const raw = getDayPlan(characterId, yesterday);
  if (raw) {
    try {
      const plan = JSON.parse(raw) as DayPlan;
      const night = plan.blocks.find(
        (b) => isSleeping(b) && b.start >= "20:00",
      );
      sleepStart = night?.start ?? null;
    } catch {
      sleepStart = null;
    }
  }
  const chatId = getCharacterChatId(characterId);
  const lastChar = chatId
    ? lastCharMessageTsBetween(
        chatId,
        characterId,
        `${yesterday} 05:00:00`,
        `${date} 05:00:00`,
      )
    : null;
  return nightSleepOf(yesterday, sleepStart, lastChar);
};

// nightly=true는 밤 정리 경로: 어제 일기가 확정된 뒤의 정식 생성이라, 새벽 대화가 미리 만든
// lazy 각본(어제 일기 없이 이틀 전 일기를 참조한 것)이 있으면 교체한다. 기본(false)은 대화 중
// lazy 생성 — 이미 각본이 있으면 무엇이든 그대로 둔다.
export const ensureTodayPlan = async (
  characterId: number,
  nightly = false,
): Promise<void> => {
  // 각본의 하루는 새벽 5시에 갈린다 — 자정~04:59에 대화가 와도 어제 각본을 계속 쓴다.
  const date = kstLogicalDate();
  const existing = getDayPlan(characterId, date);
  // 이미 있으면 비용 없이 종료(런웨이 확인도 생략). 단 밤 정리 경로는 lazy분이면 다시 만든다.
  if (
    existing &&
    !(nightly && getDayPlanMadeBy(characterId, date) === "ondemand")
  )
    return;
  // 오늘의 컨디션 시드가 담긴 이번 달 리듬을 확보(이미 있으면 no-op). 실패해도 각본은 계속
  await ensureRhythmRunway(characterId, date).catch((e) =>
    console.error("[day-plan] rhythm runway error:", e),
  );
  const prompt = buildPlanPrompt(characterId, date);
  const generate = async (user: string): Promise<DayPlan> =>
    normalizePlan(
      await chatJson<DayPlan>(PLAN_SYSTEM, user, 3000, config.modelDeep, {
        purpose: "day_plan",
        characterId,
      }),
    );
  let plan = await generate(prompt);
  let check = checkPlanAway(characterId, date, plan);
  // 자리 비움 상한을 어겼으면 어긴 줄을 붙여 한 번 더 만든다. 두 번째도 어기면 덜 어긴 쪽을
  // 저장하고 로그만 남긴다 — 각본이 없는 것보다 낫고, 아침 게시가 어긴 줄을 보인다.
  if (check.violations.length) {
    const retry = await generate(
      `${prompt}\n\n[앞서 만든 각본이 어긴 것. 이번에는 지킨다]\n${check.violations.map((v) => `- ${v}`).join("\n")}`,
    );
    const again = checkPlanAway(characterId, date, retry);
    if (again.violations.length < check.violations.length) {
      plan = retry;
      check = again;
    }
  }
  if (check.violations.length)
    console.warn(
      `[day-plan] 자리 비움 상한 어김 (캐릭터 ${characterId}, ${date}): ${check.violations.join(" / ")}`,
    );
  saveDayPlan(
    characterId,
    date,
    JSON.stringify(plan),
    nightly ? "nightly" : "ondemand",
  );
};
