// SQLite 연결과 스키마.
//
// 표 정의는 이 파일의 TABLES 한곳이고, 스키마를 바꾸면 SCHEMA_VERSION을 올려 마이그레이션을
// 붙인다. 표·컬럼의 뜻과 관계는 erd.md가 갖는다. 표마다 행을 넣고 빼는 함수는 같은 폴더의
// 묶음 파일(characters·relationship·messages·life·sends·llm-calls·trace-events·
// memory-items)에 있고, 부르는 쪽은 src/db.ts 하나로 전부 받는다. 묶음 파일끼리는 이 파일과
// 형제 파일만 부른다 — src/db.ts를 부르면 순환이 된다.
//
// 이 모듈을 부르면 DB를 쓰기로 열고 마이그레이션까지 돌린다. 값을 보기만 하는 도구
// (관리 대시보드)는 그래서 이쪽을 쓰지 않고 읽기 전용으로 따로 연다.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";
import {
  toResponsiveness,
  toActivityCategory,
  FIRST_KIND_NAME,
  LEAD_TONE_NAME,
  MOVE_NAME,
  MOVE_REACTION_NAME,
} from "../labels.js";

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

// ── 스키마 ────────────────────────────────────────────────────────────────
// 테이블 정의는 이 표 한 곳에만 둔다. 새 DB는 이 정의로 바로 만들고, 옛 DB는 아래
// 마이그레이션이 같은 정의로 테이블을 다시 만들어 값을 옮긴다.
// 값이 정해진 컬럼은 영어 식별자로 저장하고 CHECK로 막는다. 모델이 짓는 값(무엇·태그·
// 저장하는 내용·영역 이름)은 한국어 그대로 들어간다.
// 닫힌 목록의 CHECK는 labels.ts의 이름표에서 뽑아 쓴다. 값을 두 곳에 적으면 한쪽만 고쳐도
// 타입 검사가 잡지 못한다. 이미 만들어진 DB의 CHECK는 표를 다시 만들 때까지 그대로다.
const inList = (names: Record<string, string>): string =>
  Object.keys(names)
    .map((k) => `'${k}'`)
    .join(",");

