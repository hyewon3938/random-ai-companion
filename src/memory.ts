// 기억을 저장하고 찾는 자리.
//
// saveMemory는 항목·주인·영역·무엇 넷을 키로 자리를 찾아 덮어쓴다. 저장은 언제나 conversation
// 행에만 하고, 캐릭터를 만들 때 한 번 saveCreationMemory가 creation 행을 쓴다. creation 행은
// 생성 때 정한 큰 정체성이라 수정을 거부한다.
//
// searchMemories는 태그로 후보를 모으고, 꺼낸 기록을 남긴다(track:false로 끌 수 있다).
// 후보 중 무엇을 프롬프트에 넣을지 고르는 규칙과 줄을 만드는 일은 recall.ts가 갖는다.
//
// tagSearch는 유저 발화에서 검색어를 뽑는다. 한 글자 태그("일"·"돈"·"집")는 어절 단위로만
// 맞춘다 — 문자열 포함으로 두면 "일요일"·"생일"·"수집" 속 글자에 걸린다(이슈 #54).

import {
  upsertMemoryItem,
  insertCreationMemory,
  markMemoriesRetrieved,
  getMemoryItemById,
  listMemoryItems,
  moveMemoryItemType,
  setTags,
  getTags,
  findRefsByTags,
  listTagNames,
  listAreas,
  upsertArea,
  addTodayNote,
  getTodayNotes,
  type MemoryRow,
  type TagKind,
} from "./db.js";
import {
  type MemoryItemType,
  type MemoryOwner,
  type UserKnows,
  type Interest,
} from "./labels.js";
import { matchTagNames, memoryLine, pickMemories } from "./recall.js";
import { getKstNow, kstDateString, logicalDayStartTs } from "./kst.js";

// 고르는 규칙과 프롬프트 줄은 recall.ts가 갖는다 — DB를 열지 않는 자리라 관리 대시보드의
// 태그 검색 화면도 같은 함수를 부른다. 여기서 다시 내보내 부르던 곳은 그대로 둔다.
export {
  SEARCH_LIMITS,
  TYPE_ORDER,
  memoryKeyOf,
  memoryLine,
  memoryBlock,
} from "./recall.js";

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
  userKnows?: UserKnows;
  /** 주변 인물에만 쓰는 추가 정보. */
  relation?: string | null;
  contactMode?: string | null;
  region?: string | null;
  lastMentionedAt?: string | null;
  /** 진행 중인 일이 끝났다고 볼 조건. */
  endCondition?: string | null;
  /** 유저가 이 주제에 보이는 관심 수준. 캐릭터 쪽 기억에만 쓴다. */
  interest?: Interest | null;
}

const toWrite = (m: MemoryInput, area: string, subject: string) => ({
  characterId: m.characterId,
  itemType: m.itemType,
  owner: m.owner,
  area,
  subject,
  value: tidy(m.value),
  userKnows: m.userKnows,
  relation: m.relation,
  contactMode: m.contactMode,
  region: m.region,
  lastMentionedAt: m.lastMentionedAt,
  endCondition: m.endCondition,
  interest: m.interest,
  updatedAt: stamp(),
});

const attach = (m: MemoryInput, id: number, area: string, subject: string) => {
  upsertArea(m.characterId, area);
  const tags = new Set([area, subject, ...(m.tags ?? []).map(tidy)]);
  setTags(m.characterId, "memory", id, [...tags].filter(Boolean));
  return id;
};

const checkedKey = (m: MemoryInput): [string, string] => {
  const area = tidy(m.area);
  const subject = tidy(m.subject);
  const bad = keyProblem(area, subject);
  if (bad) throw new Error(`키를 만들 수 없다(${area}/${subject}): ${bad}`);
  return [area, subject];
};

/**
 * 기억 한 건을 저장한다. 같은 키가 있으면 내용을 갈아 끼우고, 태그도 새로 붙인 것으로 바꾼다.
 * 키의 두 낱말은 태그에도 그대로 들어간다 — 키로 찾던 것을 태그로도 찾을 수 있게.
 *
 * 쓰는 자리는 언제나 대화로 쌓인 행이다. 캐릭터를 만들 때 정한 행은 같은 키에 나란히 남아
 * 있고 프롬프트에는 둘 다 들어간다 — 생성 때 정한 큰 정체성이 대화로 바뀌지 않는다는 원칙을
 * 지시문이 아니라 이 쓰기 규칙 하나로 지킨다.
 */
export const saveMemory = (m: MemoryInput): number => {
  const [area, subject] = checkedKey(m);
  const id = upsertMemoryItem(toWrite(m, area, subject));
  return attach(m, id, area, subject);
};

