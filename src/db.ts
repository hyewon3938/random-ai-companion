import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { getKstNow, kstDateString, kstLogicalDate } from "./kst.js";
import {
  toResponsiveness,
  toActivityCategory,
  type MemoryItemType,
  type MemoryOwner,
  type MemoryOrigin,
  type UserKnows,
  type Interest,
  type SpeechLevel,
} from "./labels.js";

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

// ── 스키마 ────────────────────────────────────────────────────────────────
// 테이블 정의는 이 표 한 곳에만 둔다. 새 DB는 이 정의로 바로 만들고, 옛 DB는 아래
// 마이그레이션이 같은 정의로 테이블을 다시 만들어 값을 옮긴다.
// 값이 정해진 컬럼은 영어 식별자로 저장하고 CHECK로 막는다. 모델이 짓는 값(무엇·태그·
// 저장하는 내용·영역 이름)은 한국어 그대로 들어간다.
const TABLES: Record<string, string> = {
  characters: `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  genesis_json TEXT NOT NULL,
  created_at TEXT NOT NULL`,

  // 캐릭터와 유저의 관계. 여덟 항목을 컬럼으로 나눠 두고 프롬프트에 항상 넣는다.
  // 말투 값과 last_contact_at은 답장 경로가, 나머지는 새벽 정리가 갱신한다.
  // 새 컬럼은 전부 NULL을 허용한다 — 초기값을 채우는 것은 데이터 이관 회차 몫이고,
  // legacy_state_json을 지울 때 같이 NOT NULL로 조인다.
  relationships: `
  character_id INTEGER PRIMARY KEY REFERENCES characters(id),
  met_at TEXT NOT NULL,
  last_contact_at TEXT,
  stage TEXT,
  speech_level TEXT CHECK (speech_level IN ('polite','casual')),
  speech_note TEXT,
  address_terms TEXT,
  texture TEXT,
  rapport TEXT,
  cautions TEXT,
  history TEXT,
  feelings TEXT,
  updated_at TEXT,
  legacy_state_json TEXT`,

  // 기억 한 건 = 저장 항목(item_type) + 누구 쪽(owner) + 영역(area) + 무엇(subject) + 출처(origin)가 키.
  // 같은 키로 다시 들어오면 값을 덮어쓴다. 저장 항목 셋과 주인 둘이 만드는 여섯 조합이 전부 유효하다.
  //
  // 항목마다 따로 챙기는 값은 전용 컬럼으로 둔다. extra_json에 넣으면 CHECK가 닿지 않아
  // 오타 난 키가 그대로 저장되고 읽는 쪽에서야 없는 값으로 드러난다(각본 태그에서 겪었다).
  // 주변 인물은 relation·contact_mode·region·last_mentioned_at, 진행 중인 일은 end_condition,
  // 캐릭터 쪽 행은 interest를 쓰고, 해당 없는 자리는 CHECK가 막는다.
  //
  // 캐릭터를 만들 때 정한 값(origin='creation')과 대화로 쌓인 값(origin='conversation')은
  // 같은 키에 두 행으로 나란히 놓인다. 저장 함수는 언제나 conversation 행에만 쓴다.
  memory_items: `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL REFERENCES characters(id),
  item_type TEXT NOT NULL CHECK (item_type IN ('fact','ongoing','person')),
  owner TEXT NOT NULL CHECK (owner IN ('char','user')),
  area TEXT NOT NULL,
  subject TEXT NOT NULL,
  value TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'conversation' CHECK (origin IN ('creation','conversation')),
  user_knows TEXT NOT NULL DEFAULT 'unknown' CHECK (user_knows IN ('unknown','known','waiting')),
  relation TEXT,
  contact_mode TEXT,
  region TEXT,
  last_mentioned_at TEXT,
  end_condition TEXT,
  interest TEXT CHECK (interest IN ('high','medium','low')),
  last_retrieved_at TEXT,
  retrieval_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  CHECK (item_type = 'person' OR (relation IS NULL AND contact_mode IS NULL AND region IS NULL AND last_mentioned_at IS NULL)),
  CHECK (item_type = 'ongoing' OR end_condition IS NULL),
  CHECK (owner = 'char' OR interest IS NULL),
  CHECK (owner = 'char' OR user_knows = 'known'),
  UNIQUE (character_id, item_type, owner, area, subject, origin)`,

  // 태그에서 데이터로 가는 방향의 표. 기억·일기·일정이 ref_id로 함께 들어온다.
  tags: `
  character_id INTEGER NOT NULL REFERENCES characters(id),
  kind TEXT NOT NULL CHECK (kind IN ('memory','diary','schedule')),
  ref_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (kind, ref_id, tag)`,

  // 캐릭터마다 쓰는 영역 이름 목록. 새벽 정리가 키를 붙일 때 이 목록에서 고른다.
  // note는 영역이 덮는 범위 설명 — 키를 고르는 모델에게 이름과 같이 보여준다.
  areas: `
  character_id INTEGER NOT NULL REFERENCES characters(id),
  name TEXT NOT NULL,
  note TEXT,
  PRIMARY KEY (character_id, name)`,

  // 오늘 메모: 대화 중에 나온 것을 판정 없이 그대로 적어 두고, 새벽 정리가 읽어 간다.
  today_notes: `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL REFERENCES characters(id),
  created_at TEXT NOT NULL,
  note TEXT NOT NULL,
  message_id INTEGER`,

  user_preferences: `
  chat_id TEXT PRIMARY KEY,
  pref_json TEXT NOT NULL`,

  // age_band는 옛 컬럼이다. 지금 프롬프트가 나이대를 여기서 읽고 있어 birth_year로
  // 옮기는 온보딩을 고칠 때까지 함께 둔다.
  user_profile: `
  chat_id TEXT PRIMARY KEY,
  preferred_name TEXT,
  gender TEXT,
  birth_year INTEGER,
  job TEXT,
  region TEXT,
  age_band TEXT,
  updated_at TEXT`,

  diary_entries: `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL REFERENCES characters(id),
  date TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  UNIQUE (character_id, date)`,

  cast_members: `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL REFERENCES characters(id),
  owner TEXT NOT NULL DEFAULT 'char' CHECK (owner IN ('char','user')),
  name TEXT NOT NULL,
  relation_label TEXT NOT NULL,
  area TEXT,
  meet_pattern TEXT,
  place TEXT,
  recent_note TEXT,
  user_knows TEXT NOT NULL DEFAULT 'unknown' CHECK (user_knows IN ('unknown','known','waiting')),
  last_mentioned_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (character_id, name)`,

  arcs: `
  character_id INTEGER NOT NULL REFERENCES characters(id),
  period TEXT NOT NULL CHECK (period IN ('year','season','month','week')),
  content TEXT NOT NULL,
  PRIMARY KEY (character_id, period)`,

  schedules: `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL REFERENCES characters(id),
  owner TEXT NOT NULL CHECK (owner IN ('char','user')),
  date TEXT NOT NULL,
  time_hint TEXT,
  content TEXT NOT NULL,
  with_name TEXT,
  area TEXT,
  user_knows TEXT NOT NULL DEFAULT 'unknown' CHECK (user_knows IN ('unknown','known','waiting')),
  origin TEXT NOT NULL DEFAULT 'conversation' CHECK (origin IN ('conversation','rhythm','ongoing')),
  parent_kind TEXT CHECK (parent_kind IN ('memory','schedule')),
  parent_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','deferred')),
  created_at TEXT NOT NULL`,

  day_plans: `
  character_id INTEGER NOT NULL REFERENCES characters(id),
  date TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  made_by TEXT NOT NULL DEFAULT 'nightly' CHECK (made_by IN ('nightly','ondemand')),
  PRIMARY KEY (character_id, date)`,

  day_seeds: `
  character_id INTEGER NOT NULL REFERENCES characters(id),
  date TEXT NOT NULL,
  energy TEXT NOT NULL,
  wake_hint TEXT NOT NULL,
  mood TEXT NOT NULL,
  reason TEXT,
  PRIMARY KEY (character_id, date)`,

  // 각본과 달라진 시간만 남긴다. 하려던 것·어떻게 됐나·왜 셋이 한 줄이다.
  day_actuals: `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL REFERENCES characters(id),
  date TEXT NOT NULL,
  block_start TEXT,
  intended TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT,
  recorded_at TEXT NOT NULL`,

  messages: `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  character_id INTEGER,
  sent_at TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text TEXT NOT NULL,
  meta_json TEXT`,

  // 만들어 둔 답장을 보관했다가 정한 시각에 보낸다. 봇이 내려가도 보낼 것이 남는다.
  // kind='wake'는 답장이 아니라 깨우기 표시다 — 불가 구간에는 답장을 미리 만들지 않고,
  // 구간이 끝나는 시각에 이 행이 울리면 그때 쌓인 메시지를 읽고 한 번에 답장을 만든다.
  pending_replies: `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  character_id INTEGER NOT NULL REFERENCES characters(id),
  user_msg_at TEXT NOT NULL,
  bubbles_json TEXT NOT NULL,
  note_to_save TEXT,
  send_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'reply' CHECK (kind IN ('reply','recover','wake')),
  meta_json TEXT,
  call_id INTEGER,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','sent','superseded','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT`,

  // 미리 만들어 둔 아침 · 안부 선톡 문안. 만든 자리에서 바로 보내지 않고 여기 적어 두면
  // 봇이 내려가도 보낼 것이 남고, 실패한 시도를 같은 행에 세어 둘 수 있다.
  scheduled_messages: `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL REFERENCES characters(id),
  chat_id TEXT NOT NULL,
  date TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'morning' CHECK (kind IN ('morning','checkin')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','skipped')),
  skip_reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT`,

  recovery_marks: `
  chat_id TEXT PRIMARY KEY,
  replied_up_to TEXT NOT NULL`,

  send_failures: `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  character_id INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('away','catchup','goodnight')),
  error TEXT NOT NULL,
  failed_at TEXT NOT NULL`,

  llm_usage: `
  date TEXT NOT NULL,
  model TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, model)`,

  // 슬랙 트레이스 게시함(trace.ts). 보여줄 내용을 행으로 쌓아 두면 봇의 1분 틱이 슬랙으로
  // 내보낸다 — 재시작·슬랙 장애에도 보낼 것이 남고, 봇 밖 배치가 남긴 행도 같은 길로 나간다.
  // 스레드는 thread_key(부모)·parent_key(자식)로 잇고, 자식은 부모가 게시된 뒤에만 나간다.
  // dedupe_key가 있는 행은 같은 키로 두 번 쌓이지 않는다(INSERT OR IGNORE).
  trace_events: `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER REFERENCES characters(id),
  kind TEXT NOT NULL,
  dedupe_key TEXT UNIQUE,
  thread_key TEXT,
  parent_key TEXT,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  slack_ts TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL`,

  // 모델 호출 원본. 무엇을 넣었고 무엇이 나왔는지를 그대로 남겨, 답이 이상할 때 그 호출의
  // 프롬프트를 열어 볼 수 있게 한다. 판단 근거(검색한 태그와 기억, 답장 텀, 말풍선 수)는
  // 호출 시점 값으로 context_json에 붙인다 — 기억 검색은 꺼낸 기록을 남기는 쓰기 동작이라
  // 나중에 같은 검색을 다시 돌려 재현할 수 없다.
  //
  // purpose에는 CHECK를 두지 않는다. 호출 자리가 하나 늘 때마다 스키마 이관이 따라붙고,
  // CHECK에 걸린 INSERT는 기록을 통째로 잃는다. 값은 labels.ts의 CallPurpose 타입이
  // 컴파일 시점에 막는다.
  llm_calls: `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER REFERENCES characters(id),
  chat_id TEXT,
  purpose TEXT NOT NULL,
  model TEXT NOT NULL,
  max_tokens INTEGER,
  attempt INTEGER NOT NULL DEFAULT 1,
  system_hashes TEXT,
  turns_hash TEXT,
  output_hash TEXT,
  input_tokens INTEGER,
  cache_write_tokens INTEGER,
  cache_read_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER,
  error TEXT,
  context_json TEXT,
  code_version TEXT,
  created_at TEXT NOT NULL,
  traced INTEGER NOT NULL DEFAULT 0`,

  // 프롬프트·출력 본문. 키가 내용 해시라 같은 글자는 한 벌만 쌓인다 — 불변층·일간층은
  // 하루 종일 같은 내용이라, 호출마다 본문을 다시 담으면 DB가 호출 수에 비례해 커진다.
  prompt_blobs: `
  hash TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL`,
};