const TABLES: Record<string, string> = {
  characters: `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  genesis_json TEXT NOT NULL,
  created_at TEXT NOT NULL`,

  // 캐릭터와 유저의 관계. 일곱 항목을 컬럼으로 나눠 두고 프롬프트에 항상 넣는다.
  // 말투 값은 답장 경로가, 나머지는 새벽 정리가 갱신한다.
  // 일곱 항목은 전부 NULL을 허용한다 — 캐릭터 행을 넣은 다음 관계 첫 값을 쓰는 두 단계라
  // 그 사이에는 비어 있고, 잘 통하는 것과 조심할 것은 대화가 쌓여야 알 수 있어 비운 채 시작한다.
  relationships: `
  character_id INTEGER PRIMARY KEY REFERENCES characters(id),
  met_at TEXT NOT NULL,
  stage TEXT,
  stage_no INTEGER NOT NULL DEFAULT 1 CHECK (stage_no BETWEEN 1 AND 4),
  stage_since TEXT NOT NULL,
  speech_level TEXT CHECK (speech_level IN ('polite','casual')),
  speech_note TEXT,
  address_terms TEXT,
  rapport TEXT,
  cautions TEXT,
  history TEXT,
  feelings TEXT,
  user_state TEXT,
  user_state_cause TEXT CHECK (user_state_cause IN ('char','other')),
  user_state_tone TEXT CHECK (user_state_tone IN ('good','neutral','bad')),
  user_state_since TEXT,
  updated_at TEXT`,

  // 관계에서 한 번만 일어나는 일. 캐릭터마다 종류당 한 행이고, 답장 경로가 미확정으로 넣으면
  // 새벽 정리가 어제 대화를 읽고 확정하거나 지운다. 종류 20개는 relationship.md가 정한다.
  //
  // 메시지 번호와 호출 번호에 외래 키를 걸지 않는다 — 호출 기록은 90일 뒤 지우는 자리라,
  // 참조를 걸면 그 정리가 처음 기록에 막힌다.
  firsts: `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL REFERENCES characters(id),
  chat_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (${inList(FIRST_KIND_NAME)})),
  by TEXT NOT NULL CHECK (by IN ('character','user')),
  happened_at TEXT NOT NULL,
  message_id INTEGER,
  call_id INTEGER,
  confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0,1)),
  UNIQUE (character_id, kind)`,

  // 수마다 유저가 얼마나 반응했는지의 점수. 키가 채팅과 수라서 캐릭터를 바꿔도 남는다 —
  // 무엇에 반응하는지는 캐릭터가 아니라 유저의 성질이다. 점수는 -1~1이고 새벽 정리가 갱신한다.
  reaction_scores: `
  chat_id TEXT NOT NULL,
  move TEXT NOT NULL CHECK (move IN (${inList(MOVE_NAME)})),
  score REAL NOT NULL DEFAULT 0 CHECK (score BETWEEN -1 AND 1),
  sample_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, move)`,

  // 오늘 캐릭터가 관계에서 하려는 것. 새벽 정리가 하루 1행을 쓰고 답장 프롬프트와 선톡이 읽는다.
  // 네 줄(무엇을 더 알아볼지·무엇을 나눌지·어떤 수를 쓸지·어떤 결을 앞세울지)과 이어 갈 이야기,
  // 그리고 줄마다 무엇을 보고 정했는지가 basis_json에 들어간다.
  relationship_intents: `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL REFERENCES characters(id),
  date TEXT NOT NULL,
  dig TEXT,
  share TEXT,
  move TEXT CHECK (move IN (${inList(MOVE_NAME)})),
  move_note TEXT,
  lead_tone TEXT CHECK (lead_tone IN (${inList(LEAD_TONE_NAME)})),
  thread TEXT,
  basis_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (character_id, date)`,

  // 유저가 얼마나 열렸는지의 판정 결과. 답장마다 도는 판정 호출이 턴 하나에 1행을 적고,
  // 새벽 정리가 단계 문턱과 반응 점수를 셀 때 읽는다. 판정이 실패한 턴은 행이 없다.
  relationship_signals: `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL REFERENCES characters(id),
  chat_id TEXT NOT NULL,
  at TEXT NOT NULL,
  message_id INTEGER,
  opened_self INTEGER NOT NULL CHECK (opened_self IN (0,1)),
  asked_about_char INTEGER NOT NULL CHECK (asked_about_char IN (0,1)),
  said_affection INTEGER NOT NULL CHECK (said_affection IN (0,1)),
  prev_move TEXT CHECK (prev_move IN (${inList(MOVE_NAME)})),
  move_reaction TEXT CHECK (move_reaction IN (${inList(MOVE_REACTION_NAME)})),
  call_id INTEGER`,

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

  // 나이대는 birth_year 하나로만 다룬다 — 상대를 부르는 법 블록이 이 값에서 나이대를 계산한다.
  user_profile: `
  chat_id TEXT PRIMARY KEY,
  preferred_name TEXT,
  gender TEXT,
  birth_year INTEGER,
  job TEXT,
  region TEXT,
  updated_at TEXT`,

  diary_entries: `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL REFERENCES characters(id),
  date TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  UNIQUE (character_id, date)`,

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
  // kind='wake'와 'return'은 답장이 아니라 깨우기 표시다 — 불가 구간에는 답장을 미리
  // 만들지 않고, 구간이 끝나는 시각에 이 행이 울리면 그때 무엇을 할지 정한다. 둘의 차이는
  // 유저가 그 구간에 말을 걸었는가다. 'return'은 자리 비움 틱이 구간에 들어갈 때 걸어 두는
  // 행이라 아직 답할 말이 없고, 유저가 그 구간에 말을 걸면 'wake'로 바뀐다. 이 구분이
  // 필요한 이유는 선톡을 막는 isWaiting이 'wake'만 세야 하기 때문이다 — 'return'까지 세면
  // 불가 구간 내내 모든 선톡 틱이 멈춰 다음 예고와 아침·점심 선톡이 창을 놓친다.
  // 'promise'는 캐릭터가 답장에서 한 연락 약속이다(이슈 #308) — 문안 없이 약속 시각(각본 블록
  // 경계)에 걸어 두고, 울리면 그때 모델을 불러 말을 만든다. meta_json에 약속 문장이 있다.
  // 'return'처럼 선톡을 막지 않고, 유저가 말을 더 보내도 살아남는다.
  pending_replies: `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  character_id INTEGER NOT NULL REFERENCES characters(id),
  user_msg_at TEXT NOT NULL,
  bubbles_json TEXT NOT NULL,
  note_to_save TEXT,
  send_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'reply' CHECK (kind IN ('reply','recover','wake','return','promise')),
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
  kind TEXT NOT NULL CHECK (kind IN ('away','catchup','goodnight','mend','lunch','glance','intent')),
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
  //
  // stop_reason·block_types는 응답이 왜 멈췄고 어떤 블록으로 왔는지다. 저장하는 본문은
  // 텍스트 블록뿐이라 생각 과정으로 나간 몫은 출력 토큰에만 잡히는데, 그 차이를 며칠에 걸쳐
  // 보려면 로그가 아니라 여기에 있어야 한다 — 컨테이너를 다시 만들면 로그는 지워진다(#218).
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
  stop_reason TEXT,
  block_types TEXT,
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

  // 슬랙 트레이스 채널에 사람이 남긴 표시(feedback.ts). 채널을 읽다가 이상한 답장에 리액션으로
  // 분류를 고르고 이유를 스레드 답글로 적으면, 10분 간격 틱이 그것을 읽어 여기에 쌓는다.
  // 표시가 달린 글의 slack_ts로 게시 기록을 되짚어 어느 모델 호출이었는지(call_id)까지 적는다 —
  // 호출과 이어지지 않는 글(하루 각본 알림 같은)에 달린 표시는 call_id 없이 그대로 둔다.
  //
  // 지우지 않고 removed_at으로 표시한다. 폴링이라 리액션을 뗀 것은 다음 회차에 없어진 것으로
  // 드러나는데, 행을 지워 버리면 무엇이 있다가 없어졌는지가 남지 않는다.
  call_feedback: `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER REFERENCES characters(id),
  call_id INTEGER REFERENCES llm_calls(id),
  slack_ts TEXT NOT NULL,
  trace_kind TEXT,
  source TEXT NOT NULL CHECK (source IN ('reaction','reply')),
  kind TEXT CHECK (kind IN ('fact','tone','timing','good')),
  slack_user TEXT,
  text TEXT,
  reply_ts TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  removed_at TEXT`,
};

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
  `CREATE INDEX IF NOT EXISTS idx_call_feedback_call ON call_feedback (call_id)`,
  `CREATE INDEX IF NOT EXISTS idx_call_feedback_ts ON call_feedback (slack_ts, source)`,
  `CREATE INDEX IF NOT EXISTS idx_firsts_character ON firsts (character_id, confirmed)`,
  `CREATE INDEX IF NOT EXISTS idx_relationship_signals_at ON relationship_signals (character_id, at)`,
];

const createSchema = (): void => {
  for (const [name, columns] of Object.entries(TABLES))
    db.exec(`CREATE TABLE IF NOT EXISTS ${name} (${columns}\n)`);
  for (const sql of INDEXES) db.exec(sql);
};

const SCHEMA_VERSION = 10;

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
    // 관계를 한 덩어리로 담던 state_json과 마지막 연락 시각은 v6이 지우는 자리라 옮기지 않는다.
    rebuild("relationships", "character_id, met_at", "character_id, met_at");
    // 나이대도 마찬가지다 — v6이 age_band를 지우고 birth_year 하나만 남긴다.
    rebuild(
      "user_profile",
      "chat_id, preferred_name, gender, birth_year, job, region, updated_at",
      `chat_id, ${preferredName}, gender, NULL, NULL, NULL, updated_at`,
    );
    rebuild(
      "diary_entries",
      "id, character_id, date, entry_json",
      "id, character_id, date, entry_json",
    );
    // 주변 인물을 담던 cast_members는 옮기지 않는다 — memory_items의 person 행이 대신하고,
    // 옛 표는 v6이 지운다.
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

// v6: 대신할 자리가 생긴 표 다섯과 컬럼 셋을 지운다(#156).
//
// cast_members는 memory_items의 person 행이, attention_override는 day_actuals가,
// capture_marks는 today_notes가, relationships.legacy_state_json은 관계 일곱 항목 컬럼이,
// user_profile.age_band는 birth_year가 대신한다. memory_items_legacy는 v2 데이터 이관이
// 다 읽고 끝난 표다. user_preferences와 relationships.last_contact_at은 읽는 자리도
// 쓰는 자리도 없어진 채 남아 있었다.
const migrateToV6 = (): void => {
  const hasColumn = (table: string, column: string): boolean =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
      (c) => c.name === column,
    );

  db.pragma("foreign_keys = OFF");

  db.transaction(() => {
    for (const table of [
      "cast_members",
      "attention_override",
      "capture_marks",
      "user_preferences",
      "memory_items_legacy",
    ])
      db.exec(`DROP TABLE IF EXISTS ${table}`);

    for (const [table, column] of [
      ["relationships", "legacy_state_json"],
      ["relationships", "last_contact_at"],
      ["user_profile", "age_band"],
    ] as const)
      if (hasColumn(table, column))
        db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);

    const broken = db.pragma("foreign_key_check") as unknown[];
    if (broken.length)
      throw new Error(
        `[db] 마이그레이션 후 외래 키가 맞지 않는 행 ${broken.length}개 — 되돌린다`,
      );
    db.pragma(`user_version = 6`);
  })();

  console.log(`[db] 스키마를 v6으로 옮겼다`);
};

// v7: 모델 호출에 중단 사유와 응답 블록 종류 칸을 더한다(#218).
//
// 지금까지 이 둘은 호출 로그 한 줄에만 있었다. 컨테이너를 다시 만드는 배포가 그 로그를 함께
// 버리므로, 며칠에 걸쳐 분포를 봐야 하는 값이 배포 한 번에 끊겼다. 본문 보관 기간이 지나도
// 남는 메타 쪽에 두어 90일 뒤에도 어느 호출이 상한에서 잘렸는지 셀 수 있게 한다.
const migrateToV7 = (): void => {
  const cols = db.prepare(`PRAGMA table_info(llm_calls)`).all() as {
    name: string;
  }[];

  db.transaction(() => {
    for (const column of ["stop_reason", "block_types"])
      if (!cols.some((c) => c.name === column))
        db.exec(`ALTER TABLE llm_calls ADD COLUMN ${column} TEXT`);
    db.pragma(`user_version = 7`);
  })();

  console.log(`[db] 스키마를 v7로 옮겼다`);
};

// v8: 관계에 상대의 오늘 상태 칸 넷을 더한다(#309).
//
// 답장마다 작은 판정 호출이 상대의 지금 상태를 정하고, 바뀐 것만 여기에 적는다. 하루짜리
// 값이라 새벽 정리가 읽어 마음·조심할 것에 녹인 뒤 비운다. 관계 행 안에 두는 이유는 관계를
// 적는 길이 relationship-update 한 파일로 모여 있어서다.
const migrateToV8 = (): void => {
  const cols = db.prepare(`PRAGMA table_info(relationships)`).all() as {
    name: string;
  }[];
  const add: [string, string][] = [
    ["user_state", "user_state TEXT"],
    [
      "user_state_cause",
      "user_state_cause TEXT CHECK (user_state_cause IN ('char','other'))",
    ],
    [
      "user_state_tone",
      "user_state_tone TEXT CHECK (user_state_tone IN ('good','neutral','bad'))",
    ],
    ["user_state_since", "user_state_since TEXT"],
  ];

  db.transaction(() => {
    for (const [column, ddl] of add)
      if (!cols.some((c) => c.name === column))
        db.exec(`ALTER TABLE relationships ADD COLUMN ${ddl}`);
    db.pragma(`user_version = 8`);
  })();

  console.log(`[db] 스키마를 v8로 옮겼다`);
};

// v9: 관계에 단계 번호와 단계 시작일을 더한다(#331).
//
// 관계를 쌓는 표 넷(firsts·reaction_scores·relationship_intents·relationship_signals)은
// 위의 createSchema가 이미 만들었다 — 여기서는 relationships만 다시 만든다. 두 컬럼 다
// 값이 있어야 하고 단계 시작일에는 채워 넣을 상수가 없어서 ALTER로는 붙일 수 없다.
//
// 이미 있는 캐릭터는 단계 1에서 시작하고, 시작일은 캐릭터를 만든 날에서 시각을 뗀 논리일로
// 둔다. 지금까지 쌓은 대화가 어느 단계였는지 뒤늦게 매길 방법이 없으니, 다음 새벽 정리가
// 문턱을 보고 올린다.
const migrateToV9 = (): void => {
  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  db.transaction(() => {
    db.exec(`ALTER TABLE relationships RENAME TO relationships__old`);
    db.exec(`CREATE TABLE relationships (${TABLES.relationships}\n)`);
    db.exec(`
      INSERT INTO relationships
        (character_id, met_at, stage, stage_no, stage_since, speech_level, speech_note,
         address_terms, rapport, cautions, history, feelings, user_state, user_state_cause,
         user_state_tone, user_state_since, updated_at)
      SELECT r.character_id, r.met_at, r.stage, 1,
             substr(COALESCE(c.created_at, r.met_at), 1, 10),
             r.speech_level, r.speech_note, r.address_terms, r.rapport, r.cautions,
             r.history, r.feelings, r.user_state, r.user_state_cause, r.user_state_tone,
             r.user_state_since, r.updated_at
        FROM relationships__old r LEFT JOIN characters c ON c.id = r.character_id`);
    db.exec(`DROP TABLE relationships__old`);

    const broken = db.pragma("foreign_key_check") as unknown[];
    if (broken.length)
      throw new Error(
        `[db] 마이그레이션 후 외래 키가 맞지 않는 행 ${broken.length}개 — 되돌린다`,
      );
    db.pragma(`user_version = 9`);
  })();
  db.pragma("legacy_alter_table = OFF");

  console.log(`[db] 스키마를 v9로 옮겼다`);
};

// v10: 수 코드에 '어떤 사람인지 말해 주기'(notice)를 더한다(#353).
//
// 수 코드는 reaction_scores·relationship_intents·relationship_signals 세 표의 CHECK 목록에
// 박혀 있어서 표를 다시 만들어야 한다. 세 표는 v9 배포 뒤 아직 어느 코드도 쓰지 않아 비어
// 있으므로 옮길 행 없이 지우고 다시 만든다. firsts는 처음 코드만 있어 손대지 않는다.
const migrateToV10 = (): void => {
  db.transaction(() => {
    for (const name of [
      "reaction_scores",
      "relationship_intents",
      "relationship_signals",
    ] as const) {
      db.exec(`DROP TABLE IF EXISTS ${name}`);
      db.exec(`CREATE TABLE ${name} (${TABLES[name]}\n)`);
    }
    for (const sql of INDEXES) if (sql.includes("relationship_signals")) db.exec(sql);
    db.pragma(`user_version = 10`);
  })();

  console.log(`[db] 스키마를 v10으로 옮겼다`);
};

if (schemaVersion() < 4) migrateToV4();
if (schemaVersion() < 5) migrateToV5();
if (schemaVersion() < 6) migrateToV6();
if (schemaVersion() < 7) migrateToV7();
if (schemaVersion() < 8) migrateToV8();
if (schemaVersion() < 9) migrateToV9();
if (schemaVersion() < SCHEMA_VERSION) migrateToV10();

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

// 관계 표에서 관계의 결(texture)을 지우고 그 내용을 지나온 이야기(history)에 합친다. 두 항목이
// 같은 이야기를 나눠 적고 있었고, 캐릭터가 유저를 대하는 방식은 생성 때 정하는 정체성으로
// 옮겼다. 위 wake 이관과 같은 이유로 버전 번호 대신 컬럼 유무를 보고 판단한다.
const migrateRelationshipTexture = (): void => {
  const cols = db.prepare(`PRAGMA table_info(relationships)`).all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "texture")) return;

  db.transaction(() => {
    // 둘 다 값이 있으면 이어 붙인다. 다음 새벽 정리가 이 항목을 다시 쓰면서 겹친 말을 정리한다.
    db.exec(`
      UPDATE relationships
         SET history = TRIM(COALESCE(history, '') || ' ' || COALESCE(texture, ''))
       WHERE COALESCE(TRIM(texture), '') <> ''`);
    db.exec(`ALTER TABLE relationships DROP COLUMN texture`);
  })();
  console.log(`[db] 관계의 결을 지나온 이야기에 합치고 컬럼을 지웠다`);
};
migrateRelationshipTexture();

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

// pending_replies.kind에 값을 더한다('return'·'promise'). 위 wake 이관과 같은 이유로 테이블을
// 다시 만들고, 버전 번호 대신 CHECK 문구를 보고 판단한다 — 같은 스키마 판 안에서 값이 늘어난
// 자리라 판 번호를 올리지 않았다. 새 값이 또 늘면 아래 호출에 한 줄 더한다.
const rebuildPendingReplies = (marker: string): void => {
  const row = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pending_replies'`,
    )
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes(`'${marker}'`)) return;

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
         send_at, kind, meta_json, call_id, status, attempts, last_error,
         created_at, sent_at)
      SELECT id, chat_id, character_id, user_msg_at, bubbles_json, note_to_save,
             send_at, kind, meta_json, call_id, status, attempts, last_error,
             created_at, sent_at
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
  console.log(`[db] pending_replies에 ${marker}를 더했다`);
};
rebuildPendingReplies("return");
rebuildPendingReplies("promise");

