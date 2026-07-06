import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  bible_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS relationships (
  character_id INTEGER PRIMARY KEY REFERENCES characters(id),
  met_at TEXT NOT NULL,
  state_json TEXT NOT NULL,
  last_contact_at TEXT
);
CREATE TABLE IF NOT EXISTS user_preferences (
  chat_id TEXT PRIMARY KEY,
  pref_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS diary_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL REFERENCES characters(id),
  date TEXT NOT NULL,
  entry_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  character_id INTEGER,
  ts TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  meta_json TEXT
);
`);

export interface CharacterRow {
  id: number;
  chat_id: string;
  status: string;
  bible_json: string;
  created_at: string;
}

export interface MessageRow {
  id: number;
  role: string;
  text: string;
  ts: string;
}

// 관계 상태. 교체 시 이 레이어가 통째로 죽는다 — 스위칭 코스트의 실체
export interface RelationshipState {
  user_facts: { fact: string; learned_at: string }[];
  frames: { frame: string; note: string }[];
  open_loops: {
    id: number;
    content: string;
    due_hint: string | null;
    status: "open" | "asked" | "resolved";
    created_at: string;
  }[];
  our_dict: { expression: string; origin: string; first_used: string }[];
  farewell: { date: string; type: "작별" | "잠수" } | null;
}

export const emptyRelationshipState = (): RelationshipState => ({
  user_facts: [],
  frames: [],
  open_loops: [],
  our_dict: [],
  farewell: null,
});

export const getActiveCharacter = (chatId: string): CharacterRow | undefined =>
  db
    .prepare(
      `SELECT * FROM characters WHERE chat_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`,
    )
    .get(chatId) as CharacterRow | undefined;

export const insertCharacter = (
  chatId: string,
  bibleJson: string,
  now: string,
): number => {
  const result = db
    .prepare(
      `INSERT INTO characters (chat_id, status, bible_json, created_at) VALUES (?, 'active', ?, ?)`,
    )
    .run(chatId, bibleJson, now);
  const characterId = Number(result.lastInsertRowid);
  db.prepare(
    `INSERT INTO relationships (character_id, met_at, state_json) VALUES (?, ?, ?)`,
  ).run(characterId, now, JSON.stringify(emptyRelationshipState()));
  return characterId;
};

export const getRelationshipState = (
  characterId: number,
): RelationshipState => {
  const row = db
    .prepare(`SELECT state_json FROM relationships WHERE character_id = ?`)
    .get(characterId) as { state_json: string } | undefined;
  return row
    ? (JSON.parse(row.state_json) as RelationshipState)
    : emptyRelationshipState();
};

export const saveRelationshipState = (
  characterId: number,
  state: RelationshipState,
  now: string,
): void => {
  db.prepare(
    `UPDATE relationships SET state_json = ?, last_contact_at = ? WHERE character_id = ?`,
  ).run(JSON.stringify(state), now, characterId);
};

export const getMetAt = (characterId: number): string | undefined => {
  const row = db
    .prepare(`SELECT met_at FROM relationships WHERE character_id = ?`)
    .get(characterId) as { met_at: string } | undefined;
  return row?.met_at;
};

export const logMessage = (
  chatId: string,
  characterId: number | null,
  role: "user" | "char" | "system",
  text: string,
  ts: string,
  meta?: Record<string, unknown>,
): void => {
  db.prepare(
    `INSERT INTO messages (chat_id, character_id, ts, role, text, meta_json) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    chatId,
    characterId,
    ts,
    role,
    text,
    meta ? JSON.stringify(meta) : null,
  );
};

export const getRecentMessages = (
  chatId: string,
  limit: number,
): MessageRow[] => {
  const rows = db
    .prepare(
      `SELECT id, role, text, ts FROM messages WHERE chat_id = ? AND role IN ('user','char') ORDER BY id DESC LIMIT ?`,
    )
    .all(chatId, limit) as MessageRow[];
  return rows.reverse();
};

export const getRecentDiaries = (
  characterId: number,
  limit: number,
): { date: string; entry_json: string }[] => {
  const rows = db
    .prepare(
      `SELECT date, entry_json FROM diary_entries WHERE character_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(characterId, limit) as { date: string; entry_json: string }[];
  return rows.reverse();
};
