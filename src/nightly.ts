// 새벽 정리 — 하루를 닫고 다음 날에 필요한 것을 만든다.
//
// gather와 apply를 나눠 둬서, 봇 밖 스케줄러(tools/nightly-read·write)와 봇 안 폴백 크론
// (05:40)이 같은 함수를 쓴다. 기본 경로는 밖이라 봇은 API를 쓰지 않는다.
//
// 하는 일 — 일기 쓰기, 기억 정리, 다음 날 각본, 월 리듬(rhythmNeeded 신호가 오면),
// 아크 이어쓰기(arcs.ts가 달력 경계에서 정한다), 내일 선톡 문안 준비.
// 모델에 넘기는 문안(일기·기억 정리·진행 반영 프롬프트, 선톡 상황 문단)은 prompts/nightly.ts에
// 있고, 이 파일은 수집·반영·발송 시각 계산과 폴백 경로 runNightly만 갖는다.
//
// 일기에는 기억과 같은 어휘의 주제 태그를 최대 8개 붙인다. 생성 프롬프트에 이미 쓰는 태그
// 목록을 넣어서, 지난 일기도 같은 태그로 걸린다.
//
// 기억 정리 프롬프트에는 이미 있는 키 목록과 함께, 그날 대화·메모에 태그가 걸린 상대 쪽 사실의
// 지금 값도 싣는다. 캐릭터 쪽 사실·인물·진행 중인 일은 값까지 다 실리는데 상대 쪽 사실은 키만
// 들어가서, 같은 키를 다시 쓸 때 앞 값의 세부가 지워졌다(이슈 #264).
//
// 대화에서 뽑은 일정은 이미 저장된 행과 견줘 같은 일이면 넣지 않는다. 프롬프트가 [이미 저장된
// 일정] 목록을 보여주고 다시 적지 말라고 하는데도 같은 일이 날마다 한 줄씩 쌓여서(이슈 #267),
// 저장하는 자리에서도 한 번 막는다.
//
// 그렇게 걸러진 일이라도 시각이 이번 대화에서 정해졌으면 이미 있는 줄의 time_hint를 그 값으로
// 고친다(이슈 #278). 캐릭터가 말한 시각이 아무 데도 안 남으면 다음 날 각본이 오후라고만 적힌
// 값을 보고 엉뚱한 시각에 그 일을 넣어, 어제 말한 시각과 다른 하루가 만들어진다.
//
// 유저가 오래 조용하면 gather가 침묵 단계를 노출하고 apply가 게이트를 강제한다 — quiet·
// dormant면 일기와 시드와 리듬만 만들고 각본과 선톡은 건너뛰고, reconnect면 저녁 재연결
// 문안만 만든다. 밖에서 부르는 경로가 백오프를 몰라도 안전하게 두려는 것이다.

import { chatJson } from "./llm.js";
import { config } from "./config.js";
import { ensureArcs, refreshArcs } from "./arcs.js";
import {
  db,
  getDayPlan,
  getDayPlanMadeBy,
  getDaySeed,
  getRelationship,
  setUserState,
  updateRelationshipNotes,
  addSchedule,
  setScheduleTimeHint,
  markScheduleKnown,
  getActiveSchedulesOn,
  getArcs,
  saveArc,
  saveDayPlan,
  setTags,
  getUpcomingSchedules,
  getSchedulesFrom,
  insertScheduledSend,
  getTodayNotes,
  clearTodayNotes,
  getDayActuals,
  listMemoryItems,
  getMemoryItemById,
  getTags,
  listTagNames,
  getUserProfile,
  saveUserProfile,
  getMessagesBetween,
  hasMessageBetween,
  hasDiaryOn,
  insertDiary,
  hasScheduledSendOn,
  listWorkFactTitles,
  saveWorkFact,
  type CharacterRow,
  type DaySeed,
  type MemoryRow,
  type RelationshipRow,
  getRelationshipIntent,
} from "./db.js";
import {
  applyRelationOutput,
  gatherRelation,
  type NightlyRelation,
  type RelationOutput,
} from "./relationship-stage.js";
import { buildSystemBlocks } from "./context.js";
import { userStateLabel } from "./user-state.js";
import { isSameScheduleContent } from "./schedule-dedupe.js";
import type { DayPlan, PlanBlock } from "./day-plan.js";
import {
  awayPhaseOf,
  awayRuleLines,
  checkPlanAway,
  ensureTodayPlan,
  lastNightSleep,
  normalizePlan,
  planOngoingLines,
} from "./day-plan.js";
import {
  saveMemory,
  moveMemory,
  keyProblem,
  existingKeys,
  existingAreas,
  identityLines,
  searchMemories,
  tagSearch,
} from "./memory.js";
import {
  applyMonthPlan,
  ensureRhythmRunway,
  monthDays,
  monthsNeedingRhythm,
  rhythmMaterial,
  type MonthPlan,
} from "./life-plan.js";
import {
  getKstNow,
  holidayGapYear,
  kstDateString,
  kstStamp,
  dayLabelOf,
  clockLabel,
  type NightSleep,
} from "./kst.js";
import {
  dailySendPlan,
  silenceState,
  type DailySendPlan,
} from "./proactive-policy.js";
import { afterNightlyTrace, beforeNightlyTrace } from "./nightly-trace.js";
import {
  DIARY_SYSTEM,
  EXTRACT_SYSTEM,
  PROGRESS_SYSTEM,
  arcLinesOf,
  careSituation,
  diaryPrompt,
  extractPrompt,
  morningSituation,
  progressPrompt,
  quietDayPrompt,
  type MorningIntent,
  reconnectSituation,
} from "./prompts/nightly.js";
import {
  DIARY_TAG_MAX,
  EXTRACT_SCHEDULE_MAX,
  EXTRACT_USER_FACT_MAX,
  LUNCH_WINDOW,
  RECONNECT_WINDOW,
  WORK_FACT_MAX_PER_NIGHT,
  WORK_FACT_SCENE_MAX,
} from "./thresholds.js";
import {
  SPEECH_LEVEL_NAME,
  SCHEDULE_STATUS_NAME,
  type MemoryItemType,
  type MemoryOwner,
  type UserKnows,
  type Interest,
} from "./labels.js";

// 새벽 정리: 새벽 5시 컷오프로 어제 하루를 닫는다.
// 일기 응고(각본 대비·감정 관찰) + 기억·관계·일정 정리 + 오늘 각본 + 선톡 문안 준비.
//
// 실행 경로는 둘이다. 기본은 외부 scheduled task(구독)가 수집(gatherNightlyInput)→생성(자체 지능)
// →적용(applyNightlyOutput)을 수행하고, 이 파일의 runNightly는 그게 안 돌았을 때의 API 폴백이다.
// 두 경로 모두 일기 중복 체크로 이중 실행이 방지된다.
//
// 진행 중인 일(며칠에 걸쳐 하는 일)은 대화가 없던 날에도 어제 각본을 따라 한 걸음 옮긴다(이슈 #276).
// 어제 각본에서 source "ongoing" 블록을 찾아 그 일의 지금 값과 실제 기록을 같이 넘기고,
// 생성이 돌려준 새 값을 저장한다. 끝났다고 하면 사실 항목으로 옮긴다. 각본에 안 들어간 일은
// 대화로만 바뀐다 — 유저가 모르는 일까지 굴리면 관리할 것만 는다.

export interface DiaryOutput {
  diary: string;
  plan_vs_actual: string;
  user_mood: string;
  closeness: string;
  tomorrow: string[];
  // 이 하루를 나중에 다시 꺼낼 주제 태그. 기억 태그와 같은 어휘를 써야 대화 주제와 이어진다.
  // 옵셔널인 이유는 이미 저장된 일기와 아직 이 항목을 안 만드는 생성 경로가 있어서다.
  tags?: string[];
}

// 기억 정리 호출의 출력 한 건 — memory_items에 키(영역/무엇)로 저장된다.
export interface MemoryExtract {
  item_type: MemoryItemType;
  owner: MemoryOwner;
  area: string;
  subject: string;
  value: string;
  tags?: string[];
  user_knows?: UserKnows;
  relation?: string;
  contact_mode?: string;
  region?: string;
  end_condition?: string;
  interest?: Interest;
  // 그 값이 가리키는 일이 실제로 있었던 날(YYYY-MM-DD). 언제인지 모르면 안 적는다.
  occurred_on?: string;
}

// 관계 갱신분 — 넣은 항목만 갱신된다. 여기 없는 세 항목(stage·speech_level·address_terms)은
// 답장 파이프라인 몫이다(relationship-update.ts) — 낮에 달라진 값을 새벽까지 묵히지 않는다.
export interface RelationshipExtract {
  speech_note?: string;
  rapport?: string;
  cautions?: string;
  history?: string;
  feelings?: string;
}

