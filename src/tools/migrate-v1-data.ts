// v1 데이터 이관 도구 (이슈 #22). legacy_state_json에 쌓인 관계 기록과 바이블을
// v1 스키마의 저장 항목(memory_items·areas·cast_members·arcs·schedules·user_profile)으로
// 옮긴다. 후보 값은 커밋하지 않는 docs/migration/candidates.json에 있고, 이 파일에는
// 검증 규칙과 반영 절차만 둔다.
//
// 명령 5개:
//   snapshot <characterId> <out.json>            legacy 상태를 스냅샷으로 저장
//   diff-legacy <characterId> <snap.json> [out]  스냅샷 이후 늘어난 legacy 기록 확인
//   apply <candidates.json> [report.txt]         검증 후 트랜잭션 하나로 반영
//   regen <candidates.json> <plan.json>          미래 이벤트·컨디션 시드 재생성 (opus 1콜)
//   apply-regen <plan.json>                      재생성 결과를 결정적으로 반영 (API 미사용)
//
// DB_PATH를 반드시 지정해야 한다. db.ts가 import 시점에 config.dbPath를 열고
// 마이그레이션까지 돌리기 때문에, 환경변수 확인 전에 프로젝트 모듈을 정적 import하면
// 실수로 ./data/companion.db를 건드린다 — 그래서 전부 동적 import다.

import { readFileSync, writeFileSync } from "node:fs";

// ── 후보 파일 타입 ────────────────────────────────────────────────────────

type ItemType = "identity" | "user_fact" | "ongoing" | "relationship";
type Owner = "char" | "user";
type Origin = "seed" | "accrued";
type UserKnows = "unknown" | "known" | "waiting";
type ScheduleOrigin = "conversation" | "rhythm" | "ongoing";

interface CandidateMemoryItem {
  itemType: ItemType;
  owner: Owner;
  area: string;
  subject: string;
  value: string;
  origin: Origin;
  userKnows: UserKnows;
  tags: string[];
  sources?: string[];
  extra?: Record<string, unknown>;
}

interface CandidateArea {
  name: string;
  note: string;
}

interface CandidateCastUpdate {
  name: string;
  area?: string;
  meetPattern?: string;
  place?: string;
  userKnows?: UserKnows;
  lastMentionedAt?: string;
  recentNote?: string;
}

interface CandidateScheduleUpdate {
  id: number;
  origin?: ScheduleOrigin;
  userKnows?: UserKnows;
}

interface Candidates {
  characterId: number;
  chatId: string;
  memoryItems: CandidateMemoryItem[];
  areas: CandidateArea[];
  castUpdates: CandidateCastUpdate[];
  arcUpdates: Record<"year" | "season" | "month" | "week", string>;
  scheduleUpdates: CandidateScheduleUpdate[];
  scheduleDeletes: number[];
  userProfile: {
    preferredName?: string;
    job?: string;
    region?: string;
    birthYear?: number;
  };
  regen: { endDate: string; brief: string; constraints: string[] };
  gateQuestions: string[];
}

interface LegacyFact {
  fact: string;
  learned_at: string;
}

interface LegacyLoop {
  id: number;
  content: string;
  status: string;
  created_at: string;
}

interface LegacySnapshot {
  characterId: number;
  takenAt: string;
  userFacts: { i: number; fact: string; learned_at: string }[];
  charFacts: { i: number; fact: string; learned_at: string }[];
  openLoops: LegacyLoop[];
}

interface RegenEvent {
  date: string;
  time_hint: string | null;
  content: string;
  area: string | null;
  with_name: string | null;
}

interface RegenSeed {
  date: string;
  energy: string;
  wake_hint: string;
  mood: string;
  reason: string | null;
}

interface RegenPlan {
  characterId: number;
  rangeStart: string;
  rangeEnd: string;
  events: RegenEvent[];
  seeds: RegenSeed[];
}

// ── 상수 ─────────────────────────────────────────────────────────────────

