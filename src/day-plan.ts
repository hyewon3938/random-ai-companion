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
import { kstDateString, todayLabel } from "./kst.js";
import {
  AWAY_DAILY_MAX,
  AWAY_MIN_BLOCK_MIN,
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
  // 옵셔널 — 없으면 activity로 추론(blockCategory). 구 각본·외부 생성분과 호환.
  category?: ActivityCategory;
  // 출처: 이 블록이 어느 원본을 그날치로 펼친 것인가.
  //   schedule = 예정된 일 한 건(source_id가 그 행 번호) / routine = 매주 루틴(되짚을 행이 없어 번호 없음)
  // 유저가 붙잡을 때 붙잡기 판정이 이 값을 따라 원본 일정을 읽고, 유저가 아는 일인지 본다.
  // 옵셔널 — 어느 원본에서도 나오지 않은 블록(잠·식사·그날 갑자기 생긴 일)에는 붙지 않고,
  // 필드가 없는 구 각본·외부 생성분과도 호환된다(없으면 무시).
  source?: BlockSource;
  source_id?: number; // source="schedule"인 블록에만. schedules.id
}

// 공적 의무(못 미룸, 대개 폰도 불가) 키워드.
const OFFICIAL_HINT =
  /회의|미팅|근무|업무|출근|출장|발표|시험|면접|세미나|공적/;
// 남이 엮인 사적 일(조정 가능·연락은 틈틈이) 키워드.
const SOCIAL_HINT =
  /친구|약속|동기|동료|가족|부모|엄마|아빠|형|누나|언니|동생|병원|학원|모임|회식|데이트|만남|결혼식|장례|전화/;