// 상대 프로필 갱신분 — 대화에서 분명히 드러난 값만. 넣은 항목만 갱신되고,
// 빈 값은 이미 아는 값을 덮지 않는다(db.ts saveUserProfile).
export interface UserProfileExtract {
  job?: string;
  region?: string;
}

export interface ExtractOutput {
  memories: MemoryExtract[];
  relationship?: RelationshipExtract | null;
  user_profile?: UserProfileExtract | null;
  schedules: {
    who: "user" | "char";
    date: string;
    time_hint: string | null;
    content: string;
    // 이 일정을 나중에 주제로 다시 꺼낼 태그. 기억과 같은 어휘를 써야 함께 찾아진다.
    // 옵셔널인 이유는 이미 저장된 일정과 아직 이 항목을 안 만드는 생성 경로가 있어서다.
    tags?: string[];
    // 캐릭터 쪽 일정을 상대에게 말했는가. 안 넣는 생성 경로가 있어 옵셔널이고, 없으면
    // 모르는 것으로 둔다 — 말한 일을 안 말한 것으로 두는 쪽이 되돌리기 쉽다(이슈 #345).
    user_knows?: UserKnows;
  }[];
  // 이미 저장된 일정 줄의 시각을 이번 대화에서 정해진 값으로 고친다. 새 줄을 만드는 자리가
  // 아니라 있는 줄을 고치는 자리라, id는 프롬프트의 [이미 저장된 일정]에 보여 준 번호다.
  // 옵셔널인 이유는 이 항목을 아직 안 만드는 생성 경로가 있어서다(이슈 #278).
  // user_knows는 그날 대화에서 상대에게 말한 일정에만 known으로 온다 — 시각과 달리 되돌리는
  // 값은 받지 않아서, 이 자리에 known 말고 다른 값이 와도 반영하지 않는다(이슈 #345).
  schedule_updates?: {
    id: number;
    time_hint?: string;
    user_knows?: UserKnows;
  }[];
  // 관계 절 — 넘길지와 근거, 처음 확정, 오늘의 관계 의도. 아직 이 절을 안 만드는 생성 경로가
  // 있어 옵셔널이고, 없으면 처음 후보만 확정하고 단계와 의도는 건드리지 않는다.
  relation?: RelationOutput | null;
}

export interface SendDraft {
  window_start: string; // "HH:MM"
  window_end: string;
  text: string;
  // 생략 시 morning. checkin=긴 침묵 뒤 안부 1통.
  kind?: "morning" | "checkin";
}

// 진행 중인 일 한 건의 어제 몫. id는 각본 블록의 source_id(기억 행 번호), value는 새 값,
// done이 참이면 끝나는 조건이 채워진 것이라 사실 항목으로 옮긴다.
export interface OngoingProgress {
  id: number;
  value: string;
  done?: boolean;
}

export interface ProgressOutput {
  progress: OngoingProgress[];
}

export interface NightlyOutput {
  entry: DiaryOutput;
  extract?: ExtractOutput | null;
  progress?: OngoingProgress[] | null; // 어제 각본에 들어간 진행 중인 일의 새 값

  plan?: DayPlan | null; // 외부 경로가 오늘 각본까지 만들어 보낼 때
  send?: SendDraft | null; // 오늘의 선톡 문안 (근거 있을 때만)
  arcs?: {
    year?: string;
    season?: string;
    month?: string;
    week?: string;
  } | null; // 흐름 갱신이 필요할 때만
  rhythm?: ({ ym: string } & MonthPlan)[] | null; // 월 리듬(이벤트+시드) 생성이 필요했을 때
  work_facts?: WorkFactDraft[] | null; // 오늘 각본에 든 작품을 찾아본 결과(#287)
}

/**
 * 작품 사실 카드 초안(#287). 오늘 각본에 실제 작품이 들어갔는데 아직 카드가 없을 때, 외부
 * 경로가 그 작품을 한 번 찾아보고 여기에 담는다. 도구가 없는 봇 안 폴백 경로는 이 칸을
 * 비운 채로 돌아온다 — 카드가 없는 날의 말하기 규칙은 규칙층(FACT_CARE)이 갖는다.
 */
export interface WorkFactDraft {
  title: string;
  summary: string;
  scenes: string[];
  differences?: string | null;
}

export interface NightlyGathered {
  characterId: number;
  chatId: string;
  diaryDate: string; // 일기 대상 날짜 (어제)
  today: string;
  todayLabel: string;
  diaryExists: boolean;
  convo: string; // 어제 대화 전문 (없으면 "")
  msgsCount: number;
  planBriefYesterday: string;
  planExistsToday: boolean;
  identity: string; // 정체성 사실 줄들 (creation + conversation, 같은 키는 최신이 이김)
  people: string; // 주변 인물 줄들 (캐릭터 쪽·유저 쪽 모두)
  ongoing: string; // 진행 중인 일 줄들
  // 오늘 각본에 넣을 진행 중인 일 — 유저가 아는 캐릭터 쪽 것만, 줄 앞에 행 번호. 외부 생성
  // 경로가 각본 블록의 source_id에 이 번호를 적는다(day-plan.ts planOngoingLines와 같은 목록).
  ongoingForPlan: string;
  // 어제 각본에 source "ongoing"으로 들어간 일 — 지금 값과 그 블록이 실제로 어떻게 됐는지.
  // 비어 있으면 어제 손댄 일이 없어 진행 반영을 만들 필요가 없다.
  ongoingTouched: string[];
  // 상대 쪽 사실 중 그날 대화·메모에 태그가 걸린 것의 지금 값. identity가 캐릭터 쪽 사실을
  // 전부 싣는 것과 달리 상대 쪽은 키만 들어가서, 같은 키를 다시 쓸 때 모델이 앞 값을 못 보고
  // 그날 들은 것만 적었다(이슈 #264). 전부 싣지 않고 겹치는 것만 EXTRACT_USER_FACT_MAX까지.
  touchedUserFacts: string[];
  relationship: string; // 관계 일곱 항목의 지금 값
  // 관계 단계 — 코드가 센 문턱 값과 조건별 충족, 이미 한 처음과 아직 안 한 처음, 어제 처음
  // 후보, 시도할 플러팅 추천, 어제 의도. 저장 자리가 같은 값으로 출력을 검사한다(relationship-stage.ts).
  relation: NightlyRelation;
  userState: string; // 상대의 오늘 상태 — 답장이 판정해 둔 마지막 값(없으면 빈 문자열)
  userProfile: string; // 대화로 채우는 상대 프로필 두 값(하는 일·사는 지역)의 지금 상태
  todayNotes: string[]; // 그 하루 동안 대화하며 적어 둔 오늘 메모
  dayActuals: string[]; // 각본과 달라진 블록 기록
  existingKeys: { itemType: MemoryItemType; owner: MemoryOwner; key: string }[]; // 추출이 같은 주제에 재사용할 키 목록
  areas: string[]; // 쓰고 있는 영역 이름들
  tagNames: string[]; // 이미 쓰는 태그 표기들
  userSchedulesUpcoming: string; // 상대의 다가오는 일정 (선톡 근거)
  // 이미 저장된 일정 줄들(행 번호 포함) — 추출이 같은 일을 다시 적지 않게 하는 목록.
  // 선톡 근거로 쓰는 위 값과 달리 양쪽 주인을 다 담고 취소·미룸도 감추지 않는다.
  existingSchedules: string[];
  arcs: Record<string, string>;
  todaySeed: DaySeed | null; // 오늘의 컨디션 시드(있으면)
  lastNight: NightSleep | null; // 어젯밤 잠든 시각과 충분히 잔 기준 시각 — 오늘 피곤한지는 이 값으로(이슈 #289)
  // 오늘 각본에 든 작품 가운데 카드를 만들어야 하는 제목과 이미 카드가 있는 제목(#287).
  // 앞은 찾아볼 목록이고 뒤는 같은 작품을 두 번 찾지 않게 보여 주는 목록이다. 오늘 각본이
  // 아직 없는 회차(외부 경로가 이번에 각본을 만드는 날)에는 앞이 비고, 그 경우 외부 경로는
  // 자기가 만든 각본의 work 값을 보고 채운다.
  workFactsNeeded: string[];
  workFactsKnown: string[];
  awayRule: string; // 오늘 각본의 자리 비움 규칙. 관계 국면으로 상한이 달라져서 외부 생성 경로가 이 줄을 그대로 각본 규칙에 넣는다(이슈 #335)
  // 이번 새벽에 생성해야 할 월 리듬. 봇 안 월 리듬이 쓰는 재료 둘을 달마다 같이 싣는다(이슈 #411).
  // ongoing은 events의 from_ongoing에 적을 진행 중인 일 — 캐릭터 쪽 전부, 줄 앞에 행 번호.
  // ongoingForPlan은 상대가 아는 것만 담아 이보다 좁아서, 그것만 주면 상대가 모르는 일에서
  // 펼쳐 나온 일정에 원본 링크가 안 붙는다. culture는 그 달 재료에 이름이 걸린 일의 절차
  // 블록이고, 걸린 것이 없으면 빈 문자열이라 평소 회차에는 아무것도 안 붙는다.
  // holidayGap은 공휴일 표가 아직 안 덮은 해다(이슈 #415). 값이 있으면 days의 이름표에
  // 그 해 공휴일이 하나도 안 실려서, 명절이 든 달이어도 전부 평일·주말로만 보인다.
  rhythmNeeded: {
    ym: string;
    days: { date: string; label: string }[];
    ongoing: string;
    culture: string;
    holidayGap: string | null;
  }[];
  // 침묵 백오프 상태 — 외부 생성 경로가 이를 보고 산출물을 조절한다
  // (normal=평소대로 / quiet·dormant=각본·선톡 생성 불필요 / checkin=저녁 재연결 문안만)
  silenceTier: "normal" | "quiet" | "checkin" | "dormant";
  silenceDays: number;
  // 오늘 미리 만들어 둘 선톡 — morning=아침 한 통 / checkin=저녁 안부 한 통 /
  // none=준비하지 않는 날. 외부 생성 경로는 이 값만 보면 된다. 무응답 이틀째에 더 나가는
  // 점심 한 통은 여기서 준비하지 않는다 — 팔로업 틱이 점심 창에서 만들어 보낸다(이슈 #314).
  sendPlan: "morning" | "checkin" | "none";
  sendPlanReason: string;
}