const ITEM_TYPES: ItemType[] = [
  "identity",
  "user_fact",
  "ongoing",
  "relationship",
];
const OWNERS: Owner[] = ["char", "user"];
const ORIGINS: Origin[] = ["seed", "accrued"];
const USER_KNOWS: UserKnows[] = ["unknown", "known", "waiting"];
const SCHEDULE_ORIGINS: ScheduleOrigin[] = [
  "conversation",
  "rhythm",
  "ongoing",
];
const ENERGY_VALUES = ["낮음", "보통", "높음"];
const WAKE_VALUES = ["이른", "보통", "늦잠"];

// areas 테이블에 넣지 않고도 키의 첫 단어로 허용하는 구조 영역. 뼈대 두 표(변하지 않는
// 것·변하는 것)의 첫 단어들과, relationship 전용인 관계.
const STRUCTURAL_AREAS = [
  "기본",
  "직업",
  "주거",
  "생활",
  "성향",
  "말투",
  "연애",
  "가족",
  "취미",
  "관계",
];

// relationship 항목은 이 다섯 subject만 허용한다 (설계: 캐릭터와 유저의 관계 칸).
const RELATIONSHIP_SUBJECTS = [
  "서로 부르는 말",
  "지금 말투",
  "관계의 결",
  "우리끼리 생긴 표현",
  "조심할 것",
];

// ── 시간 헬퍼 ────────────────────────────────────────────────────────────

// KST(UTC+9) 타임스탬프 "YYYY-MM-DD HH:MM:SS"
const kstNow = (): string =>
  new Date(Date.now() + 9 * 3600 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");

// 논리일: 새벽 5시가 하루 경계 → KST에서 5시간을 빼면 UTC+4 시프트로 날짜만 남는다
const logicalToday = (): string =>
  new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);

