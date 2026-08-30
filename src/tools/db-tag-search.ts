// 관리 대시보드의 태그 검색 — 답장을 만들 때 도는 검색을 그대로 한 번 돌려 결과를 보여준다.
//
// 고르는 규칙과 프롬프트 줄은 src/recall.ts가 갖고 있고 여기서는 행만 읽어 넘긴다.
// 화면용으로 다시 짜면 프롬프트에 실제로 들어가는 것과 어긋나므로 계산은 하지 않는다.
//
// DB는 db-view.ts와 같은 이유로 읽기 전용으로 직접 연다 — src/db.ts를 부르면 그 모듈이
// 파일을 쓰기로 열고 마이그레이션을 돌린다. 그래서 SELECT 문은 db.ts와 따로 적혀 있고,
// 읽는 조건(어떤 행을 후보로 삼는가)이 바뀌면 두 자리를 함께 고쳐야 한다.
//
// 모델이 태그를 고르는 단계(src/tag-pick.ts)는 API 호출이라 이 화면에서 돌리지 않는다.
// 태그는 화면에서 직접 고르거나, 발화를 넣어 글자가 일치하는 것으로 채운다.

import Database from "better-sqlite3";
import {
  capHits,
  matchTagNames,
  memoryKeyOf,
  memorySection,
  oldDiarySection,
  pickMemories,
  scheduleSearchSection,
  searchable,
  type DiaryRow,
} from "../recall.js";
import { RECENT_DIARY_DAYS, SEARCH_LIMIT, TAG_PICK_MAX } from "../thresholds.js";
import { kstDateString } from "../kst.js";
import type { MemoryRow, ScheduleStateRow } from "../db.js";

/**
 * [다가오는 일정] 슬롯이 싣는 최대 행 수. src/db.ts의 getUpcomingSchedules 기본값과 같은 값이고,
 * 여기 실린 행은 태그 검색 결과에서 빠지므로 그 경계를 화면에서도 같게 잡아야 한다.
 */
const UPCOMING_LIMIT = 12;

export interface CharacterBrief {
  id: number;
  chat_id: string;
  status: string;
  /** 이 캐릭터에 붙어 있는 태그 이름 — 검색에서 고를 수 있는 전부. */
  tags: { tag: string; memory: number; diary: number; schedule: number }[];
}

/** 결과 한 줄 — 프롬프트에 들어간 문안과 그 줄이 걸린 이유를 함께 준다. */
export interface Hit {
  /** 몇 개의 태그가 겹쳐서 걸렸는지. */
  hits: number;
  /** 이 행에 붙어 있는 태그 전부. */
  tags: string[];
  /** 무엇이 걸렸는지 한 줄로. */
  label: string;
  /** 프롬프트에 실제로 들어가는 값. */
  detail: string;
}

export interface TagSearchResult {
  characterId: number;
  /** 오늘 날짜 — 일정에 '지난 일'을 붙이는 경계. */
  today: string;
  /** 검색에 쓴 태그. */
  tags: string[];
  /** 대조한 태그 수 — 걸린 것이 없을 때 검색이 돌긴 했는지 가른다. */
  pool: number;
  /** 발화에서 글자가 일치해 채워진 태그. */
  matched: string[];
  /** 답장 경로가 한 번에 쓰는 태그 수 상한. 넘겨서 골랐으면 화면에서 알린다. */
  pickMax: number;
  /** 프롬프트에 들어가는 세 절 그대로. */
  prompt: string;
  memories: Hit[];
  diaries: Hit[];
  schedules: Hit[];
  /** 태그는 맞았지만 개수 상한에 걸려 빠진 후보. */
  dropped: string[];
  /** 상한이 아니라 제외 규칙으로 빠진 행 — 왜 안 나왔는지 화면에서 답한다. */
  excluded: { reason: string; rows: string[] }[];
}

const tagsOf = (
  db: Database.Database,
  kind: string,
  ids: number[],
): Map<number, string[]> => {
  const out = new Map<number, string[]>();
  if (!ids.length) return out;
  const holes = ids.map(() => "?").join(",");
  for (const r of db
    .prepare(
      `SELECT ref_id, tag FROM tags WHERE kind = ? AND ref_id IN (${holes}) ORDER BY tag`,
    )
    .all(kind, ...ids) as { ref_id: number; tag: string }[]) {
    const list = out.get(r.ref_id) ?? [];
    list.push(r.tag);
    out.set(r.ref_id, list);
  }
  return out;
};

