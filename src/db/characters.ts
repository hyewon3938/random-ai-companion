// 캐릭터·관계·유저 프로필 표의 저장 함수.
//
// 캐릭터 행은 생성 때 한 번 넣고 상태만 바뀐다. 관계 행은 생성 배치가 첫 값을 채우고
// 새벽 정리가 항목별로 고쳐 쓴다. 유저 프로필은 chat_id 기준이라 캐릭터가 바뀌어도 남는다.

import { db } from "./connection.js";
import type { SpeechLevel } from "../labels.js";

export interface CharacterRow {
  id: number;
  chat_id: string;
  status: string;
  genesis_json: string;
  created_at: string;
}

// 캐릭터 번호만 아는 자리(각본 생성)에서 대화방을 찾는다.
export const getCharacterChatId = (characterId: number): string | null =>
  (
    db
      .prepare(`SELECT chat_id FROM characters WHERE id = ?`)
      .get(characterId) as { chat_id: string } | undefined
  )?.chat_id ?? null;

export const getActiveCharacter = (chatId: string): CharacterRow | undefined =>
  db
    .prepare(
      `SELECT * FROM characters WHERE chat_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`,
    )
    .get(chatId) as CharacterRow | undefined;

export const insertCharacter = (
  chatId: string,
  genesisJson: string,
  now: string,
): number => {
  const result = db
    .prepare(
      `INSERT INTO characters (chat_id, status, genesis_json, created_at) VALUES (?, 'active', ?, ?)`,
    )
    .run(chatId, genesisJson, now);
  const characterId = Number(result.lastInsertRowid);
  db.prepare(
    `INSERT INTO relationships (character_id, met_at) VALUES (?, ?)`,
  ).run(characterId, now);
  return characterId;
};

export const getMetAt = (characterId: number): string | undefined => {
  const row = db
    .prepare(`SELECT met_at FROM relationships WHERE character_id = ?`)
    .get(characterId) as { met_at: string } | undefined;
  return row?.met_at;
};

/** 생성 배치가 채우는 관계 첫 값. 일곱 항목 중 다섯 — 잘 통하는 것(rapport)과
 * 조심할 것(cautions)은 대화가 쌓여야 알 수 있어 비운 채 시작한다. */
export interface RelationshipFirstValues {
  stage: string;
  speechLevel: SpeechLevel;
  speechNote: string;
  addressTerms: string;
  history: string;
  feelings: string;
}

export const saveRelationshipFirstValues = (
  characterId: number,
  v: RelationshipFirstValues,
  now: string,
): void => {
  db.prepare(
    `UPDATE relationships SET
       stage = ?, speech_level = ?, speech_note = ?, address_terms = ?,
       history = ?, feelings = ?, updated_at = ?
     WHERE character_id = ?`,
  ).run(
    v.stage,
    v.speechLevel,
    v.speechNote,
    v.addressTerms,
    v.history,
    v.feelings,
    now,
    characterId,
  );
};

/** 관계 일곱 항목 컬럼을 그대로 읽는 행. 프롬프트 조립이 쓴다. */
export interface RelationshipRow {
  stage: string | null;
  speech_level: SpeechLevel | null;
  speech_note: string | null;
  address_terms: string | null;
  rapport: string | null;
  cautions: string | null;
  history: string | null;
  feelings: string | null;
  met_at: string | null;
  updated_at: string | null;
}

export const getRelationship = (
  characterId: number,
): RelationshipRow | undefined =>
  db
    .prepare(
      `SELECT stage, speech_level, speech_note, address_terms,
              rapport, cautions, history, feelings,
              met_at, updated_at
         FROM relationships WHERE character_id = ?`,
    )
    .get(characterId) as RelationshipRow | undefined;

/** 말투 값만 바꾼다. 반말이 된 뒤 존댓말로 되돌리지 않는 판단은 부르는 쪽 몫. */
export const setSpeechLevel = (
  characterId: number,
  level: SpeechLevel,
  now: string,
): void => {
  db.prepare(
    `UPDATE relationships SET speech_level = ?, updated_at = ? WHERE character_id = ?`,
  ).run(level, now, characterId);
};

/** 새벽 정리가 갱신하는 관계 서술 항목들. 준 항목만 바꾼다. */
export interface RelationshipNotes {
  stage?: string;
  speechNote?: string;
  addressTerms?: string;
  rapport?: string;
  cautions?: string;
  history?: string;
  feelings?: string;
}

