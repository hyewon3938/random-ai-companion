// V2 데이터 이관 도구 (#50) — 운영 중인 캐릭터를 새 기억 구조로 옮긴다.
//
// 명령 셋:
//   genesis <input.json> <out.json>  새로 적는 설정으로 생성 호출을 돌리고 결과 JSON만 저장한다.
//                                    DB에는 아무것도 쓰지 않는다 — 관계 여섯 값을 사람이 다듬는 재료.
//   check <candidates.json>          후보를 DB와 대조해 검증만 한다. 반영 없음.
//   apply <candidates.json>          검증을 통과하면 트랜잭션 하나로 반영한다:
//                                    주변 인물을 person 행으로 저장(대화 유래), 관계 컬럼 초기값
//                                    기입, 프롬프트 고정값 대체 키 확인, memory_items_legacy 삭제.
//
// DB_PATH를 반드시 지정해야 한다. db.js를 import하는 순간 config.dbPath가 열리고 마이그레이션이
// 돌기 때문에, 인자 검사가 끝난 뒤에 동적 import한다 (migrate-v1-data.ts와 같은 이유).
// 예: DB_PATH=data/rehearsal-v2.db npx tsx src/tools/migrate-v2-data.ts check docs/migration/candidates-v2.json
import { readFileSync, writeFileSync } from "node:fs";

const fail: (msg: string) => never = (msg) => {
  console.error(`오류: ${msg}`);
  process.exit(1);
};

const [command, ...args] = process.argv.slice(2);
if (!command || !["genesis", "check", "apply"].includes(command))
  fail(
    "사용법: migrate-v2-data.ts <genesis input.json out.json | check candidates.json | apply candidates.json>",
  );
if (!process.env.DB_PATH)
  fail(
    "DB_PATH를 지정해야 한다. 운영 DB를 실수로 여는 것을 막기 위한 안전장치.",
  );

// ---------- 후보 파일 형태 ----------

interface PersonCandidate {
  name: string;
  owner: "char" | "user";
  area: string;
  relation: string | null;
  contactMode: string | null;
  region: string | null;
  value: string;
  userKnows: "known" | "unknown";
  lastMentionedAt: string | null;
  interest: "high" | "medium" | "low" | null;
  tags?: string[];
}

interface RelationshipCandidate {
  stage: string;
  speechLevel: "polite" | "casual";
  speechNote: string;
  addressTerms: string;
  rapport: string | null;
  cautions: string | null;
  history: string;
  feelings: string;
}

interface Candidates {
  characterId: number;
  persons: PersonCandidate[];
  relationship: RelationshipCandidate;
  /** 이미 값이 차 있어야 하는 키 — 프롬프트 고정값을 대체한다. "영역/주제" 꼴. */
  keepKeys: string[];
  dropLegacyTable: boolean;
}

// ---------- genesis: 생성 호출만 돌리고 결과 저장 ----------

if (command === "genesis") {
  const [inputPath, outPath] = args;
  if (!inputPath || !outPath) fail("사용법: genesis <input.json> <out.json>");
  const raw = JSON.parse(readFileSync(inputPath, "utf8"));
  const { profile, ...input } = raw;
  if (!profile)
    fail("input.json에 profile을 함께 적어야 한다 (DB를 읽지 않는다).");

  const { generateGenesis } = await import("../character.js");
  const out = await generateGenesis(input, profile);
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");

  console.log(`생성 결과 저장됨: ${outPath}`);
  console.log("\n=== 관계 첫 값 (다듬을 재료) ===");
  for (const [k, v] of Object.entries(out.relationship))
    console.log(`\n[${k}]\n${v}`);
  process.exit(0);
}

// ---------- check / apply ----------

const candPath = args[0];
if (!candPath) fail(`사용법: ${command} <candidates.json>`);
const cand = JSON.parse(readFileSync(candPath, "utf8")) as Candidates;

const { db } = await import("../db.js");
const { keyProblem, saveMemory } = await import("../memory.js");

const errors: string[] = [];
const warnings: string[] = [];

// 1) 캐릭터 존재
const character = db
  .prepare(`SELECT id, status FROM characters WHERE id = ?`)
  .get(cand.characterId) as { id: number; status: string } | undefined;
if (!character) fail(`캐릭터 ${cand.characterId}가 없다.`);