/** 태그가 겹치는 행과 겹친 수. src/db.ts의 findRefsByTags와 같은 질의다. */
const refsByTags = (
  db: Database.Database,
  characterId: number,
  kind: string,
  tags: string[],
): { ref_id: number; hits: number }[] => {
  const wanted = tags.map((t) => t.trim()).filter(Boolean);
  if (!wanted.length) return [];
  const holes = wanted.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT ref_id, count(*) hits FROM tags
        WHERE character_id = ? AND kind = ? AND tag IN (${holes})
        GROUP BY ref_id ORDER BY hits DESC`,
    )
    .all(characterId, kind, ...wanted) as { ref_id: number; hits: number }[];
};

/** 화면을 그릴 때 함께 실어 보내는 캐릭터와 태그 목록. */
export const listCharacters = (db: Database.Database): CharacterBrief[] => {
  const chars = db
    .prepare(`SELECT id, chat_id, status FROM characters ORDER BY id`)
    .all() as { id: number; chat_id: string; status: string }[];
  const counts = db
    .prepare(
      `SELECT character_id, tag, kind, count(*) n FROM tags
        GROUP BY character_id, tag, kind ORDER BY tag`,
    )
    .all() as {
    character_id: number;
    tag: string;
    kind: string;
    n: number;
  }[];
  return chars.map((c) => {
    const byTag = new Map<string, CharacterBrief["tags"][number]>();
    for (const r of counts.filter((r) => r.character_id === c.id)) {
      const hit = byTag.get(r.tag) ?? {
        tag: r.tag,
        memory: 0,
        diary: 0,
        schedule: 0,
      };
      if (r.kind === "memory") hit.memory += r.n;
      else if (r.kind === "diary") hit.diary += r.n;
      else if (r.kind === "schedule") hit.schedule += r.n;
      byTag.set(r.tag, hit);
    }
    return { ...c, tags: [...byTag.values()] };
  });
};

export interface SearchInput {
  characterId: number;
  /** 화면에서 직접 고른 태그. */
  tags: string[];
  /** 발화 — 글자가 일치하는 태그를 여기서 더 채운다. */
  text: string;
}

/** 태그 검색 한 번. 답장 경로가 프롬프트 꼬리를 만드는 순서를 그대로 따른다. */
export const runTagSearch = (
  db: Database.Database,
  input: SearchInput,
): TagSearchResult => {
  const { characterId } = input;
  const today = kstDateString();

  const names = (
    db
      .prepare(
        `SELECT DISTINCT tag FROM tags WHERE character_id = ? ORDER BY tag`,
      )
      .all(characterId) as { tag: string }[]
  ).map((r) => r.tag);
  const matched = matchTagNames(names, input.text);
  const tags = [
    ...new Set([...input.tags.filter((t) => names.includes(t)), ...matched]),
  ];

  const dropped: string[] = [];
  const excluded: TagSearchResult["excluded"] = [];

  // ── 기억 ────────────────────────────────────────────────────────────────
  const memHits = refsByTags(db, characterId, "memory", tags);
  const memRows = memHits.length
    ? (db
        .prepare(
          `SELECT * FROM memory_items WHERE id IN (${memHits
            .map(() => "?")
            .join(",")})`,
        )
        .all(...memHits.map((h) => h.ref_id)) as MemoryRow[])
    : [];
  // 태그가 겹친 순서 그대로 넘긴다 — 고르는 쪽이 저장 항목과 갱신 시각으로 다시 세운다.
  const byMemId = new Map(memRows.map((r) => [r.id, r]));
  const candidates = memHits
    .map((h) => byMemId.get(h.ref_id))
    .filter((r): r is MemoryRow => !!r);
  const picked = pickMemories(candidates, { dropped });

  const identity = candidates.filter((r) => !searchable(r));
  if (identity.length)
    excluded.push({
      reason: "캐릭터 쪽 사실이라 늘 프롬프트에 들어간다. 검색까지 걸리면 같은 줄이 두 번 들어가서 여기서 뺀다",
      rows: identity.map(memoryKeyOf),
    });

  // ── 일기 ────────────────────────────────────────────────────────────────
  const diaryHitRows = refsByTags(db, characterId, "diary", tags);
  const diaryRows = diaryHitRows.length
    ? (db
        .prepare(
          `SELECT id, date, entry_json FROM diary_entries WHERE id IN (${diaryHitRows
            .map(() => "?")
            .join(",")}) ORDER BY date`,
        )
        .all(...diaryHitRows.map((h) => h.ref_id)) as (DiaryRow & {
        id: number;
      })[])
    : [];
  const recentDates = new Set(
    (
      db
        .prepare(
          `SELECT date FROM diary_entries WHERE character_id = ? ORDER BY id DESC LIMIT ?`,
        )
        .all(characterId, RECENT_DIARY_DAYS) as { date: string }[]
    ).map((r) => r.date),
  );
  const byDiaryId = new Map(diaryRows.map((r) => [r.id, r]));
  const diaryOrdered = diaryHitRows
    .map((h) => byDiaryId.get(h.ref_id))
    .filter((r): r is (typeof diaryRows)[number] => !!r);
  const recentHit = diaryOrdered.filter((d) => recentDates.has(d.date));
  if (recentHit.length)
    excluded.push({
      reason: `최근 일기 ${RECENT_DIARY_DAYS}편은 일간층에 이미 들어가 있어서 뺀다`,
      rows: recentHit.map((d) => `일기 ${d.date}`),
    });
  const oldDiaries = capHits(
    diaryOrdered.filter((d) => !recentDates.has(d.date)),
    SEARCH_LIMIT.diary,
    (d) => `일기 ${d.date}`,
    dropped,
  );

  // ── 일정 ────────────────────────────────────────────────────────────────
  const schedHitRows = refsByTags(db, characterId, "schedule", tags);
  const schedRows = schedHitRows.length
    ? (db
        .prepare(
          `SELECT id, owner, date, time_hint, content, status FROM schedules
            WHERE character_id = ? AND id IN (${schedHitRows
              .map(() => "?")
              .join(",")})`,
        )
        .all(characterId, ...schedHitRows.map((h) => h.ref_id)) as ScheduleStateRow[])
    : [];
  const upcomingIds = new Set(
    (
      db
        .prepare(
          `SELECT id FROM schedules
            WHERE character_id = ? AND status = 'active' AND date >= ?
            ORDER BY date, id LIMIT ?`,
        )
        .all(characterId, today, UPCOMING_LIMIT) as { id: number }[]
    ).map((r) => r.id),
  );
  const bySchedId = new Map(schedRows.map((r) => [r.id, r]));
  const schedOrdered = schedHitRows
    .map((h) => bySchedId.get(h.ref_id))
    .filter((r): r is ScheduleStateRow => !!r);
  const upcomingHit = schedOrdered.filter((r) => upcomingIds.has(r.id));
  if (upcomingHit.length)
    excluded.push({
      reason: "[다가오는 일정] 슬롯이 이미 싣고 있어서 뺀다",
      rows: upcomingHit.map((r) => `일정 ${r.date} ${r.content}`),
    });
  const foundSchedules = capHits(
    schedOrdered.filter((r) => !upcomingIds.has(r.id)),
    SEARCH_LIMIT.schedule,
    (r) => `일정 ${r.date} ${r.content}`,
    dropped,
  );

  // ── 프롬프트 문안 ────────────────────────────────────────────────────────
  const prompt = [
    memorySection(picked),
    oldDiarySection(oldDiaries),
    scheduleSearchSection(foundSchedules, today),
  ]
    .filter(Boolean)
    .join("\n\n");

  const hitCount = new Map<string, Map<number, number>>();
  hitCount.set("memory", new Map(memHits.map((h) => [h.ref_id, h.hits])));
  hitCount.set("diary", new Map(diaryHitRows.map((h) => [h.ref_id, h.hits])));
  hitCount.set("schedule", new Map(schedHitRows.map((h) => [h.ref_id, h.hits])));

  const memTags = tagsOf(db, "memory", picked.map((r) => r.id));
  const diaryTags = tagsOf(db, "diary", oldDiaries.map((d) => d.id));
  const schedTags = tagsOf(db, "schedule", foundSchedules.map((r) => r.id));

  return {
    characterId,
    today,
    tags,
    pool: names.length,
    matched,
    pickMax: TAG_PICK_MAX,
    prompt,
    memories: picked.map((r) => ({
      hits: hitCount.get("memory")?.get(r.id) ?? 0,
      tags: memTags.get(r.id) ?? [],
      label: memoryKeyOf(r),
      detail: r.value,
    })),
    diaries: oldDiaries.map((d) => ({
      hits: hitCount.get("diary")?.get(d.id) ?? 0,
      tags: diaryTags.get(d.id) ?? [],
      label: d.date,
      detail: d.entry_json,
    })),
    schedules: foundSchedules.map((r) => ({
      hits: hitCount.get("schedule")?.get(r.id) ?? 0,
      tags: schedTags.get(r.id) ?? [],
      label: `${r.date}${r.time_hint ? ` ${r.time_hint}` : ""} ${r.content}`,
      detail: `${r.owner === "user" ? "상대" : "너"} 쪽 · ${r.status}`,
    })),
    dropped,
    excluded,
  };
};

/** 화면을 그릴 때 한 번 읽는 목록. 여닫는 것은 이 함수 안에서 끝낸다. */
export const readTagIndex = (file: string): CharacterBrief[] => {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return listCharacters(db);
  } finally {
    db.close();
  }
};

/** 검색 요청 한 건. 서버가 요청마다 부른다. */
export const tagSearchOn = (
  file: string,
  input: SearchInput,
): TagSearchResult => {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return runTagSearch(db, input);
  } finally {
    db.close();
  }
};