// 재생성·시드 삭제 경계 = 논리일 기준 내일. 오늘은 이미 살고 있는 날이라 건드리지 않는다.
const boundaryDate = (): string => {
  const d = new Date(Date.now() + 4 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

const datesBetween = (start: string, end: string): string[] => {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  const e = new Date(`${end}T00:00:00Z`);
  for (; d.getTime() <= e.getTime(); d.setUTCDate(d.getUTCDate() + 1))
    out.push(d.toISOString().slice(0, 10));
  return out;
};

// ── 파일·출력 헬퍼 ────────────────────────────────────────────────────────

const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(path, "utf8")) as T;

const writeJson = (path: string, value: unknown): void =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");

const fail = (msg: string): never => {
  console.error(`[중단] ${msg}`);
  process.exit(1);
};

// ── snapshot ─────────────────────────────────────────────────────────────

const cmdSnapshot = async (
  characterId: number,
  outPath: string,
): Promise<void> => {
  const { db } = await import("../db.js");
  const row = db
    .prepare(
      `SELECT legacy_state_json FROM relationships WHERE character_id = ?`,
    )
    .get(characterId) as { legacy_state_json: string | null } | undefined;
  if (!row?.legacy_state_json)
    fail(`character ${characterId}의 legacy_state_json이 없다`);
  const state = JSON.parse(row!.legacy_state_json!) as {
    user_facts?: LegacyFact[];
    char_facts?: LegacyFact[];
    open_loops?: LegacyLoop[];
  };
  const snap: LegacySnapshot = {
    characterId,
    takenAt: kstNow(),
    userFacts: (state.user_facts ?? []).map((f, i) => ({ i, ...f })),
    charFacts: (state.char_facts ?? []).map((f, i) => ({ i, ...f })),
    openLoops: state.open_loops ?? [],
  };
  writeJson(outPath, snap);
  console.log(
    `스냅샷 저장: user_facts ${snap.userFacts.length} / char_facts ${snap.charFacts.length} / open_loops ${snap.openLoops.length} → ${outPath}`,
  );
};

// ── diff-legacy ──────────────────────────────────────────────────────────

const cmdDiffLegacy = async (
  characterId: number,
  snapPath: string,
  outPath?: string,
): Promise<void> => {
  const snap = readJson<LegacySnapshot>(snapPath);
  if (snap.characterId !== characterId)
    fail(
      `스냅샷의 characterId(${snap.characterId})가 인자(${characterId})와 다르다`,
    );
  const { db } = await import("../db.js");
  const row = db
    .prepare(
      `SELECT legacy_state_json FROM relationships WHERE character_id = ?`,
    )
    .get(characterId) as { legacy_state_json: string | null } | undefined;
  if (!row?.legacy_state_json)
    fail(`character ${characterId}의 legacy_state_json이 없다`);
  const state = JSON.parse(row!.legacy_state_json!) as {
    user_facts?: LegacyFact[];
    char_facts?: LegacyFact[];
    open_loops?: LegacyLoop[];
  };

  const knownUser = new Set(snap.userFacts.map((f) => f.fact));
  const knownChar = new Set(snap.charFacts.map((f) => f.fact));
  const knownLoops = new Map(snap.openLoops.map((l) => [l.id, l.status]));

  const newUser = (state.user_facts ?? []).filter(
    (f) => !knownUser.has(f.fact),
  );
  const newChar = (state.char_facts ?? []).filter(
    (f) => !knownChar.has(f.fact),
  );
  const liveLoops = state.open_loops ?? [];
  const newLoops = liveLoops.filter((l) => !knownLoops.has(l.id));
  const changedLoops = liveLoops.filter(
    (l) => knownLoops.has(l.id) && knownLoops.get(l.id) !== l.status,
  );

  console.log(
    `스냅샷(${snap.takenAt}) 이후 늘어난 기록: user_facts ${newUser.length} / char_facts ${newChar.length} / open_loops 신규 ${newLoops.length} · 상태 변경 ${changedLoops.length}`,
  );
  const detail = { newUser, newChar, newLoops, changedLoops };
  if (outPath) {
    writeJson(outPath, detail);
    console.log(`상세는 ${outPath}에 저장했다`);
  } else if (
    newUser.length + newChar.length + newLoops.length + changedLoops.length >
    0
  ) {
    console.log(JSON.stringify(detail, null, 2));
  }
};

// ── apply ────────────────────────────────────────────────────────────────

const cmdApply = async (
  candPath: string,
  reportPath?: string,
): Promise<void> => {
  const cand = readJson<Candidates>(candPath);
  const { db } = await import("../db.js");
  const cid = cand.characterId;
  const errors: string[] = [];
  const warnings: string[] = [];
  const report: string[] = [];

  // ── 사전 검증 (하나라도 걸리면 반영하지 않는다) ──
  const ch = db
    .prepare(`SELECT id, chat_id FROM characters WHERE id = ?`)
    .get(cid) as { id: number; chat_id: string } | undefined;
  if (!ch) errors.push(`characters에 id ${cid}가 없다`);
  else if (ch.chat_id !== cand.chatId)
    errors.push(
      `characters.chat_id(${ch.chat_id})가 후보의 chatId(${cand.chatId})와 다르다`,
    );

  const already = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM memory_items WHERE character_id = ?`)
      .get(cid) as {
      n: number;
    }
  ).n;
  if (already > 0)
    errors.push(`memory_items에 이미 ${already}건 있다 — 재실행 금지`);

  const existingAreas = (
    db.prepare(`SELECT name FROM areas WHERE character_id = ?`).all(cid) as {
      name: string;
    }[]
  ).map((r) => r.name);
  const allowedAreas = new Set([
    ...cand.areas.map((a) => a.name),
    ...existingAreas,
    ...STRUCTURAL_AREAS,
  ]);

  const seenKeys = new Set<string>();
  const relationshipSubjects: string[] = [];
  for (const m of cand.memoryItems) {
    const label = `${m.itemType}/${m.owner}/${m.area}/${m.subject}`;
    if (!ITEM_TYPES.includes(m.itemType))
      errors.push(`item_type 위반: ${label}`);
    if (!OWNERS.includes(m.owner)) errors.push(`owner 위반: ${label}`);
    if (!ORIGINS.includes(m.origin)) errors.push(`origin 위반: ${label}`);
    if (!USER_KNOWS.includes(m.userKnows))
      errors.push(`user_knows 위반: ${label}`);
    if (!allowedAreas.has(m.area)) errors.push(`허용 밖 area: ${label}`);
    if (!m.value.trim()) errors.push(`value가 비어 있다: ${label}`);
    const key = `${m.itemType}|${m.owner}|${m.area}|${m.subject}`;
    if (seenKeys.has(key)) errors.push(`후보 안 중복 키: ${label}`);
    seenKeys.add(key);
    if (m.itemType === "relationship") relationshipSubjects.push(m.subject);
    if (/할 것|하지 마|금지|해야 한다/.test(m.value))
      warnings.push(`지시문 꼴 value: ${label}`);
    if (m.value.length > 300)
      warnings.push(`value ${m.value.length}자: ${label}`);
    if (m.tags.length === 0) warnings.push(`태그 없음: ${label}`);
  }
  const relSorted = [...relationshipSubjects].sort().join("|");
  if (relSorted !== [...RELATIONSHIP_SUBJECTS].sort().join("|"))
    errors.push(
      `relationship subject가 정해진 다섯과 다르다: ${relationshipSubjects.join(", ")}`,
    );

  const castNames = new Set(
    (
      db
        .prepare(`SELECT name FROM cast_members WHERE character_id = ?`)
        .all(cid) as {
        name: string;
      }[]
    ).map((r) => r.name),
  );
  for (const c of cand.castUpdates) {
    if (!castNames.has(c.name))
      errors.push(`cast_members에 없는 이름: ${c.name}`);
    if (c.userKnows !== undefined && !USER_KNOWS.includes(c.userKnows))
      errors.push(`cast user_knows 위반: ${c.name}`);
  }

  const scheduleIdRow = db.prepare(
    `SELECT id FROM schedules WHERE id = ? AND character_id = ?`,
  );
  for (const s of cand.scheduleUpdates) {
    if (!scheduleIdRow.get(s.id, cid))
      errors.push(`schedules에 없는 id: ${s.id} (갱신)`);
    if (s.origin !== undefined && !SCHEDULE_ORIGINS.includes(s.origin))
      errors.push(`schedule origin 위반: id ${s.id}`);
    if (s.userKnows !== undefined && !USER_KNOWS.includes(s.userKnows))
      errors.push(`schedule user_knows 위반: id ${s.id}`);
  }
  for (const id of cand.scheduleDeletes)
    if (!scheduleIdRow.get(id, cid))
      errors.push(`schedules에 없는 id: ${id} (삭제)`);

  for (const [period, content] of Object.entries(cand.arcUpdates))
    if (!content.trim()) errors.push(`arc ${period}가 비어 있다`);

  if (errors.length > 0) {
    console.error(`검증 실패 ${errors.length}건 — 아무것도 반영하지 않았다`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  // ── 반영 (트랜잭션 하나) ──
  const now = kstNow();
  const boundary = boundaryDate();
  let tagCount = 0;
  let castChanged = 0;
  let schedChanged = 0;
  let seedsDeleted = 0;
  const profileFilled: string[] = [];

  db.transaction(() => {
    const upArea = db.prepare(
      `INSERT INTO areas (character_id, name, note) VALUES (?, ?, ?)
       ON CONFLICT(character_id, name) DO UPDATE SET note = excluded.note`,
    );
    for (const a of cand.areas) upArea.run(cid, a.name, a.note);

    const insItem = db.prepare(
      `INSERT INTO memory_items
       (character_id, item_type, owner, area, subject, value, origin, user_knows, extra_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insTag = db.prepare(
      `INSERT OR IGNORE INTO tags (character_id, kind, ref_id, tag) VALUES (?, 'memory', ?, ?)`,
    );
    for (const m of cand.memoryItems) {
      const r = insItem.run(
        cid,
        m.itemType,
        m.owner,
        m.area,
        m.subject,
        m.value,
        m.origin,
        m.userKnows,
        m.extra ? JSON.stringify(m.extra) : null,
        now,
      );
      const refId = Number(r.lastInsertRowid);
      for (const t of m.tags) tagCount += insTag.run(cid, refId, t).changes;
    }

    for (const c of cand.castUpdates) {
      const cols: [string, string | undefined][] = [
        ["area", c.area],
        ["meet_pattern", c.meetPattern],
        ["place", c.place],
        ["user_knows", c.userKnows],
        ["last_mentioned_at", c.lastMentionedAt],
        ["recent_note", c.recentNote],
      ];
      const sets: string[] = [];
      const vals: string[] = [];
      for (const [col, v] of cols)
        if (v !== undefined) {
          sets.push(`${col} = ?`);
          vals.push(v);
        }
      if (sets.length === 0) continue;
      castChanged += db
        .prepare(
          `UPDATE cast_members SET ${sets.join(", ")} WHERE character_id = ? AND name = ?`,
        )
        .run(...vals, cid, c.name).changes;
    }

    const upArc = db.prepare(
      `INSERT INTO arcs (character_id, period, content) VALUES (?, ?, ?)
       ON CONFLICT(character_id, period) DO UPDATE SET content = excluded.content`,
    );
    for (const [period, content] of Object.entries(cand.arcUpdates))
      upArc.run(cid, period, content);

    for (const s of cand.scheduleUpdates) {
      const sets: string[] = [];
      const vals: string[] = [];
      if (s.origin !== undefined) {
        sets.push(`origin = ?`);
        vals.push(s.origin);
      }
      if (s.userKnows !== undefined) {
        sets.push(`user_knows = ?`);
        vals.push(s.userKnows);
      }
      if (sets.length === 0) continue;
      schedChanged += db
        .prepare(
          `UPDATE schedules SET ${sets.join(", ")} WHERE id = ? AND character_id = ?`,
        )
        .run(...vals, s.id, cid).changes;
    }

    const delTag = db.prepare(
      `DELETE FROM tags WHERE character_id = ? AND kind = 'schedule' AND ref_id = ?`,
    );
    const delSched = db.prepare(
      `DELETE FROM schedules WHERE id = ? AND character_id = ?`,
    );
    for (const id of cand.scheduleDeletes) {
      delTag.run(cid, id);
      delSched.run(id, cid);
    }

    seedsDeleted = db
      .prepare(`DELETE FROM day_seeds WHERE character_id = ? AND date >= ?`)
      .run(cid, boundary).changes;

    // user_profile은 비어 있는 컬럼만 채운다 — 이미 값이 있으면 그쪽이 이긴다
    const prof = db
      .prepare(
        `SELECT preferred_name, job, region, birth_year FROM user_profile WHERE chat_id = ?`,
      )
      .get(cand.chatId) as
      | {
          preferred_name: string | null;
          job: string | null;
          region: string | null;
          birth_year: number | null;
        }
      | undefined;
    const fills: [
      string,
      string | number | null | undefined,
      string | number | undefined,
    ][] = [
      ["preferred_name", prof?.preferred_name, cand.userProfile.preferredName],
      ["job", prof?.job, cand.userProfile.job],
      ["region", prof?.region, cand.userProfile.region],
      ["birth_year", prof?.birth_year, cand.userProfile.birthYear],
    ];
    if (prof) {
      const sets: string[] = [];
      const vals: (string | number)[] = [];
      for (const [col, current, next] of fills)
        if (!current && next) {
          sets.push(`${col} = ?`);
          vals.push(next);
          profileFilled.push(col);
        }
      if (sets.length > 0)
        db.prepare(
          `UPDATE user_profile SET ${sets.join(", ")}, updated_at = ? WHERE chat_id = ?`,
        ).run(...vals, now, cand.chatId);
    } else {
      db.prepare(
        `INSERT INTO user_profile (chat_id, preferred_name, job, region, birth_year, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        cand.chatId,
        cand.userProfile.preferredName ?? null,
        cand.userProfile.job ?? null,
        cand.userProfile.region ?? null,
        cand.userProfile.birthYear ?? null,
        now,
      );
      profileFilled.push("(새 행)");
    }
  })();

  // ── 반영 후 확인 ──
  const typeCounts = db
    .prepare(
      `SELECT item_type, COUNT(*) AS n FROM memory_items WHERE character_id = ? GROUP BY item_type`,
    )
    .all(cid) as { item_type: string; n: number }[];
  const areaCount = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM areas WHERE character_id = ?`)
      .get(cid) as { n: number }
  ).n;
  const seedRange = db
    .prepare(
      `SELECT MIN(date) AS lo, MAX(date) AS hi, COUNT(*) AS n FROM day_seeds WHERE character_id = ?`,
    )
    .get(cid) as { lo: string | null; hi: string | null; n: number };
  const futureSched = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM schedules WHERE character_id = ? AND date >= ?`,
      )
      .get(cid, logicalToday()) as { n: number }
  ).n;

  report.push(`반영 완료 (경계 ${boundary}, 기록 시각 ${now})`);
  report.push(
    `memory_items: ${typeCounts.map((t) => `${t.item_type} ${t.n}`).join(" / ")} · tags ${tagCount}`,
  );
  report.push(
    `areas ${areaCount} · cast 갱신 ${castChanged} · schedules 갱신 ${schedChanged}`,
  );
  report.push(
    `schedules 삭제 ${cand.scheduleDeletes.length} · day_seeds 삭제 ${seedsDeleted} (남은 시드 ${seedRange.n}건, ${seedRange.lo}~${seedRange.hi})`,
  );
  report.push(
    `오늘 이후 schedules ${futureSched}건 · user_profile 채움: ${profileFilled.join(", ") || "없음"}`,
  );
  report.push(`경고 ${warnings.length}건`);

  for (const line of report) console.log(line);
  if (reportPath) {
    writeFileSync(
      reportPath,
      [...report, "", ...warnings.map((w) => `[경고] ${w}`)].join("\n") + "\n",
      "utf8",
    );
    console.log(`경고 상세는 ${reportPath}에 저장했다`);
  } else {
    for (const w of warnings) console.log(`[경고] ${w}`);
  }
};

// ── regen ────────────────────────────────────────────────────────────────

const cmdRegen = async (candPath: string, outPath: string): Promise<void> => {
  const cand = readJson<Candidates>(candPath);
  const { db } = await import("../db.js");
  const { chatJson } = await import("../llm.js");
  const { config } = await import("../config.js");
  const cid = cand.characterId;
  const start = boundaryDate();
  const end = cand.regen.endDate;
  if (start > end) fail(`재생성 범위가 비었다 (${start} > ${end})`);

  const kept = db
    .prepare(
      `SELECT date, time_hint, content, with_name, area, owner FROM schedules
       WHERE character_id = ? AND date >= ? AND status = 'active' ORDER BY date`,
    )
    .all(cid, logicalToday()) as {
    date: string;
    time_hint: string | null;
    content: string;
    with_name: string | null;
    area: string | null;
    owner: string;
  }[];
  const recentSeeds = (
    db
      .prepare(
        `SELECT date, energy, wake_hint, mood, reason FROM day_seeds
         WHERE character_id = ? AND date < ? ORDER BY date DESC LIMIT 5`,
      )
      .all(cid, start) as RegenSeed[]
  ).reverse();

  const system = [
    "너는 한 인물의 한 달 생활 리듬을 설계한다. 아래 인물 소개와 제약을 지켜,",
    "요청한 날짜 범위의 이벤트 목록과 매일의 컨디션 시드를 JSON 하나로만 답한다.",
    "",
    "출력 형식 (JSON 외 다른 텍스트 금지):",
    `{"events":[{"date":"YYYY-MM-DD","time_hint":"저녁"|null,"content":"...","area":"..."|null,"with_name":"..."|null}],`,
    ` "seeds":[{"date":"YYYY-MM-DD","energy":"낮음|보통|높음","wake_hint":"이른|보통|늦잠","mood":"...","reason":"..."|null}]}`,
    "",
    "규칙:",
    `- seeds는 ${start}부터 ${end}까지 하루도 빠짐없이 날짜마다 정확히 1건.`,
    "- energy는 낮음/보통/높음, wake_hint는 이른/보통/늦잠 중 하나만.",
    "- 이벤트가 있는 날과 그다음 날의 시드는 인과로 연결한다 (회식 다음 날은 피곤한 식).",
    "- 컨디션은 급변 없는 파도로 — 이미 지나간 시드의 흐름을 이어받는다.",
    "- 이미 잡혀 있는 일정과 겹치는 이벤트를 새로 만들지 않는다.",
  ].join("\n");

  const userPrompt = [
    `인물 소개:\n${cand.regen.brief}`,
    `제약:\n${cand.regen.constraints.map((c) => `- ${c}`).join("\n")}`,
    `날짜 범위: ${start} ~ ${end}`,
    `이미 잡혀 있는 일정 (건드리지 말 것):\n${JSON.stringify(kept, null, 2)}`,
    `직전 며칠의 컨디션 시드 (흐름을 이어받을 것):\n${JSON.stringify(recentSeeds, null, 2)}`,
  ].join("\n\n");

  console.log(`재생성 호출: ${start} ~ ${end}, 모델 ${config.modelDeep}`);
  const out = await chatJson<{ events: RegenEvent[]; seeds: RegenSeed[] }>(
    system,
    userPrompt,
    8192,
    config.modelDeep,
  );

  // ── 검증 ──
  const errors: string[] = [];
  const wanted = datesBetween(start, end);
  const seedDates = new Map<string, number>();
  for (const s of out.seeds ?? []) {
    seedDates.set(s.date, (seedDates.get(s.date) ?? 0) + 1);
    if (!ENERGY_VALUES.includes(s.energy))
      errors.push(`energy 위반: ${s.date} ${s.energy}`);
    if (!WAKE_VALUES.includes(s.wake_hint))
      errors.push(`wake_hint 위반: ${s.date} ${s.wake_hint}`);
  }
  for (const d of wanted) {
    const n = seedDates.get(d) ?? 0;
    if (n !== 1) errors.push(`시드가 날짜당 1건이 아니다: ${d} (${n}건)`);
  }
  for (const d of seedDates.keys())
    if (d < start || d > end) errors.push(`범위 밖 시드: ${d}`);
  for (const e of out.events ?? []) {
    if (e.date < start || e.date > end)
      errors.push(`범위 밖 이벤트: ${e.date} ${e.content}`);
    if (!e.content?.trim())
      errors.push(`이벤트 content가 비어 있다: ${e.date}`);
  }
  if (errors.length > 0) {
    console.error(`재생성 결과 검증 실패 ${errors.length}건 — 저장하지 않았다`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const plan: RegenPlan = {
    characterId: cid,
    rangeStart: start,
    rangeEnd: end,
    events: out.events,
    seeds: out.seeds,
  };
  writeJson(outPath, plan);
  console.log(
    `재생성 결과 저장: 이벤트 ${plan.events.length} / 시드 ${plan.seeds.length} → ${outPath}`,
  );
};

// ── apply-regen ──────────────────────────────────────────────────────────

const cmdApplyRegen = async (planPath: string): Promise<void> => {
  const plan = readJson<RegenPlan>(planPath);
  const { db } = await import("../db.js");
  const cid = plan.characterId;
  const boundary = boundaryDate();
  const now = kstNow();

  // 계획을 만든 날과 반영하는 날이 다르면 이미 시작된 날짜는 건너뛴다.
  // 건너뛴 날짜의 시드가 비면 그 날은 재생성을 다시 돌려야 한다 — 경고로 알린다.
  const staleSeeds = plan.seeds
    .filter((s) => s.date < boundary)
    .map((s) => s.date);
  if (staleSeeds.length > 0)
    console.warn(
      `[경고] 경계(${boundary}) 이전 시드 ${staleSeeds.length}건은 건너뛴다: ${staleSeeds.join(", ")} — 빈 날짜가 생기면 regen을 다시 돌릴 것`,
    );
  for (const s of plan.seeds) {
    if (!ENERGY_VALUES.includes(s.energy))
      fail(`energy 위반: ${s.date} ${s.energy}`);
    if (!WAKE_VALUES.includes(s.wake_hint))
      fail(`wake_hint 위반: ${s.date} ${s.wake_hint}`);
  }

  let seedsPut = 0;
  let eventsPut = 0;
  let dupSkipped = 0;
  let staleEvents = 0;

  db.transaction(() => {
    const upSeed = db.prepare(
      `INSERT OR REPLACE INTO day_seeds (character_id, date, energy, wake_hint, mood, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const s of plan.seeds) {
      if (s.date < boundary) continue;
      upSeed.run(cid, s.date, s.energy, s.wake_hint, s.mood, s.reason ?? null);
      seedsPut++;
    }

    const dupCheck = db.prepare(
      `SELECT COUNT(*) AS n FROM schedules WHERE character_id = ? AND date = ? AND content = ?`,
    );
    const insEv = db.prepare(
      `INSERT INTO schedules (character_id, owner, date, time_hint, content, with_name, area, user_knows, origin, status, created_at)
       VALUES (?, 'char', ?, ?, ?, ?, ?, 'unknown', 'rhythm', 'active', ?)`,
    );
    for (const e of plan.events) {
      if (e.date < boundary) {
        staleEvents++;
        continue;
      }
      if ((dupCheck.get(cid, e.date, e.content) as { n: number }).n > 0) {
        dupSkipped++;
        continue;
      }
      insEv.run(
        cid,
        e.date,
        e.time_hint ?? null,
        e.content,
        e.with_name ?? null,
        e.area ?? null,
        now,
      );
      eventsPut++;
    }
  })();

  const seedRange = db
    .prepare(
      `SELECT MIN(date) AS lo, MAX(date) AS hi, COUNT(*) AS n FROM day_seeds WHERE character_id = ? AND date >= ?`,
    )
    .get(cid, boundary) as { lo: string | null; hi: string | null; n: number };
  console.log(
    `재생성 반영 완료: 시드 ${seedsPut}건 (${seedRange.lo}~${seedRange.hi}) · 이벤트 ${eventsPut}건 · 중복 건너뜀 ${dupSkipped} · 지난 날짜 건너뜀 시드 ${staleSeeds.length}/이벤트 ${staleEvents}`,
  );
};