// 이 블록의 활동 성격. 명시값 우선, 없으면 activity로 추론. 공적 > 사회 > 개인 순으로 본다.
// 잠·기상·준비 등 혼자 하는 일은 개인.
export const blockCategory = (b: {
  activity: string;
  category?: ActivityCategory;
}): ActivityCategory => {
  if (b.category) return b.category;
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

// trace.ts가 슬랙에 각본 생성 프롬프트를 올릴 때도 이 시스템 문장을 함께 보여준다.
export const PLAN_SYSTEM = `너는 한 인물의 하루 흐름을 짜는 작가다. 과장 없이, 실제 그 직업과 성격의 사람이 보낼 법한 평범한 하루를 시간 블록으로 만든다. 루틴이 기본이고 변화는 잔잔하게 준다.`;

// 그날 확정 일정 한 줄. 줄 앞에 그 일정의 행 번호를 붙인다 — 생성이 그 줄을 블록으로 펼치면
// source_id에 이 번호를 그대로 적어, 나중에 블록에서 원본 일정을 되짚을 수 있다.
const scheduleLine = (s: ScheduleRow): string =>
  `- [${s.id}] ${s.time_hint ? `${s.time_hint} ` : ""}${s.content}`;

// 며칠에 걸쳐 하는 일 한 줄. 새벽 정리가 같은 항목을 프롬프트에 넣는 방식(nightly.ts)을 따르되,
// 각본에는 캐릭터 쪽 항목만 들어가서 누구 일인지 적을 자리가 없다.
// 끝나는 조건을 값과 함께 적는다 — 조건이 이미 채워진 일을 오늘 또 하는 각본이 나오지 않게.
const ongoingLine = (r: MemoryRow): string =>
  `- ${r.area}/${r.subject}: ${r.value}${r.end_condition ? ` (끝나는 조건: ${r.end_condition})` : ""}`;

// 진행 중인 일 절. 없는 날에는 머리말째로 빠진다 — 다른 절처럼 "(없음)"을 적어 두면
// 며칠에 한 번 손대는 일이 오늘은 없다는 것과 아예 없다는 것이 같은 글자로 보인다.
const ongoingSection = (ongoing: string): string =>
  ongoing
    ? `\n[진행 중인 일 — 며칠에 걸쳐 이어 하는 일. 오늘 손댈 만한 것이 있으면 그 다음 한 걸음을 블록으로 넣는다. 끝나는 조건이 이미 채워진 일은 넣지 않는다. 매일 손대는 일은 아니니 오늘 몫이 없으면 넣지 않아도 된다]\n${ongoing}\n`
    : "";

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
): string => `아래 인물의 ${date} (${label}) 하루를 시간 블록으로 짜줘.

[인물 — 같은 항목이 두 줄이면 아래쪽이 최신]
${persona || "(없음)"}

[생활 리듬 — 시간표의 기준. 여기 없는 시각·습관을 지어내지 않는다]
- 잠: ${sleep ?? "(값 없음 — 무리 없는 일반적인 수면으로)"}
- 매주 루틴: ${weeklyRoutine ?? "(없음)"}

[오늘의 컨디션 시드 — 미리 정해진 오늘의 몸 상태·기상 성향]
${seedLine(seed)}

[이 날의 확정 일정 — 있으면 반드시 하루에 자연스럽게 반영 (advance_known=true). 줄 앞의 [번호]는 그 일정의 번호다]
${schedules || "(없음)"}
${ongoingSection(ongoing)}
[삶의 큰 흐름 — 하루의 결에 은은하게 반영]
${arcs || "(없음)"}

[어제의 일기 — 여운·컨디션이 자연스럽게 이어지게 (늦게 잤으면 오늘 피곤한 식으로). 어제 이미 한 구체적인 것(특정 영화·책 제목 등)은 오늘 또 반복하지 않는다 — 봤던 건 봤고, 오늘은 다른 걸 하거나 새 제목으로]
${diary || "(없음)"}

[컨디션→기상→활동을 하나로 잇기]
- 위 컨디션 시드가 오늘의 바탕이다. 기력이 낮으면 기상이 흐트러지고(못 자서 너무 일찍 깨거나, 뻗어서 늦잠) 활동량이 준다(운동 거름·저녁 일찍 뻗음). 기력이 높으면 개운하게 제때 일어나 활동이 는다(운동 챙김·저녁도 활기).
- 단, 어제 일기에 실제 여파(회식·술·새벽까지 대화 등)가 있으면 그게 시드보다 우선이다 — 실제로 늦게 잤으면 시드가 '보통'이어도 오늘 아침은 피곤하게.

[원칙]
- 근무일이면: 기상·취침 시각은 위 [생활 리듬]의 잠 값이 기준이고, 컨디션 시드가 그날의 시각을 정한다 — '보통'이면 기준대로, '이른'이면 기준보다 일찍 눈이 떠지고, '늦잠'이면 기준을 놓쳐 허둥지둥한 아침. 출퇴근 방식·근무 형태·점심·퇴근 시각 같은 하루의 뼈대는 [인물]의 직업·생활 값에서 뽑는다. 저녁은 [생활 리듬]의 매주 루틴 중 그 요일 몫과 [인물]의 취향에서 — 루틴 활동도 그날 컨디션·사정에 따라 건너뛰거나 시간이 밀린다.
- 쉬는 날(주말·공휴일)이면: 늦잠, 밀린 잠·집안일과 이 사람 취향의 여가로 여유로운 흐름. 매주 루틴 중 그 요일 것이 있으면 넣는다.
- 이벤트 1~3개를 배치(들쭉날쭉하게 — 이벤트 많은 날도 없는 날도 있다). 두 종류가 있다:
  - 미리 아는 일정 (advance_known=true): 점심 회식, 팀원과 저녁 약속, 퇴근 후 서점 들르기 같은 예정된 일
  - 닥쳐야 아는 일 (advance_known=false): 오후에 갑자기 바빠짐, 급한 업무, 예정에 없던 호출, 갑자기 마트에 감, 친구의 급한 전화 같은 그때 가서야 겪는 일 — 이런 갑작스러운 일을 하루 한둘은 자연스럽게 껴 넣는다.
  - 그래도 아무 이벤트 없는 평범한 날도 가끔은 자연스럽다.
- 하루 곳곳에 '자리를 비우는' 불가 구간을 자연스럽게 넣는다: 운동(한 시간쯤), 씻기, 저녁 준비·식사, 장보기/마트, 집중 업무, 통화. 사람은 늘 답할 수 있는 게 아니다 — 특히 저녁 시간이 즉답으로만 쭉 이어지지 않게 unavailable·intermittent를 섞는다. 이 중 일부는 미리 아는 일(advance_known=true, 예: 정해둔 운동)이고 일부는 갑작스러운 것(false, 예: 급하게 마트 감·집안일)이다.
- **${AWAY_MIN_BLOCK_MIN}분 넘게 자리를 비우는 불가 구간(잠 제외)은 하루 ${AWAY_DAILY_MAX}개까지.** 나가기 전에 상대에게 알리고 가는 자리라, 이보다 많으면 하루 종일 자리를 비운다는 말만 주고받게 된다. 더 넣고 싶으면 짧게(${AWAY_MIN_BLOCK_MIN}분 미만) 두거나 틈틈이 폰을 볼 수 있는 일로 바꾼다.
- 각 블록의 responsiveness = 그 시간에 메신저 답장을 얼마나 할 수 있는가. 값은 셋 중 하나:
  - "instant"(즉답 — 쉬는 중·대화 시간) / "intermittent"(틈틈이 — 근무·이동·집안일·장보기처럼 틈틈이 볼 수 있음) / "unavailable"(불가 — 손이나 정신이 묶여 못 봄).
  - "unavailable"은 손이나 정신이 진짜로 묶인 때만: 통화(전화 받는 중)·운전·공식 회의·운동·씻기·영화관·잠.
  - **업무로 자리를 비우는 공적 "unavailable"(회의·시험·발표·급한 처리 등)는 한 블록 최대 1시간.** 더 길 일이면 블록을 쪼개 사이에 "intermittent"(잠깐 폰 보는 틈) 구간을 넣는다 — 업무로 한 시간 넘게 통째로 사라지지 않게. (원래 틈틈이 폰을 볼 수 있는 일은 해당 없음.)
  - **사교 자리(친구 약속·회식·모임)는 "unavailable"이 아니라 "intermittent"다** — 사람들과 있어도 폰은 틈틈이 본다. 다만 회식은 텀이 더 길고(자리를 오래 못 뜸), 친구 약속은 대체로 틈틈이 보지만 가끔 텀이 길어진다.
  - **집에서 하는 여가는 "unavailable"이 아니라 "intermittent"다** — 집에서 영화·드라마(OTT)·독서·집안일·가계부는 폰을 곁에 두고 하므로 틈틈이 답할 수 있다. 영화라도 '영화관에 감'만 "unavailable"이고 '집에서 봄'은 "intermittent".
  - **실제로 자는 시간(잠)만 밤의 "unavailable"이다. '취침 준비·잠자리에 들기'(누워서 폰 보며 뒹굴대는 시간)는 "instant".** 저녁~취침 전은 대화 시간이라 대체로 "instant".
- 블록은 00:00~23:59 안에서 시간순으로 빈틈 없이. 전날 밤부터 이어지는 잠은 00:00부터 기상 시각까지 블록으로.

- 각 블록의 category = 활동의 성격(답장 여건과 별개의 축 — 유저가 찾을 때 얼마나 조정 가능한가). 값은 셋 중 하나:
  - "personal"(개인) = 혼자 자의로 하는 일(운동·집 여가·영화·독서·장보기·산책·혼밥·낮잠). 쉽게 취소하거나 미룰 수 있다. 답장은 물리적으로 가능하면 한다(집 활동=intermittent, 영화관·운전·운동·씻기만 unavailable).
  - "social"(사회) = 남이 엮인 사적 일(친구 약속·저녁·전화, 가족 만남, 병원, 학원, 친목 회식). 즉시는 아니어도 양해를 구해 미루거나 조정할 수 있다. 연락은 대체로 intermittent, 전화 받는 중만 잠깐 unavailable.
  - "official"(공적) = 미룰 수 없는 공적 의무(회사 업무·회의·시험·발표·공적 회식). 미룰 수 없다. 업무·공적 회식은 intermittent로 답할 수 있으나, 회의·시험·발표는 폰을 볼 수 없어 "unavailable".
  - 잠·기상·준비는 "personal".

- 각 블록의 source = 이 블록이 어느 원본에서 나왔는가. 원본이 있는 블록에만 적는다.
  - 위 [이 날의 확정 일정]의 한 줄을 그날치로 펼친 블록이면 "schedule", source_id에 그 줄 앞 [번호]를 그대로 적는다. 한 일정이 두 블록으로 쪼개졌으면 두 블록에 같은 번호를 적는다.
  - 위 [생활 리듬]의 매주 루틴에서 나온 블록이면 "routine". 되짚을 원본 행이 없으니 source_id는 적지 않는다.
  - 어느 쪽도 아닌 블록(잠·식사·이동·그날 갑자기 생긴 일)에는 두 값을 적지 않는다.

[JSON 형식 — 이 구조 그대로]
{"date":"${date}","blocks":[{"start":"00:00","end":"06:03","activity":"잠","responsiveness":"unavailable","advance_known":true,"category":"personal"},{"start":"08:00","end":"09:00","activity":"업무 회의","responsiveness":"unavailable","advance_known":true,"category":"official"},{"start":"12:00","end":"13:10","activity":"동료와 점심","responsiveness":"intermittent","advance_known":true,"category":"social","source":"schedule","source_id":12},{"start":"15:00","end":"16:00","activity":"급한 업무","responsiveness":"unavailable","advance_known":false,"category":"official"},{"start":"19:00","end":"20:00","activity":"운동","responsiveness":"unavailable","advance_known":true,"category":"personal","source":"routine"}, ...]}
위 블록의 활동 이름은 형식을 보여주는 예시다. 실제 활동은 [인물]의 직업·생활·취향에서 뽑는다. source_id의 12도 예시이니, 실제 번호는 위 [이 날의 확정 일정]에 적힌 것을 쓴다.`;