// attention_override·capture_marks는 정의에서 뺐다 — 붙잡힌 상태는 day_actuals가, 세션 중 사실
// 포착은 오늘 메모가 대신한다. 쓰던 DB에 남은 행은 읽는 코드가 없어 그대로 두고, 새 DB에는 만들지 않는다.

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_characters_chat ON characters (chat_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_items_type ON memory_items (character_id, item_type)`,
  `CREATE INDEX IF NOT EXISTS idx_tags_lookup ON tags (character_id, tag)`,
  `CREATE INDEX IF NOT EXISTS idx_today_notes_day ON today_notes (character_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_schedules_date ON schedules (character_id, date)`,
  `CREATE INDEX IF NOT EXISTS idx_day_actuals_date ON day_actuals (character_id, date)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_id, sent_at)`,
  `CREATE INDEX IF NOT EXISTS idx_pending_replies_due ON pending_replies (status, send_at)`,
  `CREATE INDEX IF NOT EXISTS idx_pending_replies_chat ON pending_replies (chat_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due ON scheduled_messages (status, date)`,
  `CREATE INDEX IF NOT EXISTS idx_trace_events_pending ON trace_events (status, id)`,
  `CREATE INDEX IF NOT EXISTS idx_trace_events_thread ON trace_events (thread_key)`,
  `CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls (created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_llm_calls_purpose ON llm_calls (character_id, purpose, id)`,
];

const createSchema = (): void => {
  for (const [name, columns] of Object.entries(TABLES))
    db.exec(`CREATE TABLE IF NOT EXISTS ${name} (${columns}\n)`);
  for (const sql of INDEXES) db.exec(sql);
};

const SCHEMA_VERSION = 5;

const schemaVersion = (): number =>
  db.pragma("user_version", { simple: true }) as number;

// 옛 스키마는 user_version이 0인 채로 쌓여 왔다. 버전 대신 컬럼 이름으로 가른다.
const hasLegacySchema = (): boolean => {
  const exists = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'characters'`,
    )
    .get();
  if (!exists) return false;
  const cols = db.prepare(`PRAGMA table_info(characters)`).all() as {
    name: string;
  }[];
  return cols.some((c) => c.name === "bible_json");
};

// SQLite는 이미 있는 테이블에 CHECK·UNIQUE를 붙이지 못한다. 그래서 바뀌는 테이블은
// 옛 이름으로 밀어 두고 새로 만든 다음 값을 옮기고 옛 테이블을 지운다. 이름 바꾸기와
// 값 바꾸기가 한 번에 끝난다.
const rebuild = (
  name: string,
  columns: string,
  select: string,
  source: string = name,
): void => {
  db.exec(`ALTER TABLE ${source} RENAME TO ${name}__old`);
  db.exec(`CREATE TABLE ${name} (${TABLES[name]}\n)`);
  db.exec(
    `INSERT INTO ${name} (${columns}) SELECT ${select} FROM ${name}__old`,
  );
  db.exec(`DROP TABLE ${name}__old`);
};

const migrateToV1 = (): void => {
  // 유저 프로필의 옛 이름 컬럼은 지금 DB에만 남아 있다 — 새로 만든 DB에는 없다.
  const profileCols = db.prepare(`PRAGMA table_info(user_profile)`).all() as {
    name: string;
  }[];
  const preferredName = profileCols.some((c) => c.name === "name")
    ? "name"
    : "NULL";

  // 이름을 바꾸는 동안 자식 테이블의 REFERENCES 절을 건드리지 않게 legacy 모드로 둔다.
  // 외래 키 검사는 옮기는 동안 꺼 두고 끝난 뒤 한 번에 확인한다. 두 pragma 모두
  // 트랜잭션 안에서는 먹지 않아 밖에서 켜고 끈다.
  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");

  db.transaction(() => {
    rebuild(
      "characters",
      "id, chat_id, status, genesis_json, created_at",
      "id, chat_id, status, bible_json, created_at",
    );
    rebuild(
      "relationships",
      "character_id, met_at, last_contact_at, legacy_state_json",
      "character_id, met_at, last_contact_at, state_json",
    );
    rebuild(
      "user_profile",
      "chat_id, preferred_name, gender, birth_year, job, region, age_band, updated_at",
      `chat_id, ${preferredName}, gender, NULL, NULL, NULL, age_band, updated_at`,
    );
    rebuild(
      "diary_entries",
      "id, character_id, date, entry_json",
      "id, character_id, date, entry_json",
    );
    // 요즘 어떻게 지내는지 적어 두던 note가 recent_note 자리로 간다.
    rebuild(
      "cast_members",
      "id, character_id, owner, name, relation_label, recent_note, created_at",
      "id, character_id, who, name, relation, note, created_at",
    );
    rebuild(
      "arcs",
      "character_id, period, content",
      "character_id, horizon, content",
    );
    // 출처는 지금 값에서 알아낼 수 없어 전부 대화로 두고, 캐릭터를 옮길 때 바로잡는다.
    rebuild(
      "schedules",
      "id, character_id, owner, date, time_hint, content, status, created_at",
      "id, character_id, who, date, time_hint, content, status, created_at",
    );
    rebuild(
      "day_plans",
      "character_id, date, plan_json, made_by",
      `character_id, date, plan_json, CASE source WHEN 'lazy' THEN 'ondemand' ELSE source END`,
    );
    rebuild(
      "day_seeds",
      "character_id, date, energy, wake_hint, mood, reason",
      "character_id, date, energy, wake_hint, mood, note",
    );
    // 선톡 문안 테이블은 v4에서 scheduled_messages로 이름이 바뀌었다. 옛 DB는 여기서 새 이름으로 간다.
    rebuild(
      "scheduled_messages",
      "id, character_id, chat_id, date, window_start, window_end, text, kind, status, skip_reason, attempts, last_error, created_at, sent_at",
      `id, character_id, chat_id, date, window_start, window_end, text,
       CASE kind WHEN 'reconnect' THEN 'checkin' ELSE kind END,
       status, reason, attempts, last_error, created_at, sent_at`,
      "scheduled_sends",
    );
    // 모델 API가 대화 기록을 받을 때 쓰는 이름에 맞춰 char를 assistant로 바꾼다.
    rebuild(
      "messages",
      "id, chat_id, character_id, sent_at, role, text, meta_json",
      `id, chat_id, character_id, ts,
       CASE role WHEN 'char' THEN 'assistant' ELSE role END,
       text,
       CASE
         WHEN json_extract(meta_json, '$.kind') = 'presence' THEN json_set(meta_json, '$.kind', 'away')
         WHEN json_extract(meta_json, '$.kind') = 'reconnect' THEN json_set(meta_json, '$.kind', 'checkin')
         WHEN json_extract(meta_json, '$.kind') = 'followup'
           THEN json_set(meta_json, '$.kind', CASE WHEN CAST(substr(ts, 12, 2) AS INTEGER) < 5 THEN 'goodnight' ELSE 'catchup' END)
         ELSE meta_json
       END`,
    );
    rebuild(
      "send_failures",
      "id, chat_id, character_id, kind, error, failed_at",
      // 팔로업은 보낸 시각으로 갈린다 — 새벽 5시 전이면 밤 인사, 나머지는 근황이다.
      `id, chat_id, character_id,
       CASE kind
         WHEN 'presence' THEN 'away'
         WHEN 'reconnect' THEN 'checkin'
         WHEN 'followup' THEN CASE WHEN CAST(substr(ts, 12, 2) AS INTEGER) < 5 THEN 'goodnight' ELSE 'catchup' END
         ELSE kind END,
       error, ts`,
    );
    rebuild("recovery_marks", "chat_id, replied_up_to", "chat_id, user_ts");

    createSchema();

    const broken = db.pragma("foreign_key_check") as unknown[];
    if (broken.length)
      throw new Error(
        `[db] 마이그레이션 후 외래 키가 맞지 않는 행 ${broken.length}개 — 되돌린다`,
      );
    db.pragma(`user_version = 1`);
  })();

  db.pragma("legacy_alter_table = OFF");
  console.log(`[db] 스키마를 v1으로 옮겼다`);
};

if (hasLegacySchema() && schemaVersion() < 1) migrateToV1();
else createSchema();

// v3: 저장된 각본 블록의 답장 여건·활동 성격을 한글에서 영어 식별자로 바꾼다.
// 두 태그는 plan_json 안에 있어 CHECK도 UNIQUE도 닿지 않는다. SQL replace()로 문자열을 바꾸면
// activity 텍스트에 든 같은 낱말("불가피한 일정")까지 건드리므로, 행마다 JSON을 파싱해서 옮긴다.
const migratePlanTags = (): number => {
  const rows = db
    .prepare(`SELECT character_id, date, plan_json FROM day_plans`)
    .all() as { character_id: number; date: string; plan_json: string }[];
  const upd = db.prepare(
    `UPDATE day_plans SET plan_json = ? WHERE character_id = ? AND date = ?`,
  );
  let moved = 0;
  for (const r of rows) {
    let plan: { blocks?: Record<string, unknown>[] };
    try {
      plan = JSON.parse(r.plan_json) as { blocks?: Record<string, unknown>[] };
    } catch {
      continue; // 깨진 행은 건너뛴다 — 읽는 쪽도 파싱 실패를 이미 견딘다
    }
    if (!Array.isArray(plan.blocks)) continue;
    let touched = false;
    for (const b of plan.blocks) {
      const resp = toResponsiveness(b.responsiveness);
      if (resp && b.responsiveness !== resp) {
        b.responsiveness = resp;
        touched = true;
      }
      const cat = toActivityCategory(b.category);
      if (cat && b.category !== cat) {
        b.category = cat;
        touched = true;
      }
    }
    if (!touched) continue;
    upd.run(JSON.stringify(plan), r.character_id, r.date);
    moved++;
  }
  return moved;
};

// v2: areas에 note 컬럼 추가. CREATE TABLE IF NOT EXISTS는 이미 있는 테이블을
// 건드리지 않아서, v1 DB는 여기서 ALTER로 따라잡는다.
if (schemaVersion() < 3) {
  db.transaction(() => {
    const areaCols = db.prepare(`PRAGMA table_info(areas)`).all() as {
      name: string;
    }[];
    if (!areaCols.some((c) => c.name === "note"))
      db.exec(`ALTER TABLE areas ADD COLUMN note TEXT`);
    // 대기 답장이 답장인지 복구분인지 — 보낸 뒤 기록에 그대로 남긴다.
    const pendingCols = db
      .prepare(`PRAGMA table_info(pending_replies)`)
      .all() as {
      name: string;
    }[];
    if (pendingCols.length && !pendingCols.some((c) => c.name === "kind"))
      db.exec(
        `ALTER TABLE pending_replies ADD COLUMN kind TEXT NOT NULL DEFAULT 'reply' CHECK (kind IN ('reply','recover'))`,
      );
    const moved = migratePlanTags();
    if (moved) console.log(`[db] 각본 ${moved}일치의 태그를 식별자로 옮겼다`);
    db.pragma(`user_version = 3`);
  })();
}

// v4: 기억을 저장 항목 셋으로 줄이고, 관계를 컬럼으로 나누고, 선톡 문안 테이블 이름을 바꾼다.
//
// 기억은 정체성과 알게 된 유저 사실이 사실 하나로 합쳐지고, 캐릭터와 유저의 관계는
// relationships의 컬럼으로 옮겨 간다. 옮겨 갈 자리가 없는 관계 행과, 전용 컬럼이 받지 못하는
// extra_json 값이 있어서 옛 테이블을 memory_items_legacy로 남긴다 — 관계 컬럼의 초기값을
// 채우는 데이터 이관 회차가 이 표를 읽고, 그 회차가 끝나면 지운다.
const migrateToV4 = (): void => {
  const columns = (table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name,
    );
  const tableExists = (name: string): boolean =>
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) !== undefined;

  const memoryIsOld = columns("memory_items").includes("extra_json");
  const relationIsOld = !columns("relationships").includes("stage");
  const sendsAreOld = tableExists("scheduled_sends");
  if (!memoryIsOld && !relationIsOld && !sendsAreOld) {
    db.pragma(`user_version = 4`);
    return;
  }

  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");

  db.transaction(() => {
    if (memoryIsOld) {
      db.exec(`ALTER TABLE memory_items RENAME TO memory_items_legacy`);
      // 인덱스 이름은 DB 전체에서 하나뿐이라, 옛 테이블을 따라간 이름을 먼저 비운다.
      db.exec(`DROP INDEX IF EXISTS idx_memory_items_type`);
      db.exec(`CREATE TABLE memory_items (${TABLES.memory_items}\n)`);
      // 정체성과 알게 된 유저 사실이 사실 하나로 합쳐진다. 진행 중인 일의 끝나는 조건은
      // extra_json에 있던 ends_when이 전용 컬럼으로 온다. 관계 행은 옮기지 않는다.
      db.exec(`
        INSERT INTO memory_items
          (id, character_id, item_type, owner, area, subject, value, origin, user_knows,
           end_condition, retrieval_count, updated_at)
        SELECT id, character_id,
               CASE item_type WHEN 'ongoing' THEN 'ongoing' ELSE 'fact' END,
               owner, area, subject, value,
               CASE origin WHEN 'seed' THEN 'creation' ELSE 'conversation' END,
               CASE owner WHEN 'user' THEN 'known' ELSE user_knows END,
               CASE WHEN item_type = 'ongoing'
                    THEN json_extract(extra_json, '$.ends_when') END,
               0, updated_at
          FROM memory_items_legacy
         WHERE item_type <> 'relationship'`);
      // 옮기지 않은 행의 태그를 지운다. 남겨 두면 없는 기억을 가리키는 태그가 검색에 걸린다.
      db.exec(`
        DELETE FROM tags
         WHERE kind = 'memory'
           AND ref_id IN (SELECT id FROM memory_items_legacy
                           WHERE item_type = 'relationship')`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_memory_items_type ON memory_items (character_id, item_type)`,
      );
    }

    if (relationIsOld)
      for (const sql of [
        `ALTER TABLE relationships ADD COLUMN stage TEXT`,
        `ALTER TABLE relationships ADD COLUMN speech_level TEXT CHECK (speech_level IN ('polite','casual'))`,
        `ALTER TABLE relationships ADD COLUMN speech_note TEXT`,
        `ALTER TABLE relationships ADD COLUMN address_terms TEXT`,
        `ALTER TABLE relationships ADD COLUMN texture TEXT`,
        `ALTER TABLE relationships ADD COLUMN rapport TEXT`,
        `ALTER TABLE relationships ADD COLUMN cautions TEXT`,
        `ALTER TABLE relationships ADD COLUMN history TEXT`,
        `ALTER TABLE relationships ADD COLUMN feelings TEXT`,
        `ALTER TABLE relationships ADD COLUMN updated_at TEXT`,
      ])
        db.exec(sql);

    if (sendsAreOld) {
      // 새 이름의 빈 테이블은 부팅할 때 이미 만들어졌다. 값을 옮기고 옛 테이블을 지운다.
      db.exec(`
        INSERT INTO scheduled_messages
          (id, character_id, chat_id, date, window_start, window_end, text, kind,
           status, skip_reason, attempts, last_error, created_at, sent_at)
        SELECT id, character_id, chat_id, date, window_start, window_end, text, kind,
               status, skip_reason, attempts, last_error, created_at, sent_at
          FROM scheduled_sends`);
      db.exec(`DROP TABLE scheduled_sends`);
    }

    const broken = db.pragma("foreign_key_check") as unknown[];
    if (broken.length)
      throw new Error(
        `[db] 마이그레이션 후 외래 키가 맞지 않는 행 ${broken.length}개 — 되돌린다`,
      );
    db.pragma(`user_version = 4`);
  })();

  db.pragma("legacy_alter_table = OFF");
  console.log(`[db] 스키마를 v4로 옮겼다`);
};

// v5: 모델 호출 원본 표 둘을 만들고, 슬랙 트레이스 게시함의 이름을 trace_events로 바꾼다.
// 새 표는 부팅할 때 createSchema가 이미 만들었다 — 여기서는 옛 이름에 남은 행만 옮긴다.
const migrateToV5 = (): void => {
  const vizIsOld =
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get("viz_events") !== undefined;
  if (!vizIsOld) {
    db.pragma(`user_version = 5`);
    return;
  }

  db.transaction(() => {
    db.exec(`
      INSERT INTO trace_events
        (id, character_id, kind, dedupe_key, thread_key, parent_key, text,
         status, slack_ts, attempts, last_error, created_at)
      SELECT id, character_id, kind, dedupe_key, thread_key, parent_key, text,
             status, slack_ts, attempts, last_error, created_at
        FROM viz_events`);
    db.exec(`DROP TABLE viz_events`);

    const broken = db.pragma("foreign_key_check") as unknown[];
    if (broken.length)
      throw new Error(
        `[db] 마이그레이션 후 외래 키가 맞지 않는 행 ${broken.length}개 — 되돌린다`,
      );
    db.pragma(`user_version = 5`);
  })();

  console.log(`[db] 스키마를 v5로 옮겼다`);
};

if (schemaVersion() < 4) migrateToV4();
if (schemaVersion() < SCHEMA_VERSION) migrateToV5();

// pending_replies에 kind='wake'와 meta_json을 더한다. CHECK를 바꾸려면 테이블을 다시 만들어야
// 한다. 버전 번호 대신 테이블 모양을 보고 판단한다 — 같은 시기의 다른 마이그레이션과 번호를
// 다투지 않고, 어느 쪽이 먼저 적용돼도 안전하다.
const migratePendingWake = (): void => {
  const row = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pending_replies'`,
    )
    .get() as { sql: string } | undefined;
  if (!row || (row.sql.includes("'wake'") && row.sql.includes("meta_json")))
    return;

  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  db.transaction(() => {
    db.exec(`ALTER TABLE pending_replies RENAME TO pending_replies_old`);
    db.exec(`DROP INDEX IF EXISTS idx_pending_replies_due`);
    db.exec(`DROP INDEX IF EXISTS idx_pending_replies_chat`);
    db.exec(`CREATE TABLE pending_replies (${TABLES.pending_replies}\n)`);
    db.exec(`
      INSERT INTO pending_replies
        (id, chat_id, character_id, user_msg_at, bubbles_json, note_to_save,
         send_at, kind, status, attempts, last_error, created_at, sent_at)
      SELECT id, chat_id, character_id, user_msg_at, bubbles_json, note_to_save,
             send_at, kind, status, attempts, last_error, created_at, sent_at
        FROM pending_replies_old`);
    db.exec(`DROP TABLE pending_replies_old`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_pending_replies_due ON pending_replies (status, send_at)`,
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_pending_replies_chat ON pending_replies (chat_id, status)`,
    );
    const broken = db.pragma("foreign_key_check") as unknown[];
    if (broken.length)
      throw new Error(
        `[db] pending_replies 재생성 후 외래 키가 맞지 않는 행 ${broken.length}개 — 되돌린다`,
      );
  })();
  db.pragma("legacy_alter_table = OFF");
  console.log(`[db] pending_replies에 wake·meta_json을 더했다`);
};
migratePendingWake();

// 컬럼만 늘리는 변경. 위 wake 이관과 같은 이유로 버전을 올리지 않고 컬럼 유무를 보고 붙인다.
const addColumn = (
  table: string,
  column: string,
  ddl: string,
  after?: () => void,
): void => {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!cols.length || cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  after?.();
  console.log(`[db] ${table}에 ${column} 칸을 더했다`);
};

// 어디까지 슬랙에 게시했는지 표시한다. 이미 쌓여 있던 호출은 게시한 것으로 친다 —
// 트레이스를 처음 켤 때 지난 기록이 한꺼번에 채널로 쏟아지지 않게.
addColumn("llm_calls", "traced", "traced INTEGER NOT NULL DEFAULT 0", () => {
  db.exec(`UPDATE llm_calls SET traced = 1`);
});
// 이 답장을 만든 호출 번호. 발송·폐기 결과를 그 답장 스레드에 달 때 쓴다.
addColumn("pending_replies", "call_id", "call_id INTEGER");

db.pragma("foreign_keys = ON");

export interface CharacterRow {
  id: number;
  chat_id: string;
  status: string;
  genesis_json: string;
  created_at: string;
}

export interface MessageRow {
  id: number;
  role: string;
  text: string;
  sent_at: string;
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
    `INSERT INTO relationships (character_id, met_at, legacy_state_json) VALUES (?, ?, ?)`,
  ).run(characterId, now, JSON.stringify(emptyRelationshipState()));
  return characterId;
};

export const getRelationshipState = (
  characterId: number,
): RelationshipState => {
  const row = db
    .prepare(
      `SELECT legacy_state_json FROM relationships WHERE character_id = ?`,
    )
    .get(characterId) as { legacy_state_json: string | null } | undefined;
  if (!row?.legacy_state_json) return emptyRelationshipState();
  try {
    return JSON.parse(row.legacy_state_json) as RelationshipState;
  } catch (e) {
    // 손상된 state_json 하나가 실시간 응답 경로 전체(buildSystemPrompt)를 죽이지 않게 빈 상태로
    // 강등한다. 원본 행은 건드리지 않지만, 이 상태에서 밤 정리·캡처가 save하면 빈 상태로 덮어써질
    // 수 있다 — 그래서 조용히 넘기지 않고 크게 로그를 남긴다(발견 즉시 행 복구가 우선).
    console.error(
      `[db] 관계 상태 파싱 실패 — 빈 상태로 강등 (character=${characterId}, len=${row.legacy_state_json.length}):`,
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
    `UPDATE relationships SET legacy_state_json = ?, last_contact_at = ? WHERE character_id = ?`,
  ).run(JSON.stringify(state), now, characterId);
};

export const getMetAt = (characterId: number): string | undefined => {
  const row = db
    .prepare(`SELECT met_at FROM relationships WHERE character_id = ?`)
    .get(characterId) as { met_at: string } | undefined;
  return row?.met_at;
};

/** 생성 배치가 채우는 관계 첫 값. 여덟 항목 중 여섯 — 잘 통하는 것(rapport)과
 * 조심할 것(cautions)은 대화가 쌓여야 알 수 있어 비운 채 시작한다. */
export interface RelationshipFirstValues {
  stage: string;
  speechLevel: SpeechLevel;
  speechNote: string;
  addressTerms: string;
  texture: string;
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
       texture = ?, history = ?, feelings = ?, updated_at = ?
     WHERE character_id = ?`,
  ).run(
    v.stage,
    v.speechLevel,
    v.speechNote,
    v.addressTerms,
    v.texture,
    v.history,
    v.feelings,
    now,
    characterId,
  );
};

/** 관계 여덟 항목 컬럼을 그대로 읽는 행. 프롬프트 조립이 쓴다. */
export interface RelationshipRow {
  stage: string | null;
  speech_level: SpeechLevel | null;
  speech_note: string | null;
  address_terms: string | null;
  texture: string | null;
  rapport: string | null;
  cautions: string | null;
  history: string | null;
  feelings: string | null;
  met_at: string | null;
  last_contact_at: string | null;
  updated_at: string | null;
}

export const getRelationship = (
  characterId: number,
): RelationshipRow | undefined =>
  db
    .prepare(
      `SELECT stage, speech_level, speech_note, address_terms, texture,
              rapport, cautions, history, feelings,
              met_at, last_contact_at, updated_at
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
  texture?: string;
  rapport?: string;
  cautions?: string;
  history?: string;
  feelings?: string;
}

const NOTE_COLUMNS: Record<keyof RelationshipNotes, string> = {
  stage: "stage",
  speechNote: "speech_note",
  addressTerms: "address_terms",
  texture: "texture",
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

export const logMessage = (
  chatId: string,
  characterId: number | null,
  role: "user" | "assistant",
  text: string,
  sentAt: string,
  meta?: Record<string, unknown>,
): void => {
  db.prepare(
    `INSERT INTO messages (chat_id, character_id, sent_at, role, text, meta_json) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    chatId,
    characterId,
    sentAt,
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
      `SELECT id, role, text, sent_at FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(chatId, limit) as MessageRow[];
  return rows.reverse();
};

// 특정 시각 이전의 마지막 메시지 — '직전에 대화한 날'을 세는 데 쓴다.
export const lastMessageBefore = (
  chatId: string,
  before: string,
): MessageRow | undefined =>
  db
    .prepare(
      `SELECT id, role, text, sent_at FROM messages WHERE chat_id = ? AND sent_at < ? ORDER BY id DESC LIMIT 1`,
    )
    .get(chatId, before) as MessageRow | undefined;

// 유저가 연속으로 이어 보낸 메시지 사이의 텀(ms). 봇 응답이 끼지 않은 '이어 보내기'만 센다
// (봇 답장을 사이에 둔 건 새 턴이라 제외, 2분 넘는 텀도 새 턴으로 보고 제외).
// 텀이 길수록 = 한 번에 길게 치는 사람 = 응답 대기를 더 길게 잡아 중간에 끊지 않게 한다.
export const recentUserGaps = (chatId: string, limit = 80): number[] => {
  const rows = db
    .prepare(
      `SELECT role, sent_at FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(chatId, limit) as { role: string; sent_at: string }[];
  rows.reverse();
  const t = (s: string): number =>
    new Date(s.replace(" ", "T") + "+09:00").getTime();
  const gaps: number[] = [];
  for (let i = 1; i < rows.length; i++)
    if (rows[i].role === "user" && rows[i - 1].role === "user") {
      const g = t(rows[i].sent_at) - t(rows[i - 1].sent_at);
      if (g > 0 && g < 120000) gaps.push(g);
    }
  return gaps;
};

// 주변 인물 관계도: 캐릭터의 사람들(owner='char', 씨앗 정체성 + 등장 인물)과
// 유저가 언급한 유저의 사람들(owner='user')을 한 테이블에 소유자 구분으로 쌓는다
export interface CastMember {
  name: string;
  relation_label: string;
  recent_note: string | null;
}

export const getCast = (
  characterId: number,
  owner: "char" | "user" = "char",
): CastMember[] =>
  db
    .prepare(
      `SELECT name, relation_label, recent_note FROM cast_members WHERE character_id = ? AND owner = ? ORDER BY id`,
    )
    .all(characterId, owner) as CastMember[];

export const addCastMember = (
  characterId: number,
  owner: "char" | "user",
  name: string,
  relationLabel: string,
  recentNote: string | null,
  now: string,
): void => {
  // 이름이 곧 키다 — 같은 이름이 캐릭터 쪽과 유저 쪽에 따로 서지 않게 소유자를 빼고 본다.
  const dup = db
    .prepare(
      `SELECT 1 FROM cast_members WHERE character_id = ? AND name = ? LIMIT 1`,
    )
    .get(characterId, name);
  if (dup) return;
  db.prepare(
    `INSERT INTO cast_members (character_id, owner, name, relation_label, recent_note, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(characterId, owner, name, relationLabel, recentNote, now);
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
      `SELECT text FROM messages WHERE chat_id = ? AND role = 'assistant'
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
    .prepare(`SELECT period, content FROM arcs WHERE character_id = ?`)
    .all(characterId) as { period: string; content: string }[];
  return Object.fromEntries(rows.map((r) => [r.period, r.content]));
};

export const saveArc = (
  characterId: number,
  period: "year" | "season" | "month" | "week",
  content: string,
): void => {
  db.prepare(
    `INSERT OR REPLACE INTO arcs (character_id, period, content) VALUES (?, ?, ?)`,
  ).run(characterId, period, content);
};

// 컨디션/기상 리듬 시드: 월 단위로 미리 깔아두는 하루의 성향(기력·기상·기분).
// 이벤트(회식 등)의 여파가 다음날 시드에 인과로 이어지게 밤 정리가 한 달치를 생성한다.
// 하루 각본은 이 시드 + 어제 일기(실제 여파)를 이어 그날 기상 시각·활동량을 확정한다.
export interface DaySeed {
  date: string;
  energy: string; // 낮음 | 보통 | 높음
  wake_hint: string; // 이른 | 보통 | 늦잠
  mood: string; // 짧은 구
  reason: string | null; // 왜 이런지 (예: 어제 회식 여파)
}

export const getDaySeed = (
  characterId: number,
  date: string,
): DaySeed | undefined =>
  db
    .prepare(
      `SELECT date, energy, wake_hint, mood, reason FROM day_seeds WHERE character_id = ? AND date = ?`,
    )
    .get(characterId, date) as DaySeed | undefined;

export const getMonthSeeds = (
  characterId: number,
  ym: string, // "YYYY-MM"
): DaySeed[] =>
  db
    .prepare(
      `SELECT date, energy, wake_hint, mood, reason FROM day_seeds WHERE character_id = ? AND date LIKE ? ORDER BY date`,
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
    `INSERT OR REPLACE INTO day_seeds (character_id, date, energy, wake_hint, mood, reason) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(characterId, s.date, s.energy, s.wake_hint, s.mood, s.reason ?? null);
};

// 일정 슬롯: 하루 각본보다 성긴 층. 캐릭터의 예정(owner='char')과 유저에게 들은 예정(owner='user')을
// 캐릭터별로 보관한다. 대화에서 잡힌 약속의 추출·기록은 밤 정리 몫.
export interface ScheduleRow {
  id: number;
  owner: string;
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
      `SELECT id, owner, date, time_hint, content FROM schedules
       WHERE character_id = ? AND status = 'active' AND date >= ?
       ORDER BY date, id LIMIT ?`,
    )
    .all(characterId, fromDate, limit) as ScheduleRow[];

// 그날 유저에게 있는 일정 — 오래 답이 없는 동안에도 이 일정만은 챙겨 아침에 한 통 보낸다.
export const hasUserScheduleOn = (characterId: number, date: string): boolean =>
  !!db
    .prepare(
      `SELECT 1 FROM schedules WHERE character_id = ? AND owner = 'user' AND status = 'active' AND date = ? LIMIT 1`,
    )
    .get(characterId, date);

export const addSchedule = (
  characterId: number,
  owner: "char" | "user",
  date: string,
  timeHint: string | null,
  content: string,
  now: string,
): void => {
  db.prepare(
    `INSERT INTO schedules (character_id, owner, date, time_hint, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(characterId, owner, date, timeHint, content, now);
};

export const getSchedulesInMonth = (
  characterId: number,
  ym: string, // "YYYY-MM"
  owner?: "char" | "user",
): ScheduleRow[] =>
  db
    .prepare(
      `SELECT id, owner, date, time_hint, content FROM schedules
       WHERE character_id = ? AND status = 'active' AND date LIKE ?${owner ? " AND owner = ?" : ""}
       ORDER BY date, id`,
    )
    .all(
      ...(owner ? [characterId, `${ym}-%`, owner] : [characterId, `${ym}-%`]),
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
  kind: string; // morning | checkin
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
  kind: "morning" | "checkin" = "morning",
): void => {
  const dup = db
    .prepare(
      `SELECT 1 FROM scheduled_messages WHERE character_id = ? AND date = ? LIMIT 1`,
    )
    .get(characterId, date);
  if (dup) return; // 하루 1통
  db.prepare(
    `INSERT INTO scheduled_messages (character_id, chat_id, date, window_start, window_end, text, created_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(characterId, chatId, date, windowStart, windowEnd, text, now, kind);
};

export const getPendingSends = (date: string): ScheduledSendRow[] =>
  db
    .prepare(
      `SELECT id, character_id, chat_id, date, window_start, window_end, text, kind, attempts FROM scheduled_messages WHERE status = 'pending' AND date = ?`,
    )
    .all(date) as ScheduledSendRow[];

export const markScheduledSend = (
  id: number,
  status: "sent" | "skipped",
  skipReason: string | null,
  sentAt: string | null,
): void => {
  db.prepare(
    `UPDATE scheduled_messages SET status = ?, skip_reason = ?, sent_at = ? WHERE id = ?`,
  ).run(status, skipReason, sentAt, id);
};

// 전송 실패를 행에 남긴다 — 로그를 뒤지지 않고도 "몇 번 시도했고 왜 못 갔는지"가 보이게.
// (정상 스킵과 네트워크 실패가 똑같이 '발송 창 지남'으로 뭉뚱그려지던 걸 가르는 근거)
export const recordSendAttempt = (id: number, error: string): void => {
  db.prepare(
    `UPDATE scheduled_messages SET attempts = attempts + 1, last_error = ? WHERE id = ?`,
  ).run(error.slice(0, 300), id);
};

// scheduled_messages 밖의 선톡(팔로업·자리비움 예고) 전송 실패 흔적. 이 메시지들은 순간에 묶여 있어
// 유예·재시도가 없다 — 대신 실패했다는 사실만은 콘솔이 아니라 DB에 남겨 사후 추적이 되게 한다.
export const recordSendFailure = (
  chatId: string,
  characterId: number,
  kind: "away" | "catchup" | "goodnight",
  error: string,
): void => {
  const failedAt = `${kstDateString()} ${getKstNow().toISOString().slice(11, 19)}`;
  db.prepare(
    `INSERT INTO send_failures (chat_id, character_id, kind, error, failed_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(chatId, characterId, kind, error.slice(0, 300), failedAt);
};

// LLM 사용량을 논리일×모델 단위로 누적한다 — 캐시 절감이 실제로 작동하는지 로그를 뒤지지 않고
// DB 질의 한 줄로 확인할 수 있게(cache_read가 input보다 훨씬 크게 유지되는 것이 정상 상태).
export const recordLlmUsage = (
  model: string,
  inputTokens: number,
  cacheWriteTokens: number,
  cacheReadTokens: number,
  outputTokens: number,
): void => {
  db.prepare(
    `INSERT INTO llm_usage (date, model, calls, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens)
     VALUES (?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(date, model) DO UPDATE SET
       calls = calls + 1,
       input_tokens = input_tokens + excluded.input_tokens,
       cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
       cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
       output_tokens = output_tokens + excluded.output_tokens`,
  ).run(
    kstLogicalDate(),
    model,
    inputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    outputTokens,
  );
};

// ── 모델 호출 원본 ─────────────────────────────────────────────────────────
// 호출 하나가 행 하나다. 프롬프트·출력 본문은 내용 해시를 키로 prompt_blobs에 한 벌만 둔다 —
// 앞 두 층은 하루 종일 같은 글자라, 호출마다 본문을 다시 담으면 DB가 호출 수만큼 커진다.

const stampNow = (): string =>
  `${kstDateString()} ${getKstNow().toISOString().slice(11, 19)}`;

/** 본문을 넣고 해시를 돌려준다. 같은 내용이면 새로 쌓지 않고 마지막으로 쓴 시각만 올린다. */
export const putBlob = (text: string): string => {
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const now = stampNow();
  db.prepare(
    `INSERT INTO prompt_blobs (hash, text, bytes, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(hash) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  ).run(hash, text, Buffer.byteLength(text, "utf8"), now, now);
  return hash;
};

/** 해시로 본문을 되찾는다. 보관 기간이 지나 지워졌으면 null. */
export const getBlob = (hash: string): string | null =>
  (
    db.prepare(`SELECT text FROM prompt_blobs WHERE hash = ?`).get(hash) as
      | { text: string }
      | undefined
  )?.text ?? null;

export interface LlmCallInput {
  purpose: string;
  model: string;
  characterId?: number;
  chatId?: string;
  maxTokens?: number;
  /** JSON 재요청처럼 같은 자리에서 두 번 부른 경우의 차례. */
  attempt?: number;
  system: { text: string; cache?: boolean }[];
  /** 함께 보낸 대화 기록을 그대로 담은 글자. */
  turns: string;
  output?: string;
  usage?: {
    input: number;
    cacheWrite: number;
    cacheRead: number;
    output: number;
  };
  latencyMs: number;
  error?: string;
  codeVersion?: string;
}

/** 호출 한 건을 남기고 행 번호를 돌려준다. 뒤에 판단 근거를 붙일 때 이 번호를 쓴다. */
export const recordLlmCall = (call: LlmCallInput): number => {
  const hashes = call.system.map((b) => ({
    h: putBlob(b.text),
    cache: b.cache === true,
  }));
  const info = db
    .prepare(
      `INSERT INTO llm_calls
         (character_id, chat_id, purpose, model, max_tokens, attempt,
          system_hashes, turns_hash, output_hash,
          input_tokens, cache_write_tokens, cache_read_tokens, output_tokens,
          latency_ms, error, code_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      call.characterId ?? null,
      call.chatId ?? null,
      call.purpose,
      call.model,
      call.maxTokens ?? null,
      call.attempt ?? 1,
      JSON.stringify(hashes),
      putBlob(call.turns),
      call.output === undefined ? null : putBlob(call.output),
      call.usage?.input ?? null,
      call.usage?.cacheWrite ?? null,
      call.usage?.cacheRead ?? null,
      call.usage?.output ?? null,
      call.latencyMs,
      call.error ? call.error.slice(0, 500) : null,
      call.codeVersion ?? null,
      stampNow(),
    );
  return Number(info.lastInsertRowid);
};

/** 호출 행에 그때의 판단 근거를 붙인다 — 검색한 태그와 기억, 답장 텀, 말풍선 수. */
export const setCallContext = (callId: number, context: unknown): void => {
  db.prepare(`UPDATE llm_calls SET context_json = ? WHERE id = ?`).run(
    JSON.stringify(context),
    callId,
  );
};

// 본문 보관 기간. 지나면 본문을 가리키는 해시와 판단 근거를 지우고 메타(언제·무슨 호출·
// 토큰·지연)만 남긴다 — 본문에는 실제 대화가 통째로 들어 있어 오래 들고 있을 것이 아니고,
// 며칠 뒤에 다시 열어 보는 일도 없다. 메타는 가벼워서 계속 둔다.
export const LLM_CALL_RETENTION_DAYS = 90;

export const pruneLlmCalls = (
  days: number = LLM_CALL_RETENTION_DAYS,
): { calls: number; blobs: number } => {
  const cutoff = kstDateString(
    new Date(getKstNow().getTime() - days * 86400000),
  );
  const calls = db
    .prepare(
      `UPDATE llm_calls
          SET system_hashes = NULL, turns_hash = NULL, output_hash = NULL, context_json = NULL
        WHERE created_at < ?
          AND (system_hashes IS NOT NULL OR turns_hash IS NOT NULL
               OR output_hash IS NOT NULL OR context_json IS NOT NULL)`,
    )
    .run(cutoff).changes;
  // 아무 호출도 가리키지 않게 된 본문을 지운다. 같은 본문을 여러 호출이 가리키므로
  // 행을 지울 때가 아니라 여기서 한 번에 센다.
  const blobs = db
    .prepare(
      `DELETE FROM prompt_blobs
        WHERE hash NOT IN (
              SELECT turns_hash FROM llm_calls WHERE turns_hash IS NOT NULL
              UNION SELECT output_hash FROM llm_calls WHERE output_hash IS NOT NULL
              UNION SELECT json_extract(j.value, '$.h')
                      FROM (SELECT system_hashes FROM llm_calls
                             WHERE system_hashes IS NOT NULL) c,
                           json_each(c.system_hashes) j)`,
    )
    .run().changes;
  return { calls, blobs };
};

// 게시함 보관 기간. 지나면 행을 통째로 지운다 — 이미 올라간 글은 슬랙이 들고 있고, 이 표는
// 무엇을 올릴지 쌓아 두는 자리라 올리고 난 뒤에는 같은 글을 두 번 올리지 않게 막는 몫만 남는다.
// 그 몫(dedupe_key)이 필요한 기간은 게시 자리마다 길어야 하루다 — 아침 각본 알림은 오늘 날짜만
// 보고, 프롬프트 고정 두 덩이는 논리일마다 키가 갈리고, 호출 게시는 llm_calls.traced 표시와
// 3시간 상한이 막고, 새벽 정리는 그 날짜 일기가 있으면 게시까지 건너뛴다. 하루치를 지워 다시
// 보내는 tools/retrace.ts가 그보다 뒤 날짜를 볼 수 있어, 여유를 크게 두고 30일로 잡았다.
export const TRACE_EVENT_RETENTION_DAYS = 30;

// 기간이 지나도 남기는 행. 하나라도 참이면 지우지 않는다 — 뺄 행이 생기면 여기에 한 줄 더한다.
// 조건은 NULL을 내지 않게 쓴다. NOT (거짓 OR NULL)은 NULL이라 그 행이 조용히 안 지워진다.
const TRACE_EVENT_KEEP = [
  // 아직 슬랙에 못 올라간 행. 여기서 지우면 영영 못 올린다.
  `status = 'pending'`,
  // 아직 못 올라간 자식이 매달린 부모. 부모를 먼저 지우면 자식이 스레드를 잃고 접힌다.
  `(thread_key IS NOT NULL
        AND thread_key IN (SELECT parent_key FROM trace_events
                            WHERE status = 'pending' AND parent_key IS NOT NULL))`,
];

/**
 * 보관 기간이 지난 게시 행을 지운다. 올리지 못한 failed·skipped도 함께 지운다 — 슬랙 설정이
 * 잘못된 채로 오래 두면 모든 행이 failed가 되므로, 이것만 빼 두면 표가 다시 끝없이 커진다.
 * 무엇이 왜 실패했는지는 게시를 포기하는 자리에서 로그로 남는다.
 */
export const pruneTraceEvents = (
  days: number = TRACE_EVENT_RETENTION_DAYS,
): number => {
  const cutoff = kstDateString(
    new Date(getKstNow().getTime() - days * 86400000),
  );
  return db
    .prepare(
      `DELETE FROM trace_events
        WHERE created_at < ?
          AND NOT (${TRACE_EVENT_KEEP.join(" OR ")})`,
    )
    .run(cutoff).changes;
};

export const hasUserMessageSince = (chatId: string, since: string): boolean =>
  !!db
    .prepare(
      `SELECT 1 FROM messages WHERE chat_id = ? AND role = 'user' AND sent_at >= ? LIMIT 1`,
    )
    .get(chatId, since);

// 유저가 마지막으로 말한 시각 — 선톡 셋(근황·밤 인사·자리비움)이 무응답 시간을 재는 기준.
export const lastUserTs = (chatId: string): string | undefined =>
  (
    db
      .prepare(
        `SELECT sent_at FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1`,
      )
      .get(chatId) as { sent_at: string } | undefined
  )?.sent_at;

// 마지막 메시지(유저·캐릭 무관)의 시각·역할 — 침묵 팔로업 판단용
export const lastMessage = (
  chatId: string,
): { sent_at: string; role: string } | undefined =>
  db
    .prepare(
      `SELECT sent_at, role FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(chatId) as { sent_at: string; role: string } | undefined;

// 오늘(새벽 5시 이후) 캐릭터가 먼저 보낸 선톡 수 — 하루 총량 상한을 지키는 데 쓴다.
// followup·dispatch가 공유한다. 채널별 상한만 있으면 합이 통제되지 않아서, 각자 자기 몫을
// 다 쓰면 하루 10통까지 나갈 수 있었다.
//
// 자리비움 선톡은 여기서 뺀다 — 캐릭터가 나갔다 오는 일정 수만큼 나가는 말이라 성격이
// 다르고, 그쪽은 AWAY_DAILY_MAX가 따로 막는다.
export const proactiveCountToday = (chatId: string, since: string): number =>
  (
    db
      .prepare(
        `SELECT count(*) c FROM messages WHERE chat_id = ? AND role = 'assistant' AND sent_at >= ?
           AND meta_json LIKE '%proactive%' AND meta_json NOT LIKE '%"kind":"away"%'`,
      )
      .get(chatId, since) as { c: number }
  ).c;

// 오늘 보낸 선톡을 종류별로 센다.
export const proactiveKindCountToday = (
  chatId: string,
  since: string,
  kind: string,
): number =>
  (
    db
      .prepare(
        `SELECT count(*) c FROM messages WHERE chat_id = ? AND role = 'assistant' AND sent_at >= ? AND meta_json LIKE ?`,
      )
      .get(chatId, since, `%"kind":"${kind}"%`) as { c: number }
  ).c;

// 오늘 알리고 나간 자리비움 선톡 수. 돌아와서 하는 인사는 이미 알린 구간을 마무리하는
// 말이라 빼고 센다.
export const awayNoticeCountToday = (chatId: string, since: string): number =>
  (
    db
      .prepare(
        `SELECT count(*) c FROM messages WHERE chat_id = ? AND role = 'assistant' AND sent_at >= ?
           AND meta_json LIKE '%"kind":"away"%' AND meta_json NOT LIKE '%"return"%'`,
      )
      .get(chatId, since) as { c: number }
  ).c;

// 유저 선호(매칭 전용, 캐릭터에 비주입). 밤 정리가 대화 내용으로 뽑아 누적한다.
// topics = 유저가 몰입하는 소재(영화·투자…), facets = 캐릭터의 어떤 성향에 반응이 좋은지(태도·위트·직업·취미…).
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

// 캐릭터 프롬프트에 들어가는 유저 프로필. user_preferences(매칭 전용·비주입)와 달리 이건
// 캐릭터가 상대를 대하는 데 쓰는 공개 정보다. 값이 들어오는 길은 둘로 갈린다 —
// 성별·나이대는 env(USER_GENDER/USER_AGE_BAND)나 가입 때 받고, 하는 일·사는 지역은
// 대화에서 분명히 드러나면 새벽 정리가 채운다(nightly.ts 추출 출력의 user_profile).
// chat_id 기준(교체돼도 유지) — 유저의 정체는 어떤 캐릭터를 만나든 그대로다.
// 이름은 다루지 않는다 — 호칭을 시스템이 강제하면 자리 잡은 반말을 격식체로 되돌리는 회귀가 났다(2026-07-12).
export interface StoredUserProfile {
  gender?: string;
  ageBand?: string;
  job?: string;
  region?: string;
}

export const getUserProfile = (chatId: string): StoredUserProfile => {
  const row = db
    .prepare(
      `SELECT gender, age_band, job, region FROM user_profile WHERE chat_id = ?`,
    )
    .get(chatId) as
    | {
        gender: string | null;
        age_band: string | null;
        job: string | null;
        region: string | null;
      }
    | undefined;
  if (!row) return {};
  return {
    gender: row.gender ?? undefined,
    ageBand: row.age_band ?? undefined,
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
  const ageBand = p.ageBand?.trim() || cur.ageBand;
  const job = p.job?.trim() || cur.job;
  const region = p.region?.trim() || cur.region;
  db.prepare(
    // 이 함수가 맡은 컬럼만 고친다 — REPLACE로 행을 다시 넣으면 가입 때 받는
    // 이름·생년이 같이 지워진다.
    `INSERT INTO user_profile (chat_id, gender, age_band, job, region, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       gender = excluded.gender,
       age_band = excluded.age_band,
       job = excluded.job,
       region = excluded.region,
       updated_at = excluded.updated_at`,
  ).run(
    chatId,
    gender ?? null,
    ageBand ?? null,
    job ?? null,
    region ?? null,
    at,
  );
};

// 마지막 유저 메시지 이후 캐릭터가 먼저 보낸(proactive) 수 — '연속 무응답'을 세어 매달림을 막는다.
export const proactiveSinceLastUser = (chatId: string): number => {
  const lastUser = db
    .prepare(
      `SELECT sent_at FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1`,
    )
    .get(chatId) as { sent_at: string } | undefined;
  const since = lastUser?.sent_at ?? "0000-00-00 00:00:00";
  return (
    db
      .prepare(
        `SELECT count(*) c FROM messages WHERE chat_id = ? AND role = 'assistant' AND sent_at > ? AND meta_json LIKE '%proactive%'`,
      )
      .get(chatId, since) as { c: number }
  ).c;
};

// 복구 워터마크: "이 유저 메시지에는 답장 책임을 졌다"는 표시. 재시작(배포)으로 답장을 보냈지만
// 로그 전에 프로세스가 죽어도, 다음 부팅의 복구가 같은 메시지에 또 답하지 않도록 막는다.
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

// made_by: 밤 정리 정식 생성(nightly) vs 그날 첫 대화에서 만든 임시 각본(ondemand).
// 임시 각본은 어제 일기가 아직 없을 때 만들어진 것이라 밤 정리가 교체할 수 있다.
export const saveDayPlan = (
  characterId: number,
  date: string,
  planJson: string,
  madeBy: "nightly" | "ondemand" = "nightly",
): void => {
  db.prepare(
    `INSERT OR REPLACE INTO day_plans (character_id, date, plan_json, made_by) VALUES (?, ?, ?, ?)`,
  ).run(characterId, date, planJson, madeBy);
};

export const getDayPlanMadeBy = (
  characterId: number,
  date: string,
): string | undefined =>
  (
    db
      .prepare(
        `SELECT made_by FROM day_plans WHERE character_id = ? AND date = ?`,
      )
      .get(characterId, date) as { made_by: string } | undefined
  )?.made_by;

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

/** 태그 검색으로 찾은 일기를 id로 읽는다. 날짜 오름차순. */
export const getDiariesByIds = (
  ids: number[],
): { id: number; date: string; entry_json: string }[] => {
  if (!ids.length) return [];
  const holes = ids.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT id, date, entry_json FROM diary_entries WHERE id IN (${holes}) ORDER BY date`,
    )
    .all(...ids) as { id: number; date: string; entry_json: string }[];
};

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

// ── 대기 중인 답장 ────────────────────────────────────────────────────────
// 답장을 미리 만들어 두고 정한 시각에 보낸다. 몇 시간짜리 대기가 생기므로 행으로 남겨
// 프로세스가 다시 떠도 이어간다.

export interface PendingReplyRow {
  id: number;
  chat_id: string;
  character_id: number;
  user_msg_at: string;
  bubbles_json: string;
  note_to_save: string | null;
  send_at: string;
  kind: string;
  meta_json: string | null;
  /** 이 답장을 만든 모델 호출 번호. 트레이스에서 발송 결과를 그 답장 아래에 단다. */
  call_id: number | null;
  attempts: number;
  created_at: string;
}

export const insertPendingReply = (p: {
  chatId: string;
  characterId: number;
  userMsgAt: string;
  bubbles: string[];
  noteToSave: string | null;
  sendAt: string;
  kind: string;
  metaJson?: string | null;
  callId?: number | null;
  createdAt: string;
}): number =>
  Number(
    db
      .prepare(
        `INSERT INTO pending_replies
           (chat_id, character_id, user_msg_at, bubbles_json, note_to_save, send_at, kind, meta_json, call_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.chatId,
        p.characterId,
        p.userMsgAt,
        JSON.stringify(p.bubbles),
        p.noteToSave,
        p.sendAt,
        p.kind,
        p.metaJson ?? null,
        p.callId ?? null,
        p.createdAt,
      ).lastInsertRowid,
  );

export const getWaitingPendingReplies = (): PendingReplyRow[] =>
  db
    .prepare(
      `SELECT id, chat_id, character_id, user_msg_at, bubbles_json, note_to_save, send_at, kind, meta_json, call_id, attempts, created_at
         FROM pending_replies WHERE status = 'waiting' ORDER BY send_at`,
    )
    .all() as PendingReplyRow[];

export const hasWaitingPendingReply = (chatId: string): boolean =>
  !!db
    .prepare(
      `SELECT 1 FROM pending_replies WHERE chat_id = ? AND status = 'waiting' LIMIT 1`,
    )
    .get(chatId);

export const hasWaitingWakeRow = (chatId: string): boolean =>
  !!db
    .prepare(
      `SELECT 1 FROM pending_replies WHERE chat_id = ? AND status = 'waiting' AND kind = 'wake' LIMIT 1`,
    )
    .get(chatId);

/** 버린 대기 행 — 트레이스가 그 답장 스레드에 폐기 사실을 달 수 있게 호출 번호까지 준다. */
export interface SupersededRow {
  id: number;
  call_id: number | null;
}

// 유저가 대기 중에 말을 더 걸면 만들어 둔 답장을 버린다 — 그 사이 대화가 바뀌었기 때문.
// 깨우기 표시는 답장이 아니라 남긴다 — 메시지가 더 쌓여도 구간 끝에 한 번 깨는 건 같다.
export const supersedePendingReplies = (chatId: string): SupersededRow[] => {
  const rows = db
    .prepare(
      `SELECT id, call_id FROM pending_replies WHERE chat_id = ? AND status = 'waiting' AND kind != 'wake'`,
    )
    .all(chatId) as SupersededRow[];
  if (rows.length)
    db.prepare(
      `UPDATE pending_replies SET status = 'superseded' WHERE chat_id = ? AND status = 'waiting' AND kind != 'wake'`,
    ).run(chatId);
  return rows;
};

// 깨우기 표시를 거둔다 — 불가 구간이 아닌 길로 답장이 나가게 됐을 때(붙잡힘 등).
export const supersedeWakeRows = (chatId: string): SupersededRow[] => {
  const rows = db
    .prepare(
      `SELECT id, call_id FROM pending_replies WHERE chat_id = ? AND status = 'waiting' AND kind = 'wake'`,
    )
    .all(chatId) as SupersededRow[];
  if (rows.length)
    db.prepare(
      `UPDATE pending_replies SET status = 'superseded' WHERE chat_id = ? AND status = 'waiting' AND kind = 'wake'`,
    ).run(chatId);
  return rows;
};

export const markPendingReply = (
  id: number,
  status: "sent" | "failed" | "superseded",
  sentAt: string | null,
  error?: string | null,
): void => {
  db.prepare(
    `UPDATE pending_replies SET status = ?, sent_at = ?, last_error = coalesce(?, last_error) WHERE id = ?`,
  ).run(status, sentAt, error ?? null, id);
};

export const bumpPendingAttempt = (id: number, error: string): void => {
  db.prepare(
    `UPDATE pending_replies SET attempts = attempts + 1, last_error = ? WHERE id = ?`,
  ).run(error, id);
};
