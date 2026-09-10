// 프롬프트 재료 읽기 — 조립에 필요한 것을 DB와 시계에서 한 번에 읽어 값 묶음으로 만든다.
//
// 조립(context/assemble.ts)은 여기서 만든 ContextInput만 보고 문자열을 만들며 DB를 부르지
// 않는다. 그래서 조립 쪽은 값을 지어 넣어 검사할 수 있고, 무엇을 읽는지는 이 파일 하나로 보인다.
// 이번 발화의 태그로 기억·옛 일기·지난 일정을 검색하는 것도 읽기라 여기서 하고, 무엇을 찾아
// 넣었는지(BuildTrace)도 여기서 적는다.

import type { DayPlan } from "../day-plan.js";
import { isSleeping } from "../day-plan.js";
import { renderUserBlock } from "../user-profile.js";
import { currentSpeechLevel, type SpeechLevelGuess } from "../speech-level.js";
import {
  getMetAt,
  getRelationship,
  getRecentDiaries,
  getDiariesByIds,
  getDayPlan,
  getUpcomingSchedules,
  getSchedulesByIds,
  type ScheduleRow,
  type ScheduleStateRow,
  lastMessageBefore,
  reopenedGap,
  getRecentMessages,
  type MessageRow,
  getDayActuals,
  listMemoryItems,
  listWorkFactTitles,
  getWorkFactsByTitles,
  type WorkFact,
  type MemoryRow,
  type RelationshipRow,
} from "../db.js";
import {
  alwaysIncluded,
  searchMemories,
  memoryKeyOf,
  searchTaggedRefs,
  todayNotes,
} from "../memory.js";
import { capHits, pickUserMemories } from "../recall.js";
import type { TagPick, TagPicker } from "../tag-pick.js";
import {
  CONTACT_GAP_HOLD_MS,
  RECENT_DIARY_DAYS,
  SEARCH_LIMIT,
} from "../thresholds.js";
import {
  kstDescription,
  kstDateString,
  kstVerbalTime,
  workdayContext,
  kstLogicalDate,
  kstLogicalClock,
  logicalDayStartTs,
  lastTalkedLabel,
  contactGapOf,
  kstStampBefore,
  type ContactGap,
} from "../kst.js";
import { WOKE_OUTCOME } from "../labels.js";
import { dayProgressOf, type DayProgress } from "./day-progress.js";
import { readRelationshipInput, type RelationshipInput } from "./relationship.js";

/** 이번 조립이 무엇을 찾아 넣었는지 — 답장 호출 기록에 붙여 "왜 저 기억을 꺼냈나"를 되짚는다. */
export interface BuildTrace {
  /** 유저 발화에서 고른 검색어. */
  tags: string[];
  /** 고를 수 있었던 태그 수 — 걸린 것이 없을 때 검색이 돌긴 했는지 가른다. */
  tagPool: number;
  /** 검색어를 무엇이 골랐는지와 그 모델 호출 번호. */
  tagBy?: TagPicker;
  tagCallId?: number | null;
  /** 꺼내 넣은 기억 — 항목·주인·키. */
  memories: string[];
  /** 함께 꺼낸 옛 일기 날짜. */
  oldDiaries: string[];
  /** 주제로 찾아 넣은 일정 — 날짜와 내용. */
  schedules: string[];
  /** 태그는 맞았지만 개수 상한에 걸려 빠진 후보 — 기억 키와 옛 일기 날짜. */
  dropped: string[];
}

