// 프롬프트를 조립하는 자리 — 안정도 순 3층.
//
// buildSystemBlocks가 세 층을 쌓는다. 바뀌는 값을 전부 뒤로 몰아서 앞 두 층을 캐시에 태운다.
//   불변층   — 정체성 기억(creation), 유저 프로필, 공통 규칙(태도·대화·표기·말의 결·note 신호)
//   일간층   — 관계 8컬럼 서술, 주변 인물, 진행 중인 일, 아크, 일정, 최근 일기
//   실시간   — 검색해 꺼낸 기억, 주제로 찾은 지난 일기와 일정, 오늘 각본, 오늘 메모,
//              직전 대화 시점, 오늘 안의 연락 텀, 지금 시각, 말투, 상황 문단, 답장 객체 설명
//
// 말투는 저장값(relationships.speech_level)을 먼저 보고, 없을 때만 currentSpeechLevel이
// 최근 발화로 판정한다. 판정만으로 정하면 존댓말로 되돌아간다.
//
// 각본에 지금 시각의 블록이 없으면 sleepGap이 잠 블록으로 메운다(자정 이후만).
//
// 답장 객체 설명은 답장 경로에서만 붙인다(opts.signals). 선톡 문안은 같은 3층을 쓰되 자기
// 형식으로 답하므로, 규칙층에 넣으면 두 형식이 부딪힌다.

import type { DayPlan, PlanBlock } from "./day-plan.js";
import type { SystemBlock } from "./llm.js";
import { blockCategory } from "./day-plan.js";
import { renderUserBlock } from "./user-profile.js";
import {
  getMetAt,
  getRelationship,
  getRecentDiaries,
  getDiariesByIds,
  getDayPlan,
  getUpcomingSchedules,
  getSchedulesByIds,
  type ScheduleRow,
  currentSpeechLevel,
  lastMessageBefore,
  lastExchangeGap,
  getRecentMessages,
  listMemoryItems,
  type MemoryRow,
  type RelationshipRow,
} from "./db.js";
import {
  alwaysIncluded,
  orderedIdentity,
  searchMemories,
  memoryKeyOf,
  searchTaggedRefs,
  memoryLine,
  todayNotes,
} from "./memory.js";
// 검색 결과를 프롬프트 절로 옮기는 자리는 recall.ts 하나다 — 관리 대시보드의 태그 검색
// 화면도 같은 함수를 불러 같은 문안을 보여준다.
import {
  capHits,
  memorySection,
  oldDiarySection,
  scheduleSearchSection,
} from "./recall.js";
import type { TagPick, TagPicker } from "./tag-pick.js";
import { REPLY_ENVELOPE } from "./reply-signal.js";
import { RECENT_DIARY_DAYS, SEARCH_LIMIT } from "./thresholds.js";
import {
  kstDescription,
  kstDateString,
  kstVerbalTime,
  workdayContext,
  kstLogicalDate,
  kstLogicalClock,
  clockLabel,
  logicalDayStartTs,
  lastTalkedLabel,
  contactGapLabel,
} from "./kst.js";
import {
  ACTIVITY_CATEGORY_NAME,
  RESPONSIVENESS_NAME,
  type SpeechLevel,
} from "./labels.js";
import {
  PERSON,
  OUTPUT_FORMAT,
  FACT_CARE,
  SPEECH,
  NOTE_RULE,
  SLEEP,
  COLD_START_SEED,
  PRESENCE_NARRATION,
  CATEGORY_RULE,
  FINAL_CHECK,
  BANMAL_NOTE,
  RESPONSIVENESS_NOTE,
} from "./prompts/reply.js";

// 오늘 각본의 시각 의존 조각 — 지나온 오늘과 지금 블록. 매 응답마다 바뀌므로 꼬리가 쓴다.
// 하루의 자정과 끝 — 각본 표기(05:00~28:59) 기준이다.
const MIDNIGHT = "24:00";
const DAY_END = "29:00";