// 하루 창의 끝을 만드는 다음 날짜. 대화·오늘 메모를 05:00~다음날 05:00로 끊는 데 쓴다.
export const nextDate = (date: string): string =>
  kstDateString(
    new Date(new Date(`${date}T00:00:00Z`).getTime() + 24 * 3600_000),
  );

// 모델이 준 태그를 다듬는다. 배열이 아닐 수도, 빈 문자열이나 같은 말이 두 번 올 수도 있다.
export const cleanTags = (raw: unknown, max?: number): string[] => {
  const list = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (const t of list) {
    const v = typeof t === "string" ? t.trim() : "";
    if (!v || out.includes(v)) continue;
    out.push(v);
    if (max && out.length >= max) break;
  }
  return out;
};

// 일기에 붙일 태그. 상한을 두는 이유는 thresholds.ts DIARY_TAG_MAX 주석에 적었다.
// 일정 태그에는 상한을 두지 않는다 — 일정은 대화에서 잡힌 것만 드문드문 쌓여서, 같은 호출의
// 기억 태그와 사정이 같다.
const diaryTags = (entry: DiaryOutput): string[] =>
  cleanTags(entry.tags, DIARY_TAG_MAX);

export const planBrief = (raw: string | undefined): string => {
  if (!raw) return "";
  try {
    const p = JSON.parse(raw) as DayPlan;
    return p.blocks
      .map((b) => `${clockLabel(b.start)} ${b.activity}`)
      .join(" / ");
  } catch {
    return "";
  }
};

// 줄 끝에 붙이는 '상대가 아는가'의 지금 값. waiting은 아직 말하지 않고 꺼낼 자리를 기다리는
// 것이라 모름 쪽으로 적는다(reply-timing.ts와 같은 기준). 추출이 이 값을 못 보던 동안 모델은
// 매번 처음부터 다시 판단했고, 다시 안 적어 낸 행은 앞 값을 그대로 이어받아 캐릭터를 만들 때
// 정해진 unknown에서 한 번도 움직이지 않았다(이슈 #345).
const knowsMarkOf = (v: UserKnows): string =>
  v === "known" ? " [상대가 앎]" : " [상대는 모름]";

// 표시는 '나'(char) 쪽 줄에만 붙는다 — 상대가 제 일을 아는지는 물을 것이 없다.
const knowsMark = (r: MemoryRow): string =>
  r.owner === "char" ? knowsMarkOf(r.user_knows) : "";

// 아크 재료에서는 이 표시를 뗀다. 아크 프롬프트에는 표시를 설명하는 자리가 없고, 캐릭터를
// 만들 때 character.ts가 만드는 같은 모양에도 없어서, 두면 아크 문장에 그대로 섞인다.
const withoutKnowsMark = (s: string): string =>
  s.replaceAll(" [상대가 앎]", "").replaceAll(" [상대는 모름]", "");

const personLine = (r: MemoryRow): string => {
  const meta = [r.area, r.relation, r.owner === "user" ? "상대 쪽 사람" : null]
    .filter(Boolean)
    .join(", ");
  return `- ${r.subject} (${meta}): ${r.value}${knowsMark(r)}`;
};

const ongoingLine = (r: MemoryRow): string =>
  `- ${r.owner === "user" ? "(상대) " : ""}${r.area}/${r.subject}: ${r.value}${r.end_condition ? ` (끝나는 조건: ${r.end_condition})` : ""}${knowsMark(r)}`;

// 갱신 날짜를 함께 적는다 — 앞 값이 언제 것인지 알아야 한 번 있었던 일과 이어지는 상태를 가른다.
const userFactLine = (r: MemoryRow): string =>
  `- ${r.area}/${r.subject}: ${r.value} (${r.updated_at.slice(0, 10)} 갱신)`;

// 어제 각본에서 진행 중인 일로 펼친 블록을 그 일의 기억 행에 맞춰 한 줄씩. 같은 일이 블록
// 두 개로 들어갔으면 한 줄에 이어 적는다. 실제 기록(day_actuals)은 블록 시작 시각으로 맞춘다 —
// 취소·미룸이면 그날 몫은 없던 것이라 생성이 값을 옮기지 않는다.
const touchedOngoingLines = (
  characterId: number,
  diaryDate: string,
): string[] => {
  const raw = getDayPlan(characterId, diaryDate);
  if (!raw) return [];
  let blocks: PlanBlock[];
  try {
    blocks = normalizePlan(JSON.parse(raw) as DayPlan).blocks;
  } catch {
    return [];
  }
  const actuals = getDayActuals(characterId, diaryDate);
  const byId = new Map<number, { row: MemoryRow; how: string[] }>();
  for (const b of blocks) {
    if (b.source !== "ongoing" || typeof b.source_id !== "number") continue;
    let cur = byId.get(b.source_id);
    if (!cur) {
      const row = getMemoryItemById(b.source_id);
      if (
        !row ||
        row.character_id !== characterId ||
        row.item_type !== "ongoing" ||
        row.owner !== "char"
      )
        continue;
      cur = { row, how: [] };
      byId.set(b.source_id, cur);
    }
    const hit = actuals.filter((a) => a.block_start === b.start);
    const outcome = hit.length
      ? `달라짐: ${hit.map((a) => `${a.outcome}${a.reason ? `(${a.reason})` : ""}`).join(", ")}`
      : "각본대로";
    cur.how.push(`${clockLabel(b.start)} ${b.activity} → ${outcome}`);
  }
  return [...byId.values()].map(
    ({ row, how }) =>
      `- [${row.id}] ${row.area}/${row.subject}: ${row.value}${row.end_condition ? ` (끝나는 조건: ${row.end_condition})` : ""} — 어제 각본: ${how.join(" / ")}`,
  );
};

/**
 * 상대 쪽 사실 중 그날 대화·메모에 태그가 걸린 것을 지금 값과 함께 줄로 만든다.
 * 답장 경로와 같은 태그 대조·고르기(tagSearch·searchMemories)를 쓰고, 상한만 새벽 정리 것으로
 * 바꾼다. 캐릭터 쪽 사실은 검색 대상이 아니라(recall.ts searchable) 여기 섞이지 않는다.
 * 꺼낸 기록은 남기지 않는다 — 답장에 넣은 것이 아니라서.
 */
export const touchedUserFactLines = (
  characterId: number,
  dayText: string,
): string[] => {
  const { tags } = tagSearch(characterId, dayText);
  if (!tags.length) return [];
  return searchMemories(characterId, tags, {
    itemTypes: ["fact"],
    limits: { fact: EXTRACT_USER_FACT_MAX },
    track: false,
  })
    .filter((r) => r.owner === "user")
    .map(userFactLine);
};

