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
  type DaySeed,
} from "./db.js";
import type { Bible } from "./character.js";
import { ensureRhythmRunway } from "./life-plan.js";
import { kstDateString, todayLabel } from "./kst.js";
import {
  toResponsiveness,
  toActivityCategory,
  type Responsiveness,
  type ActivityCategory,
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

const PLAN_SYSTEM = `너는 한 인물의 하루 흐름을 짜는 작가다. 과장 없이, 실제 그 직업과 성격의 사람이 보낼 법한 평범한 하루를 시간 블록으로 만든다. 루틴이 기본이고 변화는 잔잔하게 준다.`;

const seedLine = (seed: DaySeed | undefined): string => {
  if (!seed) return "(없음 — 평범한 컨디션으로)";
  return `기력=${seed.energy}, 기상 성향=${seed.wake_hint}, 기분=${seed.mood}${seed.reason ? ` (이유: ${seed.reason})` : ""}`;
};

const planPrompt = (
  bible: Bible,
  date: string,
  label: string,
  schedules: string,
  arcs: string,
  diary: string,
  seed: DaySeed | undefined,
): string => `아래 인물의 ${date} (${label}) 하루를 시간 블록으로 짜줘.

[인물]
${JSON.stringify({ identity: bible.identity, life: bible.life, tastes: bible.tastes }, null, 2)}

[오늘의 컨디션 시드 — 미리 정해진 오늘의 몸 상태·기상 성향]
${seedLine(seed)}

[이 날의 확정 일정 — 있으면 반드시 하루에 자연스럽게 반영 (advance_known=true)]
${schedules || "(없음)"}

[삶의 큰 흐름 — 하루의 결에 은은하게 반영]
${arcs || "(없음)"}

[어제의 일기 — 여운·컨디션이 자연스럽게 이어지게 (늦게 잤으면 오늘 피곤한 식으로). 어제 이미 한 구체적인 것(특정 영화·책 제목 등)은 오늘 또 반복하지 않는다 — 봤던 건 봤고, 오늘은 다른 걸 하거나 새 제목으로]
${diary || "(없음)"}

[컨디션→기상→활동을 하나로 잇기]
- 위 컨디션 시드가 오늘의 바탕이다. 기력이 낮으면 기상이 흐트러지고(못 자서 너무 일찍 깨거나, 뻗어서 늦잠) 활동량이 준다(운동 거름·저녁 일찍 뻗음). 기력이 높으면 개운하게 제때 일어나 활동이 는다(운동 챙김·저녁도 활기).
- 단, 어제 일기에 실제 여파(회식·술·새벽까지 대화 등)가 있으면 그게 시드보다 우선이다 — 실제로 늦게 잤으면 시드가 '보통'이어도 오늘 아침은 피곤하게.

[원칙]
- 근무일이면: 기상은 위 컨디션 시드에 맞춰 그날의 시각을 정한다 — 보통이면 5시 50분~6시 20분, '이른'이면 5시 30분 무렵(눈이 일찍 떠짐), '늦잠'이면 6시 40분~7시(허둥지둥한 아침). 씻고 준비, 자차로 출근, 오전 업무, 점심(12:00~13:00), 오후 업무, 퇴근(보통 18시 넘어서, 가끔 더 늦게), 저녁 운동(그날 컨디션·사정에 따라 밥 전/후·건너뛰기도), 집에서 이 사람의 성격·취향에 맞는 저녁, 자정 전후 취침.
- 쉬는 날(주말·공휴일)이면: 늦잠, 밀린 잠·집안일과 이 사람 취향의 여가로 여유로운 흐름.
- 이벤트 1~3개를 배치(들쭉날쭉하게 — 이벤트 많은 날도 없는 날도 있다). 두 종류가 있다:
  - 미리 아는 일정 (advance_known=true): 점심 회식, 팀원과 저녁 약속, 퇴근 후 서점 들르기 같은 예정된 일
  - 닥쳐야 아는 일 (advance_known=false): 오후에 갑자기 바빠짐, 급한 업무, 예정에 없던 호출, 갑자기 마트에 감, 친구의 급한 전화 같은 그때 가서야 겪는 일 — 이런 갑작스러운 일을 하루 한둘은 자연스럽게 껴 넣는다.
  - 그래도 아무 이벤트 없는 평범한 날도 가끔은 자연스럽다.
- 하루 곳곳에 '자리를 비우는' 불가 구간을 자연스럽게 넣는다: 운동(한 시간쯤), 씻기, 저녁 준비·식사, 장보기/마트, 집중 업무, 통화. 사람은 늘 답할 수 있는 게 아니다 — 특히 저녁 시간이 즉답으로만 쭉 이어지지 않게 unavailable·intermittent를 섞는다. 이 중 일부는 미리 아는 일(advance_known=true, 예: 정해둔 운동)이고 일부는 갑작스러운 것(false, 예: 급하게 마트 감·집안일)이다.
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

[JSON 형식 — 이 구조 그대로]
{"date":"${date}","blocks":[{"start":"00:00","end":"06:03","activity":"잠","responsiveness":"unavailable","advance_known":true,"category":"personal"},{"start":"08:00","end":"09:00","activity":"업무 회의","responsiveness":"unavailable","advance_known":true,"category":"official"},{"start":"12:00","end":"13:10","activity":"동료와 점심","responsiveness":"intermittent","advance_known":false,"category":"social"},{"start":"19:00","end":"20:00","activity":"운동","responsiveness":"unavailable","advance_known":false,"category":"personal"}, ...]}
위 블록의 활동 이름은 형식을 보여주는 예시다. 실제 활동은 [인물]의 직업·생활·취향에서 뽑는다.`;

// 두 태그는 plan_json 안에 있어 DB가 값을 검사해 주지 않는다. 생성이 한글 이름으로 답하거나
// 모르는 값을 내면 여기서 식별자로 되돌리고, 그래도 못 알아보면 무난한 쪽으로 채운다.
const normalize = (plan: DayPlan): DayPlan => ({
  ...plan,
  blocks: (plan.blocks ?? []).map((b) => ({
    ...b,
    responsiveness: toResponsiveness(b.responsiveness) ?? "intermittent",
    category: toActivityCategory(b.category) ?? blockCategory(b),
  })),
});

// nightly=true는 밤 정리 경로: 어제 일기가 확정된 뒤의 정식 생성이라, 새벽 대화가 미리 만든
// lazy 각본(어제 일기 없이 이틀 전 일기를 참조한 것)이 있으면 교체한다. 기본(false)은 대화 중
// lazy 생성 — 이미 각본이 있으면 무엇이든 그대로 둔다.
export const ensureTodayPlan = async (
  characterId: number,
  bible: Bible,
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
  await ensureRhythmRunway(characterId, bible, date).catch((e) =>
    console.error("[day-plan] rhythm runway error:", e),
  );
  const seed = getDaySeed(characterId, date);
  // 일정 슬롯에서 이 날의 캐릭터 예정을 가져와 각본에 반영한다
  const todays = getUpcomingSchedules(characterId, date)
    .filter((s) => s.date === date && s.owner === "char")
    .map((s) => `${s.time_hint ? `${s.time_hint} ` : ""}${s.content}`)
    .join(" / ");
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
  const plan = await chatJson<DayPlan>(
    PLAN_SYSTEM,
    planPrompt(bible, date, todayLabel(), todays, arcs, lastDiary, seed),
    3000,
    config.modelDeep,
  );
  saveDayPlan(
    characterId,
    date,
    JSON.stringify(normalize(plan)),
    nightly ? "nightly" : "ondemand",
  );
};
