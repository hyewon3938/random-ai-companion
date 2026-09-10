// 관계가 쌓이면서 늘어나는 표 넷의 저장 함수.
//
// 처음(firsts)은 이 관계에서 한 번만 일어나는 일을 종류마다 한 행으로 남기고, 반응 점수
// (reaction_scores)는 캐릭터가 쓴 플러팅을 유저가 어떻게 받았는지를 대화방 단위로 누적한다.
// 관계 의도(relationship_intents)는 새벽 정리가 오늘 하려는 것을 하루 한 행으로 적고,
// 열림 신호(relationship_signals)는 답장마다 도는 판정 호출이 턴 하나에 한 행을 적는다.
//
// 어느 단계에서 어느 플러팅을 쓰는지, 무엇을 세어 단계를 올리는지 같은 규칙은 프롬프트와 새벽
// 정리가 갖는다 — 여기는 행을 넣고 빼는 자리다. 관계 한 행(단계·말투·서술 항목)은 같은
// 폴더의 characters.ts에 있다.

import { db } from "./connection.js";
import { getKstNow, kstDateString } from "../kst.js";
import type {
  FirstBy,
  FirstKind,
  LeadTone,
  Move,
  MoveReaction,
} from "../labels.js";

// ── 처음 ───────────────────────────────────────────────────────────────────
// 답장 경로가 신호를 받아 미확정으로 넣고, 새벽 정리가 어제 대화와 견줘 확정하거나 지운다.
// 캐릭터마다 종류당 한 행이라 두 번째로 들어오는 같은 종류는 조용히 버린다.

export interface FirstRow {
  id: number;
  character_id: number;
  chat_id: string;
  kind: FirstKind;
  by: FirstBy;
  happened_at: string;
  message_id: number | null;
  call_id: number | null;
  confirmed: number;
}

export interface FirstInput {
  characterId: number;
  chatId: string;
  kind: FirstKind;
  by: FirstBy;
  happenedAt: string;
  messageId?: number;
  callId?: number;
}

/** 미확정 처음 한 건을 넣는다. 그 종류가 이미 있으면 아무것도 하지 않고 undefined. */
export const insertFirst = (v: FirstInput): number | undefined => {
  const row = db
    .prepare(
      `INSERT INTO firsts
         (character_id, chat_id, kind, by, happened_at, message_id, call_id, confirmed)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT (character_id, kind) DO NOTHING
       RETURNING id`,
    )
    .get(
      v.characterId,
      v.chatId,
      v.kind,
      v.by,
      v.happenedAt,
      v.messageId ?? null,
      v.callId ?? null,
    ) as { id: number } | undefined;
  return row?.id;
};

/** 확정된 처음 전부. 프롬프트가 무엇을 이미 했는지 보는 자리라 오래된 것부터 준다. */
export const getConfirmedFirsts = (characterId: number): FirstRow[] =>
  db
    .prepare(
      `SELECT * FROM firsts
        WHERE character_id = ? AND confirmed = 1
        ORDER BY happened_at`,
    )
    .all(characterId) as FirstRow[];

/** 아직 확정하지 않은 처음. 새벽 정리가 어제 대화와 견주려고 읽는다. */
export const getUnconfirmedFirsts = (characterId: number): FirstRow[] =>
  db
    .prepare(
      `SELECT * FROM firsts
        WHERE character_id = ? AND confirmed = 0
        ORDER BY happened_at`,
    )
    .all(characterId) as FirstRow[];

export const hasFirst = (characterId: number, kind: FirstKind): boolean =>
  db
    .prepare(`SELECT 1 FROM firsts WHERE character_id = ? AND kind = ?`)
    .get(characterId, kind) !== undefined;

export const confirmFirst = (id: number): void => {
  db.prepare(`UPDATE firsts SET confirmed = 1 WHERE id = ?`).run(id);
};

/** 새벽 정리가 어제 대화에서 근거를 못 찾은 미확정 행을 지운다. 확정된 행은 지우지 않는다. */
export const deleteUnconfirmedFirst = (id: number): void => {
  db.prepare(`DELETE FROM firsts WHERE id = ? AND confirmed = 0`).run(id);
};

// ── 반응 점수 ──────────────────────────────────────────────────────────────
// 키가 대화방과 플러팅이라서 캐릭터를 바꿔도 남는다 — 무엇에 반응하는지는 캐릭터가 아니라
// 유저 쪽 성질이다. 점수를 어떻게 계산하는지는 새벽 정리가 갖는다.

export interface ReactionScoreRow {
  chat_id: string;
  move: Move;
  score: number;
  sample_count: number;
  updated_at: string;
}

export const getReactionScores = (chatId: string): ReactionScoreRow[] =>
  db
    .prepare(
      `SELECT * FROM reaction_scores WHERE chat_id = ? ORDER BY score DESC, move`,
    )
    .all(chatId) as ReactionScoreRow[];

export const saveReactionScore = (
  chatId: string,
  move: Move,
  score: number,
  sampleCount: number,
  now: string,
): void => {
  db.prepare(
    `INSERT INTO reaction_scores (chat_id, move, score, sample_count, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (chat_id, move) DO UPDATE SET
       score = excluded.score,
       sample_count = excluded.sample_count,
       updated_at = excluded.updated_at`,
  ).run(chatId, move, score, sampleCount, now);
};

// ── 오늘의 관계 의도 ───────────────────────────────────────────────────────
// 새벽 정리가 하루 한 행을 쓰고 답장 프롬프트와 선톡이 읽는다. 오늘 메모와 달리 다음 새벽
// 정리가 비우지 않고 보관 기간이 지날 때 지운다.