// 대화로 채우는 프로필 두 값의 지금 상태. 모르는 값을 그대로 드러내 추출 호출이
// 무엇을 찾아야 하는지 알게 하고, 이미 아는 값은 다시 쓰지 않게 한다.
const userProfileLines = (chatId: string): string => {
  const p = getUserProfile(chatId);
  return [
    `- 하는 일: ${p.job ?? "(모름)"}`,
    `- 사는 지역: ${p.region ?? "(모름)"}`,
  ].join("\n");
};

const relationshipLines = (r: RelationshipRow | undefined): string => {
  if (!r) return "";
  const items: [string, string | null][] = [
    ["지금 어떤 사이", r.stage],
    ["말투", r.speech_level ? SPEECH_LEVEL_NAME[r.speech_level] : null],
    ["상대에게 쓰는 말투", r.speech_note],
    ["서로 부르는 말", r.address_terms],
    ["잘 통하는 것", r.rapport],
    ["조심할 것", r.cautions],
    ["지나온 이야기", r.history],
    ["지금 마음", r.feelings],
  ];
  return items
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
};

// 상대의 오늘 상태 — 답장이 판정해 둔 마지막 값. 일기와 기억 정리가 읽고, 적용 단계가 비운다.
const userStateLine = (
  r: RelationshipRow | undefined,
  diaryDate: string,
): string => (r ? (userStateLabel(r, diaryDate) ?? "") : "");

// 아크 생성·갱신에 넣는 인물 재료 — 기억(정체성·주변 인물·진행 중인 일)과 관계로 만든다.
// V2 생성 직후에는 character.ts의 arcMaterial이 생성 출력으로 같은 모양을 만든다.
const arcMaterialOf = (g: NightlyGathered): string =>
  [
    "[정체성]",
    g.identity || "(없음)",
    "",
    "[주변 인물]",
    withoutKnowsMark(g.people) || "(없음)",
    "",
    "[진행 중인 일]",
    withoutKnowsMark(g.ongoing) || "(없음)",
    "",
    "[유저와의 관계]",
    g.relationship || "(이제 막 시작한 사이)",
  ].join("\n");

// 오늘 각본이 다루는 작품 가운데 무엇을 찾아봐야 하는지(#287). 각본 블록의 work 값에서 제목을
// 모으고, 이미 카드가 있는 제목은 빼서 찾을 목록을 만든다. 회차당 상한을 두어 하루에 여러 편을
// 몰아 찾지 않는다 — 남은 것은 다음 새벽이 이어 만든다.
//
// 보통 회차에서 찾을 목록은 비어 있다 — 오늘 각본은 이 수집 뒤에 생성이 만들기 때문이다. 그때는
// 방금 만든 각본의 work 값 가운데 known에 없는 것을 생성이 스스로 고르고, 저장 쪽(applyNightlyTxn)이
// 저장된 각본으로 다시 검사한다. 목록이 차는 것은 각본이 이미 있는 회차(봇 안 폴백이 먼저 만들었거나
// 같은 날 다시 도는 경우)뿐이다. known은 어느 회차에서나 같은 작품을 두 번 찾지 않게 한다.
const planWorkTitles = (characterId: number, date: string): string[] => {
  const raw = getDayPlan(characterId, date);
  if (!raw) return [];
  try {
    const titles = ((JSON.parse(raw) as DayPlan).blocks ?? [])
      .map((b) => b.work)
      .filter((t): t is string => !!t);
    return [...new Set(titles)];
  } catch {
    return []; // 깨진 각본은 찾을 작품이 없는 것으로 본다
  }
};

const workFactPlan = (
  characterId: number,
  today: string,
): Pick<NightlyGathered, "workFactsNeeded" | "workFactsKnown"> => {
  const known = listWorkFactTitles(characterId);
  return {
    workFactsNeeded: planWorkTitles(characterId, today)
      .filter((t) => !known.includes(t))
      .slice(0, WORK_FACT_MAX_PER_NIGHT),
    workFactsKnown: known,
  };
};

// targetDiaryDate를 주면 그 날짜의 하루(05:00~익일 05:00)를 응고 대상으로 잡는다 — 결번 백필용.
// 생략하면 기본대로 '어제'.
export const gatherNightlyInput = (
  character: CharacterRow,
  targetDiaryDate?: string,
): NightlyGathered => {
  const now = getKstNow();
  const shifted = new Date(now.getTime() - 5 * 3600_000);
  const today = kstDateString(shifted);
  const diaryDate =
    targetDiaryDate ??
    kstDateString(new Date(shifted.getTime() - 24 * 3600_000));

  // 대화 창은 그 하루(diaryDate 05:00 ~ 다음날 05:00)로 한정 — 백필로 과거 날짜를 잡아도
  // 오늘까지의 대화가 통째로 섞이지 않게.
  const diaryNext = nextDate(diaryDate);
  const msgs = getMessagesBetween(
    character.chat_id,
    character.id,
    `${diaryDate} 05:00:00`,
    `${diaryNext} 05:00:00`,
  );

  const convo = msgs
    .map(
      (m) =>
        `[${m.sent_at.slice(11, 16)}] ${m.role === "user" ? "상대" : "나"}: ${m.text.replace(/\n/g, " ")}`,
    )
    .join("\n");
  const todayNotes = getTodayNotes(character.id, `${diaryDate} 05:00:00`)
    .filter((n) => n.created_at < `${diaryNext} 05:00:00`)
    .map((n) => `[${n.created_at.slice(11, 16)}] ${n.note}`);

  const silence = silenceState(character.chat_id, character.id);
  const plan = dailySendPlan(character.chat_id, character.id, today);
  return {
    characterId: character.id,
    chatId: character.chat_id,
    diaryDate,
    today,
    todayLabel: dayLabelOf(today),
    diaryExists: hasDiaryOn(character.id, diaryDate),
    convo,
    msgsCount: msgs.length,
    planBriefYesterday: planBrief(getDayPlan(character.id, diaryDate)),
    planExistsToday: !!getDayPlan(character.id, today),
    identity: identityLines(character.id),
    people: listMemoryItems(character.id, "person").map(personLine).join("\n"),
    ongoing: listMemoryItems(character.id, "ongoing")
      .map(ongoingLine)
      .join("\n"),
    ongoingForPlan: planOngoingLines(character.id),
    ongoingTouched: touchedOngoingLines(character.id, diaryDate),
    touchedUserFacts: touchedUserFactLines(
      character.id,
      [convo, ...todayNotes].join("\n"),
    ),
    relationship: relationshipLines(getRelationship(character.id)),
    relation: gatherRelation(character.id, character.chat_id, diaryDate, today),
    userState: userStateLine(getRelationship(character.id), diaryDate),
    userProfile: userProfileLines(character.chat_id),
    todayNotes,
    // 결과 뒤의 시각은 그렇게 된 실제 시각이다. 잠 블록의 깸이면 그 시각에 깬 것이라, 일기가
    // 몇 시에 깼는지를 어림하지 않고 이 값을 쓴다(이슈 #288).
    dayActuals: getDayActuals(character.id, diaryDate).map(
      (a) =>
        `- ${a.block_start ? `${clockLabel(a.block_start)} ` : ""}${a.intended} → ${a.outcome} ${a.recorded_at.slice(11, 16)}${a.reason ? ` (${a.reason})` : ""}`,
    ),
    existingKeys: existingKeys(character.id),
    areas: existingAreas(character.id),
    tagNames: listTagNames(character.id),
    userSchedulesUpcoming: getUpcomingSchedules(character.id, today)
      .filter((s) => s.owner === "user")
      .map(
        (s) => `${s.date}${s.time_hint ? ` ${s.time_hint}` : ""} ${s.content}`,
      )
      .join(" / "),
    // 기준일(어제)부터 앞으로. 하루를 되돌아보는 대화라 어제 일도 다시 언급되고,
    // 그때 이미 저장된 줄이 안 보이면 같은 일이 한 줄 더 쌓인다.
    existingSchedules: getSchedulesFrom(
      character.id,
      diaryDate,
      EXTRACT_SCHEDULE_MAX,
    ).map(
      (s) =>
        `- [${s.id}] ${s.date}${s.time_hint ? ` ${s.time_hint}` : ""} ${
          s.owner === "user" ? "상대" : "나"
        }: ${s.content}${
          s.status === "active" ? "" : ` (${SCHEDULE_STATUS_NAME[s.status]})`
        }${s.owner === "char" ? knowsMarkOf(s.user_knows) : ""}`,
    ),
    arcs: getArcs(character.id),
    todaySeed: getDaySeed(character.id, today) ?? null,
    lastNight: lastNightSleep(character.id, today),
    ...workFactPlan(character.id, today),
    awayRule: awayRuleLines(awayPhaseOf(character.id, today)),
    rhythmNeeded: monthsNeedingRhythm(character.id, today).map((ym) => {
      const { ongoing, culture } = rhythmMaterial(character.id, ym);
      return {
        ym,
        days: monthDays(ym),
        ongoing,
        culture,
        holidayGap: holidayGapYear(ym),
      };
    }),
    silenceTier: silence.tier,
    silenceDays: silence.days,
    sendPlan: plan.kind,
    sendPlanReason: plan.reason,
  };
};

