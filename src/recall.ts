// 태그로 찾은 것 중 무엇을 프롬프트에 넣을지 고르고, 넣을 줄을 만드는 자리.
//
// DB를 열지 않는다. 행을 받아 고르고 줄로 옮기는 계산만 해서, 답장 경로와 관리 대시보드가
// 같은 함수를 부를 수 있다. 대시보드는 마이그레이션을 타지 않으려고 DB를 읽기 전용으로
// 직접 열기 때문에(src/tools/db-view.ts), src/db.ts를 부르는 모듈은 가져다 쓸 수 없다.
// 화면용으로 고르는 규칙을 다시 짜면 프롬프트에 실제로 들어가는 것과 어긋나므로 여기 모은다.
//
// 부르는 곳 셋 — 기억을 꺼내는 src/memory.ts, 프롬프트를 조립하는 src/context.ts,
// 태그 검색 화면을 만드는 src/tools/db-tag-search.ts.
//
// 저장·검색 자체(어디에 쓰고 어떤 행을 후보로 삼는가)는 src/memory.ts가 갖고,
// 여기는 후보가 정해진 다음의 순서·상한·문안만 담당한다.

import {
  MEMORY_ITEM_TYPE_NAME,
  MEMORY_OWNER_IN_PROMPT,
  SCHEDULE_STATUS_NAME,
  type MemoryItemType,
} from "./labels.js";
import { SEARCH_LIMIT } from "./thresholds.js";
// 타입만 가져온다 — 값을 가져오면 src/db.ts가 DB를 열고 마이그레이션을 돌린다.
import type { MemoryRow, ScheduleStateRow } from "./db.js";

/**
 * 저장 항목별로 프롬프트에 넣을 개수 상한.
 * 한 항목이 자리를 다 차지하지 않게 두는 장치다. 숫자는 thresholds.ts가 갖고 있고,
 * 실제 프롬프트 길이를 보면서 조절한다.
 */
export const SEARCH_LIMITS: Record<MemoryItemType, number> = {
  ongoing: SEARCH_LIMIT.ongoing,
  person: SEARCH_LIMIT.person,
  fact: SEARCH_LIMIT.fact,
};

/**
 * 태그로 찾아 넣을 수 있는 기억인지 본다.
 * 캐릭터 쪽 사실은 정체성이라 늘 프롬프트에 들어간다 — 검색까지 걸리면 같은 줄이 두 번 들어간다.
 */
export const searchable = (r: MemoryRow): boolean =>
  !(r.item_type === "fact" && r.owner === "char");

/** 꺼내는 순서 — 지금 진행 중인 것부터. */
export const TYPE_ORDER: MemoryItemType[] = ["ongoing", "person", "fact"];

/** 기억 한 건을 한 줄로 가리키는 키 — 호출 기록에 무엇을 넣고 무엇을 뺐는지 적을 때 쓴다. */
export const memoryKeyOf = (r: MemoryRow): string =>
  `${r.item_type}/${r.owner} ${r.area}/${r.subject}`;

export interface PickOptions {
  /** 어떤 저장 항목에서 고를지. 안 주면 검색으로 골라 넣는 것 전부. */
  itemTypes?: MemoryItemType[];
  /** 저장 항목별 개수 상한. 안 주면 SEARCH_LIMITS. */
  limits?: Partial<Record<MemoryItemType, number>>;
  /**
   * 넘겨 주면 태그는 맞았지만 개수 상한에 걸려 빠진 후보의 키를 여기에 적는다.
   * 답장이 어떤 기억을 두고 어떤 기억을 골랐는지 되짚을 때 쓴다(호출 기록용).
   */
  dropped?: string[];
}

/**
 * 태그가 겹친 기억 후보에서 프롬프트에 넣을 것을 고른다.
 * 저장 항목 순서 → 최신순 → 항목별 개수 상한 순으로 자른다.
 */
