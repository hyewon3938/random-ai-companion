// 프롬프트 재료 읽기 — 조립에 필요한 것을 DB와 시계에서 한 번에 읽어 값 묶음으로 만든다.
//
// 조립(context/assemble.ts)은 여기서 만든 ContextInput만 보고 문자열을 만들며 DB를 부르지
// 않는다. 그래서 조립 쪽은 값을 지어 넣어 검사할 수 있고, 무엇을 읽는지는 이 파일 하나로 보인다.
// 이번 발화의 태그로 기억·옛 일기·지난 일정을 검색하는 것도 읽기라 여기서 하고, 무엇을 찾아
// 넣었는지(BuildTrace)도 여기서 적는다. 작품 사실 카드를 붙일지 정하려고 대화·검색 결과·각본에서
// 제목을 찾는 것도 같은 까닭으로 여기서 한다. [네 마음] 블록(context/mind.ts)에 싣는 오늘
// 기분(day_seeds)과 마음이 생긴 뒤 지난 시간을 재는 지금 시각도 여기서 읽는다(이슈 #473).

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
  getUpcomingWindow,
  getSchedulesByIds,
  type ScheduleRow,
  type ScheduleStateRow,
  lastMessageBefore,
  reopenedGap,
  getRecentMessages,
  type MessageRow,
  getDayActuals,
  getDaySeed,
  listMemoryItems,
  listWorkFactTitles,
  getWorkFactsByTitles,
  getTags,
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
  RECENT_TURN_COUNT,
  SEARCH_LIMIT,
  WORK_FACT_MAX_PER_REPLY,
  WORK_TITLE_SHORT_MAX,
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
  kstStamp,
  kstStampBefore,
  shiftDate,
  type ContactGap,
} from "../kst.js";
import { isHoldOutcome, WOKE_OUTCOME } from "../labels.js";
import { dayProgressOf, type DayProgress } from "./day-progress.js";
import {
  intentLineText,
  readRelationshipInput,
  type RelationshipInput,
} from "./relationship.js";
import type { DayMood } from "./mind.js";

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
  /**
   * 이번 호출이 읽은 [다가오는 일정] — 주인과 날짜, 내용.
   *
   * 이 절은 하루 한 번 굳는 덩이에 들어가서 답장 스레드에 붙는 마지막 덩이에는 없다. 그래서
   * 캐릭터가 앞일을 날짜까지 말해도 저장된 일정을 읽은 것인지 그 자리에서 지어낸 것인지
   * 트레이스만 보고는 갈리지 않았다 — 본문에 한 줄로 적어 가른다(이슈 #397).
   */
  upcoming: string[];
  /** 태그는 맞았지만 개수 상한에 걸려 빠진 후보 — 기억 키와 옛 일기 날짜. */
  dropped: string[];
  /** 실은 작품 사실 카드 — 제목(찾은 곳) 꼴(#458). */
  works?: string[];
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
  /** 지금 블록을 상대가 붙잡아 취소하거나 미룬 기록의 결과와 시각. 없으면 null. */
  held: { outcome: string; at: string } | null;
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
  /** 지금 관계 — 단계·며칠째·처음·오늘 쓴 플러팅·오늘의 의도(#353). */
  relationship: RelationshipInput;
  /** 이번 프롬프트에 싣는 작품 사실 카드(#287·#458). 찾는 곳에 제목이 나온 작품만 상한까지 싣는다. */
  workFacts: WorkFact[];
  /** 오늘 기분 — 월 리듬이 정해 둔 오늘(논리일)의 값. 시드가 없거나 기분이 비었으면 null(#473). */
  mood: DayMood | null;
  /** 지금 시각의 KST 타임스탬프 — 마음이 생긴 뒤 지난 시간을 재는 기준이다. */
  stamp: string;
}

/** 작품 카드를 붙인 제목을 어디서 찾았는지 — 트레이스에 제목과 함께 적는다. */
export type WorkSource =
  | "대화"
  | "기억"
  | "지난 일기"
  | "어제 일기"
  | "대화 계획"
  | "상황 문단"
  | "각본"
  | "진행 중인 일";