export interface BuildOptions {
  /** 이번 발화로 고른 검색 태그 — 답장 경로가 pickTags로 먼저 고른 결과를 넘긴다. */
  pick?: TagPick;
  /** 상황 문단 — 선톡 문안, 불가 구간 끝 몰아 답장, 배웅 답이 쓴다. 프롬프트 맨 끝에 붙는다. */
  situation?: string;
  /**
   * 방금까지 오간 말을 이만큼 꼬리에 넣는다 — 선톡 문안 경로에서만 켠다.
   * 답장 경로는 대화 기록을 turns로 넘기므로 켜면 같은 말이 두 번 들어간다.
   */
  recent?: number;
  /**
   * 태그 없이 고른 상대 쪽 기억을 이만큼 꼬리에 넣는다 — 선톡 문안 경로에서만 켠다.
   * 답장 경로는 이번 발화의 태그로 검색하므로 켜면 같은 줄이 두 자리에 들어간다.
   */
  userMemories?: number;
  /** 넘겨 주면 검색 결과를 여기에 적어 돌려준다(호출 기록용). */
  trace?: BuildTrace;
  /**
   * 답장 객체(JSON) 형식 블록을 꼬리 맨 끝에 붙인다 — 답장 경로에서만 켠다.
   * 선톡 문안 여섯 곳은 같은 3층을 쓰되 자기 형식({send,text})으로 답하므로 켜지 않는다.
   */
  signals?: boolean;
}

export interface DiaryLine {
  date: string;
  entry_json: string;
}

export interface DiaryHit extends DiaryLine {
  id: number;
}

/** 조립이 받는 값 묶음. 전부 읽어 둔 값이라 조립은 DB를 부르지 않는다. */
export interface ContextInput {
  /** 정체성 기억 전부 — 줄 순서는 조립 쪽이 정한다. */
  identity: MemoryRow[];
  rel: RelationshipRow | undefined;
  /** 처음 연결된 시각. 없으면 각본 기준 오늘이다. */
  metAt: string;
  /** 유저 프로필 절 — user-profile.ts가 만든 문자열. */
  userBlock: string;
  /** 달력 오늘과 각본 기준 오늘(YYYY-MM-DD). */
  today: string;
  logicalToday: string;
  /** [오늘/내일] 문구. */
  workday: string;
  plan: DayPlan | null;
  /** 각본 표기의 지금 시각과 그 시각의 지나온·지금 블록. */
  now: string;
  progress: DayProgress;
  /** 잠 블록에서 상대 연락으로 깬 기록의 시각. 없으면 null. */
  wokeAt: string | null;
  /** 지금 시각의 숫자 표기와 말 표현. */
  nowDescription: string;
  nowVerbal: string;
  /** 최근 발화로 판정한 말투. 저장된 말투가 있으면 판정하지 않고 null이다. */
  judgedSpeech: SpeechLevelGuess;
  upcoming: ScheduleRow[];
  diaries: DiaryLine[];
  /** 유저 쪽 기억이 하나도 없는 첫 대화. */
  coldStart: boolean;
  /** 이번 발화의 태그로 찾은 것. */
  search: {
    memories: MemoryRow[];
    oldDiaries: DiaryHit[];
    schedules: ScheduleStateRow[];
  };
  notes: string[];
  /** 직전에 대화한 날의 표시. 오늘이 첫 대화면 null. */
  lastTalk: string | null;
  /** 연락 텀 — 문구와, 기다렸다는 말을 얹어도 되는 텀인지. 기준에 못 미치면 null. */
  contactGap: ContactGap | null;
  /** 방금까지 오간 말 — opts.recent를 켠 선톡 문안 경로에서만 채운다. */
  recent: MessageRow[];
  /** 태그 없이 고른 상대 쪽 기억 — opts.userMemories를 켠 선톡 문안 경로에서만 채운다. */
  userMemories: MemoryRow[];
  /** 지금 관계 — 단계·며칠째·처음·오늘 쓴 수·오늘의 의도(#353). */
  relationship: RelationshipInput;
  /** 오늘 다루는 작품의 사실 카드(#287). 오늘 각본·진행 중인 일에 없는 작품은 안 싣는다. */
  workFacts: WorkFact[];
}

/**
 * 오늘 프롬프트에 실을 작품 카드 고르기(#287). 두 자리에서 제목을 모은다 — 오늘 각본 블록의
 * work 값과, 진행 중인 일 줄에 제목이 그대로 들어 있는 작품. 뒤쪽은 카드가 있는 제목 목록을
 * 먼저 읽고 그 제목이 줄에 있는지 보는 식이라, 없는 작품을 텍스트에서 뽑아내려 하지 않는다.
 * 카드가 아직 없는 제목은 조회에서 저절로 빠진다.
 */