export const pickMemories = (
  candidates: MemoryRow[],
  opts: PickOptions = {},
): MemoryRow[] => {
  const types = opts.itemTypes;
  const rows = candidates.filter(
    (r) => searchable(r) && (!types || types.includes(r.item_type)),
  );

  const picked: MemoryRow[] = [];
  for (const t of TYPE_ORDER) {
    if (types && !types.includes(t)) continue;
    const cap = opts.limits?.[t] ?? SEARCH_LIMITS[t];
    const ranked = rows
      .filter((r) => r.item_type === t)
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    picked.push(...ranked.slice(0, cap));
    if (opts.dropped)
      opts.dropped.push(...ranked.slice(cap).map((r) => memoryKeyOf(r)));
  }
  return picked;
};

// ── 유저 발화에서 태그 골라내기 ───────────────────────────────────────────

/**
 * 한 글자 태그 뒤에 붙어 있어도 그 어절이 태그 자체를 가리키는 것으로 보는 조사.
 * 이 목록 밖 글자가 이어지면 다른 낱말("일요일"의 "요일")로 보고 매치하지 않는다.
 */
const TAG_PARTICLES = new Set([
  "이",
  "가",
  "은",
  "는",
  "을",
  "를",
  "도",
  "만",
  "에",
  "의",
  "와",
  "과",
  "로",
  "으로",
  "랑",
  "이랑",
  "이나",
  "이야",
  "이지",
  "에서",
  "에는",
  "에도",
  "에만",
  "까지",
  "부터",
  "조차",
  "마저",
  "보다",
  "처럼",
  "밖에",
]);

/** 발화를 어절로 나눈다. 앞뒤에 붙은 문장부호는 떼어 낸다. */
const eojeolsOf = (text: string): string[] =>
  text
    .split(/\s+/)
    .map((w) => w.replace(/^[^0-9A-Za-z가-힣]+|[^0-9A-Za-z가-힣]+$/g, ""))
    .filter(Boolean);

/** 한 글자 태그의 어절 단위 매치 — 어절이 태그와 같거나, 태그 뒤가 조사뿐일 때. */
const matchesAsEojeol = (tag: string, words: string[]): boolean =>
  words.some(
    (w) =>
      w === tag ||
      (w.startsWith(tag) && TAG_PARTICLES.has(w.slice(tag.length))),
  );

/**
 * 발화에 글자가 들어 있는 태그를 골라낸다. 모델 호출 없이 이름을 맞춰 보는 것이라
 * 답장 경로에서 검색어를 만드는 값싼 쪽이다.
 * 한 글자 태그("일"·"돈"·"집")는 문자열 포함으로 보면 "일요일"·"생일"·"수집" 같은
 * 다른 낱말에도 걸려 관련 없는 기억이 검색되므로, 어절 단위 매치만 허용한다.
 */
export const matchTagNames = (names: string[], text: string): string[] => {
  if (!text.trim()) return [];
  const words = eojeolsOf(text);
  return names.filter((t) =>
    t.length >= 2 ? text.includes(t) : matchesAsEojeol(t, words),
  );
};

// ── 프롬프트에 들어가는 줄 ────────────────────────────────────────────────
//
// 여기서 만든 문안이 그대로 프롬프트에 들어간다. 대시보드의 태그 검색 화면도 같은 함수를
// 불러서 보여주므로, 화면에 뜬 문안과 모델이 받는 문안이 어긋나지 않는다.

// 갱신 날짜를 함께 적는다 — 오늘 일인지 지난달 일인지를 모델이 지금 시각과 견줘 판단한다.
const dayLabel = (updatedAt: string): string => {
  const [y, m, d] = updatedAt.slice(0, 10).split("-");
  return y && m && d ? `${Number(m)}/${Number(d)}` : updatedAt.slice(0, 10);
};