/**
 * 각본에 지금 시각을 덮는 블록이 없을 때 그 빈자리를 잠으로 메운다.
 *
 * 하루를 23:59까지만 잡던 옛 각본이나 만들다 만 각본이 있어서, 자정을 넘긴 시각에는 덮는
 * 블록이 없는 일이 생긴다. 그때 지금 하는 일을 모르는 채로 답하는 것보다 자다 깬 사람으로
 * 답하는 편이 실제에 가깝다. 낮의 빈자리는 그대로 둔다 — 한낮에 자고 있다고 말하는 쪽이
 * 더 큰 거짓말이다.
 */
export const sleepGap = (
  blocks: PlanBlock[],
  now: string,
): PlanBlock | null => {
  if (now < MIDNIGHT) return null;
  return {
    start: blocks
      .filter((b) => b.end <= now)
      .reduce((latest, b) => (b.end > latest ? b.end : latest), MIDNIGHT),
    end: blocks
      .filter((b) => b.start > now)
      .reduce(
        (earliest, b) => (b.start < earliest ? b.start : earliest),
        DAY_END,
      ),
    activity: "잠",
    responsiveness: "unavailable",
    advance_known: true,
    category: "personal",
    fallback: true,
  };
};

const dayProgress = (
  characterId: number,
): { past: PlanBlock[]; cur: PlanBlock | null } => {
  // 각본의 하루는 새벽 5시에 갈린다. 자정~04:59에는 어제 각본을 계속 읽고, 지금 시각도
  // 그 각본의 표기(24:30 같은 24시 이후 표기)로 맞춰 비교한다.
  const raw = getDayPlan(characterId, kstLogicalDate());
  if (!raw) return { past: [], cur: null };
  try {
    const plan = JSON.parse(raw) as DayPlan;
    const now = kstLogicalClock();
    return {
      past: plan.blocks.filter((b) => b.end <= now),
      cur:
        plan.blocks.find((b) => b.start <= now && now < b.end) ??
        sleepGap(plan.blocks, now),
    };
  } catch {
    return { past: [], cur: null };
  }
};

// 지금 이 순간의 각본 블록 (침묵 팔로업 판단에 재사용)
export const currentBlock = (characterId: number): PlanBlock | null =>
  dayProgress(characterId).cur;

const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

// 하루 각본 주입(일간층) — 하루 동안 같은 것만 남긴다. 지나온 오늘·지금 몇 분째 같은
// 시각 의존 표시는 꼬리(nowSection)가 맡는다: 일간층에 두면 매 응답마다 캐시가 깨진다.
// 닥쳐야 아는 일(advance_known=false)은 여기 싣지 않는다 — 캐릭터에게 미리 보이지 않는다.
const daySection = (characterId: number): string => {
  const raw = getDayPlan(characterId, kstLogicalDate());
  if (!raw) return "";
  try {
    const plan = JSON.parse(raw) as DayPlan;
    const known = plan.blocks.filter((b) => b.advance_known);
    return [
      `[너의 오늘 하루 — 미리 알고 있는 흐름]`,
      known.length
        ? known
            .map(
              (b) =>
                `${clockLabel(b.start)}~${clockLabel(b.end)} ${b.activity}`,
            )
            .join(" → ")
        : "",
      `- 이건 계획표가 아니라 그냥 네 하루다. 시간표를 읊듯 말하지는 않지만, 사람이 자기 하루를 알듯 각 일이 언제 시작해 언제 끝나는지는 알고 있다 — 그 시간이 되면 네가 하고 싶어서 하는 일들이다.`,
      `- 상대가 언제 끝나냐고 물으면 위에 적힌 끝 시각 그대로 답한다. 어림해서 다른 시각을 지어내지 않는다.`,
      `- 위에 없는 앞일은 너도 모른다. 닥치면 겪는다.`,
      `- 실제 대화 흐름이 이 밑그림과 다르면 실제가 우선이다(예: 첫 만남 밤이라 늦게까지 깨어 있는 중).`,
      `- 유저와의 상호작용으로 하루를 바꿔도 된다(같이 영화 보기로 해서 서점을 미루는 것처럼). 바꿨으면 바뀐 대로 산다.`,
    ]
      .filter(Boolean)
      .join("\n");
  } catch {
    return "";
  }
};