/**
 * 캐릭터를 만들 때 정한 기억을 저장한다. 생성 배치만 쓰는 자리이고, 같은 키가 이미 있으면
 * 그대로 둔다 — 이 행은 만든 뒤로 고치지 않는다.
 */
export const saveCreationMemory = (m: MemoryInput): number => {
  const [area, subject] = checkedKey(m);
  const id = insertCreationMemory(toWrite(m, area, subject));
  return attach(m, id, area, subject);
};

/** 일이 끝났을 때 저장 항목만 옮긴다(진행 중인 일 → 사실). */
export const moveMemory = (id: number, to: MemoryItemType): number =>
  moveMemoryItemType(id, to, stamp());

export const memoryTags = (id: number): string[] => getTags("memory", id);

export interface SearchOptions {
  /** 어떤 저장 항목에서 찾을지. 안 주면 검색으로 골라 넣는 것 전부. */
  itemTypes?: MemoryItemType[];
  /** 저장 항목별 개수 상한. 안 주면 SEARCH_LIMITS. */
  limits?: Partial<Record<MemoryItemType, number>>;
  /** 꺼낸 기록을 남길지. 화면에 보여주기만 하는 도구는 false로 부른다. */
  track?: boolean;
  /**
   * 넘겨 주면 태그는 맞았지만 개수 상한에 걸려 빠진 후보의 키를 여기에 적는다.
   * 답장이 어떤 기억을 두고 어떤 기억을 골랐는지 되짚을 때 쓴다(호출 기록용).
   */
  dropped?: string[];
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
  const candidates = hits
    .map((h) => getMemoryItemById(h.ref_id))
    .filter((r): r is MemoryRow => !!r);
  const picked = pickMemories(candidates, opts);
  if (opts.track !== false)
    markMemoriesRetrieved(
      picked.map((r) => r.id),
      stamp(),
    );
  return picked;
};

/**
 * 유저 발화에 들어 있는 태그를 골라낸다. 붙어 있는 태그 이름을 맞춰 보는 것이라 추가 모델
 * 호출이 없다 — 답장 경로에서 검색어를 만드는 값싼 쪽이고, 맞춰 보는 규칙은 recall.ts가 갖는다.
 * 대조한 태그 수(pool)도 함께 준다 — 걸린 태그가 없을 때 검색이 돌긴 했는지 가른다.
 */
export const tagSearch = (
  characterId: number,
  text: string,
): { tags: string[]; pool: number } => {
  const names = listTagNames(characterId);
  return { tags: matchTagNames(names, text), pool: names.length };
};

/** 일기·일정도 같은 태그로 찾는다. 행을 읽는 건 그 데이터를 가진 쪽 몫이라 id만 준다. */
export const searchTaggedRefs = (
  characterId: number,
  kind: TagKind,
  tags: string[],
): number[] => findRefsByTags(characterId, kind, tags).map((h) => h.ref_id);

/**
 * 늘 프롬프트에 들어가는 기억 — 캐릭터 쪽 사실, 곧 정체성이다.
 * 관계는 relationships 테이블이 갖고 있고, 프롬프트에 넣는 건 context.ts가 한다.
 */
export const alwaysIncluded = (characterId: number): MemoryRow[] =>
  listMemoryItems(characterId, "fact").filter((r) => r.owner === "char");

// 정체성 줄 정렬 — 생성 때 정한 행(creation)을 먼저, 대화로 쌓인 행(conversation)을
// 뒤에 둔다: 같은 항목이 두 줄이면 뒤가 최신이라 이긴다. 대화 프롬프트(context.ts)와
// 각본·월 리듬 생성(day-plan·life-plan)이 같은 순서를 쓴다.
export const orderedIdentity = (rows: MemoryRow[]): MemoryRow[] => {
  const creation = rows
    .filter((r) => r.origin === "creation")
    .sort((a, b) => a.id - b.id);
  const accrued = rows
    .filter((r) => r.origin === "conversation")
    .sort((a, b) =>
      a.updated_at === b.updated_at
        ? a.id - b.id
        : a.updated_at < b.updated_at
          ? -1
          : 1,
    );
  return [...creation, ...accrued];
};

/** 정체성 전부를 프롬프트 재료 줄로 — 각본·월 리듬 생성의 [인물] 자리가 쓴다. */
export const identityLines = (characterId: number): string =>
  orderedIdentity(alwaysIncluded(characterId)).map(memoryLine).join("\n");

/** 정체성에서 키 하나의 값. 같은 키가 여러 줄이면 가장 최신(뒤쪽) 것. */
export const identityValue = (
  rows: MemoryRow[],
  area: string,
  subject: string,
): string | null => {
  const ordered = orderedIdentity(rows);
  for (let i = ordered.length - 1; i >= 0; i--) {
    const r = ordered[i];
    if (r.area === area && r.subject === subject) return r.value;
  }
  return null;
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
