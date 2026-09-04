// 새벽 정리 — 하루를 닫고 다음 날에 필요한 것을 만든다.
//
// gather와 apply를 나눠 둬서, 봇 밖 스케줄러(tools/nightly-read·write)와 봇 안 폴백 크론
// (05:40)이 같은 함수를 쓴다. 기본 경로는 밖이라 봇은 API를 쓰지 않는다.
//
// 하는 일 — 일기 쓰기, 기억 정리, 다음 날 각본, 월 리듬(rhythmNeeded 신호가 오면),
// 아크 이어쓰기(월요일은 주, 1일은 달), 내일 선톡 문안 준비.
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
// 유저가 오래 조용하면 gather가 침묵 단계를 노출하고 apply가 게이트를 강제한다 — quiet·
// dormant면 일기와 시드와 리듬만 만들고 각본과 선톡은 건너뛰고, reconnect면 저녁 재연결
// 문안만 만든다. 밖에서 부르는 경로가 백오프를 몰라도 안전하게 두려는 것이다.

import { chatJson } from "./llm.js";
import { config } from "./config.js";
import {
  db,
  getDayPlan,
  getDayPlanMadeBy,
  getDaySeed,
  getRecentDiaries,
  getRelationship,
  updateRelationshipNotes,
  addSchedule,
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
  type CharacterRow,
  type DaySeed,
  type MemoryRow,
  type RelationshipRow,
} from "./db.js";
import { buildSystemBlocks } from "./context.js";
import { isSameScheduleContent } from "./schedule-dedupe.js";
import type { DayPlan, PlanBlock } from "./day-plan.js";
import {
  ensureTodayPlan,
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
  type MonthPlan,
} from "./life-plan.js";
import { getKstNow, kstDateString, dayLabelOf, clockLabel } from "./kst.js";
import {
  dailySendPlan,
  silenceState,
  type DailySendPlan,
} from "./proactive-policy.js";
import { afterNightlyTrace, beforeNightlyTrace } from "./nightly-trace.js";
import {
  DIARY_TAG_MAX,
  EXTRACT_SCHEDULE_MAX,
  EXTRACT_USER_FACT_MAX,
  LUNCH_WINDOW,
  RECONNECT_WINDOW,
  RECENT_DIARY_DAYS,
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
  }[];
}

export interface SendDraft {
  window_start: string; // "HH:MM"
  window_end: string;
  text: string;
  // 생략 시 morning. checkin=긴 침묵 뒤 안부 1통.
  // 점심 선톡은 morning으로 저장하고 발송 창만 점심으로 둔다 — 발송 경로가 같아서
  // 종류를 늘리면 scheduled_messages 이관만 늘고 얻는 게 없다.
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
  rhythmNeeded: { ym: string; days: { date: string; label: string }[] }[]; // 이번 새벽에 생성해야 할 월 리듬
  // 침묵 백오프 상태 — 외부 생성 경로가 이를 보고 산출물을 조절한다
  // (normal=평소대로 / quiet·dormant=각본·선톡 생성 불필요 / checkin=저녁 재연결 문안만)
  silenceTier: "normal" | "quiet" | "checkin" | "dormant";
  silenceDays: number;
  // 오늘 미리 만들어 둘 선톡 — morning=아침 한 통 / lunch=점심 한 통 /
  // checkin=저녁 안부 한 통 / none=준비하지 않는 날. 외부 생성 경로는 이 값만 보면 된다.
  sendPlan: "morning" | "lunch" | "checkin" | "none";
  sendPlanReason: string;
}

const nowStamp = (): string =>
  `${kstDateString()} ${getKstNow().toISOString().slice(11, 19)}`;

// 하루 창의 끝을 만드는 다음 날짜. 대화·오늘 메모를 05:00~다음날 05:00로 끊는 데 쓴다.
const nextDate = (date: string): string =>
  kstDateString(
    new Date(new Date(`${date}T00:00:00Z`).getTime() + 24 * 3600_000),
  );