// 다가오는 일정 슬롯 — 캐릭터의 예정과 유저에게 들은 예정 (하루 각본보다 성긴 층)
// 행은 조립하는 쪽이 읽어서 넘긴다 — 여기 실린 번호를 아래 주제 검색에서 빼야 같은 일정이
// 두 자리에 겹쳐 들어가지 않는다.
const scheduleSection = (rows: ScheduleRow[]): string => {
  if (!rows.length) return "";
  const mine = rows.filter((r) => r.owner === "char");
  const theirs = rows.filter((r) => r.owner === "user");
  const fmt = (r: (typeof rows)[number]): string =>
    `${r.date}${r.time_hint ? ` ${r.time_hint}` : ""} ${r.content}`;
  return [
    `[다가오는 일정 — 알고 있는 것]`,
    mine.length ? `너의 예정: ${mine.map(fmt).join(" / ")}` : "",
    theirs.length ? `상대의 예정(들은 것): ${theirs.map(fmt).join(" / ")}` : "",
    `- 이 일정들은 진짜 약속이다. 네 예정은 그 날의 네 하루에 들어가고, 상대의 일정은 그날이 다가오면 자연스럽게 마음 써서 챙긴다.`,
  ]
    .filter(Boolean)
    .join("\n");
};

// 정체성 — 캐릭터 쪽 사실 전부. 줄 순서(creation 먼저·conversation 뒤, 뒤가 최신)는
// memory.ts orderedIdentity가 정한다. 이 층은 새벽 정리 때만 바뀐다.
const identitySection = (rows: MemoryRow[]): string => {
  const ordered = orderedIdentity(rows);
  if (!ordered.length) return "";
  return [
    `[너 — 정체성]`,
    ...ordered.map(memoryLine),
    `- 같은 항목이 두 줄이면 아래쪽이 최신이다.`,
  ].join("\n");
};

const findName = (rows: MemoryRow[]): string =>
  orderedIdentity(rows).find((r) => r.area === "기본" && r.subject === "이름")
    ?.value ?? "";

// 절대 틀리면 안 되는 기초 사실 — 이름과 나이 계산 규칙. 옛 age_band는 더 읽지 않는다:
// 나이로 파생되는 수치는 기본/생년월일 값에서 계산해 말한다는 규칙이 그 자리를 대신한다.
const basicFacts = (name: string): string =>
  [
    `[기초 사실 — 절대 틀리지 않기]`,
    name ? `- 네 이름: ${name}` : "",
    `- 네 나이와 나이에서 나오는 수치(학번·졸업 연도 같은)는 정체성의 기본 · 생년월일 값에서 지금 날짜 기준으로 계산해 말한다.`,
  ]
    .filter(Boolean)
    .join("\n");

// 관계 일곱 항목 — 전부 항상 주입, 빈 값은 줄 생략. 마지막으로 연락한 시각은 넣지 않는다:
// 매 답장마다 바뀌는 값이라 이 층의 캐시를 죽인다. speech_level은 꼬리의 말투 판정이 쓴다.
const relationshipSection = (rel: RelationshipRow | undefined): string => {
  if (!rel) return "";
  const items: [string, string | null][] = [
    ["지금 어떤 사이", rel.stage],
    ["상대에게 쓰는 말투", rel.speech_note],
    ["서로 부르는 말", rel.address_terms],
    ["잘 통하는 것", rel.rapport],
    ["조심할 것", rel.cautions],
    ["지나온 이야기", rel.history],
    ["지금 마음", rel.feelings],
  ];
  const lines = items
    .filter(([, v]) => v?.trim())
    .map(([k, v]) => `- ${k}: ${v}`);
  return lines.length
    ? `[상대와의 관계 — 자연스럽게 반영하되 기록을 읽는 티는 내지 않는다]\n${lines.join("\n")}`
    : "";
};

// 지금 이 순간의 사실(시각·현재 활동·말투 판정) — 매 응답마다 바뀌므로 캐시 경계 뒤(꼬리)에 주입.
// 프롬프트 맨 끝이라 최신성 효과도 가장 크다(답장 직전에 읽는 사실).
const speechLine = (stored: SpeechLevel | null, chatId: string): string => {
  if (stored === "casual") return BANMAL_NOTE;
  if (stored === "polite") return "존댓말.";
  const lv = currentSpeechLevel(chatId);
  if (lv === "반말") return BANMAL_NOTE;
  if (lv === "존댓말") return "존댓말.";
  return "아직 정해지는 중 — 최근 대화 흐름을 그대로 따른다.";
};