const readWorkFacts = (
  characterId: number,
  plan: DayPlan | null,
  items: MemoryRow[],
): WorkFact[] => {
  const fromPlan = (plan?.blocks ?? [])
    .map((b) => b.work)
    .filter((t): t is string => !!t);
  const ongoing = items
    .filter((m) => m.item_type === "ongoing" && m.owner === "char")
    .map((m) => `${m.subject} ${m.value}`)
    .join("\n");
  const fromOngoing = ongoing
    ? listWorkFactTitles(characterId).filter((t) => ongoing.includes(t))
    : [];
  const titles = [...new Set([...fromPlan, ...fromOngoing])];
  return getWorkFactsByTitles(characterId, titles);
};

/**
 * 오늘 각본. 각본의 하루는 새벽 5시에 갈린다 — 자정~04:59에는 어제 각본을 계속 읽고, 지금
 * 시각도 그 각본의 표기(24:30 같은 24시 이후 표기)로 맞춰 비교한다. 없거나 깨졌으면 null.
 */
export const readTodayPlan = (
  characterId: number,
  logicalToday: string = kstLogicalDate(),
): DayPlan | null => {
  const raw = getDayPlan(characterId, logicalToday);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DayPlan;
  } catch {
    return null;
  }
};

export const readContextInput = (
  characterId: number,
  chatId: string,
  opts: BuildOptions = {},
): ContextInput => {
  const identity = alwaysIncluded(characterId);
  const rel = getRelationship(characterId);
  const logicalToday = kstLogicalDate();
  const metAt = getMetAt(characterId) ?? logicalToday;

  // 오늘 날짜는 한 번만 읽어 두 자리가 같은 값을 쓴다 — [다가오는 일정]이 싣는 경계와 아래
  // 검색 결과에 '지난 일'을 붙이는 경계가 어긋나면 같은 일정이 두 자리에서 다르게 읽힌다.
  const today = kstDateString();
  const upcoming = getUpcomingSchedules(characterId, today);
  const diaries = getRecentDiaries(characterId, RECENT_DIARY_DAYS);
  // 저장된 기억 전부를 한 번만 읽어 두 자리가 나눠 쓴다 — 첫 대화인지 보는 데도, 선톡이
  // 태그 없이 상대 쪽 기억을 고르는 데도 같은 목록이 필요하다.
  const memoryItems = listMemoryItems(characterId);
  const coldStart = !memoryItems.some((r) => r.owner === "user");

  const plan = readTodayPlan(characterId, logicalToday);
  const now = kstLogicalClock();
  const progress = plan ? dayProgressOf(plan.blocks, now) : { past: [], cur: null };
  // 잠 블록인데 오늘 실제 기록에 깸 행이 있으면 깨어 있는 것이다 — 답장 텀 판정(reply-timing)이
  // 남긴 표시를 같은 키(블록 시작·결과)로 읽는다.
  const cur = progress.cur;
  const woke =
    cur && isSleeping(cur)
      ? getDayActuals(characterId, logicalToday).find(
          (a) => a.block_start === cur.start && a.outcome === WOKE_OUTCOME,
        )
      : undefined;

  // 이번 발화의 태그로 검색한 기억·옛 일기·지난 일정.
  const { tags, pool: tagPool } = opts.pick ?? { tags: [], pool: 0 };
  // 상한에 걸려 빠진 후보도 받아 둔다 — 넣은 것만 봐서는 왜 그 기억이 안 들어갔는지 알 수 없다.
  const dropped: string[] = [];
  const found = tags.length
    ? searchMemories(characterId, tags, { dropped })
    : [];

  const recentDates = new Set(diaries.map((d) => d.date));
  const diaryIds = tags.length
    ? searchTaggedRefs(characterId, "diary", tags)
    : [];
  const byId = new Map(getDiariesByIds(diaryIds).map((d) => [d.id, d]));
  const diaryHits = diaryIds
    .map((id) => byId.get(id))
    .filter((d): d is NonNullable<typeof d> => !!d && !recentDates.has(d.date));
  const oldDiaries = capHits(
    diaryHits,
    SEARCH_LIMIT.diary,
    (d) => `일기 ${d.date}`,
    dropped,
  );

  // 주제로 찾은 일정. 일기와 같은 모양이되 빼는 기준이 날짜가 아니라 행 번호다 — 날짜로 자르면
  // 오래전 일정이 통째로 안 걸리는데, 이 경로가 꺼내려는 것이 바로 그 지난 일정이다.
  // 대신 하루 동안 같은 데이터층의 [다가오는 일정]에 이미 실린 행을 뺀다.
  const upcomingIds = new Set(upcoming.map((r) => r.id));
  const schedIds = tags.length
    ? searchTaggedRefs(characterId, "schedule", tags)
    : [];
  const schedById = new Map(
    getSchedulesByIds(characterId, schedIds).map((r) => [r.id, r]),
  );
  const schedHits = schedIds
    .map((id) => schedById.get(id))
    .filter((r): r is NonNullable<typeof r> => !!r && !upcomingIds.has(r.id));
  const foundSchedules = capHits(
    schedHits,
    SEARCH_LIMIT.schedule,
    (r) => `일정 ${r.date} ${r.content}`,
    dropped,
  );

  if (opts.trace) {
    opts.trace.tags = tags;
    opts.trace.tagPool = tagPool;
    opts.trace.tagBy = opts.pick?.by ?? "none";
    opts.trace.tagCallId = opts.pick?.callId ?? null;
    opts.trace.memories = found.map(memoryKeyOf);
    opts.trace.oldDiaries = oldDiaries.map((d) => d.date);
    opts.trace.schedules = foundSchedules.map((r) => `${r.date} ${r.content}`);
    opts.trace.dropped = dropped;
  }

  // 직전에 대화한 날 — 오늘 기록만 보면 모델이 공백 자체를 인지하지 못한다.
  const prev = lastMessageBefore(chatId, characterId, logicalDayStartTs());
  // 몇 시간 만에 온 연락인지 — 기록의 시간 표시만으로는 모델이 그 텀을 화제로 삼지 않는다.
  // 텀이 기준에 못 미치면 null이다(이슈 #284). 재개 지점을 30분 동안 붙들어 두므로, 유저가
  // 다시 말을 건 뒤 몇 마디가 오가는 동안에도 절이 남는다(이슈 #316).
  const gap = reopenedGap(
    chatId,
    characterId,
    kstStampBefore(CONTACT_GAP_HOLD_MS),
  );

  return {
    identity,
    rel,
    metAt,
    userBlock: renderUserBlock(chatId),
    today,
    logicalToday,
    workday: workdayContext(),
    plan,
    now,
    progress,
    wokeAt: woke?.recorded_at ?? null,
    nowDescription: kstDescription(),
    nowVerbal: kstVerbalTime(),
    // 저장된 말투가 반말·존댓말이면 판정하지 않는다 — 판정만으로 정하면 존댓말로 되돌아간다.
    judgedSpeech:
      rel?.speech_level === "casual" || rel?.speech_level === "polite"
        ? null
        : currentSpeechLevel(chatId, characterId),
    upcoming,
    diaries,
    coldStart,
    search: { memories: found, oldDiaries, schedules: foundSchedules },
    workFacts: readWorkFacts(characterId, plan, memoryItems),
    notes: todayNotes(characterId),
    lastTalk: prev ? lastTalkedLabel(prev.sent_at) : null,
    contactGap: gap ? contactGapOf(gap.lastChar, gap.firstUser) : null,
    recent: opts.recent ? getRecentMessages(chatId, characterId, opts.recent) : [],
    userMemories: opts.userMemories
      ? pickUserMemories(memoryItems, opts.userMemories)
      : [],
    relationship: readRelationshipInput(characterId, chatId, logicalToday),
  };
};
