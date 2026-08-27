import {
  upsertMemoryItem,
  getMemoryItemById,
  listMemoryItems,
  moveMemoryItemType,
  setTags,
  getTags,
  findRefsByTags,
  listAreas,
  upsertArea,
  addTodayNote,
  getTodayNotes,
  type MemoryRow,
  type TagKind,
} from "./db.js";
import {
  MEMORY_ITEM_TYPE_NAME,
  type MemoryItemType,
  type MemoryOwner,
  type MemoryOrigin,
  type UserKnows,
  type InterestLevel,
} from "./labels.js";
import { getKstNow, kstDateString, logicalDayStartTs } from "./kst.js";

// 기억 저장과 태그 검색.
//
// 대화 원문을 통째로 쌓지 않고 주제 단위로 나눠 저장한다. 같은 주제를 다시 이야기하면 행이
// 늘지 않고 내용만 바뀌므로 저장량이 주제 수만큼으로 묶이고, 필요한 것만 골라 넣을 수 있다.
//
// 자리를 찾을 때는 키를 쓰고, 꺼낼 때는 태그를 쓴다.
//   키   = 저장 항목 · 누구 쪽 · 영역 · 무엇. 정확하게 지어야 같은 주제가 갈라지지 않는다.
//   태그 = 그 내용과 관련된 말들. 넉넉하게 붙여야 관련 대화에서 딸려 나온다.

/** 영역의 기본 갈래. 캐릭터가 쓰는 이름은 areas 테이블이 갖고, 대화로 더 생길 수 있다. */
export const CORE_AREAS = [
  "일",
  "건강",
  "가족",
  "친구",
  "돈",
  "집",
  "음식",
  "여행",
] as const;

/**
 * 저장 항목별로 프롬프트에 넣을 개수 상한.
 * 한 항목이 자리를 다 차지하지 않게 두는 장치다. 실제 숫자는 며칠 써 보고 정하기로 했다
 * (time-and-memory.md 「고정된 기준값」에 결정 대상으로 올려 뒀다).
 */
export const SEARCH_LIMITS: Record<MemoryItemType, number> = {
  ongoing: 5,
  user_fact: 5,
  identity: 4,
  relationship: 4,
};

/** 검색으로 골라 넣는 저장 항목. 정체성과 관계는 늘 들어가므로 여기 없다. */
const SEARCHABLE: MemoryItemType[] = ["ongoing", "user_fact"];

/** 꺼내는 순서 — 지금 진행 중인 것부터. */
const TYPE_ORDER: MemoryItemType[] = [
  "ongoing",
  "user_fact",
  "identity",
  "relationship",
];

const stamp = (): string =>
  `${kstDateString()} ${getKstNow().toISOString().slice(11, 19)}`;

const tidy = (v: string): string => v.trim().replace(/\s+/g, " ");

/**
 * 키를 쓸 수 있는 모양인지 본다. 못 쓸 이유를 돌려주고, 괜찮으면 null.
 * 영역과 무엇 둘 다 명사 한 덩어리여야 같은 주제가 두 자리로 갈라지지 않는다.
 */
export const keyProblem = (area: string, subject: string): string | null => {
  const a = tidy(area);
  const s = tidy(subject);
  if (!a || !s) return "영역과 무엇이 모두 있어야 한다";
  if (a.length > 12 || s.length > 20) return "키가 너무 길다";
  if (/[\/|,·]/.test(a) || /[\/|,·]/.test(s))
    return "키 한 자리에 여러 낱말을 묶지 않는다";
  return null;
};

export interface MemoryInput {
  characterId: number;
  itemType: MemoryItemType;
  owner: MemoryOwner;
  area: string;
  subject: string;
  value: string;
  tags?: string[];
  origin?: MemoryOrigin;
  userKnows?: UserKnows;
  interestLevel?: InterestLevel | null;
  extra?: Record<string, unknown> | null;
}

/**
 * 기억 한 건을 저장한다. 같은 키가 있으면 내용을 갈아 끼우고, 태그도 새로 붙인 것으로 바꾼다.
 * 키의 두 낱말은 태그에도 그대로 들어간다 — 키로 찾던 것을 태그로도 찾을 수 있게.
 */
export const saveMemory = (m: MemoryInput): number => {
  const area = tidy(m.area);
  const subject = tidy(m.subject);
  const bad = keyProblem(area, subject);
  if (bad) throw new Error(`키를 만들 수 없다(${area}/${subject}): ${bad}`);

  const id = upsertMemoryItem({
    characterId: m.characterId,
    itemType: m.itemType,
    owner: m.owner,
    area,
    subject,
    value: tidy(m.value),
    origin: m.origin,
    userKnows: m.userKnows,
    interestLevel: m.interestLevel,
    extraJson: m.extra ? JSON.stringify(m.extra) : null,
    updatedAt: stamp(),
  });

  upsertArea(m.characterId, area);
  const tags = new Set([area, subject, ...(m.tags ?? []).map(tidy)]);
  setTags(m.characterId, "memory", id, [...tags].filter(Boolean));
  return id;
};