// 모델이 준 태그를 다듬는다. 배열이 아닐 수도, 빈 문자열이나 같은 말이 두 번 올 수도 있다.
const cleanTags = (raw: unknown, max?: number): string[] => {
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

const planBrief = (raw: string | undefined): string => {
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

const personLine = (r: MemoryRow): string => {
  const meta = [r.area, r.relation, r.owner === "user" ? "상대 쪽 사람" : null]
    .filter(Boolean)
    .join(", ");
  return `- ${r.subject} (${meta}): ${r.value}`;
};

const ongoingLine = (r: MemoryRow): string =>
  `- ${r.owner === "user" ? "(상대) " : ""}${r.area}/${r.subject}: ${r.value}${r.end_condition ? ` (끝나는 조건: ${r.end_condition})` : ""}`;

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

const arcLinesOf = (g: NightlyGathered): string =>
  Object.entries(g.arcs)
    .map(([h, c]) => `${h}: ${c}`)
    .join("\n");

// 아크 생성·갱신에 넣는 인물 재료 — 기억(정체성·주변 인물·진행 중인 일)과 관계로 만든다.
// V2 생성 직후에는 character.ts의 arcMaterial이 생성 출력으로 같은 모양을 만든다.
const arcMaterialOf = (g: NightlyGathered): string =>
  [
    "[정체성]",
    g.identity || "(없음)",
    "",
    "[주변 인물]",
    g.people || "(없음)",
    "",
    "[진행 중인 일]",
    g.ongoing || "(없음)",
    "",
    "[유저와의 관계]",
    g.relationship || "(이제 막 시작한 사이)",
  ].join("\n");

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
  const msgs = db
    .prepare(
      `SELECT role, sent_at, text FROM messages WHERE chat_id = ? AND sent_at >= ? AND sent_at < ? ORDER BY id`,
    )
    .all(
      character.chat_id,
      `${diaryDate} 05:00:00`,
      `${diaryNext} 05:00:00`,
    ) as {
    role: string;
    sent_at: string;
    text: string;
  }[];

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
    diaryExists: !!db
      .prepare(
        `SELECT 1 FROM diary_entries WHERE character_id = ? AND date = ? LIMIT 1`,
      )
      .get(character.id, diaryDate),
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
    userProfile: userProfileLines(character.chat_id),
    todayNotes,
    dayActuals: getDayActuals(character.id, diaryDate).map(
      (a) =>
        `- ${a.block_start ? `${clockLabel(a.block_start)} ` : ""}${a.intended} → ${a.outcome}${a.reason ? ` (${a.reason})` : ""}`,
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
        }`,
    ),
    arcs: getArcs(character.id),
    todaySeed: getDaySeed(character.id, today) ?? null,
    rhythmNeeded: monthsNeedingRhythm(character.id, today).map((ym) => ({
      ym,
      days: monthDays(ym),
    })),
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
    const ts = nowStamp();

    const dup = db
      .prepare(
        `SELECT 1 FROM diary_entries WHERE character_id = ? AND date = ? LIMIT 1`,
      )
      .get(g.characterId, g.diaryDate);
    if (dup) return `skip: ${g.diaryDate} 일기 이미 있음`;

    const diaryId = Number(
      db
        .prepare(
          `INSERT INTO diary_entries (character_id, date, entry_json) VALUES (?, ?, ?)`,
        )
        .run(g.characterId, g.diaryDate, JSON.stringify(out.entry))
        .lastInsertRowid,
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
    }

    // 그날 각본: 없으면 저장하고, 있어도 새벽 대화가 만든 lazy 각본이면 정식 각본으로 교체한다.
    // 임시 각본은 어제 일기가 아직 없을 때(이틀 전 일기 참조) 만들어진 것 — 그대로 두면
    // "어제 여파가 시드보다 우선" 설계가 정확히 새벽까지 대화한 날마다 무력화된다.
    // (교체에 쓰는 정식 각본은 그 새벽 대화가 담긴 어제 일기를 반영하므로 모순 위험은 작다.)
    if (
      out.plan &&
      (!getDayPlan(g.characterId, g.today) ||
        getDayPlanMadeBy(g.characterId, g.today) === "ondemand")
    )
      saveDayPlan(
        g.characterId,
        g.today,
        JSON.stringify(normalizePlan(out.plan)),
        "nightly",
      );

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

    // 선톡 문안 — 관제탑(dailySendPlan) 게이트를 지나야 저장된다. 외부 생성 경로가 그날의
    // 판정을 모르고 문안을 보내와도 여기서 걸러진다. 점심 문안은 아침 문안과 같은 종류로
    // 저장하므로 둘을 함께 통과시키고, 창은 생성 쪽이 정한 값을 그대로 쓴다.
    let sendStored = false;
    if (out.send?.text) {
      const plan = dailySendPlan(g.chatId, g.characterId, g.today);
      const kind = out.send.kind ?? "morning";
      const allowed =
        kind === "checkin"
          ? plan.kind === "checkin"
          : plan.kind === "morning" || plan.kind === "lunch";
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

    return `ok: ${g.diaryDate} 일기 응고 (대화 ${g.msgsCount}개${diaryTagList.length ? `, 일기 태그 ${diaryTagList.length}개` : ""}${memCount ? `, 기억 ${memCount}건` : ""}${schedTagCount ? `, 일정 태그 ${schedTagCount}개` : ""}${schedSkipped ? `, 이미 있는 일정 ${schedSkipped}건 건너뜀` : ""}${skippedKeys.length ? `, 키 불가 ${skippedKeys.length}건 건너뜀` : ""}${notesCleared ? `, 오늘 메모 ${notesCleared}줄 비움` : ""}${progressCount ? `, 진행 중인 일 ${progressCount}건${progressDone ? ` (끝남 ${progressDone}건)` : ""}` : ""}${progressYielded ? `, 대화로 정리한 일 ${progressYielded}건은 진행 반영 건너뜀` : ""})${out.plan ? ` + ${g.today} 각본` : ""}${profileFilled.length ? ` + 상대 프로필(${profileFilled.join("·")})` : ""}${sendStored ? ` + 선톡 준비(${out.send?.kind ?? "morning"})` : ""}`;
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
    const hasDiary = !!db
      .prepare(
        `SELECT 1 FROM diary_entries WHERE character_id = ? AND date = ? LIMIT 1`,
      )
      .get(characterId, d);
    if (hasDiary) continue;
    const hasMsgs = !!db
      .prepare(
        `SELECT 1 FROM messages WHERE chat_id = ? AND sent_at >= ? AND sent_at < ? LIMIT 1`,
      )
      .get(chatId, `${d} 05:00:00`, `${next} 05:00:00`);
    if (hasMsgs) out.push(d);
  }
  return out;
};

// ── 이하 API 폴백 경로 ──────────────────────────────────────────

const DIARY_SYSTEM = `너는 주어진 인물 그 자체다. 하루를 마치고 혼자 일기를 쓴다. 담백하고 사적인 1인칭 문장으로, 과장 없이.`;

const diaryPrompt = (g: NightlyGathered): string => `너는 이 인물이다.

[정체성]
${g.identity || "(없음)"}

[삶의 흐름]
${arcLinesOf(g) || "(없음)"}

[상대와의 관계]
${g.relationship || "(이제 막 시작한 사이)"}

오늘은 ${g.diaryDate}였다.

[오늘의 원래 흐름]
${g.planBriefYesterday || "(기록 없음)"}

[각본과 달라진 것]
${g.dayActuals.join("\n") || "(없음)"}

[오늘 메모 — 대화하며 적어 둔 것]
${g.todayNotes.join("\n") || "(없음)"}

[이미 쓰는 태그]
${g.tagNames.join(", ") || "(없음)"}

[상대와 나눈 대화 전체]
${g.convo}

오늘을 정리해 JSON으로:
{"diary":"오늘의 일기. 1인칭, 5~10문장. 실제 보낸 하루와 상대와 나눈 것, 마음에 남은 것","plan_vs_actual":"원래 흐름과 실제로 보낸 하루가 달랐던 점 한두 줄","user_mood":"상대의 감정 흐름에 대한 관찰 한두 줄","closeness":"상대와의 거리감·온도 한 줄 (내부 기록, 상대에게 절대 언급하지 않는 것)","tomorrow":["내일 자연스럽게 이어가거나 물어볼 것 0~2개"],"tags":["이 하루를 나중에 다시 꺼낼 주제 태그 3~${DIARY_TAG_MAX}개"]}

tags 규칙:
- 나중에 이 하루를 다시 꺼내는 실마리다. 한 일·간 곳·만난 사람 이름·나눈 이야기의 주제를 낱말로 적는다.
- [이미 쓰는 태그]에 같은 뜻이 있으면 그 표기를 그대로 쓴다. 같은 주제를 다른 낱말로 적으면 나중에 함께 찾아지지 않는다.
- 명사 한 덩어리로 짧게. 날짜·문장·감상은 태그로 쓰지 않는다.`;

const quietDayPrompt = (g: NightlyGathered): string => `너는 이 인물이다.

[정체성]
${g.identity || "(없음)"}

[삶의 흐름]
${arcLinesOf(g) || "(없음)"}

오늘은 ${g.diaryDate}였고, 상대와 대화가 없던 날이다. 아래 흐름대로 혼자 하루를 보냈다.

[오늘의 흐름]
${g.planBriefYesterday || "(평범한 하루)"}
${g.dayActuals.length ? `\n[각본과 달라진 것]\n${g.dayActuals.join("\n")}\n` : ""}
[이미 쓰는 태그]
${g.tagNames.join(", ") || "(없음)"}

JSON으로:
{"diary":"혼자 보낸 하루의 일기. 1인칭, 3~6문장. 대화가 없었던 것에 대한 감정이 있다면 안정형답게 담담하게","plan_vs_actual":"—","user_mood":"—","closeness":"—","tomorrow":[],"tags":["이 하루를 나중에 다시 꺼낼 주제 태그 2~${DIARY_TAG_MAX}개"]}

tags 규칙: 한 일·간 곳·만난 사람 이름을 낱말로 적는다. [이미 쓰는 태그]에 같은 뜻이 있으면 그 표기를 그대로 쓰고, 명사 한 덩어리로 짧게 쓴다.`;

// 기억과 일정이 같은 어휘로 묶이도록 태그 규칙은 한 문장을 두 자리에 쓴다 — 규칙이 갈라지면
// 같은 주제가 다른 낱말로 적혀 함께 찾아지지 않는다.
const TAG_RULE = `내용과 관련된 말을 넉넉히 붙인다. 사람 이름은 반드시 태그로. [이미 쓰는 태그]에 같은 뜻이 있으면 그 표기를 재사용한다.`;

const PROGRESS_SYSTEM = `너는 캐릭터가 며칠에 걸쳐 하는 일이 어제 얼마나 나아갔는지 적는 정리자다. 어제 각본에 그 일을 하는 시간이 있었고 실제로 그대로 지냈으면 한 걸음만 옮긴다. 지어내지 말고 그 일의 결에 맞는 만큼만 적는다.`;

// 진행 반영 프롬프트. 어제 각본에 들어간 일마다 지금 값·끝나는 조건·실제 기록을 넘기고
// 새 값을 받는다. 어제 대화가 있으면 같이 넘긴다 — 대화에서 이미 어디까지 갔다고 말했으면
// 그 말과 어긋난 값을 적지 않게.
export const progressPrompt = (g: NightlyGathered): string => `[어제 각본에 들어간 진행 중인 일 — [번호] 영역/무엇: 지금 값 (끝나는 조건) — 어제 각본: 시각 활동 → 각본대로 / 달라짐]
${g.ongoingTouched.join("\n")}
${g.convo ? `\n[어제 대화 — ${g.diaryDate}]\n${g.convo}\n` : ""}
규칙:
- 각본대로 지낸 블록마다 그 일을 한 걸음만 옮긴다. 책이면 몇 장 더, 준비하는 일이면 그 다음 단계. 며칠치를 한 번에 옮기지 않는다.
- 새 값은 한두 문장으로, 앞 값에 있던 구체(제목·상대·수치)는 그대로 둔다. 어디까지 왔는지가 드러나게 쓴다.
- "달라짐"으로 취소되거나 미뤄진 블록은 그날 몫이 없던 것이다. 그 일은 목록에 넣지 않는다.
- 어제 대화에서 그 일을 어디까지 했다고 말했으면 그 말과 어긋나지 않게 적는다.
- 끝나는 조건이 채워졌으면 done을 true로 하고, value에는 끝난 상태(${g.diaryDate}에 끝났다는 것과 무엇으로 끝났는지)를 적는다. 그렇지 않으면 done은 false.
- 옮길 것이 없으면 빈 배열을 준다.

출력(JSON만):
{"progress":[{"id":61,"value":"새 값 한두 문장","done":false}]}`;

const EXTRACT_SYSTEM = `너는 캐릭터의 하루에서 다음 대화에 필요한 기억을 정리하는 정리자다. 대화에 나온 확실한 사실만 담고, 남길 것이 없으면 빈 배열을 준다.`;

export const extractPrompt = (g: NightlyGathered): string => {
  const keyLines = g.existingKeys
    .map((k) => `- ${k.itemType} ${k.owner} ${k.key}`)
    .join("\n");
  return `기준 날짜: ${g.diaryDate}. '나' = 캐릭터(owner "char"), '상대' = 유저(owner "user").

[나의 정체성 — 이미 아는 것]
${g.identity || "(없음)"}

[이미 아는 주변 인물]
${g.people || "(없음)"}

[진행 중인 일]
${g.ongoing || "(없음)"}

[상대에 대해 이미 아는 것 — 오늘 대화와 겹치는 키의 지금 값]
${g.touchedUserFacts.join("\n") || "(없음)"}

[상대와의 관계 — 지금 값]
${g.relationship || "(이제 막 시작한 사이)"}

[상대 프로필 — 지금 값]
${g.userProfile}

[이미 있는 키 — 같은 주제는 반드시 이 키를 그대로 다시 쓴다 (항목 owner 영역/무엇)]
${keyLines || "(없음)"}

[영역 이름 목록]
${g.areas.join(", ") || "(없음)"}

[이미 쓰는 태그]
${g.tagNames.join(", ") || "(없음)"}

[이미 저장된 일정 — 같은 일이면 다시 적지 않는다]
${g.existingSchedules.join("\n") || "(없음)"}

[오늘의 대화]
${g.convo}

[오늘 메모 — 대화하며 적어 둔 남길 것]
${g.todayNotes.join("\n") || "(없음)"}

[각본과 달라진 것]
${g.dayActuals.join("\n") || "(없음)"}

JSON으로:
{"memories":[{"item_type":"fact|ongoing|person","owner":"char|user","area":"영역","subject":"무엇","value":"사실 한두 문장","tags":["관련어"],"user_knows":"known|unknown — '나'(char) 쪽만","relation":"person만 — 어떤 사이","contact_mode":"person만 — 만나는 결(직장에서 매일, 가끔 연락 등)","region":"person만 — 어디 사람인지","end_condition":"ongoing만 — 끝났다고 볼 조건","interest":"high|medium|low — '나' 쪽 기억에 상대의 관심이 뚜렷할 때만"}],"relationship":{"speech_note":"상대에게 쓰는 말투","rapport":"잘 통하는 것","cautions":"조심할 것","history":"지나온 이야기","feelings":"지금 마음"},"user_profile":{"job":"상대가 하는 일","region":"상대가 사는 지역"},"schedules":[{"who":"user 또는 char","date":"YYYY-MM-DD","time_hint":"오전/저녁/14:00 등 또는 null","content":"무슨 일정인지","tags":["관련어"]}]}

memories 규칙:
- 남길 것 = 다음에 대화할 때 알고 있어야 자연스러운 사실만. 잡담 전부가 아니라 이어질 것만.
- item_type: 그때그때의 사실=fact / 끝나는 조건이 있는 일=ongoing / 사람=person.
- 키 = 영역/무엇. 영역은 위 [영역 이름 목록]에서 고르고, 꼭 맞는 게 없을 때만 새로 만든다(12자 이내). '무엇'은 명사 한 덩어리 20자 이내. 두 자리 모두 슬래시·세로줄·쉼표·가운뎃점 금지.
- 같은 주제가 [이미 있는 키]에 있으면 반드시 그 키를 그대로 쓴다. 같은 키에 쓰면 값이 통째로 갈아 끼워지니, 다시 쓸 때는 위에 적힌 앞 값에 있던 원인 추정·장소·이름·숫자 같은 세부를 그대로 두고 이번에 새로 안 것을 합쳐 쓴다. 앞 값과 모순되는 부분만 새 값으로 바꾼다. 이미 아는 내용과 같은 것은 다시 넣지 않는다.
- 합친 값이 길어지면 지나간 상태와 되풀이된 감상부터 줄이고, 원인·장소·이름·숫자처럼 한 번 지우면 되찾을 수 없는 것은 남긴다. 값은 두 문장 안에 둔다.
- 한 번 있었던 일은 날짜를 붙인 사건으로 적는다(예: ${g.diaryDate} 저녁에 야근했다). 평소 그렇다는 성향 문장은 같은 모습이 앞 값에도 있어 여러 번 나왔을 때만 쓴다.
- 값에는 사실만 적고, 그날 대화에서 누가 무엇을 묻고 어떻게 답했는지 같은 장면은 넣지 않는다. 그런 장면은 일기의 몫이다.
- person: 영역=갈래(가족·직장·친구 등), 무엇=이름(모르면 호칭 그대로). 상대가 흘리듯 언급한 상대 쪽 사람도 빠뜨리지 않는다. 이미 아는 인물은 내용이 달라졌을 때만 같은 키로 다시 쓴다.
- "~라고 불러줘" 같은 지시·부탁은 사실 문장으로 바꿔 저장한다 (예: 상대는 OO라고 불리는 걸 좋아한다).
- tags: ${TAG_RULE}
- user_knows: '나'(char) 쪽 기억에만 — 이 사실을 상대가 아는가.

relationship 규칙: 이 하루로 실제 달라진 항목만 넣는다 (넣은 항목만 갱신되고, 나머지는 그대로 남는다). 각 항목은 짧은 서술로. 지금 어떤 사이인지·서로 부르는 말·존댓말과 반말은 대화하는 자리에서 이미 갱신되니 여기서 건드리지 않는다. 달라진 게 없으면 relationship은 null.
user_profile 규칙:
- 상대가 하는 일·사는 지역이 대화에서 분명히 드러났을 때만 넣는다. 어림짐작으로 채우지 않고, 확실하지 않으면 비워 둔다.
- 위 [상대 프로필 — 지금 값]에 이미 있는 값과 같으면 넣지 않는다. 두 값 다 그대로면 user_profile은 null.
- 값은 짧게 — 하는 일은 직업 한 덩어리(예: 중학교 교사), 사는 지역은 시·구 정도(예: 서울 마포구). 문장으로 쓰지 않는다.
- 여기 넣은 값은 프롬프트에 늘 들어간다. 같은 내용을 memories에 또 넣지 않고, 이야기가 붙는 것(회사를 옮긴 사정, 동네에서 자주 가는 곳 같은)만 memories로 남긴다.
schedules 규칙:
- 기준 날짜로 환산 가능한 날짜만. 위 정체성의 직업·생활과 어긋나는 날짜면 제외한다.
- 위 [이미 저장된 일정]에 같은 일이 있으면 넣지 않는다. 말이 조금 다르게 적혀 있어도
  같은 날 같은 약속을 가리키면 같은 일이다 — 시간이나 사람 이름이 이번에 더 나왔다고
  해서 새로 적지 않는다. 그 줄은 이미 있는 것으로 두고 넘어간다.
- 새 일정으로 넣는 것은 [이미 저장된 일정]에 없는 일만이다.
- tags: ${TAG_RULE}`;
};

// ── 선톡 문안 — 대화와 같은 3층 프롬프트(buildSystemBlocks)에 상황 문단만 얹는다 ──
// 앞 두 층이 대화와 같아야 캐시가 붙는다. 문안은 새벽에 미리 쓰지만 나가는 건 아침·저녁이라,
// 실시간 꼬리의 '지금' 시각이 아니라 보내는 시점의 결로 쓰라고 상황 문단이 못박는다.

const morningSituation = (
  g: NightlyGathered,
  moment: string,
  tomorrow: string[],
): string =>
  [
    `[문안 준비 — 오늘 상대에게 먼저 보낼 한 통]`,
    `이 문안은 지금(새벽) 미리 써 두고 아래 '보내는 시점'에 나간다. 위의 '지금' 시각이 아니라 그 시점의 상황에서 쓰는 말이어야 한다.`,
    `- 보내는 시점: ${moment}`,
    `- 어제에서 이어갈 것: ${tomorrow.length ? tomorrow.join(" / ") : "(없음)"}`,
    `- 상대의 다가오는 일정(들은 것): ${g.userSchedulesUpcoming || "(없음)"}`,
    ``,
    `문안 규칙:`,
    `- 아침이면 웬만하면 보낸다. 네 하루가 시작됐다는 걸 가볍게 알리는 결 — '보내는 시점' 그대로의 상황에서 쓰는 말이어야 한다. 자기 삶 공유는 그 자체로 근거다.`,
    `- 각본상 오늘 유난히 일찍 깼거나 늦잠이면 그 결을 자연스럽게 반영한다.`,
    `- 이어갈 것이나 상대의 일정이 있으면 그중 하나를 자연스럽게 엮는다. 특히 상대의 일정이 오늘이면 그걸 챙기는 게 우선이다.`,
    `- 한 통에 하나만. 캐묻지 않는다. 용건 없는 애정 표시성 핑은 금지. 1~3개 말풍선(줄바꿈 구분).`,
    `- 상대 일정이 점심·저녁에 있으면 window를 "점심"/"저녁"으로 바꿔도 된다(그 외엔 "아침").`,
    `- 아주 가끔은(그날 각본이 유난히 정신없으면) 건너뛰어도 사람답다 → send=false.`,
    ``,
    `JSON으로만 답한다: {"send":true,"window":"아침|점심|저녁","text":"..."} 또는 {"send":false}`,
  ].join("\n");

// 이틀째 답이 없는 날 — 아침을 거르고 점심 무렵에 한 통만 보낸다.
const lunchSituation = (g: NightlyGathered, tomorrow: string[]): string =>
  [
    `[문안 준비 — 오늘 점심 무렵에 보낼 한 통]`,
    `상대가 이틀째 답이 없다. 아침 인사는 거르고 점심 무렵에 한 통만 보낸다. 이 문안은 지금(새벽) 미리 써 두고 점심에 나가니, 위의 '지금' 시각이 아니라 점심 무렵의 결로 쓴다.`,
    `- 어제에서 이어갈 것: ${tomorrow.length ? tomorrow.join(" / ") : "(없음)"}`,
    `- 상대의 다가오는 일정(들은 것): ${g.userSchedulesUpcoming || "(없음)"}`,
    ``,
    `문안 규칙:`,
    `- 점심 무렵 네가 뭘 하고 있는지 가볍게 한 마디. 답을 재촉하지 않고 상대가 다시 말 걸 자리를 만들어 두는 것이다.`,
    `- 답이 없는 걸 언급하지 않는다. 서운함·걱정·캐묻기 금지.`,
    `- 상대의 일정이 오늘이면 그것만 가볍게 챙긴다.`,
    `- 1~2개 말풍선(줄바꿈 구분).`,
    ``,
    `JSON으로만 답한다: {"send":true,"text":"..."} 또는 {"send":false}`,
  ].join("\n");

// 오래 답이 없는 중에도 상대에게 오늘 일정이 있는 날 — 그 일정만 챙기는 한 통.
const careSituation = (g: NightlyGathered): string =>
  [
    `[문안 준비 — 오늘 아침에 보낼 한 통]`,
    `상대와 연락이 오간 지 ${g.silenceDays}일쯤 됐다. 평소라면 먼저 말을 걸지 않지만, 오늘은 상대가 말해 둔 일정이 있어 그것만 챙기는 한 통을 보낸다. 지금(새벽) 미리 써 두고 아침에 나가니 아침의 결로 쓴다.`,
    `- 상대의 일정(들은 것): ${g.userSchedulesUpcoming || "(없음)"}`,
    ``,
    `문안 규칙:`,
    `- 오늘 있는 그 일정 하나만 짧게 챙긴다. 잘되길 바란다는 정도.`,
    `- 그동안 연락이 없던 걸 언급하지 않는다. 서운함·안부 캐묻기·근황 요구 금지.`,
    `- 1~2개 말풍선(줄바꿈 구분).`,
    ``,
    `JSON으로만 답한다: {"send":true,"text":"..."} 또는 {"send":false}`,
  ].join("\n");

const reconnectSituation = (g: NightlyGathered): string =>
  [
    `[문안 준비 — 오늘 저녁에 보낼 안부 한 통]`,
    `상대와 마지막으로 연락이 오간 지 ${g.silenceDays}일쯤 됐다. 이 문안은 지금(새벽) 미리 써 두고 저녁에 나간다 — 저녁의 결로 쓴다.`,
    `- "요새 많이 바쁘지?" 같은, 근황을 가볍게 묻는 결. 네 근황 한 조각을 곁들여도 좋다.`,
    `- 서운함·재촉·"왜 연락 없어" 금지. 답장을 요구하는 압박 금지. 길게 쓰지 않는다.`,
    `- 1~2개 말풍선(줄바꿈 구분).`,
    ``,
    `JSON으로만 답한다: {"text":"..."}`,
  ].join("\n");

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

const addMin = (hhmm: string, m: number): string => {
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

const morningStyles = (raw: string | undefined): MorningStyle[] => {
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

// 미리 만들어 두는 선톡 한 통 — 그날 판정(morning·lunch)에 맞는 상황 문단으로 문안을 받는다.
// 점심 문안은 창이 정해져 있고, 아침 문안은 각본에서 뽑은 순간(style)에 창을 맞춘다.
const draftPrepared = async (
  g: NightlyGathered,
  kind: "morning" | "lunch",
  tomorrow: string[],
  style: MorningStyle | null,
): Promise<SendDraft | null> => {
  // 오래 답이 없는 중에 나가는 아침 한 통은 상대 일정을 챙기는 자리라 결이 다르다.
  const care = kind === "morning" && g.silenceTier !== "normal";
  const situation = care
    ? careSituation(g)
    : kind === "lunch"
      ? lunchSituation(g, tomorrow)
      : morningSituation(
          g,
          style ? style.moment : "아침 (여유로운 시간대)",
          tomorrow,
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
    { purpose: kind, characterId: g.characterId, chatId: g.chatId },
  );
  if (!draft.send || !draft.text) return null;
  if (kind === "lunch") {
    const [ws, we] = windowTimes("점심");
    return { window_start: ws, window_end: we, text: draft.text };
  }
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
  const exists = db
    .prepare(
      `SELECT 1 FROM scheduled_messages WHERE character_id = ? AND date = ? LIMIT 1`,
    )
    .get(g.characterId, g.today);
  if (exists) return;
  const style =
    plan.kind === "morning" && g.silenceTier === "normal"
      ? (morningStyles(getDayPlan(g.characterId, g.today))[0] ?? null)
      : null;
  const send =
    plan.kind === "checkin"
      ? await draftReconnect(g)
      : await draftPrepared(g, plan.kind, [], style);
  if (send)
    insertScheduledSend(
      g.characterId,
      g.chatId,
      g.today,
      send.window_start,
      send.window_end,
      send.text,
      nowStamp(),
      send.kind ?? "morning",
    );
};

const ARC_SYSTEM = `너는 한 인물의 삶의 큰 흐름을 짜는 작가다. 과장 없이, 실제 그 사람의 한 해에 있을 법한 결로.`;

const arcPrompt = (
  personBlock: string,
  today: string,
): string => `오늘은 ${today}다. 아래 인물의 삶의 큰 흐름을 JSON으로 짜줘.

[인물]
${personBlock}

{"year":"올해의 큰 진행 사건 1~2문장","season":"이 계절의 결 1~2문장","month":"이번 달의 상황 1~2문장","week":"이번 주의 특이사항 1문장 (없으면 '평범한 주')"}`;

export const ensureArcs = async (
  characterId: number,
  personBlock: string,
): Promise<void> => {
  if (Object.keys(getArcs(characterId)).length) return;
  const arcs = await chatJson<{
    year: string;
    season: string;
    month: string;
    week: string;
  }>(
    ARC_SYSTEM,
    arcPrompt(personBlock, kstDateString()),
    1000,
    config.modelDeep,
    { purpose: "arc", characterId },
  );
  saveArc(characterId, "year", arcs.year);
  saveArc(characterId, "season", arcs.season);
  saveArc(characterId, "month", arcs.month);
  saveArc(characterId, "week", arcs.week);
};

// 흐름 갱신: ensureArcs는 최초 1회 부트스트랩뿐이라 아크가 생성 시점에 영구 고정되던 것을,
// 달력 경계에서만 이어서 다시 쓴다 — 매주 월요일에 '이번 주', 매달 1일에 '이번 달'
// (분기 시작 달엔 계절, 1월 1일엔 올해까지). 기존 흐름과 최근 일기를 주고 단절 없이 진행시킨다.
const arcRefreshPrompt = (
  g: NightlyGathered,
  diaries: string,
): string => `오늘은 ${g.today}다. 아래 인물의 삶의 큰 흐름을 이어서 갱신해줘. 기존 흐름과 단절되지 않게 — 진행 중인 사건은 자연스럽게 진행시키고, 매듭지어질 때가 된 것은 마무리하고, 새 흐름이 필요하면 이 인물답게 잔잔하게 연다.

[인물]
${arcMaterialOf(g)}

[지금까지의 흐름]
${arcLinesOf(g) || "(없음)"}

[최근 일기 — 실제로 산 나날]
${diaries || "(없음)"}

{"year":"올해의 큰 진행 사건 1~2문장","season":"이 계절의 결 1~2문장","month":"이번 달의 상황 1~2문장","week":"이번 주의 특이사항 1문장 (없으면 '평범한 주')"}`;

const refreshArcs = async (g: NightlyGathered): Promise<void> => {
  const isFirst = g.today.endsWith("-01");
  const isMonday = new Date(`${g.today}T00:00:00Z`).getUTCDay() === 1;
  if (!isFirst && !isMonday) return;
  const diaries = getRecentDiaries(g.characterId, RECENT_DIARY_DAYS)
    .map((d) => {
      try {
        return `${d.date}: ${(JSON.parse(d.entry_json) as { diary?: string }).diary ?? ""}`;
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .join("\n");
  const arcs = await chatJson<{
    year: string;
    season: string;
    month: string;
    week: string;
  }>(ARC_SYSTEM, arcRefreshPrompt(g, diaries), 1000, config.modelDeep, {
    purpose: "arc",
    characterId: g.characterId,
    chatId: g.chatId,
  });
  if (isMonday && arcs.week) saveArc(g.characterId, "week", arcs.week);
  if (isFirst) {
    if (arcs.month) saveArc(g.characterId, "month", arcs.month);
    const m = Number(g.today.slice(5, 7));
    if ([3, 6, 9, 12].includes(m) && arcs.season)
      saveArc(g.characterId, "season", arcs.season);
    if (m === 1 && arcs.year) saveArc(g.characterId, "year", arcs.year);
  }
  console.log(
    `[nightly] 아크 갱신 (${isMonday ? "주" : ""}${isFirst ? " 월" : ""})`,
  );
};

export const runNightly = async (character: CharacterRow): Promise<string> => {
  const g = gatherNightlyInput(character);
  await ensureArcs(g.characterId, arcMaterialOf(g));
  // 이번 달(+월말이면 다음 달) 리듬을 확보한다. ensureTodayPlan이 오늘 시드를 읽어 각본에 잇는다
  await ensureRhythmRunway(g.characterId, g.today);
  // 달력 경계 아크 갱신 — 침묵 중엔 생략(볼 사람이 없고, 복귀 후 다음 경계에 이어 쓴다)
  if (g.silenceTier === "normal")
    await refreshArcs(g).catch((e) =>
      console.error(
        "[nightly] 아크 갱신 실패:",
        e instanceof Error ? e.message : String(e),
      ),
    );

  // 결번 백필: '어제'보다 오래된 미응고 날짜(대화는 있는데 일기가 없는 날)를 먼저 처리한다.
  // 새벽 정리가 며칠 안 돌았어도 중간 날짜의 기억·일정 정리가 영구히 빠지지 않게. 각본·선톡은
  // 오늘 것만 의미가 있으므로 백필에서는 만들지 않는다.
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
        1500,
        config.modelDeep,
        { purpose: "extract", characterId: bg.characterId, chatId: bg.chatId },
      );
      console.log(
        `[nightly] 백필 ${applyNightlyOutput(bg, { entry, extract })}`,
      );
    } catch (e) {
      // 백필 하루 실패가 오늘(어제 일기) 처리까지 막지 않게 — 다음 새벽에 같은 날짜를 재시도한다
      console.error(
        `[nightly] 백필 실패 (${d}):`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

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
      1500,
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
      send = await draftPrepared(g, "morning", entry.tomorrow ?? [], null);
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

  // 선톡 문안: 아침의 자기 삶 공유가 기본이고, 이틀째 답이 없으면 아침을 거르고 점심에 한 통만
  // 보낸다. 대화와 같은 3층 프롬프트를 쓰므로 어제에서 이어갈 것(entry.tomorrow — 아직 DB에
  // 없는 방금 쓴 일기의 것)만 상황 문단으로 넘긴다.
  if (plan.kind === "morning" || plan.kind === "lunch")
    send = await draftPrepared(g, plan.kind, entry.tomorrow ?? [], style);

  const result = applyNightlyOutput(g, { entry, extract, progress, send });
  return result;
};