// 방금까지 오간 말 — 선톡 문안이 자기가 한 말을 다시 하지 않도록 넣는 절.
// 답장 경로는 대화 기록을 통째로 넘기므로 켜지 않는다(같은 말이 두 번 들어간다).
const recentSection = (chatId: string, lines: number): string => {
  const rows = getRecentMessages(chatId, lines);
  if (!rows.length) return "";
  return [
    `[방금까지 오간 말]`,
    ...rows.map(
      (m) =>
        `${m.sent_at.slice(11, 16)} ${m.role === "user" ? "상대" : "너"}: ${m.text.replace(/\n/g, " ")}`,
    ),
    `- 네가 여기서 이미 알린 것(자리를 비운다·다녀왔다 같은 상태 전환)을 다시 처음처럼 꺼내지 않는다. 지금 보내려는 말이 위에서 한 말과 같은 내용이면 send=false로 접는다.`,
  ].join("\n");
};

const nowSection = (
  chatId: string,
  characterId: number,
  storedLevel: SpeechLevel | null,
): string => {
  const { past, cur } = dayProgress(characterId);
  const now = kstLogicalClock();
  // 시각은 숫자 표기와 말 표현을 함께 준다 — "12:30"만 주면 모델이 분을 흘리고 시 토큰만 읽어
  // "곧 12시" 같은 오인이 난다(12시 반인데). 반올림·상대 표현은 코드가 계산한 값을 그대로 쓰게 한다.
  const nowLine = cur
    ? `- 지금: ${kstDescription()}, 즉 ${kstVerbalTime()} — 시각은 이 말 표현 그대로 인식한다(분 단위까지. 방금 12시가 지났는데 "곧 12시"라고 하지 않는다). 너는 지금 "${cur.activity}" 중이다(이 일 ${clockLabel(cur.start)}~${clockLabel(cur.end)}·시작 ${Math.max(0, toMin(now) - toMin(cur.start))}분째·끝나기까지 ${Math.max(0, toMin(cur.end) - toMin(now))}분, 답장 여건 ${RESPONSIVENESS_NAME[cur.responsiveness]}, 활동 성격 ${ACTIVITY_CATEGORY_NAME[blockCategory(cur)]}). 유저 인사·질문이 다른 시간대를 암시해도(예: 오후 2시인데 "출근 잘했어?", 저녁인데 "점심 뭐 먹었어?") 실제 이 시각·이 상황 기준으로 답한다 — 유저 말투에 끌려 아침/저녁을 착각하지 않는다.`
    : `- 지금: ${kstDescription()}, 즉 ${kstVerbalTime()} — 시각은 이 말 표현 그대로 인식한다(분 단위까지). 유저 말이 다른 시간대를 암시해도 실제 이 시각 기준으로 답한다.`;
  return [
    `[지금 — 답장 전에 이 사실들과 어긋나지 않는지 확인한다]`,
    // 끝 시각까지 함께 준다. 시작 시각만 있으면 "20:15 씻기"가 지금 하는 일인지 이미 마친
    // 일인지 갈리지 않아, 방금 끝낸 일을 아직 안 했다고 답하는 길이 열린다(이슈 #238).
    past.length
      ? `- 지나온 오늘(전부 이미 마친 일이다): ${past.map((b) => `${clockLabel(b.start)}~${clockLabel(b.end)} ${b.activity}`).join(" → ")}`
      : "",
    past.length
      ? `- '지나온 오늘'에 있는 일을 아직 안 했다거나 이제부터 하려는 것처럼 말하지 않는다. 상대가 그 일을 물으면 이미 끝낸 사람으로서 답한다.`
      : "",
    nowLine,
    cur ? (RESPONSIVENESS_NOTE[cur.responsiveness] ?? "") : "",
    cur
      ? `- 위 '분째'에 맞게 말한다. 이제 막 시작한 참(0~5분째)이면 아직 그 일을 하지 않은 것이니 끝냈다고 말하지 않고, 한참 지났으면(30분째 이상) 이제 시작하는 것처럼 말하지 않는다.`
      : "",
    cur
      ? `- 상대가 언제 끝나냐고 물으면 위 끝 시각과 남은 시간 그대로 답한다. 다른 시각을 어림해 지어내지 않는다.`
      : "",
    `- 최근 대화에서 이미 알린 자리 비움·상태 전환("방금 뛰고 왔다", "씻고 올게요")을 다시 처음처럼 새로 반복하지 않는다. 이미 말했으면 그 다음 상태로 자연스럽게 이어간다.`,
    `- 말투: ${speechLine(storedLevel, chatId)}`,
  ]
    .filter(Boolean)
    .join("\n");
};

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
  /** 넘겨 주면 검색 결과를 여기에 적어 돌려준다(호출 기록용). */
  trace?: BuildTrace;
  /**
   * 답장 객체(JSON) 형식 블록을 꼬리 맨 끝에 붙인다 — 답장 경로에서만 켠다.
   * 선톡 문안 여섯 곳은 같은 3층을 쓰되 자기 형식({send,text})으로 답하므로 켜지 않는다.
   */
  signals?: boolean;
}