/** 일이 끝났을 때 저장 항목만 옮긴다(진행 중인 일 → 알게 된 유저 사실). */
export const moveMemory = (id: number, to: MemoryItemType): number =>
  moveMemoryItemType(id, to, stamp());

export const memoryTags = (id: number): string[] => getTags("memory", id);

export interface SearchOptions {
  /** 어떤 저장 항목에서 찾을지. 기본은 검색으로 골라 넣는 두 가지. */
  itemTypes?: MemoryItemType[];
  /** 저장 항목별 개수 상한. 안 주면 SEARCH_LIMITS. */
  limits?: Partial<Record<MemoryItemType, number>>;
}

/**
 * 태그가 겹치는 기억을 모은다.
 * 후보는 태그 일치가 만들고, 넣을 것은 저장 항목 순서 → 최신순 → 항목별 개수 상한이 정한다.
 */
export const searchMemories = (
  characterId: number,
  tags: string[],
  opts: SearchOptions = {},
): MemoryRow[] => {
  const hits = findRefsByTags(characterId, "memory", tags);
  if (!hits.length) return [];
  const types = opts.itemTypes ?? SEARCHABLE;
  const rows = hits
    .map((h) => getMemoryItemById(h.ref_id))
    .filter((r): r is MemoryRow => !!r && types.includes(r.item_type));

  const picked: MemoryRow[] = [];
  for (const t of TYPE_ORDER) {
    if (!types.includes(t)) continue;
    const cap = opts.limits?.[t] ?? SEARCH_LIMITS[t];
    picked.push(
      ...rows
        .filter((r) => r.item_type === t)
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
        .slice(0, cap),
    );
  }
  return picked;
};

/** 일기·일정도 같은 태그로 찾는다. 행을 읽는 건 그 데이터를 가진 쪽 몫이라 id만 준다. */
export const searchTaggedRefs = (
  characterId: number,
  kind: TagKind,
  tags: string[],
): number[] => findRefsByTags(characterId, kind, tags).map((h) => h.ref_id);

/** 늘 프롬프트에 들어가는 항목(정체성·관계). */
export const alwaysIncluded = (characterId: number): MemoryRow[] => [
  ...listMemoryItems(characterId, "identity"),
  ...listMemoryItems(characterId, "relationship"),
];

// 갱신 날짜를 함께 적는다 — 오늘 일인지 지난달 일인지를 모델이 지금 시각과 견줘 판단한다.
const dayLabel = (updatedAt: string): string => {
  const [y, m, d] = updatedAt.slice(0, 10).split("-");
  return y && m && d ? `${Number(m)}/${Number(d)}` : updatedAt.slice(0, 10);
};

export const memoryLine = (r: MemoryRow): string =>
  `- ${r.area} · ${r.subject}: ${r.value} (${dayLabel(r.updated_at)} 갱신)`;

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
          .map(memoryLine)
          .join("\n")}`,
    )
    .join("\n\n");
};

/**
 * 이미 있는 키와 태그 목록.
 * 새벽 정리가 기억을 정리할 때 같이 준다 — 같은 주제에 매번 다른 이름을 붙이면
 * 한 주제가 여러 자리로 갈라져 어느 쪽도 이어지지 않는다.
 */
export const existingKeys = (
  characterId: number,
): { itemType: MemoryItemType; owner: MemoryOwner; key: string }[] =>
  listMemoryItems(characterId).map((r) => ({
    itemType: r.item_type,
    owner: r.owner,
    key: `${r.area}/${r.subject}`,
  }));

export const existingAreas = (characterId: number): string[] => {
  const saved = listAreas(characterId).map((a) => a.name);
  return [...new Set([...saved, ...CORE_AREAS])];
};

/** 새 캐릭터가 시작할 때 영역의 기본 갈래를 깔아 준다. */
export const ensureCoreAreas = (characterId: number): void => {
  for (const a of CORE_AREAS) upsertArea(characterId, a);
};

// ── 오늘 메모 ─────────────────────────────────────────────────────────────
// 대화 중에는 저장 항목도 키도 판정하지 않고, 남길 내용을 문장 그대로 적어 둔다.
// 판정을 대화 경로에 넣으면 답장이 느려지고, 한 번의 대화로는 어느 주제에 속할지도 이르다.

export const saveTodayNote = (
  characterId: number,
  note: string,
  messageId?: number | null,
): void => {
  const text = tidy(note);
  if (!text) return;
  addTodayNote(characterId, stamp(), text, messageId);
};

/** 오늘(새벽 5시 경계) 적어 둔 메모. */
export const todayNotes = (characterId: number): string[] =>
  getTodayNotes(characterId, logicalDayStartTs()).map((n) => n.note);