/**
 * 제목을 찾는 곳 하나. texts는 제목이 들어 있는지 보는 글이고, exact는 제목과 똑같은지만 보는
 * 값이다 — 각본의 작품 칸과 태그는 제목 하나가 통째로 들어가는 자리라 부분 일치를 보지 않는다.
 */
export interface WorkLookup {
  source: WorkSource;
  texts: string[];
  exact: string[];
}

// 제목은 띄어쓰기와 대소문자를 빼고 비교한다 — 대화에서는 제목을 붙여 쓰거나 띄어 쓰는 일이 흔하다.
const normTitle = (s: string): string => s.replace(/\s+/g, "").toLowerCase();

/**
 * 카드가 있는 제목 가운데 찾는 곳에 나온 것을, 앞에 둔 곳부터 상한까지 고른다(#458).
 *
 * 짧은 제목(WORK_TITLE_SHORT_MAX 글자 이하)은 글에서 찾지 않고 exact 값과 똑같을 때만 고른다.
 * 두 글자 제목은 평범한 낱말과 겹쳐서, 글에서 찾으면 그 작품 얘기가 아닌 말에도 카드가 붙는다.
 * 같은 제목이 여러 곳에 나오면 앞에 둔 곳 하나로 적는다.
 */
export const pickWorkTitles = (
  titles: string[],
  lookups: WorkLookup[],
  max: number,
): { title: string; source: WorkSource }[] => {
  const picked: { title: string; source: WorkSource }[] = [];
  for (const { source, texts, exact } of lookups) {
    const bodies = texts.map(normTitle);
    const values = exact.map(normTitle).filter(Boolean);
    // 같은 곳 안에서는 앞에 둔 글에 나온 제목부터 — 대화는 최신 말을 앞에 넘긴다.
    const hits = titles
      .filter((title) => !picked.some((p) => p.title === title))
      .map((title) => {
        const n = normTitle(title);
        const inText =
          n.length > WORK_TITLE_SHORT_MAX
            ? bodies.findIndex((b) => b.includes(n))
            : -1;
        const inExact = n ? values.indexOf(n) : -1;
        const rank =
          inText >= 0 ? inText : inExact >= 0 ? bodies.length + inExact : -1;
        return { title, rank };
      })
      .filter((h) => h.rank >= 0)
      .sort((a, b) => a.rank - b.rank);
    for (const { title } of hits) {
      if (picked.length >= max) return picked;
      picked.push({ title, source });
    }
  }
  return picked;
};

// 어제 일기의 내일 챙길 것 — 선톡이 어제에서 이어갈 거리로 쓰는 줄이다. 어제 일기가 없거나
// 깨졌으면 빈 목록이다. 더 앞 일기의 줄은 이미 지난 얘기라 보지 않는다.
const tomorrowOf = (diaries: DiaryLine[], date: string): string[] => {
  const d = diaries.find((x) => x.date === date);
  if (!d) return [];
  try {
    const t = (JSON.parse(d.entry_json) as { tomorrow?: unknown }).tomorrow;
    return Array.isArray(t)
      ? t.filter((s): s is string => typeof s === "string")
      : [];
  } catch {
    return [];
  }
};

/**
 * 이번 프롬프트에 실을 작품 카드 고르기(#287·#458).
 *
 * 카드가 있는 제목 목록을 먼저 읽고 그 제목이 찾는 곳에 나오는지 보는 식이라, 없는 작품을 글에서
 * 뽑아내려 하지 않는다. 찾는 곳은 이번 프롬프트에 실제로 들어가는 글이고 경로마다 다르다.
 *   답장   — 최근 대화 → 태그로 꺼낸 기억 → 태그로 꺼낸 지난 일기
 *   선톡   — 방금까지 오간 말 → 어제 일기의 내일 챙길 것 → 대화 계획의 내 얘기 줄 → 상황 문단
 * 두 경로 모두 그 뒤에 오늘 각본의 작품 칸과 캐릭터 쪽 진행 중인 일을 본다. 앞에 둔 곳이 지금
 * 오가는 얘기에 가까워서, 상한에 걸리면 뒤쪽 곳에서만 나온 작품이 빠진다. 정체성 절과 최근 일기
 * 본문은 늘 실리는 글이라 거기서 찾으면 본 작품 카드가 매번 붙어서 보지 않는다.
 */
