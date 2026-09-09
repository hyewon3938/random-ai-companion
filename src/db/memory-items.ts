// 기억·태그·영역·오늘 메모·오늘 실제 표의 저장 함수.
//
// 기억 한 건은 키(저장 항목·누구 쪽·영역·무엇)로 자리를 찾고 태그로 모은다. 키를 짓고
// 태그를 고르는 규칙은 memory.ts가 갖고, 여기는 행을 넣고 빼는 자리다. 오늘 메모와 오늘
// 실제는 하루 동안 쌓였다가 새벽 정리가 읽고 비운다.

import { db } from "./connection.js";
import type {
  MemoryItemType,
  MemoryOwner,
  MemoryOrigin,
  UserKnows,
  Interest,
} from "../labels.js";

// ── 기억 한 건과 태그 ──────────────────────────────────────────────────────
// 저장은 키(저장 항목·누구 쪽·영역·무엇)로 자리를 찾고, 검색은 태그로 모은다.
// 키를 짓고 태그를 고르는 규칙은 memory.ts가 갖는다 — 여기는 행을 넣고 빼는 자리다.

export interface MemoryRow {
  id: number;
  character_id: number;
  item_type: MemoryItemType;
  owner: MemoryOwner;
  area: string;
  subject: string;
  value: string;
  origin: MemoryOrigin;
  user_knows: UserKnows;
  relation: string | null;
  contact_mode: string | null;
  region: string | null;
  last_mentioned_at: string | null;
  end_condition: string | null;
  interest: Interest | null;
  last_retrieved_at: string | null;
  retrieval_count: number;
  updated_at: string;
}

export interface MemoryWrite {
  characterId: number;
  itemType: MemoryItemType;
  owner: MemoryOwner;
  area: string;
  subject: string;
  value: string;
  userKnows?: UserKnows;
  relation?: string | null;
  contactMode?: string | null;
  region?: string | null;
  lastMentionedAt?: string | null;
  endCondition?: string | null;
  interest?: Interest | null;
  updatedAt: string;
}

// 항목별 전용 컬럼은 해당 항목에서만 값을 갖는다. 어긋난 값이 오면 CHECK가 쓰기를 통째로
// 막아 버려서, DB에 닿기 전에 여기서 비운다 — 각본 태그를 세 겹으로 막아 둔 것과 같은 이유다.
const fitToItem = (w: MemoryWrite) => {
  const person = w.itemType === "person";
  const ofChar = w.owner === "char";
  return {
    relation: person ? (w.relation ?? null) : null,
    contactMode: person ? (w.contactMode ?? null) : null,
    region: person ? (w.region ?? null) : null,
    lastMentionedAt: person ? (w.lastMentionedAt ?? null) : null,
    endCondition: w.itemType === "ongoing" ? (w.endCondition ?? null) : null,
    interest: ofChar ? (w.interest ?? null) : null,
    userKnows: ofChar ? (w.userKnows ?? "unknown") : "known",
  };
};

const MEMORY_COLUMNS = `character_id, item_type, owner, area, subject, value, origin, user_knows,
   relation, contact_mode, region, last_mentioned_at, end_condition, interest, updated_at`;

const memoryValues = (w: MemoryWrite, origin: MemoryOrigin): unknown[] => {
  const f = fitToItem(w);
  return [
    w.characterId,
    w.itemType,
    w.owner,
    w.area,
    w.subject,
    w.value,
    origin,
    f.userKnows,
    f.relation,
    f.contactMode,
    f.region,
    f.lastMentionedAt,
    f.endCondition,
    f.interest,
    w.updatedAt,
  ];
};

const memoryIdOf = (w: MemoryWrite, origin: MemoryOrigin): number =>
  (
    db
      .prepare(
        `SELECT id FROM memory_items
          WHERE character_id = ? AND item_type = ? AND owner = ? AND area = ? AND subject = ? AND origin = ?`,
      )
      .get(w.characterId, w.itemType, w.owner, w.area, w.subject, origin) as {
      id: number;
    }
  ).id;

// 같은 키가 이미 있으면 내용만 갈아 끼운다 — 사실이 바뀌어도 행이 늘지 않는다.
//
// 출처를 확인하는 분기는 두지 않고 언제나 대화로 쌓인 행에만 쓴다. 캐릭터를 만들 때 정한
// 값은 같은 키의 다른 행에 그대로 남아, 대화가 큰 정체성을 바꾸지 못한다.
export const upsertMemoryItem = (w: MemoryWrite): number => {
  const r = db
    .prepare(
      `INSERT INTO memory_items (${MEMORY_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (character_id, item_type, owner, area, subject, origin) DO UPDATE SET
         value = excluded.value,
         user_knows = excluded.user_knows,
         relation = excluded.relation,
         contact_mode = excluded.contact_mode,
         region = excluded.region,
         last_mentioned_at = excluded.last_mentioned_at,
         end_condition = excluded.end_condition,
         interest = excluded.interest,
         updated_at = excluded.updated_at
       RETURNING id`,
    )
    .get(...memoryValues(w, "conversation")) as { id: number } | undefined;
  // 넣은 행과 갈아 끼운 행 중 어느 쪽이든 그 행의 id가 필요하다. lastInsertRowid는 갈아 끼울
  // 때 값이 서지 않고 태그를 넣는 것 같은 다른 쓰기에 밀리기도 해서, 문장이 돌려주는 값을 쓴다.
  return r ? r.id : memoryIdOf(w, "conversation");
};