// send_failures.kind에 값을 더한다. 늘어난 값마다 한 번씩 부른다. 위 이관과 같은 이유로 테이블을 다시
// 만들고, 버전 번호 대신 CHECK 문구를 보고 판단한다. 이 표에는 인덱스가 없어 다시 만들 것도
// 없다 — 실패 기록을 사람이 훑어보는 자리라 조회가 인덱스를 타지 않는다.
const rebuildSendFailures = (marker: string): void => {
  const row = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'send_failures'`,
    )
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes(`'${marker}'`)) return;

  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  db.transaction(() => {
    db.exec(`ALTER TABLE send_failures RENAME TO send_failures_old`);
    db.exec(`CREATE TABLE send_failures (${TABLES.send_failures}\n)`);
    db.exec(`
      INSERT INTO send_failures (id, chat_id, character_id, kind, error, failed_at)
      SELECT id, chat_id, character_id, kind, error, failed_at FROM send_failures_old`);
    db.exec(`DROP TABLE send_failures_old`);
    const broken = db.pragma("foreign_key_check") as unknown[];
    if (broken.length)
      throw new Error(
        `[db] send_failures 재생성 후 외래 키가 맞지 않는 행 ${broken.length}개 — 되돌린다`,
      );
  })();
  db.pragma("legacy_alter_table = OFF");
  console.log(`[db] send_failures에 ${marker}를 더했다`);
};
rebuildSendFailures("mend");
rebuildSendFailures("lunch");
rebuildSendFailures("glance");
rebuildSendFailures("intent");

db.pragma("foreign_keys = ON");
