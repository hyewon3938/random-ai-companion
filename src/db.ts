import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { getKstNow, kstDateString } from "./kst.js";

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
CREATE TABLE IF NOT EXISTS user_profile (
  chat_id TEXT PRIMARY KEY,
  gender TEXT,
  age_band TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS diary_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL REFERENCES characters(id),
  date TEXT NOT NULL,
  entry_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cast_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL REFERENCES characters(id),
  who TEXT NOT NULL DEFAULT 'char',
  name TEXT NOT NULL,
  relation TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS arcs (
  character_id INTEGER NOT NULL REFERENCES characters(id),
  horizon TEXT NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (character_id, horizon)
);
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL REFERENCES characters(id),
  who TEXT NOT NULL,
  date TEXT NOT NULL,
  time_hint TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS day_plans (
  character_id INTEGER NOT NULL REFERENCES characters(id),
  date TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'nightly',
  PRIMARY KEY (character_id, date)
);
CREATE TABLE IF NOT EXISTS day_seeds (
  character_id INTEGER NOT NULL REFERENCES characters(id),
  date TEXT NOT NULL,
  energy TEXT NOT NULL,
  wake_hint TEXT NOT NULL,
  mood TEXT NOT NULL,
  note TEXT,
  PRIMARY KEY (character_id, date)
);
CREATE TABLE IF NOT EXISTS scheduled_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL REFERENCES characters(id),
  chat_id TEXT NOT NULL,
  date TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'morning',
  status TEXT NOT NULL DEFAULT 'pending',
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
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
CREATE TABLE IF NOT EXISTS recovery_marks (
  chat_id TEXT PRIMARY KEY,
  user_ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attention_override (
  chat_id TEXT PRIMARY KEY,
  until_ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS capture_marks (
  chat_id TEXT PRIMARY KEY,
  last_msg_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS send_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  character_id INTEGER,
  kind TEXT NOT NULL,
  error TEXT NOT NULL,
  ts TEXT NOT NULL
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
  // 누적 정체성: 캐릭터가 이 관계에서 자기에 대해 새로 말한 사실 (한번 나오면 일관 유지)
  char_facts?: { fact: string; learned_at: string }[];
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
  if (!row) return emptyRelationshipState();
  try {
    return JSON.parse(row.state_json) as RelationshipState;
  } catch (e) {
    // 손상된 state_json 하나가 실시간 응답 경로 전체(buildSystemPrompt)를 죽이지 않게 빈 상태로
    // 강등한다. 원본 행은 건드리지 않지만, 이 상태에서 밤 정리·캡처가 save하면 빈 상태로 덮어써질
    // 수 있다 — 그래서 조용히 넘기지 않고 크게 로그를 남긴다(발견 즉시 행 복구가 우선).
    console.error(
      `[db] state_json 파싱 실패 — 빈 상태로 강등 (character=${characterId}, len=${row.state_json.length}):`,
      e instanceof Error ? e.message : String(e),
    );
    return emptyRelationshipState();
  }
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

// 유저가 연속으로 이어 보낸 메시지 사이의 텀(ms). 봇 응답이 끼지 않은 '이어 보내기'만 센다
// (봇 답장을 사이에 둔 건 새 턴이라 제외, 2분 넘는 텀도 새 턴으로 보고 제외).
// 텀이 길수록 = 한 번에 길게 치는 사람 = 응답 대기를 더 길게 잡아 중간에 끊지 않게 한다.
export const recentUserGaps = (chatId: string, limit = 80): number[] => {
  const rows = db
    .prepare(
      `SELECT role, ts FROM messages WHERE chat_id = ? AND role IN ('user','char') ORDER BY id DESC LIMIT ?`,
    )
    .all(chatId, limit) as { role: string; ts: string }[];
  rows.reverse();
  const t = (s: string): number =>
    new Date(s.replace(" ", "T") + "+09:00").getTime();
  const gaps: number[] = [];
  for (let i = 1; i < rows.length; i++)
    if (rows[i].role === "user" && rows[i - 1].role === "user") {
      const g = t(rows[i].ts) - t(rows[i - 1].ts);
      if (g > 0 && g < 120000) gaps.push(g);
    }
  return gaps;
};

// 주변 인물 관계도: 캐릭터의 사람들(who='char', 바이블 시드 + 등장 인물)과
// 유저가 언급한 유저의 사람들(who='user')을 한 테이블에 소유자 구분으로 쌓는다
const castCols = db.prepare(`PRAGMA table_info(cast_members)`).all() as {
  name: string;
}[];
if (!castCols.some((c) => c.name === "who"))
  db.exec(
    `ALTER TABLE cast_members ADD COLUMN who TEXT NOT NULL DEFAULT 'char'`,
  );

// 선톡 발송 시도 흔적: 폐기된 문안이 '창을 놓쳤을 뿐'인지 '계속 전송에 실패했는지' 구분용
const sendCols = db.prepare(`PRAGMA table_info(scheduled_sends)`).all() as {
  name: string;
}[];
if (!sendCols.some((c) => c.name === "attempts"))
  db.exec(
    `ALTER TABLE scheduled_sends ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`,
  );
if (!sendCols.some((c) => c.name === "last_error"))
  db.exec(`ALTER TABLE scheduled_sends ADD COLUMN last_error TEXT`);
// 문안의 종류: morning=아침 안부, reconnect=긴 침묵 후 재연결 1통 (침묵 백오프)
if (!sendCols.some((c) => c.name === "kind"))
  db.exec(
    `ALTER TABLE scheduled_sends ADD COLUMN kind TEXT NOT NULL DEFAULT 'morning'`,
  );

// 하루 각본의 출처: 밤 정리 정식 생성(nightly) vs 그날 첫 대화의 lazy 생성.
// 새벽 대화가 만든 lazy 각본(어제 일기가 아직 없어 이틀 전 일기 참조)을 밤 정리가 교체할 수 있게 구분
const planCols = db.prepare(`PRAGMA table_info(day_plans)`).all() as {
  name: string;
}[];
if (!planCols.some((c) => c.name === "source"))
  db.exec(
    `ALTER TABLE day_plans ADD COLUMN source TEXT NOT NULL DEFAULT 'nightly'`,
  );

export interface CastMember {
  name: string;
  relation: string;
  note: string | null;
}

export const getCast = (
  characterId: number,
  who: "char" | "user" = "char",
): CastMember[] =>
  db
    .prepare(
      `SELECT name, relation, note FROM cast_members WHERE character_id = ? AND who = ? ORDER BY id`,
    )
    .all(characterId, who) as CastMember[];

export const addCastMember = (
  characterId: number,
  who: "char" | "user",
  name: string,
  relation: string,
  note: string | null,
  now: string,
): void => {
  const dup = db
    .prepare(
      `SELECT 1 FROM cast_members WHERE character_id = ? AND who = ? AND name = ? LIMIT 1`,
    )
    .get(characterId, who, name);
  if (dup) return;
  db.prepare(
    `INSERT INTO cast_members (character_id, who, name, relation, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(characterId, who, name, relation, note, now);
};

// 지금 이 관계가 반말인지 존댓말인지 — 최근 캐릭터 발화의 종결어미로 판정한다.
// 반말 전환이 명시 상태로 저장돼 있지 않아, 선톡·팔로업 등 최근 대화를 안 보는 경로가
// 씨앗 말투(존댓말)로 되돌아가는 회귀를 막기 위한 힌트. 표본이 적으면 null(판단 보류).
export const currentSpeechLevel = (
  chatId: string,
): "반말" | "존댓말" | null => {
  // 선톡(아침 안부·팔로업·자리비움)은 제외하고 실제 대화 답장만으로 판정한다.
  // 선톡이 존댓말로 잘못 나가면 그게 판정을 존댓말로 오염시켜 다음 선톡도 존댓말이 되는 악순환을 막는다.
  const rows = db
    .prepare(
      `SELECT text FROM messages WHERE chat_id = ? AND role = 'char'
       AND (meta_json IS NULL OR json_extract(meta_json,'$.kind') IN ('reply','recover'))
       ORDER BY id DESC LIMIT 14`,
    )
    .all(chatId) as { text: string }[];
  const JON =
    /(요|에요|예요|세요|까요|네요|어요|아요|죠|습니다|ㅂ니다|십시오)[?!~.… ]*$/;
  const BAN =
    /(어|아|지|자|래|니|봐|줘|거든|거야|잖아|는데|던데|더라|을게|ㄹ게|야|음)[?!~.… ]*$/;
  let jon = 0;
  let ban = 0;
  for (const r of rows) {
    const last =
      r.text
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .pop() ?? "";
    if (JON.test(last)) jon++;
    else if (BAN.test(last)) ban++;
  }
  if (jon + ban < 3) return null;
  return ban > jon ? "반말" : "존댓말";
};

// 선톡·팔로업 프롬프트용 말투 지시. 그 프롬프트들엔 존댓말 예시가 많아, 반말인데도 예시를 베껴
// 존댓말이 나오는 문제가 있었다. 예시를 이기도록 강하게 못 박는다.
export const speechGuard = (chatId: string): string => {
  const lv = currentSpeechLevel(chatId);
  if (lv === "반말")
    return " [말투 — 반드시 지킴: 지금 서로 반말이다. 반말로 쓴다. 아래에 존댓말로 적힌 예시가 있어도 전부 반말로 바꿔 말한다. 존댓말로 되돌아가지 않는다. 단 '야' 호명·'했냐'처럼 '냐'로 끝나는 거친 반말은 안 씀.]";
  if (lv === "존댓말") return " (지금은 존댓말 사이 — 존댓말 유지)";
  return " (최근 대화의 말투를 그대로 따른다 — 아래 예시 말투에 얽매이지 말 것)";
};

// 삶의 큰 흐름: 연/계절/월/주 단위 이벤트 아크. 하루 각본이 이를 참고한다
export const getArcs = (characterId: number): Record<string, string> => {
  const rows = db
    .prepare(`SELECT horizon, content FROM arcs WHERE character_id = ?`)
    .all(characterId) as { horizon: string; content: string }[];
  return Object.fromEntries(rows.map((r) => [r.horizon, r.content]));
};

export const saveArc = (
  characterId: number,
  horizon: "year" | "season" | "month" | "week",
  content: string,
): void => {
  db.prepare(
    `INSERT OR REPLACE INTO arcs (character_id, horizon, content) VALUES (?, ?, ?)`,
  ).run(characterId, horizon, content);
};

// 컨디션/기상 리듬 시드: 월 단위로 미리 깔아두는 하루의 성향(기력·기상·기분).
// 이벤트(회식 등)의 여파가 다음날 시드에 인과로 이어지게 밤 정리가 한 달치를 생성한다.
// 하루 각본은 이 시드 + 어제 일기(실제 여파)를 이어 그날 기상 시각·활동량을 확정한다.
export interface DaySeed {
  date: string;
  energy: string; // 낮음 | 보통 | 높음
  wake_hint: string; // 이른 | 보통 | 늦잠
  mood: string; // 짧은 구
  note: string | null; // 왜 이런지 (예: 어제 회식 여파)
}

export const getDaySeed = (
  characterId: number,
  date: string,
): DaySeed | undefined =>
  db
    .prepare(
      `SELECT date, energy, wake_hint, mood, note FROM day_seeds WHERE character_id = ? AND date = ?`,
    )
    .get(characterId, date) as DaySeed | undefined;

export const getMonthSeeds = (
  characterId: number,
  ym: string, // "YYYY-MM"
): DaySeed[] =>
  db
    .prepare(
      `SELECT date, energy, wake_hint, mood, note FROM day_seeds WHERE character_id = ? AND date LIKE ? ORDER BY date`,
    )
    .all(characterId, `${ym}-%`) as DaySeed[];

export const monthHasSeeds = (characterId: number, ym: string): boolean =>
  !!db
    .prepare(
      `SELECT 1 FROM day_seeds WHERE character_id = ? AND date LIKE ? LIMIT 1`,
    )
    .get(characterId, `${ym}-%`);

export const saveDaySeed = (characterId: number, s: DaySeed): void => {
  db.prepare(
    `INSERT OR REPLACE INTO day_seeds (character_id, date, energy, wake_hint, mood, note) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(characterId, s.date, s.energy, s.wake_hint, s.mood, s.note ?? null);
};

// 일정 슬롯: 하루 각본보다 성긴 층. 캐릭터의 예정(who='char')과 유저에게 들은 예정(who='user')을
// 캐릭터별로 보관한다. 대화에서 잡힌 약속의 추출·기록은 밤 정리 몫.
export interface ScheduleRow {
  id: number;
  who: string;
  date: string;
  time_hint: string | null;
  content: string;
}

export const getUpcomingSchedules = (
  characterId: number,
  fromDate: string,
  limit = 12,
): ScheduleRow[] =>
  db
    .prepare(
      `SELECT id, who, date, time_hint, content FROM schedules
       WHERE character_id = ? AND status = 'active' AND date >= ?
       ORDER BY date, id LIMIT ?`,
    )
    .all(characterId, fromDate, limit) as ScheduleRow[];

export const addSchedule = (
  characterId: number,
  who: "char" | "user",
  date: string,
  timeHint: string | null,
  content: string,
  now: string,
): void => {
  db.prepare(
    `INSERT INTO schedules (character_id, who, date, time_hint, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(characterId, who, date, timeHint, content, now);
};

export const getSchedulesInMonth = (
  characterId: number,
  ym: string, // "YYYY-MM"
  who?: "char" | "user",
): ScheduleRow[] =>
  db
    .prepare(
      `SELECT id, who, date, time_hint, content FROM schedules
       WHERE character_id = ? AND status = 'active' AND date LIKE ?${who ? " AND who = ?" : ""}
       ORDER BY date, id`,
    )
    .all(
      ...(who ? [characterId, `${ym}-%`, who] : [characterId, `${ym}-%`]),
    ) as ScheduleRow[];

// 선톡: 밤 정리가 근거 있을 때만 하루 1통 문안을 준비해두고, 디스패처가 창 안에서 발송한다
export interface ScheduledSendRow {
  id: number;
  character_id: number;
  chat_id: string;
  date: string;
  window_start: string;
  window_end: string;
  text: string;
  kind: string; // morning | reconnect
  attempts: number;
}

export const insertScheduledSend = (
  characterId: number,
  chatId: string,
  date: string,
  windowStart: string,
  windowEnd: string,
  text: string,
  now: string,
  kind: "morning" | "reconnect" = "morning",
): void => {
  const dup = db
    .prepare(
      `SELECT 1 FROM scheduled_sends WHERE character_id = ? AND date = ? LIMIT 1`,
    )
    .get(characterId, date);
  if (dup) return; // 하루 1통
  db.prepare(
    `INSERT INTO scheduled_sends (character_id, chat_id, date, window_start, window_end, text, created_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(characterId, chatId, date, windowStart, windowEnd, text, now, kind);
};

export const getPendingSends = (date: string): ScheduledSendRow[] =>
  db
    .prepare(
      `SELECT id, character_id, chat_id, date, window_start, window_end, text, kind, attempts FROM scheduled_sends WHERE status = 'pending' AND date = ?`,
    )
    .all(date) as ScheduledSendRow[];

export const markScheduledSend = (
  id: number,
  status: "sent" | "skipped",
  reason: string | null,
  sentAt: string | null,
): void => {
  db.prepare(
    `UPDATE scheduled_sends SET status = ?, reason = ?, sent_at = ? WHERE id = ?`,
  ).run(status, reason, sentAt, id);
};

// 전송 실패를 행에 남긴다 — 로그를 뒤지지 않고도 "몇 번 시도했고 왜 못 갔는지"가 보이게.
// (정상 스킵과 네트워크 실패가 똑같이 '발송 창 지남'으로 뭉뚱그려지던 걸 가르는 근거)
export const recordSendAttempt = (id: number, error: string): void => {
  db.prepare(
    `UPDATE scheduled_sends SET attempts = attempts + 1, last_error = ? WHERE id = ?`,
  ).run(error.slice(0, 300), id);
};

// scheduled_sends 밖의 선톡(팔로업·자리비움 예고) 전송 실패 흔적. 이 메시지들은 순간에 묶여 있어
// 유예·재시도가 없다 — 대신 실패했다는 사실만은 콘솔이 아니라 DB에 남겨 사후 추적이 되게 한다.
export const recordSendFailure = (
  chatId: string,
  characterId: number,
  kind: string,
  error: string,
): void => {
  const ts = `${kstDateString()} ${getKstNow().toISOString().slice(11, 19)}`;
  db.prepare(
    `INSERT INTO send_failures (chat_id, character_id, kind, error, ts) VALUES (?, ?, ?, ?, ?)`,
  ).run(chatId, characterId, kind, error.slice(0, 300), ts);
};

export const hasUserMessageSince = (chatId: string, ts: string): boolean =>
  !!db
    .prepare(
      `SELECT 1 FROM messages WHERE chat_id = ? AND role = 'user' AND ts >= ? LIMIT 1`,
    )
    .get(chatId, ts);

// 마지막 메시지(유저·캐릭 무관)의 시각·역할 — 침묵 팔로업 판단용
export const lastMessage = (
  chatId: string,
): { ts: string; role: string } | undefined =>
  db
    .prepare(
      `SELECT ts, role FROM messages WHERE chat_id = ? AND role IN ('user','char') ORDER BY id DESC LIMIT 1`,
    )
    .get(chatId) as { ts: string; role: string } | undefined;

// 오늘(새벽 5시 이후) 캐릭터가 먼저 보낸(proactive) 발송 수 — 팔로업 총량 제한용
// 하루 선제 발송 총량 상한(아침 안부·팔로업·자리비움 예고 합산). followup·presence가 공유한다 —
// 채널별 상한만 있으면 합이 통제되지 않는다(각자 자기 몫을 다 쓰면 하루 ~10통까지 가능했다).
export const PROACTIVE_DAILY_MAX = 6;

export const proactiveCountToday = (chatId: string, since: string): number =>
  (
    db
      .prepare(
        `SELECT count(*) c FROM messages WHERE chat_id = ? AND role = 'char' AND ts >= ? AND meta_json LIKE '%proactive%'`,
      )
      .get(chatId, since) as { c: number }
  ).c;

// 유저 선호(매칭 전용, 캐릭터에 비주입). 밤 정리가 대화 내용으로 뽑아 누적한다.
// topics = 유저가 몰입하는 소재(영화·투자…), facets = 우진의 어떤 성향에 반응이 좋은지(안정감·위트·직업·취미…).
export interface UserPreferences {
  topics: { topic: string; note: string; learned_at: string }[];
  facets: {
    facet: string;
    response: string;
    note: string;
    learned_at: string;
  }[];
}

export const getUserPreferences = (chatId: string): UserPreferences => {
  const row = db
    .prepare(`SELECT pref_json FROM user_preferences WHERE chat_id = ?`)
    .get(chatId) as { pref_json: string } | undefined;
  if (!row) return { topics: [], facets: [] };
  try {
    const p = JSON.parse(row.pref_json) as Partial<UserPreferences>;
    return { topics: p.topics ?? [], facets: p.facets ?? [] };
  } catch {
    return { topics: [], facets: [] };
  }
};

export const saveUserPreferences = (
  chatId: string,
  prefs: UserPreferences,
): void => {
  db.prepare(
    `INSERT OR REPLACE INTO user_preferences (chat_id, pref_json) VALUES (?, ?)`,
  ).run(chatId, JSON.stringify(prefs));
};

// 유저 프로필(성별·나이대). user_preferences(매칭 전용·비주입)와 달리 이건
// 캐릭터가 상대를 대하는 데 쓰는 공개 정보다. env로 지정하지 않았으면 밤 정리가 대화로 채운다.
// chat_id 기준(교체돼도 유지) — 유저의 정체는 어떤 캐릭터를 만나든 그대로다.
// 이름은 다루지 않는다 — 호칭을 시스템이 강제하면 자리 잡은 반말을 격식체로 되돌리는 회귀가 났다(2026-07-12).
export interface StoredUserProfile {
  gender?: string;
  ageBand?: string;
}

export const getUserProfile = (chatId: string): StoredUserProfile => {
  const row = db
    .prepare(`SELECT gender, age_band FROM user_profile WHERE chat_id = ?`)
    .get(chatId) as
    { gender: string | null; age_band: string | null } | undefined;
  if (!row) return {};
  return {
    gender: row.gender ?? undefined,
    ageBand: row.age_band ?? undefined,
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
  const ageBand = p.ageBand?.trim() || cur.ageBand;
  db.prepare(
    `INSERT OR REPLACE INTO user_profile (chat_id, gender, age_band, updated_at) VALUES (?, ?, ?, ?)`,
  ).run(chatId, gender ?? null, ageBand ?? null, at);
};

// 마지막 유저 메시지 이후 캐릭터가 먼저 보낸(proactive) 수 — '연속 무응답'을 세어 매달림을 막는다.
export const proactiveSinceLastUser = (chatId: string): number => {
  const lastUser = db
    .prepare(
      `SELECT ts FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1`,
    )
    .get(chatId) as { ts: string } | undefined;
  const since = lastUser?.ts ?? "0000-00-00 00:00:00";
  return (
    db
      .prepare(
        `SELECT count(*) c FROM messages WHERE chat_id = ? AND role = 'char' AND ts > ? AND meta_json LIKE '%proactive%'`,
      )
      .get(chatId, since) as { c: number }
  ).c;
};

// 복구 워터마크: "이 유저 메시지에는 답장 책임을 졌다"는 표시. 재시작(배포)으로 답장을 보냈지만
// 로그 전에 프로세스가 죽어도, 다음 부팅의 복구가 같은 메시지에 또 답하지 않도록 막는다.
export const getRecoveryMark = (chatId: string): string | undefined =>
  (
    db
      .prepare(`SELECT user_ts FROM recovery_marks WHERE chat_id = ?`)
      .get(chatId) as { user_ts: string } | undefined
  )?.user_ts;

export const setRecoveryMark = (chatId: string, userTs: string): void => {
  db.prepare(
    `INSERT OR REPLACE INTO recovery_marks (chat_id, user_ts) VALUES (?, ?)`,
  ).run(chatId, userTs);
};

// 주의 집중(attention override): 유저가 붙잡아 우진이 조정 가능한(개인·사회) 자기 일정을 접거나 미루고 대화로 돌아온 상태.
// until_ts(KST "YYYY-MM-DD HH:MM:SS")까지는 각본상 불가여도 곁에 있는 것으로 본다(즉답, 예고 안 함).
export const getAttentionUntil = (chatId: string): string | undefined =>
  (
    db
      .prepare(`SELECT until_ts FROM attention_override WHERE chat_id = ?`)
      .get(chatId) as { until_ts: string } | undefined
  )?.until_ts;

export const setAttentionOverride = (chatId: string, untilTs: string): void => {
  db.prepare(
    `INSERT OR REPLACE INTO attention_override (chat_id, until_ts) VALUES (?, ?)`,
  ).run(chatId, untilTs);
};

// 세션 중 사실 포착의 워터마크: 여기 id까지는 이미 포착을 시도했다. 다음엔 그 이후 메시지만 본다.
export const getCaptureMark = (chatId: string): number =>
  (
    db
      .prepare(`SELECT last_msg_id FROM capture_marks WHERE chat_id = ?`)
      .get(chatId) as { last_msg_id: number } | undefined
  )?.last_msg_id ?? 0;

export const setCaptureMark = (chatId: string, lastMsgId: number): void => {
  db.prepare(
    `INSERT OR REPLACE INTO capture_marks (chat_id, last_msg_id) VALUES (?, ?)`,
  ).run(chatId, lastMsgId);
};

export const getDayPlan = (
  characterId: number,
  date: string,
): string | undefined =>
  (
    db
      .prepare(
        `SELECT plan_json FROM day_plans WHERE character_id = ? AND date = ?`,
      )
      .get(characterId, date) as { plan_json: string } | undefined
  )?.plan_json;

// source: 밤 정리 정식 생성(nightly) vs 그날 첫 대화의 lazy 생성.
// lazy 각본은 어제 일기가 아직 없을 때 만들어진 것이라 밤 정리가 교체할 수 있다.
export const saveDayPlan = (
  characterId: number,
  date: string,
  planJson: string,
  source: "nightly" | "lazy" = "nightly",
): void => {
  db.prepare(
    `INSERT OR REPLACE INTO day_plans (character_id, date, plan_json, source) VALUES (?, ?, ?, ?)`,
  ).run(characterId, date, planJson, source);
};

export const getDayPlanSource = (
  characterId: number,
  date: string,
): string | undefined =>
  (
    db
      .prepare(
        `SELECT source FROM day_plans WHERE character_id = ? AND date = ?`,
      )
      .get(characterId, date) as { source: string } | undefined
  )?.source;

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