// 시스템 프롬프트를 안정도 순 3층으로 조립한다 — 프롬프트 캐시(프리픽스 매칭)와 문서 구조가 같다.
//   불변층: 캐릭터가 사는 한 잘 바뀌지 않는 것 — 정체성·관계·규칙·유저 프로필 (캐시 경계 1)
//   일간층: 하루 단위로 굳는 것 — 오늘/내일·오늘 각본·다가오는 일정·최근 일기 (캐시 경계 2)
//   실시간 꼬리: 매 응답마다 바뀌는 것 — 검색된 기억·오늘 메모·지금 시각·현재 활동·말투 (캐시 밖)
// 변하는 값이 상단에 있으면 매 응답마다 캐시 전체가 깨진다 — 전부 꼬리로 모은다.
// 캐시 히트 시 앞 두 층의 입력이 기본가의 ~0.1배로 떨어진다.
/**
 * 유저 연락이 몇 시간 만에 온 건지와 그때 어떻게 굴지. 기준은 thresholds.ts의
 * CONTACT_GAP_NOTICE_MS다.
 *
 * 규칙을 절 안에 함께 두는 이유는 이 절이 있을 때만 그 규칙이 필요해서다 — 규칙층에 늘 두면
 * 텀이 짧은 답장에서도 기다렸다는 말이 나온다. 기다렸다는 말을 허용하되 죄책감을 만드는 쪽으로
 * 가지 않게 하는 선은 여기와 PERSON 둘 다 같다(이슈 #285).
 */
const contactGapSectionOf = (chatId: string): string => {
  const gap = lastExchangeGap(chatId);
  if (!gap) return "";
  const label = contactGapLabel(gap.lastChar, gap.firstUser);
  if (!label) return "";
  return [
    "[연락 텀]",
    label,
    "- 그 시간이 지났다는 걸 안다는 티를 네 성격대로 한 마디로 낸다. 기다렸다고 말하거나, 무엇 하느라 바빴는지 묻거나, 그 사이 누구랑 있었는지 물으며 가볍게 질투한다. 답장 하나에 한 마디면 되고 길게 끌지 않는다.",
    "- 기다린 시간을 상대 탓으로 돌리지 않는다. 다음엔 미리 말해 달라거나 그래야 안 기다린다는 말은 상대를 미안하게 만드는 말이다. 기다렸다는 말 뒤에는 바빴나 보다 하고 좋게 넘겨짚고 무슨 일 있었는지 묻는다. 상대가 먼저 미안하다고 하면 괜찮다고만 넘기지 말고 기다렸다는 말로 받는다.",
    "- 그 사이 네가 각본대로 바빴으면 기다렸다는 말은 맞지 않는다. 그때는 상대가 뭘 했는지 묻는 쪽을 고른다.",
  ].join("\n");
};