const NOTE_COLUMNS: Record<keyof RelationshipNotes, string> = {
  stage: "stage",
  speechNote: "speech_note",
  addressTerms: "address_terms",
  rapport: "rapport",
  cautions: "cautions",
  history: "history",
  feelings: "feelings",
};

export const updateRelationshipNotes = (
  characterId: number,
  notes: RelationshipNotes,
  now: string,
): void => {
  const sets: string[] = [];
  const values: string[] = [];
  for (const [key, column] of Object.entries(NOTE_COLUMNS) as [
    keyof RelationshipNotes,
    string,
  ][]) {
    const v = notes[key];
    if (v === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(v);
  }
  if (!sets.length) return;
  db.prepare(
    `UPDATE relationships SET ${sets.join(", ")}, updated_at = ? WHERE character_id = ?`,
  ).run(...values, now, characterId);
};

// 캐릭터 프롬프트에 들어가는 유저 프로필. 캐릭터가 상대를 대하는 데 쓰는 공개 정보다.
// 값이 들어오는 길은 둘로 갈린다 — 성별은 env(USER_GENDER)나 가입 때 받고, 하는 일·사는
// 지역은 대화에서 분명히 드러나면 새벽 정리가 채운다(nightly.ts 추출 출력의 user_profile).
// chat_id 기준(교체돼도 유지) — 유저의 정체는 어떤 캐릭터를 만나든 그대로다.
// 나이대는 여기서 다루지 않는다 — 가입 때 받는 birth_year 하나에서 계산한다(getUserProfileFull).
// 이름도 다루지 않는다 — 호칭을 시스템이 강제하면 자리 잡은 반말을 격식체로 되돌리는 회귀가 났다(2026-07-12).
export interface StoredUserProfile {
  gender?: string;
  job?: string;
  region?: string;
}

export const getUserProfile = (chatId: string): StoredUserProfile => {
  const row = db
    .prepare(
      `SELECT gender, job, region FROM user_profile WHERE chat_id = ?`,
    )
    .get(chatId) as
    | {
        gender: string | null;
        job: string | null;
        region: string | null;
      }
    | undefined;
  if (!row) return {};
  return {
    gender: row.gender ?? undefined,
    job: row.job ?? undefined,
    region: row.region ?? undefined,
  };
};

// 온보딩이 채우는 컬럼까지 포함한 프로필 전체. 캐릭터 생성이 부르는 이름(서로 부르는 말·
// 첫 인사)과 하는 일·사는 지역(취향 접점 하나·거리 감각)을 읽는 데 쓴다.
export interface UserProfileFull {
  preferredName?: string;
  gender?: string;
  birthYear?: number;
  job?: string;
  region?: string;
}

export const getUserProfileFull = (chatId: string): UserProfileFull => {
  const row = db
    .prepare(
      `SELECT preferred_name, gender, birth_year, job, region FROM user_profile WHERE chat_id = ?`,
    )
    .get(chatId) as
    | {
        preferred_name: string | null;
        gender: string | null;
        birth_year: number | null;
        job: string | null;
        region: string | null;
      }
    | undefined;
  if (!row) return {};
  return {
    preferredName: row.preferred_name ?? undefined,
    gender: row.gender ?? undefined,
    birthYear: row.birth_year ?? undefined,
    job: row.job ?? undefined,
    region: row.region ?? undefined,
  };
};

// 새로 확실해진 값만 채운다 — 빈 값은 기존 값을 덮지 않는다(한번 안 건 유지).
export const saveUserProfile = (
  chatId: string,
  p: StoredUserProfile,
  at: string,
): void => {
  const cur = getUserProfile(chatId);
  const gender = p.gender?.trim() || cur.gender;
  const job = p.job?.trim() || cur.job;
  const region = p.region?.trim() || cur.region;
  db.prepare(
    // 이 함수가 맡은 컬럼만 고친다 — REPLACE로 행을 다시 넣으면 가입 때 받는
    // 이름·생년이 같이 지워진다.
    `INSERT INTO user_profile (chat_id, gender, job, region, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       gender = excluded.gender,
       job = excluded.job,
       region = excluded.region,
       updated_at = excluded.updated_at`,
  ).run(chatId, gender ?? null, job ?? null, region ?? null, at);
};