// 주인 표시는 검색 기억에만 붙인다 — 정체성 층은 전부 캐릭터 쪽 사실이라 줄마다 '너'가
// 붙으면 같은 말이 반복될 뿐이고, 검색 기억은 진행 중인 일과 주변 인물에서 양쪽이 섞인다.
const renderLine = (r: MemoryRow, owner: boolean): string =>
  `- ${owner ? `${MEMORY_OWNER_IN_PROMPT[r.owner]} · ` : ""}${r.area} · ${r.subject}: ${r.value} (${dayLabel(r.updated_at)} 갱신)`;

export const memoryLine = (r: MemoryRow): string => renderLine(r, false);

export const memoryBlock = (rows: MemoryRow[]): string => {
  const byType = new Map<MemoryItemType, MemoryRow[]>();
  for (const r of rows) {
    const list = byType.get(r.item_type) ?? [];
    list.push(r);
    byType.set(r.item_type, list);
  }
  return TYPE_ORDER.filter((t) => byType.get(t)?.length)
    .map(
      (t) =>
        `[${MEMORY_ITEM_TYPE_NAME[t]}]\n${(byType.get(t) ?? [])
          .map((r) => renderLine(r, true))
          .join("\n")}`,
    )
    .join("\n\n");
};

/** 태그로 찾은 기억 절. 넣을 것이 없으면 빈 문자열이라 조립하는 쪽에서 그대로 빠진다. */
export const memorySection = (rows: MemoryRow[]): string =>
  rows.length ? `[지금 얘기와 관련해 기억나는 것]\n${memoryBlock(rows)}` : "";

export interface DiaryRow {
  date: string;
  entry_json: string;
}

/** 태그로 찾은 지난 일기 절. 최근 일기는 이미 일간층에 있으므로 부르는 쪽이 빼고 넘긴다. */
export const oldDiarySection = (rows: DiaryRow[]): string =>
  rows.length
    ? `[지금 얘기와 관련 있는 옛 일기]\n${rows.map((d) => `${d.date}: ${d.entry_json}`).join("\n")}`
    : "";

// 주제로 찾은 일정 한 줄. [다가오는 일정] 슬롯과 달리 주인과 상태를 함께 적는다 — 여기 실리는
// 것은 대부분 이미 지나갔거나 취소·미룸으로 표시된 일정이라, 상태가 없으면 앞으로의 약속처럼 읽힌다.
export const scheduleHitLine = (r: ScheduleStateRow, today: string): string => {
  const state =
    r.status !== "active"
      ? SCHEDULE_STATUS_NAME[r.status]
      : r.date < today
        ? "지난 일"
        : SCHEDULE_STATUS_NAME.active;
  return `${r.date}${r.time_hint ? ` ${r.time_hint}` : ""} ${r.content} (${
    r.owner === "user" ? "상대" : "너"
  } 쪽 · ${state})`;
};

/** 태그로 찾은 일정 절. [다가오는 일정]에 이미 실린 행은 부르는 쪽이 빼고 넘긴다. */
export const scheduleSearchSection = (
  rows: ScheduleStateRow[],
  today: string,
): string =>
  rows.length
    ? `[지금 얘기와 관련 있는 일정]\n${rows
        .map((r) => scheduleHitLine(r, today))
        .join("\n")}\n- 괄호 안 상태가 '${SCHEDULE_STATUS_NAME.active}'이 아니면 아직 남은 약속이 아니다. 지나갔거나 없어진 일을 앞으로의 예정처럼 말하지 않는다.`
    : "";

/**
 * 개수 상한으로 자르고 빠진 것을 적는다. 일기·일정처럼 저장 항목으로 나뉘지 않는 검색 결과가 쓴다.
 * 넣은 것만 봐서는 왜 그것이 안 들어갔는지 알 수 없어서, 빠진 후보를 같은 자리에서 남긴다.
 */
export const capHits = <T>(
  rows: T[],
  cap: number,
  label: (r: T) => string,
  dropped?: string[],
): T[] => {
  if (dropped) dropped.push(...rows.slice(cap).map(label));
  return rows.slice(0, cap);
};