// 행 번호로 쓸 수 있는 값인가. 생성이 숫자를 따옴표에 넣어 답하는 일이 있어 문자열도 받는다.
const toScheduleId = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v.trim()) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
};

// 출처 두 칸을 함께 판정한다 — 둘은 한 쌍이라 따로 살아남으면 뜻이 없다.
// "schedule"은 되짚을 행 번호가 있어야 원본을 찾을 수 있으니 번호가 없으면 출처째로 버리고,
// "routine"은 되짚을 행이 없는 게 정상이라 번호 없이 남긴다.
const normalizeSource = (
  b: PlanBlock,
): Pick<PlanBlock, "source" | "source_id"> => {
  const source = toBlockSource(b.source);
  if (source === "schedule") {
    const id = toScheduleId(b.source_id);
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
export const normalizePlan = (plan: DayPlan): DayPlan => ({
  ...plan,
  blocks: (plan.blocks ?? []).map((b) => {
    // 출처 두 칸은 스프레드로 딸려 오면 모르는 값이 그대로 살아남는다 —
    // 빼 두고 판정 결과만 얹는다.
    const { source: _source, source_id: _sourceId, ...rest } = b;
    return {
      ...rest,
      responsiveness: toResponsiveness(b.responsiveness) ?? "intermittent",
      category: toActivityCategory(b.category) ?? blockCategory(b),
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
  // 흐름에 한 번도 드러나지 않는다. 캐릭터 쪽 항목만, 최근에 손댄 것부터 상한까지.
  const ongoing = listMemoryItems(characterId, "ongoing")
    .filter((r) => r.owner === "char")
    .slice(0, PLAN_ONGOING_MAX)
    .map(ongoingLine)
    .join("\n");
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
    todayLabel(),
    todays,
    ongoing,
    arcs,
    lastDiary,
    seed,
  );
};

// nightly=true는 밤 정리 경로: 어제 일기가 확정된 뒤의 정식 생성이라, 새벽 대화가 미리 만든
// lazy 각본(어제 일기 없이 이틀 전 일기를 참조한 것)이 있으면 교체한다. 기본(false)은 대화 중
// lazy 생성 — 이미 각본이 있으면 무엇이든 그대로 둔다.
export const ensureTodayPlan = async (
  characterId: number,
  nightly = false,
): Promise<void> => {
  const date = kstDateString();
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
  const plan = await chatJson<DayPlan>(
    PLAN_SYSTEM,
    buildPlanPrompt(characterId, date),
    3000,
    config.modelDeep,
    { purpose: "day_plan", characterId },
  );
  saveDayPlan(
    characterId,
    date,
    JSON.stringify(normalizePlan(plan)),
    nightly ? "nightly" : "ondemand",
  );
};