const readWorkFacts = (
  characterId: number,
  chatId: string,
  opts: BuildOptions,
  ctx: {
    plan: DayPlan | null;
    items: MemoryRow[];
    memories: MemoryRow[];
    oldDiaries: DiaryHit[];
    diaries: DiaryLine[];
    recent: MessageRow[];
    relationship: RelationshipInput;
    logicalToday: string;
  },
): { facts: WorkFact[]; trace: string[] } => {
  const titles = listWorkFactTitles(characterId);
  if (!titles.length) return { facts: [], trace: [] };

  const memoryLookup = (source: WorkSource, rows: MemoryRow[]): WorkLookup => ({
    source,
    texts: rows.map((m) => `${m.subject} ${m.value}`),
    exact: rows.flatMap((m) => getTags("memory", m.id)),
  });
  // 답장 경로는 대화 기록을 turns로 따로 넘겨서 ctx.recent가 비어 있다 — 최근 행을 따로 읽는다.
  // 대화 기록은 턴으로 세서 이보다 길 수 있지만, 작품 얘기를 알아보는 데는 최근 행이면 충분하다.
  // 방금 온 유저 말은 답장을 만들기 전에 저장되므로 여기에 들어 있다.
  const talk: WorkLookup[] = opts.signals
    ? [
        {
          source: "대화",
          texts: getRecentMessages(chatId, characterId, RECENT_TURN_COUNT)
            .map((m) => m.text)
            .reverse(),
          exact: [],
        },
        memoryLookup("기억", ctx.memories),
        {
          source: "지난 일기",
          texts: ctx.oldDiaries.map((d) => d.entry_json),
          exact: ctx.oldDiaries.flatMap((d) => getTags("diary", d.id)),
        },
      ]
    : [
        {
          source: "대화",
          texts: ctx.recent.map((m) => m.text).reverse(),
          exact: [],
        },
        {
          source: "어제 일기",
          texts: tomorrowOf(ctx.diaries, shiftDate(ctx.logicalToday, -1)),
          exact: [],
        },
        {
          source: "대화 계획",
          texts: [intentLineText(ctx.relationship.intent, "share") ?? ""],
          exact: [],
        },
        // 새벽 정리의 아침 한 통은 방금 쓴 일기와 오늘 대화 계획이 아직 DB에 없어서 상황 문단으로
        // 넘긴다 — 위 두 곳이 비는 자리라 상황 문단도 함께 본다.
        { source: "상황 문단", texts: [opts.situation ?? ""], exact: [] },
      ];
  const lookups: WorkLookup[] = [
    ...talk,
    {
      source: "각본",
      texts: [],
      exact: (ctx.plan?.blocks ?? [])
        .map((b) => b.work)
        .filter((t): t is string => !!t),
    },
    memoryLookup(
      "진행 중인 일",
      ctx.items.filter((m) => m.item_type === "ongoing" && m.owner === "char"),
    ),
  ];

  const picked = pickWorkTitles(titles, lookups, WORK_FACT_MAX_PER_REPLY);
  // 조회는 제목순으로 돌아와서, 고른 순서(가까운 곳 먼저)로 다시 맞춘다.
  const byTitle = new Map(
    getWorkFactsByTitles(
      characterId,
      picked.map((p) => p.title),
    ).map((f) => [f.title, f]),
  );
  return {
    facts: picked
      .map((p) => byTitle.get(p.title))
      .filter((f): f is WorkFact => !!f),
    trace: picked.map((p) => `${p.title}(${p.source})`),
  };
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
  // 범위는 오늘부터 2주다(thresholds.UPCOMING_SCHEDULE_DAYS). 그 뒤의 일정은 주제로 걸릴 때만
  // 들어오고, 캐릭터가 먼저 아는 앞일은 이 창 안의 것뿐이다.
  const upcoming = getUpcomingWindow(characterId, today);
  const diaries = getRecentDiaries(characterId, RECENT_DIARY_DAYS);
  // 저장된 기억 전부를 한 번만 읽어 두 자리가 나눠 쓴다 — 첫 대화인지 보는 데도, 선톡이
  // 태그 없이 상대 쪽 기억을 고르는 데도 같은 목록이 필요하다.
  const memoryItems = listMemoryItems(characterId);
  const coldStart = !memoryItems.some((r) => r.owner === "user");

  const plan = readTodayPlan(characterId, logicalToday);
  const now = kstLogicalClock();
  const progress = plan
    ? dayProgressOf(plan.blocks, now)
    : { past: [], cur: null };
  // 지금 블록의 오늘 실제 기록 — 답장 텀 판정(reply-timing)과 답장의 stay 신호가 남긴 표시를
  // 같은 키(블록 시작·결과)로 읽는다. 잠 블록에 깸 행이 있으면 깨어 있는 것이고, 취소·미룸 행이
  // 있으면 상대가 붙잡아 그 일을 하지 않고 있는 것이다.
  const cur = progress.cur;
  const actuals = cur
    ? getDayActuals(characterId, logicalToday).filter(
        (a) => a.block_start === cur.start,
      )
    : [];
  const woke =
    cur && isSleeping(cur)
      ? actuals.find((a) => a.outcome === WOKE_OUTCOME)
      : undefined;
  const held = actuals.find((a) => isHoldOutcome(a.outcome));

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

  const recent = opts.recent
    ? getRecentMessages(chatId, characterId, opts.recent)
    : [];
  const relationship = readRelationshipInput(characterId, chatId, logicalToday);
  const works = readWorkFacts(characterId, chatId, opts, {
    plan,
    items: memoryItems,
    memories: found,
    oldDiaries,
    diaries,
    recent,
    relationship,
    logicalToday,
  });

  if (opts.trace) {
    opts.trace.tags = tags;
    opts.trace.tagPool = tagPool;
    opts.trace.tagBy = opts.pick?.by ?? "none";
    opts.trace.tagCallId = opts.pick?.callId ?? null;
    opts.trace.memories = found.map(memoryKeyOf);
    opts.trace.oldDiaries = oldDiaries.map((d) => d.date);
    opts.trace.schedules = foundSchedules.map((r) => `${r.date} ${r.content}`);
    // 프롬프트에 적히는 것과 같은 꼴로 적되 주인을 앞에 둔다 — 절에서는 '너의 예정'과
    // '상대의 예정'으로 갈려 있어서, 한 줄로 옮기면 주인이 사라진다.
    opts.trace.upcoming = upcoming.map(
      (r) =>
        `${r.owner === "user" ? "상대" : "너"} ${r.date}${
          r.time_hint ? ` ${r.time_hint}` : ""
        } ${r.content}`,
    );
    opts.trace.dropped = dropped;
    opts.trace.works = works.trace;
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
  // 오늘 기분 — 상대와 상관없이 정해진 값이라 [네 마음] 블록에 이야깃거리로만 싣는다.
  const seed = getDaySeed(characterId, logicalToday);

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
    held: held ? { outcome: held.outcome, at: held.recorded_at } : null,
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
    workFacts: works.facts,
    notes: todayNotes(characterId),
    lastTalk: prev ? lastTalkedLabel(prev.sent_at) : null,
    contactGap: gap ? contactGapOf(gap.lastChar, gap.firstUser) : null,
    recent,
    userMemories: opts.userMemories
      ? pickUserMemories(memoryItems, opts.userMemories)
      : [],
    relationship,
    mood: seed?.mood.trim() ? { mood: seed.mood, reason: seed.reason } : null,
    stamp: kstStamp(),
  };
};