// 생성 결과를 DB에 반영한다. 외부 scheduled task와 API 폴백이 공유하는 단일 쓰기 경로.
//
// 전체가 하나의 트랜잭션이다(본문은 전부 동기 호출). 이게 없으면 일기 INSERT 후 뒷단(기억~선톡)
// 어디서든 예외가 나면 일기만 남고, 재실행은 아래 dup 체크에 막혀 그 날짜의 기억·일정·선톡이
// 영구히 빠진다 — 전부 반영되거나 전부 롤백되어 재실행이 항상 안전하게.
// (saveMemory 내부의 태그 트랜잭션은 better-sqlite3가 세이브포인트로 중첩 처리한다.)
const applyNightlyTxn = db.transaction(
  (g: NightlyGathered, out: NightlyOutput): string => {
    const ts = kstStamp();

    if (hasDiaryOn(g.characterId, g.diaryDate))
      return `skip: ${g.diaryDate} 일기 이미 있음`;

    const diaryId = insertDiary(
      g.characterId,
      g.diaryDate,
      JSON.stringify(out.entry),
    );
    // 일기도 기억과 같은 태그로 찾는다 — 이 줄이 없으면 옛 일기를 태그로 꺼내는
    // 경로(context.ts)가 늘 빈손으로 돌아온다.
    const diaryTagList = diaryTags(out.entry);
    if (diaryTagList.length)
      setTags(g.characterId, "diary", diaryId, diaryTagList);

    const ex = out.extract;
    let memCount = 0;
    // 기억 정리가 이번에 쓴 캐릭터 쪽 키 — 진행 반영이 같은 키를 또 덮지 않게 한다.
    // 대화에서 그 일을 어디까지 했다고 말한 날은 그 말로 정리한 값이 각본에서 짐작한 값보다 앞선다.
    const extractTouched = new Set<string>();
    let schedTagCount = 0;
    let schedSkipped = 0;
    let schedTimeFixed = 0;
    let schedKnownFixed = 0;
    let profileFilled: string[] = [];
    const skippedKeys: string[] = [];
    if (ex) {
      // 같은 키를 다시 쓸 때 모델이 생략한 추가 정보(어떤 사이·만나는 결 등)가
      // null로 덮이지 않게, 기존 행의 값을 받침으로 깐다. conversation 행 우선.
      const prevRows = new Map<string, MemoryRow>();
      for (const r of listMemoryItems(g.characterId)) {
        const k = `${r.item_type}|${r.owner}|${r.area}/${r.subject}`;
        const cur = prevRows.get(k);
        if (
          !cur ||
          (cur.origin !== "conversation" && r.origin === "conversation")
        )
          prevRows.set(k, r);
      }
      for (const m of ex.memories ?? []) {
        if (!m.value?.trim() || !m.area || !m.subject) continue;
        // 키가 규칙에 안 맞는 한 건이 트랜잭션 전체를 되돌리지 않게(saveMemory는 throw) 미리 걸러 건너뛴다
        if (keyProblem(m.area, m.subject)) {
          skippedKeys.push(`${m.area}/${m.subject}`);
          continue;
        }
        const prev = prevRows.get(
          `${m.item_type}|${m.owner}|${m.area.trim()}/${m.subject.trim()}`,
        );
        saveMemory({
          characterId: g.characterId,
          itemType: m.item_type,
          owner: m.owner,
          area: m.area,
          subject: m.subject,
          value: m.value,
          tags: Array.isArray(m.tags) ? m.tags : undefined,
          userKnows: m.user_knows ?? prev?.user_knows ?? undefined,
          relation: m.relation ?? prev?.relation ?? undefined,
          contactMode: m.contact_mode ?? prev?.contact_mode ?? undefined,
          region: m.region ?? prev?.region ?? undefined,
          lastMentionedAt: m.item_type === "person" ? g.diaryDate : undefined,
          endCondition: m.end_condition ?? prev?.end_condition ?? undefined,
          interest: m.interest ?? prev?.interest ?? undefined,
          // 있었던 날은 한 번 정해지면 바뀌지 않는다. 이번 추출이 안 적었으면 저장 쪽이
          // 전에 적힌 날을 지킨다(db/memory-items.ts의 upsertMemoryItem) — 여기서 받침을
          // 깔면 같은 규칙이 두 자리에 생긴다.
          occurredOn: m.occurred_on,
        });
        memCount++;
        if (m.owner === "char")
          extractTouched.add(
            `${m.area.trim().replace(/\s+/g, " ")}/${m.subject.trim().replace(/\s+/g, " ")}`,
          );
      }
      if (skippedKeys.length)
        console.warn(
          `[nightly] 키 규칙에 안 맞아 건너뜀: ${skippedKeys.join(", ")}`,
        );

      // 관계 갱신 — 출력에 넣은 항목만 바뀌고 나머지는 그대로 남는다
      if (ex.relationship) {
        const r = ex.relationship;
        const clean = (v?: string): string | undefined =>
          v && v.trim() ? v.trim() : undefined;
        updateRelationshipNotes(
          g.characterId,
          {
            speechNote: clean(r.speech_note),
            rapport: clean(r.rapport),
            cautions: clean(r.cautions),
            history: clean(r.history),
            feelings: clean(r.feelings),
          },
          ts,
        );
      }

      // 상대 프로필 — 대화로 채우는 두 값(하는 일·사는 지역). 이미 아는 값과 같으면 건너뛰고,
      // 빈 값은 기존 값을 덮지 않는다(saveUserProfile이 한 번 더 막는다).
      const curProfile = getUserProfile(g.chatId);
      const job = ex.user_profile?.job?.trim();
      const region = ex.user_profile?.region?.trim();
      const nextProfile = {
        job: job && job !== curProfile.job ? job : undefined,
        region: region && region !== curProfile.region ? region : undefined,
      };
      if (nextProfile.job || nextProfile.region) {
        saveUserProfile(g.chatId, nextProfile, ts);
        profileFilled = [
          nextProfile.job ? "하는 일" : "",
          nextProfile.region ? "사는 곳" : "",
        ].filter(Boolean);
      }

      // 일정도 기억·일기와 같은 태그로 찾는다 — 이 줄이 없으면 지난 일정을 주제로 꺼내는
      // 경로(context.ts)가 늘 빈손으로 돌아온다.
      //
      // 넣기 전에 같은 주인·날짜에 살아 있는 행과 내용을 견주고, 같은 일이면 건너뛴다.
      // 공백·기호 차이만 지우고 견주므로 같은 일을 다르게 적은 줄은 그대로 들어온다 — 그건
      // 프롬프트의 [이미 저장된 일정] 목록이 막는 몫이다(schedule-dedupe.ts).
      // 건너뛴 줄의 태그는 붙이지 않는다: 남아 있는 행에 이미 그 자리의 태그가 붙어 있고,
      // 여기서 다시 붙이면 그 행의 태그가 이번 회차 것으로 통째로 갈아 끼워진다.
      for (const s of ex.schedules ?? [])
        if (s.date && s.content) {
          const owner = s.who === "user" ? "user" : "char";
          const already = getActiveSchedulesOn(g.characterId, owner, s.date);
          if (
            already.some((r) => isSameScheduleContent(r.content, s.content))
          ) {
            schedSkipped += 1;
            continue;
          }
          const schedId = addSchedule(
            g.characterId,
            owner,
            s.date,
            s.time_hint ?? null,
            s.content,
            ts,
            "conversation",
            s.user_knows === "known" ? "known" : "unknown",
          );
          const schedTagList = cleanTags(s.tags);
          if (schedTagList.length)
            setTags(g.characterId, "schedule", schedId, schedTagList);
          schedTagCount += schedTagList.length;
        }
      if (schedSkipped)
        console.log(
          `[nightly] 이미 있는 일정 ${schedSkipped}건은 다시 넣지 않음 (캐릭터 ${g.characterId}, ${g.diaryDate})`,
        );

      // 이미 있는 줄의 시각과 '상대가 아는가' 고치기. 위 넣기와 달리 값을 덮어쓰는 자리라
      // 성한 것만 넘긴다 — 번호가 아닌 줄은 여기서 버리고, 남의 캐릭터·접힌 일정인지는 db가
      // 건다. 두 값은 따로 온다: 시각만 정해진 회차도, 말했다는 사실만 생긴 회차도 있다.
      for (const u of ex.schedule_updates ?? []) {
        const schedId = Number(u?.id);
        if (!Number.isInteger(schedId) || schedId <= 0) continue;
        const hint = typeof u?.time_hint === "string" ? u.time_hint.trim() : "";
        if (hint && setScheduleTimeHint(g.characterId, schedId, hint))
          schedTimeFixed += 1;
        if (
          u?.user_knows === "known" &&
          markScheduleKnown(g.characterId, schedId)
        )
          schedKnownFixed += 1;
      }
      if (schedTimeFixed)
        console.log(
          `[nightly] 일정 시각 ${schedTimeFixed}건 고침 (캐릭터 ${g.characterId}, ${g.diaryDate})`,
        );
      if (schedKnownFixed)
        console.log(
          `[nightly] 상대에게 말한 일정 ${schedKnownFixed}건 표시 (캐릭터 ${g.characterId}, ${g.diaryDate})`,
        );
    }

    // 그날 각본: 없으면 저장하고, 있어도 새벽 대화가 만든 lazy 각본이면 정식 각본으로 교체한다.
    // 임시 각본은 어제 일기가 아직 없을 때(이틀 전 일기 참조) 만들어진 것 — 그대로 두면
    // "어제 여파가 시드보다 우선" 설계가 정확히 새벽까지 대화한 날마다 무력화된다.
    // (교체에 쓰는 정식 각본은 그 새벽 대화가 담긴 어제 일기를 반영하므로 모순 위험은 작다.)
    if (
      out.plan &&
      (!getDayPlan(g.characterId, g.today) ||
        getDayPlanMadeBy(g.characterId, g.today) === "ondemand")
    ) {
      const plan = normalizePlan(out.plan);
      // 외부 생성분은 다시 만들 수 없으니 자리 비움 상한을 어겼으면 로그만 남기고 저장한다.
      // 아침 게시가 같은 셈을 보여서 어긴 날을 알 수 있다(이슈 #335).
      const away = checkPlanAway(g.characterId, g.today, plan);
      if (away.violations.length)
        console.warn(
          `[nightly] 자리 비움 상한 어김 (캐릭터 ${g.characterId}, ${g.today}): ${away.violations.join(" / ")}`,
        );
      saveDayPlan(g.characterId, g.today, JSON.stringify(plan), "nightly");
    }

    // 작품 사실 카드(#287). 오늘 각본에 실제로 그 제목이 있을 때만 받는다 — 답장 경로가
    // 각본·진행 중인 일에 있는 작품만 읽으므로 그 밖의 카드는 쌓아 둘 자리가 없고, 생성이
    // 엉뚱한 작품을 찾아와도 여기서 걸린다. 각본은 바로 위에서 저장했을 수도 있어 이 순서다.
    let workFactCount = 0;
    if (out.work_facts?.length) {
      const planned = new Set(planWorkTitles(g.characterId, g.today));
      for (const w of out.work_facts.slice(0, WORK_FACT_MAX_PER_NIGHT)) {
        const title = typeof w?.title === "string" ? w.title.trim() : "";
        const summary = typeof w?.summary === "string" ? w.summary.trim() : "";
        if (!title || !summary || !planned.has(title)) continue;
        const scenes = (Array.isArray(w.scenes) ? w.scenes : [])
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(0, WORK_FACT_SCENE_MAX);
        // 장면이 하나도 없는 카드는 저장하지 않는다 — 없는 장면을 말하지 않게 하려고 만드는
        // 자리인데 줄거리만 있으면 그 일을 못 한다.
        if (!scenes.length) continue;
        const diff =
          typeof w.differences === "string" ? w.differences.trim() : "";
        saveWorkFact(
          g.characterId,
          { title, summary, scenes, differences: diff || null },
          ts,
        );
        workFactCount += 1;
      }
    }

    if (out.arcs) {
      for (const h of ["year", "season", "month", "week"] as const)
        if (out.arcs[h]) saveArc(g.characterId, h, out.arcs[h]);
    }

    // 진행 중인 일의 어제 몫. 행이 이 캐릭터의 캐릭터 쪽 진행 중인 일일 때만 받는다 —
    // 생성이 번호를 잘못 적어도 남의 행이나 사실 행을 덮지 않게. 태그는 그대로 잇는다:
    // saveMemory가 태그를 통째로 갈아 끼우므로 안 넘기면 검색에서 빠진다.
    let progressCount = 0;
    let progressDone = 0;
    let progressYielded = 0;
    for (const p of out.progress ?? []) {
      if (typeof p.id !== "number" || !p.value?.trim()) continue;
      const row = getMemoryItemById(p.id);
      if (
        !row ||
        row.character_id !== g.characterId ||
        row.item_type !== "ongoing" ||
        row.owner !== "char"
      )
        continue;
      if (extractTouched.has(`${row.area}/${row.subject}`)) {
        progressYielded += 1;
        continue;
      }
      const savedId = saveMemory({
        characterId: g.characterId,
        itemType: "ongoing",
        owner: "char",
        area: row.area,
        subject: row.subject,
        value: p.value.trim(),
        tags: getTags("memory", row.id),
        userKnows: row.user_knows,
        endCondition: row.end_condition,
        interest: row.interest,
      });
      progressCount += 1;
      if (p.done) {
        moveMemory(savedId, "fact");
        progressDone += 1;
      }
    }

    if (out.rhythm)
      for (const r of out.rhythm)
        if (r.ym) applyMonthPlan(g.characterId, r.ym, r);

    // 관계 — 처음 확정과 취소, 단계 전이, 오늘의 관계 의도. 관계 절이 없는 회차에도 부른다:
    // 어제 답장이 표시한 처음 후보는 모델이 안 봤어도 확정으로 둔다. 순서와 검사는
    // relationship-stage.ts에 있다.
    const rel = applyRelationOutput(g, ex?.relation ?? null, ts);
    if (rel.advanceRejected)
      console.warn(`[nightly] 단계 전이 건너뜀: ${rel.advanceRejected}`);

    // 선톡 문안 — 관제탑(dailySendPlan) 게이트를 지나야 저장된다. 외부 생성 경로가 그날의
    // 판정을 모르고 문안을 보내와도 여기서 걸러진다. 창은 생성 쪽이 정한 값을 그대로 쓴다.
    let sendStored = false;
    if (out.send?.text) {
      const plan = dailySendPlan(g.chatId, g.characterId, g.today);
      const kind = out.send.kind ?? "morning";
      const allowed =
        kind === "checkin" ? plan.kind === "checkin" : plan.kind === "morning";
      if (allowed) {
        insertScheduledSend(
          g.characterId,
          g.chatId,
          g.today,
          out.send.window_start,
          out.send.window_end,
          out.send.text,
          ts,
          kind,
        );
        sendStored = true;
      }
    }

    // 오늘 메모는 수명이 하루다 — 이 배치가 그 하루를 읽어 기억·일정으로 옮겼으니 비운다.
    // 창은 gather가 읽은 것과 같은 05:00~다음날 05:00다. 추출이 아무것도 안 만든 날도 비운다:
    // 원문 대화가 messages에 그대로 남아 있어 되짚을 수 있고, 남겨 두면 지우는 자리가 없어
    // 그 하루치가 표에 영영 남는다.
    const notesCleared = clearTodayNotes(
      g.characterId,
      `${g.diaryDate} 05:00:00`,
      `${nextDate(g.diaryDate)} 05:00:00`,
    );
    // 상대의 오늘 상태도 같은 창으로 비운다 — 위 기억 정리가 마음·조심할 것에 녹였다. 창이
    // 닫힌 뒤에 판정된 값(새벽 정리가 늦게 돈 날의 새 대화)은 오늘 것이라 남긴다.
    const relNow = getRelationship(g.characterId);
    const stateCleared =
      !!relNow?.user_state &&
      (relNow.user_state_since ?? "") < `${nextDate(g.diaryDate)} 05:00:00`;
    if (stateCleared) setUserState(g.characterId, null);

    return `ok: ${g.diaryDate} 일기 응고 (대화 ${g.msgsCount}개${diaryTagList.length ? `, 일기 태그 ${diaryTagList.length}개` : ""}${memCount ? `, 기억 ${memCount}건` : ""}${schedTagCount ? `, 일정 태그 ${schedTagCount}개` : ""}${schedSkipped ? `, 이미 있는 일정 ${schedSkipped}건 건너뜀` : ""}${schedTimeFixed ? `, 일정 시각 ${schedTimeFixed}건 고침` : ""}${schedKnownFixed ? `, 상대에게 말한 일정 ${schedKnownFixed}건 표시` : ""}${skippedKeys.length ? `, 키 불가 ${skippedKeys.length}건 건너뜀` : ""}${notesCleared ? `, 오늘 메모 ${notesCleared}줄 비움` : ""}${stateCleared ? ", 상대 상태 비움" : ""}${rel.advanced ? `, 단계 ${rel.advanced.from}→${rel.advanced.to}` : ""}${rel.advanceRejected ? `, 단계 전이 건너뜀(${rel.advanceRejected})` : ""}${rel.confirmed.length ? `, 처음 확정 ${rel.confirmed.length}건` : ""}${rel.cancelled.length ? `, 처음 취소 ${rel.cancelled.length}건` : ""}${rel.userAdded.length ? `, 상대가 먼저 한 처음 ${rel.userAdded.length}건` : ""}${rel.intentSaved ? ", 오늘 의도" : ""}${progressCount ? `, 진행 중인 일 ${progressCount}건${progressDone ? ` (끝남 ${progressDone}건)` : ""}` : ""}${progressYielded ? `, 대화로 정리한 일 ${progressYielded}건은 진행 반영 건너뜀` : ""})${out.plan ? ` + ${g.today} 각본` : ""}${workFactCount ? ` + 작품 카드 ${workFactCount}건` : ""}${profileFilled.length ? ` + 상대 프로필(${profileFilled.join("·")})` : ""}${sendStored ? ` + 선톡 준비(${out.send?.kind ?? "morning"})` : ""}`;
  },
);