// 2) 주변 인물 후보 ↔ cast_members 대조: 이름 집합이 정확히 일치해야 한다
const castRows = db
  .prepare(
    `SELECT owner, name, relation_label, meet_pattern, place, recent_note, user_knows, last_mentioned_at
     FROM cast_members WHERE character_id = ?`,
  )
  .all(cand.characterId) as {
  owner: string;
  name: string;
  relation_label: string | null;
  meet_pattern: string | null;
  place: string | null;
  recent_note: string | null;
  user_knows: string;
  last_mentioned_at: string | null;
}[];
const castByName = new Map(castRows.map((r) => [r.name, r]));
const candNames = new Set(cand.persons.map((p) => p.name));
if (candNames.size !== cand.persons.length)
  errors.push("후보에 이름 중복이 있다.");
for (const r of castRows)
  if (!candNames.has(r.name))
    errors.push(`cast_members의 ${r.name}이 후보에 없다.`);
for (const p of cand.persons) {
  const src = castByName.get(p.name);
  if (!src) {
    errors.push(`후보 ${p.name}에 해당하는 cast_members 행이 없다.`);
    continue;
  }
  if (src.owner !== p.owner)
    errors.push(
      `${p.name}: owner가 다르다 (원본 ${src.owner}, 후보 ${p.owner}).`,
    );
  if (src.user_knows !== p.userKnows)
    errors.push(`${p.name}: userKnows가 다르다 (원본 ${src.user_knows}).`);
  const bad = keyProblem(p.area, p.name);
  if (bad) errors.push(`${p.name}: 키 문제 — ${bad}`);
  if (!p.value?.trim()) errors.push(`${p.name}: value가 비었다.`);
  if (p.owner === "user" && p.interest)
    errors.push(`${p.name}: 유저 쪽 행에는 interest를 두지 않는다.`);
  if (p.owner === "user" && p.userKnows !== "known")
    errors.push(`${p.name}: 유저 쪽 행은 user_knows가 known이어야 한다.`);
  if (src.recent_note && p.value !== src.recent_note)
    warnings.push(
      `${p.name}: value가 recent_note와 다르다 (의도한 수정인지 확인).`,
    );
}

// 3) 관계 초기값: 여덟 칸 검사 + 아직 비어 있어야 함
const rel = cand.relationship;
for (const k of [
  "stage",
  "speechNote",
  "addressTerms",
  "history",
  "feelings",
] as const)
  if (!rel[k]?.trim()) errors.push(`관계 초기값 ${k}가 비었다.`);
if (!["polite", "casual"].includes(rel.speechLevel))
  errors.push(`speechLevel은 polite|casual만 된다: ${rel.speechLevel}`);
const relRow = db
  .prepare(
    `SELECT stage, legacy_state_json FROM relationships WHERE character_id = ?`,
  )
  .get(cand.characterId) as
  { stage: string | null; legacy_state_json: string | null } | undefined;
if (!relRow) errors.push("relationships 행이 없다.");
else if (relRow.stage !== null)
  errors.push("relationships.stage에 이미 값이 있다 — 재실행으로 보인다.");

// 4) person 행이 아직 없어야 함 (재실행 방지)
const personCount = (
  db
    .prepare(
      `SELECT COUNT(*) AS n FROM memory_items WHERE character_id = ? AND item_type = 'person'`,
    )
    .get(cand.characterId) as { n: number }
).n;
if (personCount > 0)
  errors.push(`person 행이 이미 ${personCount}건 있다 — 재실행으로 보인다.`);

// 5) 프롬프트 고정값을 대체할 키: 생성 유래 행에 값이 차 있어야 함
for (const key of cand.keepKeys) {
  const [area, subject] = key.split("/");
  const row = db
    .prepare(
      `SELECT value FROM memory_items
       WHERE character_id = ? AND owner = 'char' AND origin = 'creation' AND area = ? AND subject = ?`,
    )
    .get(cand.characterId, area, subject) as { value: string } | undefined;
  if (!row?.value?.trim()) errors.push(`대체 키 ${key}가 없거나 비어 있다.`);
}

// 6) 옛 기억 표 이관 확인: relationship 외 모든 행이 id 그대로 새 표에 있고 내용이 같아야 삭제 가능
const legacyExists = db
  .prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_items_legacy'`,
  )
  .get();
let legacyStats = { total: 0, relationship: 0, unmoved: 0 };
if (cand.dropLegacyTable && !legacyExists)
  errors.push("memory_items_legacy가 이미 없다 — 재실행으로 보인다.");