// ── 진입점 ───────────────────────────────────────────────────────────────

const usage = (): never => {
  console.error(
    [
      "사용법 (DB_PATH 환경변수 필수):",
      "  migrate-v1-data snapshot <characterId> <out.json>",
      "  migrate-v1-data diff-legacy <characterId> <snap.json> [out.json]",
      "  migrate-v1-data apply <candidates.json> [report.txt]",
      "  migrate-v1-data regen <candidates.json> <plan.json>",
      "  migrate-v1-data apply-regen <plan.json>",
    ].join("\n"),
  );
  process.exit(1);
};

const main = async (): Promise<void> => {
  if (!process.env.DB_PATH)
    fail(
      "DB_PATH가 없다. 어느 DB를 건드리는지 명시해야 한다 (예: DB_PATH=./rehearsal.db)",
    );
  const [cmd, a, b, c] = process.argv.slice(2);
  if (cmd === "snapshot" && a && b) await cmdSnapshot(Number(a), b);
  else if (cmd === "diff-legacy" && a && b)
    await cmdDiffLegacy(Number(a), b, c);
  else if (cmd === "apply" && a) await cmdApply(a, b);
  else if (cmd === "regen" && a && b) await cmdRegen(a, b);
  else if (cmd === "apply-regen" && a) await cmdApplyRegen(a);
  else usage();
};

await main();
