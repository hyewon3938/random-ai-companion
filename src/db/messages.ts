// 대화 기록 표의 저장·조회 함수와 답장 복구 표시.
//
// 메시지 행을 넣고 최근 것을 꺼내는 자리다. 넣을 때 그 행의 번호를 돌려주는 이유는 오늘
// 메모다 — 메모는 답장 하나에 딸리므로, 어느 답장에 적은 메모인지를 그 번호로 잇는다
// (이슈 #346). 캐릭터 말의 meta_json을 패턴으로 세는 함수는
// 패턴을 인자로 받기만 한다 — 무엇을 선톡으로 치는지는 proactive-policy.ts가 정한다.
//
// 읽는 함수는 전부 대화방과 캐릭터를 함께 받는다. 같은 대화방에서 캐릭터를 바꾸면 행은
// 그대로 남으므로, 대화방만으로 거르면 새 캐릭터가 앞 캐릭터의 대화를 자기 것으로 읽는다.
// 대화방을 조건에 남겨 두는 것은 인덱스가 (chat_id, sent_at)이라서다.

import { db } from "./connection.js";

export interface MessageRow {
  id: number;
  role: string;
  text: string;
  sent_at: string;
}

export const logMessage = (
  chatId: string,
  characterId: number | null,
  role: "user" | "assistant",
  text: string,
  sentAt: string,
  meta?: Record<string, unknown>,
): number => {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO messages (chat_id, character_id, sent_at, role, text, meta_json) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      chatId,
      characterId,
      sentAt,
      role,
      text,
      meta ? JSON.stringify(meta) : null,
    );
  return Number(lastInsertRowid);
};