if (legacyExists) {
  legacyStats = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(item_type = 'relationship') AS relationship,
              SUM(item_type <> 'relationship'
                  AND NOT EXISTS (SELECT 1 FROM memory_items m
                                   WHERE m.id = memory_items_legacy.id
                                     AND m.value = memory_items_legacy.value)) AS unmoved
       FROM memory_items_legacy`,
    )
    .get() as typeof legacyStats;
  if (legacyStats.unmoved > 0)
    errors.push(
      `옛 표의 ${legacyStats.unmoved}건이 새 표로 옮겨지지 않았다 — 삭제 불가.`,
    );
}

// ---------- 결과 출력, check는 여기서 끝 ----------

console.log(`캐릭터: id=${character.id} (${character.status})`);
console.log(
  `주변 인물 후보 ${cand.persons.length}건 (캐릭터 쪽 ${cand.persons.filter((p) => p.owner === "char").length}, 유저 쪽 ${cand.persons.filter((p) => p.owner === "user").length})`,
);
if (legacyExists)
  console.log(
    `옛 기억 표 ${legacyStats.total}건 = 관계 ${legacyStats.relationship} + 이관 확인 ${legacyStats.total - legacyStats.relationship - legacyStats.unmoved}, 미이관 ${legacyStats.unmoved}`,
  );
if (warnings.length) {
  console.log(`\n주의 ${warnings.length}건:`);
  for (const w of warnings) console.log(`  - ${w}`);
}
if (errors.length) {
  console.log(`\n오류 ${errors.length}건:`);
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}
console.log("\n검증 통과.");
if (command === "check") process.exit(0);

// ---------- apply: 트랜잭션 하나로 반영 ----------

const now = new Date().toISOString().replace("T", " ").slice(0, 19);
const applyAll = db.transaction(() => {
  for (const p of cand.persons)
    saveMemory({
      characterId: cand.characterId,
      itemType: "person",
      owner: p.owner,
      area: p.area,
      subject: p.name,
      value: p.value,
      userKnows: p.userKnows,
      relation: p.relation,
      contactMode: p.contactMode,
      region: p.region,
      lastMentionedAt: p.lastMentionedAt,
      interest: p.owner === "char" ? p.interest : null,
      tags: p.tags,
    });
  db.prepare(
    `UPDATE relationships SET stage = ?, speech_level = ?, speech_note = ?, address_terms = ?,
       rapport = ?, cautions = ?, history = ?, feelings = ?, updated_at = ?
     WHERE character_id = ?`,
  ).run(
    rel.stage,
    rel.speechLevel,
    rel.speechNote,
    rel.addressTerms,
    rel.rapport,
    rel.cautions,
    rel.history,
    rel.feelings,
    now,
    cand.characterId,
  );
  if (cand.dropLegacyTable) db.exec(`DROP TABLE memory_items_legacy`);
});
applyAll();

// ---------- 반영 확인 ----------

console.log("\n=== 반영 결과 ===");
const byType = db
  .prepare(
    `SELECT item_type, owner, origin, COUNT(*) AS n FROM memory_items
     WHERE character_id = ? GROUP BY item_type, owner, origin ORDER BY item_type, owner, origin`,
  )
  .all(cand.characterId) as {
  item_type: string;
  owner: string;
  origin: string;
  n: number;
}[];
for (const r of byType)
  console.log(`  ${r.item_type}/${r.owner}/${r.origin}: ${r.n}`);

const relAfter = db
  .prepare(
    `SELECT stage, speech_level, speech_note, address_terms, rapport, cautions,
            history, feelings, legacy_state_json IS NOT NULL AS legacy_kept
     FROM relationships WHERE character_id = ?`,
  )
  .get(cand.characterId) as Record<string, unknown>;
console.log("\n=== 관계 컬럼 ===");
for (const [k, v] of Object.entries(relAfter))
  console.log(
    `  ${k}: ${v == null ? "(비움)" : k === "legacy_kept" ? v : String(v).slice(0, 40) + "…"}`,
  );

const legacyGone = !db
  .prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_items_legacy'`,
  )
  .get();
console.log(`\n옛 기억 표 삭제됨: ${legacyGone}`);
console.log(
  `integrity_check: ${(db.pragma("integrity_check") as { integrity_check: string }[])[0].integrity_check}`,
);
console.log(
  `foreign_key_check 위반: ${(db.pragma("foreign_key_check") as unknown[]).length}건`,
);