// 봇 밖 스케줄러(tools/nightly-write)와 봇 안 폴백 크론이 둘 다 이 함수를 지난다 —
// 트레이스 게시를 여기 한 자리에 걸어 두 경로가 같은 기록을 남긴다.
// 이전 값은 트랜잭션 전에 읽고, 게시함에 쌓는 것은 트랜잭션 바깥에서 한다:
// 게시가 실패해도 그날 새벽 정리는 이미 저장되어 있다.
export const applyNightlyOutput = (
  g: NightlyGathered,
  out: NightlyOutput,
): string => {
  const snap = beforeNightlyTrace(g, out);
  const result = applyNightlyTxn(g, out);
  afterNightlyTrace(g, out, snap, result);
  return result;
};

// 최근 결번 날짜들: 원시 대화는 있는데 일기가 안 써진 날(오래된 순, '어제' 포함).
// 새벽 정리가 며칠 안 돌면(외부 경로·폴백 모두 실패) 생기며, 소급하지 않으면 그 날짜의
// 기억·일정 정리가 영구히 빠진다 — 매일 한 번 도는 새벽 정리가 이 목록을 순회해 따라잡는다.
// (대화가 없던 결번 날은 소급하지 않는다 — 응고할 재료가 없고, 지어낸 일기만 남는다.)
export const missingDiaryDates = (
  characterId: number,
  chatId: string,
  lookbackDays = 7,
): string[] => {
  const shifted = new Date(getKstNow().getTime() - 5 * 3600_000);
  const out: string[] = [];
  for (let i = lookbackDays; i >= 1; i--) {
    const d = kstDateString(new Date(shifted.getTime() - i * 24 * 3600_000));
    const next = kstDateString(
      new Date(shifted.getTime() - (i - 1) * 24 * 3600_000),
    );
    if (hasDiaryOn(characterId, d)) continue;
    if (
      hasMessageBetween(
        chatId,
        characterId,
        `${d} 05:00:00`,
        `${next} 05:00:00`,
      )
    )
      out.push(d);
  }
  return out;
};