// 캐릭터를 만드는 배치만 쓰는 자리다. 여기서 한 번 넣은 행은 뒤에 아무도 고치지 않는다.
export const insertCreationMemory = (w: MemoryWrite): number => {
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO memory_items (${MEMORY_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(...memoryValues(w, "creation")) as { id: number } | undefined;
  // 같은 키가 이미 있으면 아무것도 넣지 않고 돌려주는 행도 없다 — 그때는 있던 행의 id를 찾는다.
  return r ? r.id : memoryIdOf(w, "creation");
};

// 태그로 찾아 프롬프트에 넣은 기억에 그 사실을 적어 둔다. 오래 꺼내지 않은 기억을 골라
// 응축할 때 쓸 값이라, 답장 한 번이 느려지지 않게 검색한 뒤 한 번에 세운다.
export const markMemoriesRetrieved = (ids: number[], at: string): void => {
  if (!ids.length) return;
  const upd = db.prepare(
    `UPDATE memory_items SET last_retrieved_at = ?, retrieval_count = retrieval_count + 1 WHERE id = ?`,
  );
  db.transaction(() => {
    for (const id of ids) upd.run(at, id);
  })();
};

export const getMemoryItemById = (id: number): MemoryRow | undefined =>
  db.prepare(`SELECT * FROM memory_items WHERE id = ?`).get(id) as
    MemoryRow | undefined;

export const listMemoryItems = (
  characterId: number,
  itemType?: MemoryItemType,
): MemoryRow[] =>
  db
    .prepare(
      itemType
        ? `SELECT * FROM memory_items WHERE character_id = ? AND item_type = ? ORDER BY updated_at DESC`
        : `SELECT * FROM memory_items WHERE character_id = ? ORDER BY updated_at DESC`,
    )
    .all(
      ...(itemType ? [characterId, itemType] : [characterId]),
    ) as MemoryRow[];

// 일이 끝나면 키에서 저장 항목만 바뀐다(진행 중인 일 → 사실). 나머지 키는 그대로 두어
// 이어 온 내용이 끊기지 않게 한다. 옮긴 자리에 같은 키가 이미 있으면 그쪽 내용을 갈아 끼운다.
//
// 옮긴 결과는 언제나 대화로 쌓인 행이다. 캐릭터를 만들 때 정한 행을 옮기면 그 행은 자리에
// 그대로 두고 태그만 새 행에 복사한다 — 만들 때 정한 값은 지우지 않는다.
export const moveMemoryItemType = (
  id: number,
  itemType: MemoryItemType,
  updatedAt: string,
): number => {
  const cur = getMemoryItemById(id);
  if (!cur) return id;
  const moved = upsertMemoryItem({
    characterId: cur.character_id,
    itemType,
    owner: cur.owner,
    area: cur.area,
    subject: cur.subject,
    value: cur.value,
    userKnows: cur.user_knows,
    relation: cur.relation,
    contactMode: cur.contact_mode,
    region: cur.region,
    lastMentionedAt: cur.last_mentioned_at,
    endCondition: cur.end_condition,
    interest: cur.interest,
    updatedAt,
  });
  if (moved === id) return moved;
  if (cur.origin === "creation") {
    db.prepare(
      `INSERT OR IGNORE INTO tags (character_id, kind, ref_id, tag)
       SELECT character_id, 'memory', ?, tag FROM tags WHERE kind = 'memory' AND ref_id = ?`,
    ).run(moved, id);
    return moved;
  }
  db.prepare(
    `UPDATE tags SET ref_id = ? WHERE kind = 'memory' AND ref_id = ?`,
  ).run(moved, id);
  db.prepare(`DELETE FROM memory_items WHERE id = ?`).run(id);
  return moved;
};

export type TagKind = "memory" | "diary" | "schedule";

// 태그는 통째로 갈아 끼운다 — 내용이 바뀌면 붙일 태그도 달라진다.
export const setTags = (
  characterId: number,
  kind: TagKind,
  refId: number,
  tags: string[],
): void => {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO tags (character_id, kind, ref_id, tag) VALUES (?, ?, ?, ?)`,
  );
  db.transaction(() => {
    db.prepare(`DELETE FROM tags WHERE kind = ? AND ref_id = ?`).run(
      kind,
      refId,
    );
    for (const t of tags) {
      const v = t.trim();
      if (v) ins.run(characterId, kind, refId, v);
    }
  })();
};

export const getTags = (kind: TagKind, refId: number): string[] =>
  (
    db
      .prepare(
        `SELECT tag FROM tags WHERE kind = ? AND ref_id = ? ORDER BY tag`,
      )
      .all(kind, refId) as { tag: string }[]
  ).map((r) => r.tag);

// 태그가 겹치는 대상을 찾는다. 몇 개나 겹쳤는지(hits)를 같이 주어 memory.ts가 순서를 매긴다.
export const findRefsByTags = (
  characterId: number,
  kind: TagKind,
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

/** 이 캐릭터에 붙어 있는 태그 이름 전부. 유저 발화에서 태그를 골라낼 때 쓴다. */
export const listTagNames = (characterId: number): string[] =>
  (
    db
      .prepare(
        `SELECT DISTINCT tag FROM tags WHERE character_id = ? ORDER BY tag`,
      )
      .all(characterId) as { tag: string }[]
  ).map((r) => r.tag);

export const listAreas = (
  characterId: number,
): { name: string; note: string | null }[] =>
  db
    .prepare(
      `SELECT name, note FROM areas WHERE character_id = ? ORDER BY rowid`,
    )
    .all(characterId) as { name: string; note: string | null }[];

export const upsertArea = (
  characterId: number,
  name: string,
  note?: string | null,
): void => {
  db.prepare(
    `INSERT INTO areas (character_id, name, note) VALUES (?, ?, ?)
     ON CONFLICT (character_id, name) DO UPDATE SET note = coalesce(excluded.note, areas.note)`,
  ).run(characterId, name, note ?? null);
};

// ── 오늘 메모 ─────────────────────────────────────────────────────────────
// 대화 중에 저장 항목·키를 판정하지 않고 그날 있었던 일을 그대로 적어 두는 자리.
// 새벽 정리가 이걸 읽어 기억으로 옮기고, 그날이 지나면 다시 보지 않는다.

export const addTodayNote = (
  characterId: number,
  createdAt: string,
  note: string,
  messageId?: number | null,
): void => {
  db.prepare(
    `INSERT INTO today_notes (character_id, created_at, note, message_id) VALUES (?, ?, ?, ?)`,
  ).run(characterId, createdAt, note, messageId ?? null);
};

// 메모를 그 메모가 딸린 캐릭터 발화 번호로 찾는 표. 대화 기록을 모델에 넘길 때 그 턴에
// 실제로 적은 메모를 함께 적는 데 쓴다(이슈 #346). 번호가 없는 행은 빠진다 — 이 컬럼을
// 채우기 전에 쌓인 메모와, 답장 밖에서 적은 메모가 그렇다.
export const getNotesByMessage = (
  characterId: number,
  since: string,
): Map<number, string> =>
  new Map(
    (
      db
        .prepare(
          `SELECT message_id, note FROM today_notes
            WHERE character_id = ? AND created_at >= ? AND message_id IS NOT NULL
            ORDER BY id`,
        )
        .all(characterId, since) as { message_id: number; note: string }[]
    ).map((r) => [r.message_id, r.note]),
  );

export const getTodayNotes = (
  characterId: number,
  since: string,
): { created_at: string; note: string }[] =>
  db
    .prepare(
      `SELECT created_at, note FROM today_notes
        WHERE character_id = ? AND created_at >= ? ORDER BY id`,
    )
    .all(characterId, since) as { created_at: string; note: string }[];

// 하루치를 지운다 — 새벽 정리가 그 하루의 메모를 기억으로 옮긴 뒤에 부른다.
// 창을 양쪽으로 닫는 것이 중요하다: 위를 열어 두면 경계(05:00) 뒤에 적힌 오늘 메모까지
// 지워져, 새벽 정리가 도는 사이에 나눈 대화의 메모가 프롬프트에서 사라진다.
export const clearTodayNotes = (
  characterId: number,
  since: string,
  until: string,
): number =>
  db
    .prepare(
      `DELETE FROM today_notes
        WHERE character_id = ? AND created_at >= ? AND created_at < ?`,
    )
    .run(characterId, since, until).changes;

// ── 오늘 실제 ─────────────────────────────────────────────────────────────
// 각본과 달라진 블록만 남긴다: 하려던 것 · 어떻게 됐나 · 왜.

export interface DayActualRow {
  id: number;
  date: string;
  block_start: string | null;
  intended: string;
  outcome: string;
  reason: string | null;
  recorded_at: string;
}

export const recordDayActual = (
  characterId: number,
  date: string,
  blockStart: string | null,
  intended: string,
  outcome: string,
  reason: string | null,
  recordedAt: string,
): void => {
  db.prepare(
    `INSERT INTO day_actuals (character_id, date, block_start, intended, outcome, reason, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(characterId, date, blockStart, intended, outcome, reason, recordedAt);
};

export const getDayActuals = (
  characterId: number,
  date: string,
): DayActualRow[] =>
  db
    .prepare(
      `SELECT id, date, block_start, intended, outcome, reason, recorded_at
         FROM day_actuals WHERE character_id = ? AND date = ? ORDER BY id`,
    )
    .all(characterId, date) as DayActualRow[];