export interface RelationshipIntentRow {
  id: number;
  character_id: number;
  date: string;
  dig: string | null;
  share: string | null;
  move: Move | null;
  move_note: string | null;
  lead_tone: LeadTone | null;
  thread: string | null;
  basis_json: string | null;
  created_at: string;
}

export interface RelationshipIntentInput {
  dig?: string;
  share?: string;
  move?: Move;
  moveNote?: string;
  leadTone?: LeadTone;
  thread?: string;
  basisJson?: string;
}

export const getRelationshipIntent = (
  characterId: number,
  date: string,
): RelationshipIntentRow | undefined =>
  db
    .prepare(
      `SELECT * FROM relationship_intents WHERE character_id = ? AND date = ?`,
    )
    .get(characterId, date) as RelationshipIntentRow | undefined;

/** 하루 한 행. 같은 날짜로 다시 부르면 통째로 덮어쓴다 — 새벽 정리를 다시 돌린 경우다. */
export const saveRelationshipIntent = (
  characterId: number,
  date: string,
  v: RelationshipIntentInput,
  now: string,
): void => {
  db.prepare(
    `INSERT INTO relationship_intents
       (character_id, date, dig, share, move, move_note, lead_tone, thread,
        basis_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (character_id, date) DO UPDATE SET
       dig = excluded.dig,
       share = excluded.share,
       move = excluded.move,
       move_note = excluded.move_note,
       lead_tone = excluded.lead_tone,
       thread = excluded.thread,
       basis_json = excluded.basis_json,
       created_at = excluded.created_at`,
  ).run(
    characterId,
    date,
    v.dig ?? null,
    v.share ?? null,
    v.move ?? null,
    v.moveNote ?? null,
    v.leadTone ?? null,
    v.thread ?? null,
    v.basisJson ?? null,
    now,
  );
};

export const RELATIONSHIP_INTENT_RETENTION_DAYS = 30;

/** 보관 기간이 지난 의도 행을 지우고 지운 행 수를 준다. 오늘 것과 어제 것은 답장 프롬프트와
 * 새벽 정리가 읽으므로 기간을 하루 이틀로 줄이지 않는다. */
export const pruneRelationshipIntents = (
  days: number = RELATIONSHIP_INTENT_RETENTION_DAYS,
): number => {
  const cutoff = kstDateString(
    new Date(getKstNow().getTime() - days * 86400000),
  );
  return db
    .prepare(`DELETE FROM relationship_intents WHERE date < ?`)
    .run(cutoff).changes;
};

// ── 열림 신호 ──────────────────────────────────────────────────────────────
// 답장마다 도는 판정 호출이 턴 하나에 한 행을 적는다. 판정이 실패한 턴은 행이 없다 —
// 세는 쪽은 있는 행만 보고, 없는 턴을 0으로 치지 않는다.

export interface RelationshipSignalRow {
  id: number;
  character_id: number;
  chat_id: string;
  at: string;
  message_id: number | null;
  opened_self: number;
  asked_about_char: number;
  said_affection: number;
  prev_move: Move | null;
  move_reaction: MoveReaction | null;
  call_id: number | null;
}

export interface RelationshipSignalInput {
  characterId: number;
  chatId: string;
  at: string;
  openedSelf: boolean;
  askedAboutChar: boolean;
  saidAffection: boolean;
  messageId?: number;
  prevMove?: Move;
  moveReaction?: MoveReaction;
  callId?: number;
}

export const insertRelationshipSignal = (
  v: RelationshipSignalInput,
): number => {
  const row = db
    .prepare(
      `INSERT INTO relationship_signals
         (character_id, chat_id, at, message_id, opened_self, asked_about_char,
          said_affection, prev_move, move_reaction, call_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      v.characterId,
      v.chatId,
      v.at,
      v.messageId ?? null,
      v.openedSelf ? 1 : 0,
      v.askedAboutChar ? 1 : 0,
      v.saidAffection ? 1 : 0,
      v.prevMove ?? null,
      v.moveReaction ?? null,
      v.callId ?? null,
    ) as { id: number };
  return row.id;
};

/** 마지막으로 나간 답장 뒤에 적힌 이 대화의 신호 행을 지운다. 만들어 둔 답장이 폐기되고 다시
 * 만들어질 때 앞선 행을 걷어 한 유저 턴에 1행을 지킨다. since가 없으면(아직 나간 답장이 없으면)
 * 이 대화의 행 전부다. 지운 수를 돌려준다. */
export const deleteRelationshipSignalsAfter = (
  characterId: number,
  chatId: string,
  since: string | null,
): number =>
  since === null
    ? db
        .prepare(
          `DELETE FROM relationship_signals WHERE character_id = ? AND chat_id = ?`,
        )
        .run(characterId, chatId).changes
    : db
        .prepare(
          `DELETE FROM relationship_signals
            WHERE character_id = ? AND chat_id = ? AND at > ?`,
        )
        .run(characterId, chatId, since).changes;

/** 두 시각 사이의 신호. 새벽 정리가 어제치를 세어 문턱을 재고 반응 점수의 표본으로 쓴다.
 * from은 포함, to는 제외한다. */
export const getRelationshipSignals = (
  characterId: number,
  from: string,
  to: string,
): RelationshipSignalRow[] =>
  db
    .prepare(
      `SELECT * FROM relationship_signals
        WHERE character_id = ? AND at >= ? AND at < ?
        ORDER BY at`,
    )
    .all(characterId, from, to) as RelationshipSignalRow[];