// ── 이하 API 폴백 경로 ──────────────────────────────────────────

const draftReconnect = async (
  g: NightlyGathered,
): Promise<SendDraft | null> => {
  const d = await chatJson<{ text: string }>(
    buildSystemBlocks(g.characterId, g.chatId, {
      situation: reconnectSituation(g),
    }),
    "위 상황 문단대로 문안을 만들어.",
    400,
    config.modelDeep,
    { purpose: "reconnect", characterId: g.characterId, chatId: g.chatId },
  );
  if (!d.text) return null;
  const toMin = (t: string): number => {
    const [h, m] = t.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const lo = toMin(RECONNECT_WINDOW.start);
  const hi = toMin(RECONNECT_WINDOW.end);
  const start = lo + Math.floor(Math.random() * Math.max(1, hi - lo + 1));
  const f = (m: number): string =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return {
    window_start: f(start),
    window_end: f(start + 90),
    text: d.text,
    kind: "checkin",
  };
};

export const addMin = (hhmm: string, m: number): string => {
  const [h, mm] = hhmm.split(":").map(Number);
  const t = Math.min(23 * 60 + 59, (h ?? 0) * 60 + (mm ?? 0) + m);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

// 오늘 각본에서 아침 문안이 쓰일 순간을 찾는다 — 기상과 그 뒤 첫 일과.
// 특정 직업의 시간표(출근 등)를 가정하지 않고, 각본에 적힌 활동을 그대로 상황으로 쓴다.
interface MorningStyle {
  moment: string; // 문안이 쓰이는 순간의 서술 — 상황 문단의 '보내는 시점'에 들어간다
  start: string; // 발송 창
  end: string;
}

export const morningStyles = (raw: string | undefined): MorningStyle[] => {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw) as DayPlan;
    const styles: MorningStyle[] = [];
    const isSleep = (b: PlanBlock): boolean => /잠|취침|수면/.test(b.activity);
    const isWake = (b: PlanBlock): boolean => /기상|일어/.test(b.activity);
    const wakeAt = p.blocks.find(isWake)?.start ?? p.blocks.find(isSleep)?.end;
    if (wakeAt)
      styles.push({
        moment: `막 일어난 참 (기상 ${wakeAt}쯤)`,
        start: wakeAt,
        end: addMin(wakeAt, 25),
      });
    const first = p.blocks.find(
      (b) =>
        !isSleep(b) &&
        !isWake(b) &&
        b.start >= (wakeAt ?? "05:00") &&
        b.start < "11:00",
    );
    if (first) {
      styles.push({
        moment: `오늘 첫 일과인 '${first.activity}'을 막 시작할 무렵 (${clockLabel(first.start)}쯤)`,
        start: first.start,
        end: addMin(first.start, 25),
      });
      if (first.responsiveness !== "unavailable")
        styles.push({
          moment: `'${first.activity}' 하다가 한숨 돌린 참 (${clockLabel(addMin(first.start, 20))}쯤)`,
          start: addMin(first.start, 10),
          end: addMin(first.start, 50),
        });
    }
    return styles;
  } catch {
    return [];
  }
};