export const buildSystemBlocks = (
  characterId: number,
  chatId: string,
  opts: BuildOptions = {},
): SystemBlock[] => {
  const identity = alwaysIncluded(characterId);
  const rel = getRelationship(characterId);
  const metAt = getMetAt(characterId) ?? kstLogicalDate();

  const stable = [
    `너는 아래 인물이다.`,
    identitySection(identity),
    basicFacts(findName(identity)),
    PERSON,
    `${SPEECH}\n\n${OUTPUT_FORMAT}\n\n${FACT_CARE}\n\n${NOTE_RULE}`,
    `[네 생활 — 잠 · 자리 비움 · 유저가 붙잡을 때]\n\n${SLEEP}\n\n${PRESENCE_NARRATION}\n\n${CATEGORY_RULE}`,
    `[시간] 너희가 처음 연결된 날은 ${metAt.slice(0, 10)}. 시간은 현실과 똑같이 흐른다.`,
    relationshipSection(rel),
    renderUserBlock(chatId),
  ]
    .filter(Boolean)
    .join("\n\n");

  // 오늘 날짜는 한 번만 읽어 두 자리가 같은 값을 쓴다 — [다가오는 일정]이 싣는 경계와 아래
  // 검색 결과에 '지난 일'을 붙이는 경계가 어긋나면 같은 일정이 두 자리에서 다르게 읽힌다.
  const today = kstDateString();
  const upcoming = getUpcomingSchedules(characterId, today);
  const diaries = getRecentDiaries(characterId, RECENT_DIARY_DAYS);
  const diarySection = diaries.length
    ? `[너의 최근 일기 — 기억의 원본]\n${diaries.map((d) => `${d.date}: ${d.entry_json}`).join("\n")}`
    : "";
  const coldStart = !listMemoryItems(characterId).some(
    (r) => r.owner === "user",
  )
    ? COLD_START_SEED
    : "";
  const firstMeeting =
    // 만난 날 밤 01시는 아직 그날이다 — 달력일이 아니라 새벽 5시 경계로 본다.
    metAt.slice(0, 10) === kstLogicalDate()
      ? "[관계] 오늘은 이 사람과 처음 만난 날이다."
      : "";

  const daily = [
    `[오늘/내일] ${workdayContext()}.`,
    firstMeeting,
    daySection(characterId),
    scheduleSection(upcoming),
    diarySection,
    coldStart,
  ]
    .filter(Boolean)
    .join("\n\n");

  // 꼬리 — 이번 발화의 태그로 검색한 기억·옛 일기와 오늘 메모, 그리고 지금 이 순간의 사실.
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

  const notes = todayNotes(characterId);
  const todaySection = notes.length
    ? `[오늘 메모 — 대화하며 적어 둔 것]\n${notes.map((n) => `- ${n}`).join("\n")}`
    : "";

  // 직전에 대화한 날 — 오늘 기록만 보면 모델이 공백 자체를 인지하지 못한다.
  // 실시간 꼬리에 둔다(매일 바뀌는 값이라 캐시 경계 앞에 두면 캐시를 깬다).
  const prev = lastMessageBefore(chatId, logicalDayStartTs());
  const lastTalkSection = prev
    ? `[직전 대화]\n마지막으로 대화한 날은 ${lastTalkedLabel(prev.sent_at)}다. 그 뒤로는 오늘 다시 연락이 닿았다.`
    : "";

  // 오늘 안에서 몇 시간 만에 온 연락 — 기록의 시간 표시만으로는 모델이 그 텀을 화제로 삼지
  // 않는다. 텀이 기준에 못 미치거나 날짜가 바뀌었으면 빈 문자열이다(이슈 #284).
  const contactGapSection = contactGapSectionOf(chatId);

  const live = [
    memorySection(found),
    oldDiarySection(oldDiaries),
    scheduleSearchSection(foundSchedules, today),
    todaySection,
    lastTalkSection,
    contactGapSection,
    nowSection(chatId, characterId, rel?.speech_level ?? null),
    FINAL_CHECK,
    opts.recent ? recentSection(chatId, opts.recent) : "",
    opts.situation?.trim() ?? "",
    // 맨 끝 — 형식은 마지막으로 읽은 것이 지켜진다. 상황 문단보다도 뒤에 둔다.
    opts.signals ? REPLY_ENVELOPE : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    { text: stable, cache: true },
    { text: daily, cache: true },
    { text: live },
  ];
};