export const getRecentMessages = (
  chatId: string,
  characterId: number,
  limit: number,
): MessageRow[] => {
  const rows = db
    .prepare(
      `SELECT id, role, text, sent_at FROM messages
        WHERE chat_id = ? AND character_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(chatId, characterId, limit) as MessageRow[];
  return rows.reverse();
};

// 특정 시각 이전의 마지막 메시지 — '직전에 대화한 날'을 세는 데 쓴다.
// 어느 구간 안 캐릭터의 마지막 말 시각. 어젯밤 몇 시까지 깨어 있었는지 잰다(이슈 #289).
export const lastCharMessageTsBetween = (
  chatId: string,
  characterId: number,
  from: string,
  to: string,
): string | null =>
  (
    db
      .prepare(
        `SELECT sent_at FROM messages
          WHERE chat_id = ? AND character_id = ? AND role = 'assistant'
            AND sent_at >= ? AND sent_at < ? ORDER BY id DESC LIMIT 1`,
      )
      .get(chatId, characterId, from, to) as { sent_at: string } | undefined
  )?.sent_at ?? null;

export const lastMessageBefore = (
  chatId: string,
  characterId: number,
  before: string,
): MessageRow | undefined =>
  db
    .prepare(
      `SELECT id, role, text, sent_at FROM messages
        WHERE chat_id = ? AND character_id = ? AND sent_at < ?
        ORDER BY id DESC LIMIT 1`,
    )
    .get(chatId, characterId, before) as MessageRow | undefined;

// 유저가 다시 말을 건 자리 — sinceTs 뒤 유저의 첫 말과, 그 앞에서 캐릭터가 마지막으로 한 말.
// 그 둘 사이가 연락 텀이다(이슈 #284). 캐릭터 말을 먼저 찾지 않고 유저 말부터 찾는 이유는
// 대화가 이어지는 동안에도 절을 잠깐 남겨 두기 위해서다(이슈 #316) — 유저가 30분 전에 말을
// 건 뒤로 몇 마디가 오갔어도 그 재개 지점이 계속 나온다. 창 안에 유저 말이 없으면 값이 없다.
export const reopenedGap = (
  chatId: string,
  characterId: number,
  sinceTs: string,
): { lastChar: string; firstUser: string } | undefined => {
  const u = db
    .prepare(
      `SELECT id FROM messages
        WHERE chat_id = ? AND character_id = ? AND role = 'user' AND sent_at >= ?
        ORDER BY id ASC LIMIT 1`,
    )
    .get(chatId, characterId, sinceTs) as { id: number } | undefined;
  if (!u) return undefined;
  const last = db
    .prepare(
      `SELECT id, sent_at FROM messages
        WHERE chat_id = ? AND character_id = ? AND role = 'assistant' AND id < ?
        ORDER BY id DESC LIMIT 1`,
    )
    .get(chatId, characterId, u.id) as
    { id: number; sent_at: string } | undefined;
  if (!last) return undefined;
  // 유저가 연달아 보낸 말은 첫 통이 기준이다 — 창 안에 든 말이 그중 두 번째일 수 있다.
  const first = db
    .prepare(
      `SELECT sent_at FROM messages
        WHERE chat_id = ? AND character_id = ? AND role = 'user' AND id > ?
        ORDER BY id ASC LIMIT 1`,
    )
    .get(chatId, characterId, last.id) as { sent_at: string } | undefined;
  return first
    ? { lastChar: last.sent_at, firstUser: first.sent_at }
    : undefined;
};

export const hasUserMessageSince = (
  chatId: string,
  characterId: number,
  since: string,
): boolean =>
  !!db
    .prepare(
      `SELECT 1 FROM messages
        WHERE chat_id = ? AND character_id = ? AND role = 'user' AND sent_at >= ?
        LIMIT 1`,
    )
    .get(chatId, characterId, since);

// 유저가 마지막으로 말한 시각 — 선톡 셋(근황·밤 인사·자리비움)이 무응답 시간을 재는 기준.
export const lastUserTs = (
  chatId: string,
  characterId: number,
): string | undefined =>
  (
    db
      .prepare(
        `SELECT sent_at FROM messages
          WHERE chat_id = ? AND character_id = ? AND role = 'user'
          ORDER BY id DESC LIMIT 1`,
      )
      .get(chatId, characterId) as { sent_at: string } | undefined
  )?.sent_at;

// 캐릭터가 마지막으로 말한 시각 — 자리 비움 복귀 인사가 침묵 길이를 재는 기준.
export const lastAssistantTs = (
  chatId: string,
  characterId: number,
): string | undefined =>
  (
    db
      .prepare(
        `SELECT sent_at FROM messages
          WHERE chat_id = ? AND character_id = ? AND role = 'assistant'
          ORDER BY id DESC LIMIT 1`,
      )
      .get(chatId, characterId) as { sent_at: string } | undefined
  )?.sent_at;

export interface LastMessageRow {
  sent_at: string;
  role: string;
  text: string;
  meta_json: string | null;
}

// 마지막 메시지(유저·캐릭 무관)의 시각·역할·본문 — 침묵 팔로업 판단용
export const lastMessage = (
  chatId: string,
  characterId: number,
): LastMessageRow | undefined =>
  db
    .prepare(
      `SELECT sent_at, role, text, meta_json FROM messages
        WHERE chat_id = ? AND character_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(chatId, characterId) as LastMessageRow | undefined;

// 최근 메시지의 역할과 시각만, 오래된 것부터. 유저가 이어 보내는 텀을 재는 데 쓴다(reply-timing.ts).
// 한 논리일 창(시작 포함, 끝 미포함)의 대화. 새벽 정리가 어제 하루치를 읽는다.
export const getMessagesBetween = (
  chatId: string,
  characterId: number,
  from: string,
  to: string,
): { role: string; sent_at: string; text: string }[] =>
  db
    .prepare(
      `SELECT role, sent_at, text FROM messages
        WHERE chat_id = ? AND character_id = ? AND sent_at >= ? AND sent_at < ?
        ORDER BY id`,
    )
    .all(chatId, characterId, from, to) as {
    role: string;
    sent_at: string;
    text: string;
  }[];

export const hasMessageBetween = (
  chatId: string,
  characterId: number,
  from: string,
  to: string,
): boolean =>
  !!db
    .prepare(
      `SELECT 1 FROM messages
        WHERE chat_id = ? AND character_id = ? AND sent_at >= ? AND sent_at < ?
        LIMIT 1`,
    )
    .get(chatId, characterId, from, to);

export const recentMessageTimes = (
  chatId: string,
  characterId: number,
  limit: number,
): { role: string; sent_at: string }[] => {
  const rows = db
    .prepare(
      `SELECT role, sent_at FROM messages
        WHERE chat_id = ? AND character_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(chatId, characterId, limit) as { role: string; sent_at: string }[];
  return rows.reverse();
};

// 최근 답장 본문, 최신부터. 선톡(아침 안부·팔로업·자리비움)은 빼고 실제 대화 답장만 —
// 말투 높낮이를 재는 데 쓴다(speech-level.ts).
export const recentReplyTexts = (
  chatId: string,
  characterId: number,
  limit: number,
): string[] =>
  (
    db
      .prepare(
        `SELECT text FROM messages
          WHERE chat_id = ? AND character_id = ? AND role = 'assistant'
       AND (meta_json IS NULL OR json_extract(meta_json,'$.kind') IN ('reply','recover'))
       ORDER BY id DESC LIMIT ?`,
      )
      .all(chatId, characterId, limit) as { text: string }[]
  ).map((r) => r.text);

/** 캐릭터 말 가운데 meta_json이 패턴에 맞는 것을 고르는 조건.
 *  after가 참이면 since 뒤(>), 아니면 since부터(>=)다. */
export interface AssistantMetaFilter {
  after?: boolean;
  like?: string[];
  notLike?: string[];
}

const assistantMetaWhere = (
  chatId: string,
  characterId: number,
  since: string,
  f: AssistantMetaFilter,
): { sql: string; params: (string | number)[] } => {
  const parts = [
    `chat_id = ? AND character_id = ? AND role = 'assistant' AND sent_at ${f.after ? ">" : ">="} ?`,
  ];
  const params: (string | number)[] = [chatId, characterId, since];
  for (const p of f.like ?? []) {
    parts.push("meta_json LIKE ?");
    params.push(p);
  }
  for (const p of f.notLike ?? []) {
    parts.push("meta_json NOT LIKE ?");
    params.push(p);
  }
  return { sql: parts.join(" AND "), params };
};

export const countAssistantMeta = (
  chatId: string,
  characterId: number,
  since: string,
  f: AssistantMetaFilter,
): number => {
  const w = assistantMetaWhere(chatId, characterId, since, f);
  return (
    db
      .prepare(`SELECT count(*) c FROM messages WHERE ${w.sql}`)
      .get(...w.params) as {
      c: number;
    }
  ).c;
};

export const hasAssistantMeta = (
  chatId: string,
  characterId: number,
  since: string,
  f: AssistantMetaFilter,
): boolean => {
  const w = assistantMetaWhere(chatId, characterId, since, f);
  return !!db
    .prepare(`SELECT 1 FROM messages WHERE ${w.sql} LIMIT 1`)
    .get(...w.params);
};

// 복구 워터마크: "이 유저 메시지에는 답장 책임을 졌다"는 표시. 재시작(배포)으로 답장을 보냈지만
// 로그 전에 프로세스가 죽어도, 다음 부팅의 복구가 같은 메시지에 또 답하지 않도록 막는다.
// 대화방 하나에 한 행이라 캐릭터를 가리지 않는다 — 표시가 시각이고 앞으로만 가서, 캐릭터를
// 바꿔도 앞 캐릭터의 메시지에 다시 답하지는 않는다.
export const getRecoveryMark = (chatId: string): string | undefined =>
  (
    db
      .prepare(`SELECT replied_up_to FROM recovery_marks WHERE chat_id = ?`)
      .get(chatId) as { replied_up_to: string } | undefined
  )?.replied_up_to;

export const setRecoveryMark = (chatId: string, repliedUpTo: string): void => {
  db.prepare(
    `INSERT OR REPLACE INTO recovery_marks (chat_id, replied_up_to) VALUES (?, ?)`,
  ).run(chatId, repliedUpTo);
};