// 발송 예정 시각을 창 전체에서 무작위로 뽑는다 — 매일 같은 시각에 오면 기계처럼 보이므로.
const windowTimes = (w: string): [string, string] => {
  const toMin = (t: string): number => {
    const [h, m] = t.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const range: [number, number] = w.includes("점심")
    ? [toMin(LUNCH_WINDOW.start), toMin(LUNCH_WINDOW.end)]
    : w.includes("저녁")
      ? [19 * 60 + 20, 20 * 60 + 40]
      : [9 * 60, 9 * 60 + 50]; // 아침 09:00~09:50
  const span = Math.max(1, range[1] - range[0] - 12);
  const s = range[0] + Math.floor(Math.random() * span); // 창 안 무작위 발송 예정 시각
  const f = (m: number): string =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return [f(s), f(range[1])];
};

// 미리 만들어 두는 아침 한 통 — 각본에서 뽑은 순간(style)에 발송 창을 맞춘다.
const draftPrepared = async (
  g: NightlyGathered,
  tomorrow: string[],
  style: MorningStyle | null,
  intent: MorningIntent | null,
): Promise<SendDraft | null> => {
  // 오래 답이 없는 중에 나가는 아침 한 통은 상대 일정을 챙기는 자리라 결이 다르다.
  const care = g.silenceTier !== "normal";
  const situation = care
    ? careSituation(g)
    : morningSituation(
        g,
        style ? style.moment : "아침 (여유로운 시간대)",
        tomorrow,
        intent,
      );
  const draft = await chatJson<{
    send: boolean;
    window?: string;
    text?: string;
  }>(
    buildSystemBlocks(g.characterId, g.chatId, { situation }),
    "위 상황 문단대로 문안을 만들어.",
    800,
    config.modelDeep,
    { purpose: "morning", characterId: g.characterId, chatId: g.chatId },
  );
  if (!draft.send || !draft.text) return null;
  if (draft.window && /점심|저녁/.test(draft.window)) {
    const [ws, we] = windowTimes(draft.window);
    return { window_start: ws, window_end: we, text: draft.text };
  }
  if (style)
    return {
      window_start: style.start,
      window_end: style.end,
      text: draft.text,
    };
  const [ws, we] = windowTimes("아침");
  return { window_start: ws, window_end: we, text: draft.text };
};

// 외부 경로가 일기만 응고하고 문안을 안 만든 날의 보강 — 오늘 문안이 없으면 여기서 준비한다.
const ensurePreparedSend = async (
  g: NightlyGathered,
  plan: DailySendPlan,
): Promise<void> => {
  if (plan.kind === "none") return;
  if (hasScheduledSendOn(g.characterId, g.today)) return;
  const style =
    plan.kind === "morning" && g.silenceTier === "normal"
      ? (morningStyles(getDayPlan(g.characterId, g.today))[0] ?? null)
      : null;
  const send =
    plan.kind === "checkin"
      ? await draftReconnect(g)
      : await draftPrepared(
          g,
          [],
          style,
          getRelationshipIntent(g.characterId, g.today) ?? null,
        );
  if (send)
    insertScheduledSend(
      g.characterId,
      g.chatId,
      g.today,
      send.window_start,
      send.window_end,
      send.text,
      kstStamp(),
      send.kind ?? "morning",
    );
};

export const runNightly = async (character: CharacterRow): Promise<string> => {
  const g = gatherNightlyInput(character);
  await ensureArcs(g.characterId, arcMaterialOf(g));
  // 이번 달(+월말이면 다음 달) 리듬을 확보한다. ensureTodayPlan이 오늘 시드를 읽어 각본에 잇는다
  await ensureRhythmRunway(g.characterId, g.today);
  // 달력 경계 아크 갱신 — 침묵 중엔 생략(볼 사람이 없고, 복귀 후 다음 경계에 이어 쓴다)
  if (g.silenceTier === "normal")
    await refreshArcs({
      characterId: g.characterId,
      chatId: g.chatId,
      today: g.today,
      personBlock: arcMaterialOf(g),
      arcLines: arcLinesOf(g),
    }).catch((e) =>
      console.error(
        "[nightly] 아크 갱신 실패:",
        e instanceof Error ? e.message : String(e),
      ),
    );

  // 결번 백필: '어제'보다 오래된 미응고 날짜(대화는 있는데 일기가 없는 날)를 먼저 처리한다.
  // 새벽 정리가 며칠 안 돌았어도 중간 날짜의 기억·일정 정리가 영구히 빠지지 않게. 각본·선톡은
  // 오늘 것만 의미가 있으므로 백필에서는 만들지 않는다.
  let backfilled = 0;
  for (const d of missingDiaryDates(g.characterId, g.chatId).filter(
    (x) => x < g.diaryDate,
  )) {
    try {
      const bg = gatherNightlyInput(character, d);
      const entry = await chatJson<DiaryOutput>(
        DIARY_SYSTEM,
        diaryPrompt(bg),
        2000,
        config.modelDeep,
        { purpose: "diary", characterId: bg.characterId, chatId: bg.chatId },
      );
      const extract = await chatJson<ExtractOutput>(
        EXTRACT_SYSTEM,
        extractPrompt(bg),
        2000,
        config.modelDeep,
        { purpose: "extract", characterId: bg.characterId, chatId: bg.chatId },
      );
      // 백필 회차는 관계 절에서 처음 확정만 받는다 — 며칠 지난 날의 값으로 단계를 올리거나
      // 그날 의도를 적지 않게. 의도는 applyRelationOutput이 날짜로 한 번 더 거른다.
      const backfillExtract: ExtractOutput = {
        ...extract,
        relation: extract.relation
          ? { firsts: extract.relation.firsts ?? null }
          : null,
      };
      backfilled += 1;
      console.log(
        `[nightly] 백필 ${applyNightlyOutput(bg, { entry, extract: backfillExtract })}`,
      );
    } catch (e) {
      // 백필 하루 실패가 오늘(어제 일기) 처리까지 막지 않게 — 다음 새벽에 같은 날짜를 재시도한다
      console.error(
        `[nightly] 백필 실패 (${d}):`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  // 백필이 처음을 확정했으면 오늘 회차의 관계 값은 수집 때와 달라져 있다 — 다시 읽는다.
  if (backfilled)
    g.relation = gatherRelation(g.characterId, g.chatId, g.diaryDate, g.today);

  if (g.diaryExists) {
    // 정식(어제 일기 반영) 각본 확보 — 새벽 대화가 만든 lazy 각본이 있으면 교체된다
    if (g.silenceTier === "normal") await ensureTodayPlan(g.characterId, true);
    await ensurePreparedSend(
      g,
      dailySendPlan(g.chatId, g.characterId, g.today),
    );
    return `skip: ${g.diaryDate} 일기 이미 있음 (침묵 ${g.silenceDays}일, ${g.silenceTier})`;
  }

  let entry: DiaryOutput;
  let extract: ExtractOutput | null = null;
  let send: SendDraft | null = null;
  let progress: OngoingProgress[] | null = null;

  if (g.msgsCount) {
    entry = await chatJson<DiaryOutput>(
      DIARY_SYSTEM,
      diaryPrompt(g),
      2000,
      config.modelDeep,
      { purpose: "diary", characterId: g.characterId, chatId: g.chatId },
    );
    extract = await chatJson<ExtractOutput>(
      EXTRACT_SYSTEM,
      extractPrompt(g),
      2000,
      config.modelDeep,
      { purpose: "extract", characterId: g.characterId, chatId: g.chatId },
    );
  } else {
    entry = await chatJson<DiaryOutput>(
      DIARY_SYSTEM,
      quietDayPrompt(g),
      1200,
      config.modelDeep,
      { purpose: "diary", characterId: g.characterId, chatId: g.chatId },
    );
  }

  // 어제 각본에 진행 중인 일이 있었으면 대화가 없던 날에도 한 걸음 옮긴다. 실패해도 일기와
  // 기억 정리는 그대로 반영한다 — 이 값은 다음 각본이 다시 손댈 때 따라잡는다.
  if (g.ongoingTouched.length)
    progress = await chatJson<ProgressOutput>(
      PROGRESS_SYSTEM,
      progressPrompt(g),
      800,
      config.modelDeep,
      { purpose: "progress", characterId: g.characterId, chatId: g.chatId },
    )
      .then((r) => r.progress ?? null)
      .catch((e) => {
        console.error(
          "[nightly] 진행 중인 일 반영 실패:",
          e instanceof Error ? e.message : String(e),
        );
        return null;
      });

  // 오늘 무엇을 미리 만들어 둘지는 관제탑이 정한다 — 아침 한 통 / 점심 한 통 / 저녁 안부 /
  // 없음. 반영 직전과 발송 직전에도 같은 판정을 다시 거친다.
  const plan = dailySendPlan(g.chatId, g.characterId, g.today);

  // 침묵 백오프: 조용/휴면 단계에선 각본을 만들지 않는다 — 볼 사람이 없는 산출물에 opus를
  // 쓰지 않는다. 유저가 돌아오면 각본은 lazy 생성이 받고, 다음 새벽부터 정식 경로가 재개된다.
  // 다만 그날 상대에게 일정이 있으면 그것만 챙기는 아침 한 통은 준비한다.
  if (g.silenceTier === "quiet" || g.silenceTier === "dormant") {
    if (plan.kind === "morning")
      send = await draftPrepared(
        g,
        entry.tomorrow ?? [],
        null,
        extract?.relation?.intent ?? null,
      );
    return `${applyNightlyOutput(g, { entry, extract, progress, send })} (침묵 ${g.silenceDays}일 — ${plan.reason})`;
  }
  // 재연결 단계: 아침 인사 대신 저녁 안부 1통만 준비한다
  if (g.silenceTier === "checkin") {
    send = await draftReconnect(g);
    return applyNightlyOutput(g, { entry, extract, progress, send });
  }

  // 오늘 각본을 먼저 만들고, 아침 선톡의 발송 시점을 그 각본의 삶(기상·첫 일과)과 연동한다.
  // 새벽 정리 경로(nightly=true)라 새벽 대화가 만든 lazy 각본이 있으면 정식 각본으로 교체된다.
  await ensureTodayPlan(g.characterId, true);
  const styles = morningStyles(getDayPlan(g.characterId, g.today));
  const style = styles.length
    ? styles[Math.floor(Math.random() * styles.length)]
    : null;

  // 선톡 문안: 아침의 자기 삶 공유가 기본이다. 대화와 같은 3층 프롬프트를 쓰므로 어제에서
  // 이어갈 것(entry.tomorrow — 아직 DB에 없는 방금 쓴 일기의 것)만 상황 문단으로 넘긴다.
  if (plan.kind === "morning")
    send = await draftPrepared(
      g,
      entry.tomorrow ?? [],
      style,
      extract?.relation?.intent ?? null,
    );

  const result = applyNightlyOutput(g, { entry, extract, progress, send });
  return result;
};
