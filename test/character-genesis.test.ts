// 캐릭터 생성의 입력·출력 검사와 저장(character.ts)을 검사한다 — 모델은 부르지 않는다.
//
// 유저 입력을 거르는 inputProblem, 첫 호출 결과를 거르는 genesisProblem의 거부 분기 전부,
// 두 번째 호출에 넣는 재료 문장(arcMaterial)은 평가용 고정 재료(EVAL_GENESIS·EVAL_INPUT)를
// 한 칸씩 깨서 본다. persistGenesis는 임시 DB에 실제로 저장해 영역의 기본 갈래, userKnows
// 기본값, 원본 보존, 말투 첫 값을 본다. 텔레그램도 부르지 않는다.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CharacterGender,
  CharacterInput,
  GenesisCastRow,
  GenesisIdentityRow,
  GenesisOngoingRow,
  GenesisOutput,
  GenesisRelationshipFirst,
} from "../src/character.js";
import type { MemoryRow } from "../src/db.js";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

// DB 경로를 정한 뒤에 읽어야 임시 파일로 열린다 — 정적 import는 이 줄들보다 먼저 돈다.
const { db, getRelationship, listAreas, listMemoryItems } =
  await import("../src/db.js");
const {
  CHARACTER_AGE_BANDS,
  FREE_TEXT_MAX,
  arcMaterial,
  genesisProblem,
  inputProblem,
  persistGenesis,
} = await import("../src/character.js");
const { CORE_AREAS } = await import("../src/memory.js");
const { EVAL_GENESIS, EVAL_INPUT } =
  await import("../src/eval/fixture-character.js");

after(() => {
  db.close();
});

const clone = (): GenesisOutput => structuredClone(EVAL_GENESIS);

const identityOf = (
  out: GenesisOutput,
  area: string,
  subject: string,
): GenesisIdentityRow => {
  const r = out.identity.find((i) => i.area === area && i.subject === subject);
  if (!r) throw new Error(`고정 재료에 ${area}/${subject}가 없다`);
  return r;
};

const without = (
  out: GenesisOutput,
  area: string,
  subject: string,
): GenesisOutput => ({
  ...out,
  identity: out.identity.filter(
    (i) => !(i.area === area && i.subject === subject),
  ),
});

const memoryRowsOf = (characterId: number): MemoryRow[] =>
  db
    .prepare(`SELECT * FROM memory_items WHERE character_id = ? ORDER BY id`)
    .all(characterId) as MemoryRow[];

const rowOf = (rows: MemoryRow[], area: string, subject: string): MemoryRow => {
  const r = rows.find((m) => m.area === area && m.subject === subject);
  if (!r) throw new Error(`저장된 행에 ${area}/${subject}가 없다`);
  return r;
};

// ── genesisProblem ────────────────────────────────────────────────────────

test("고정 재료는 그대로 통과한다", () => {
  assert.equal(genesisProblem(EVAL_GENESIS), null);
});

test("identity·cast·ongoing·relationship 중 하나라도 빠지면 거른다", () => {
  const missing = "identity·cast·ongoing·relationship이 모두 있어야 한다";
  assert.equal(
    genesisProblem({
      ...clone(),
      identity: undefined as unknown as GenesisIdentityRow[],
    }),
    missing,
  );
  assert.equal(
    genesisProblem({
      ...clone(),
      cast: undefined as unknown as GenesisCastRow[],
    }),
    missing,
  );
  assert.equal(
    genesisProblem({
      ...clone(),
      ongoing: undefined as unknown as GenesisOngoingRow[],
    }),
    missing,
  );
  assert.equal(
    genesisProblem({
      ...clone(),
      relationship: undefined as unknown as GenesisRelationshipFirst,
    }),
    missing,
  );
});

test("정체성 키가 형식에 안 맞으면 어느 키인지 적어 거른다", () => {
  const out = clone();
  identityOf(out, "기본", "이름").area = "";
  assert.match(
    genesisProblem(out) ?? "",
    /^정체성 키\(\/이름\): 영역과 무엇이 모두 있어야 한다$/,
  );
});

test("정체성 값이 비면 거른다", () => {
  const out = clone();
  identityOf(out, "기본", "이름").value = "   ";
  assert.match(genesisProblem(out) ?? "", /^정체성 값이 비었다\(기본\/이름\)$/);
});

test("정체성 키가 겹치면 거른다", () => {
  const out = clone();
  out.identity.push({ area: "기본", subject: "이름", value: "다른 이름" });
  assert.match(genesisProblem(out) ?? "", /^정체성 키가 겹친다\(기본\/이름\)$/);
});

test("키 목록에도 취미에도 없는 정체성 키는 거른다", () => {
  const out = clone();
  out.identity.push({ area: "별자리", subject: "띠", value: "양자리" });
  assert.match(
    genesisProblem(out) ?? "",
    /^정체성에 없는 키\(별자리\/띠\) — 키 목록과 취미만 쓴다$/,
  );
});

test("정체성 키가 빠지면 어느 키인지 적어 거른다", () => {
  const out = without(clone(), "생활", "잠");
  assert.match(genesisProblem(out) ?? "", /^정체성에 빠진 키: 생활\/잠$/);
  const two = without(out, "연애", "이력");
  assert.match(
    genesisProblem(two) ?? "",
    /^정체성에 빠진 키: 생활\/잠, 연애\/이력$/,
  );
});

test("취미가 셋 미만이면 거른다", () => {
  const out = without(clone(), "취미", "영화");
  assert.match(genesisProblem(out) ?? "", /^취미가 2개 — 최소 3개$/);
});

test("그늘을 유저가 아는 것으로 적으면 거른다", () => {
  const out = clone();
  identityOf(out, "기본", "그늘").userKnows = "known";
  assert.equal(genesisProblem(out), "그늘은 unknown이어야 한다");
});

test("주변 인물이 셋 미만이면 거른다", () => {
  const out = clone();
  out.cast.pop();
  assert.match(genesisProblem(out) ?? "", /^주변 인물이 2명 — 최소 3명$/);
});

test("주변 인물 이름에 구분자가 있으면 키로 못 쓴다고 거른다", () => {
  const out = clone();
  const first = out.cast[0];
  assert.ok(first);
  first.name = "엄마/아빠";
  assert.match(
    genesisProblem(out) ?? "",
    /^주변 인물 키\(가족\/엄마\/아빠\): 키 한 자리에 여러 낱말을 묶지 않는다$/,
  );
});

test("주변 인물 항목 넷 중 하나라도 비면 거른다", () => {
  for (const field of ["relation", "contactMode", "region", "value"] as const) {
    const out = clone();
    const first = out.cast[0];
    assert.ok(first);
    first[field] = " ";
    assert.match(
      genesisProblem(out) ?? "",
      /^주변 인물 항목이 비었다\(부모님\) — relation·contactMode·region·value 전부 필요$/,
      field,
    );
  }
});

test("진행 중인 일이 둘 미만이면 거른다", () => {
  const out = clone();
  out.ongoing.pop();
  assert.match(genesisProblem(out) ?? "", /^진행 중인 일이 1개 — 최소 2개$/);
});

test("진행 중인 일의 키가 너무 길면 거른다", () => {
  const out = clone();
  const first = out.ongoing[0];
  assert.ok(first);
  first.subject = "가".repeat(21);
  assert.match(
    genesisProblem(out) ?? "",
    /^진행 중인 일 키\(직업\/가{21}\): 키가 너무 길다$/,
  );
});

test("진행 중인 일의 값이 비면 거른다", () => {
  const out = clone();
  const first = out.ongoing[0];
  assert.ok(first);
  first.value = "";
  assert.match(
    genesisProblem(out) ?? "",
    /^진행 중인 일 값이 비었다\(직업\/상가 리모델링 설계\)$/,
  );
});

test("진행 중인 일의 끝나는 조건이 비면 거른다", () => {
  const out = clone();
  const first = out.ongoing[0];
  assert.ok(first);
  first.endCondition = "  ";
  assert.match(
    genesisProblem(out) ?? "",
    /^끝나는 조건이 비었다\(직업\/상가 리모델링 설계\)$/,
  );
});

test("관계 첫 값 다섯 중 하나라도 비면 어느 칸인지 적어 거른다", () => {
  for (const field of [
    "stage",
    "addressTerms",
    "speechNote",
    "history",
    "feelings",
  ] as const) {
    const out = clone();
    out.relationship[field] = "";
    assert.equal(genesisProblem(out), `관계 첫 값이 비었다(${field})`);
  }
});

test("첫 인사가 비면 거른다", () => {
  const out = clone();
  out.firstGreeting = " \n";
  assert.equal(genesisProblem(out), "첫 인사가 비었다");
});

// ── inputProblem ──────────────────────────────────────────────────────────

test("고정 입력은 그대로 통과한다", () => {
  assert.equal(inputProblem(EVAL_INPUT), null);
});

test("성별이 선택지 밖이면 거른다", () => {
  assert.equal(
    inputProblem({ ...EVAL_INPUT, gender: "기타" as CharacterGender }),
    "성별은 남성·여성 중 하나여야 한다",
  );
});

test("나이대가 선택지 밖이면 거른다 — 미성년 나이대도 마찬가지다", () => {
  const expected = `나이대는 선택지(${CHARACTER_AGE_BANDS[0]}~${CHARACTER_AGE_BANDS[CHARACTER_AGE_BANDS.length - 1]}) 중 하나여야 한다`;
  assert.equal(inputProblem({ ...EVAL_INPUT, ageBand: "10대 후반" }), expected);
  assert.equal(inputProblem({ ...EVAL_INPUT, ageBand: "30대" }), expected);
});

test("서술은 1000자까지 받고 한 글자 넘으면 어느 칸인지 적어 거른다", () => {
  const limit = "가".repeat(FREE_TEXT_MAX);
  const over = "가".repeat(FREE_TEXT_MAX + 1);
  assert.equal(inputProblem({ ...EVAL_INPUT, personality: limit }), null);
  assert.equal(
    inputProblem({ ...EVAL_INPUT, personality: over }),
    `성격 서술이 너무 길다(${FREE_TEXT_MAX}자 이내)`,
  );
  assert.equal(
    inputProblem({ ...EVAL_INPUT, relationship: over }),
    `관계 서술이 너무 길다(${FREE_TEXT_MAX}자 이내)`,
  );
  assert.equal(
    inputProblem({ ...EVAL_INPUT, wish: over }),
    `바라는 모습 서술이 너무 길다(${FREE_TEXT_MAX}자 이내)`,
  );
});

test("서술 셋을 다 비워도 선택지 둘만 맞으면 통과한다", () => {
  const input: CharacterInput = { gender: "여성", ageBand: "20대 후반" };
  assert.equal(inputProblem(input), null);
});

// ── arcMaterial ───────────────────────────────────────────────────────────

test("아크 재료는 정체성·주변 인물·진행 중인 일·관계 순으로 머리말이 선다", () => {
  const text = arcMaterial(EVAL_GENESIS);
  const at = (h: string): number => {
    const i = text.indexOf(h);
    assert.ok(i >= 0, `${h}가 없다`);
    return i;
  };
  assert.ok(at("[정체성]") < at("[주변 인물]"));
  assert.ok(at("[주변 인물]") < at("[진행 중인 일]"));
  assert.ok(at("[진행 중인 일]") < at("[유저와의 관계]"));
  assert.ok(text.startsWith("[정체성]\n"));
});

test("정체성 줄은 '- 영역/무엇: 값' 꼴이고 항목 수만큼 들어간다", () => {
  const lines = arcMaterial(EVAL_GENESIS).split("\n");
  assert.ok(lines.includes("- 기본/이름: 한도윤"));
  const identityLines = lines.filter((l) =>
    EVAL_GENESIS.identity.some(
      (r) => l === `- ${r.area}/${r.subject}: ${r.value}`,
    ),
  );
  assert.equal(identityLines.length, EVAL_GENESIS.identity.length);
});

test("주변 인물·진행 중인 일·관계 줄이 정한 꼴로 들어간다", () => {
  const text = arcMaterial(EVAL_GENESIS);
  const parent = EVAL_GENESIS.cast[0];
  assert.ok(parent);
  assert.ok(
    text.includes(
      `- ${parent.name} (${parent.area}, ${parent.relation}): ${parent.value}`,
    ),
  );
  const work = EVAL_GENESIS.ongoing[0];
  assert.ok(work);
  assert.ok(
    text.includes(
      `- ${work.area}/${work.subject}: ${work.value} (끝나는 조건: ${work.endCondition})`,
    ),
  );
  const rel = EVAL_GENESIS.relationship;
  assert.ok(text.endsWith(`[유저와의 관계]\n- ${rel.stage} / ${rel.history}`));
});

// ── persistGenesis (DB) ───────────────────────────────────────────────────

test("저장하면 영역의 기본 갈래 여덟 개가 깔린다", () => {
  const id = persistGenesis("chat-genesis-areas", EVAL_INPUT, EVAL_GENESIS);
  assert.ok(id > 0);
  const names = listAreas(id).map((a) => a.name);
  for (const core of CORE_AREAS) assert.ok(names.includes(core), core);
});

test("userKnows를 안 적은 항목은 unknown으로 저장되고 적은 값은 그대로 간다", () => {
  const out = clone();
  identityOf(out, "기본", "이름").userKnows = "known";
  const teammate = out.cast[2];
  assert.ok(teammate);
  teammate.userKnows = "known";
  const id = persistGenesis("chat-genesis-knows", EVAL_INPUT, out);
  const rows = memoryRowsOf(id);
  assert.equal(rowOf(rows, "기본", "이름").user_knows, "known");
  assert.equal(rowOf(rows, "기본", "고향").user_knows, "unknown");
  assert.equal(rowOf(rows, "기본", "그늘").user_knows, "unknown");
  assert.equal(rowOf(rows, "가족", "부모님").user_knows, "unknown");
  assert.equal(rowOf(rows, "직장", teammate.name).user_knows, "known");
  assert.equal(rowOf(rows, "직업", "상가 리모델링 설계").user_knows, "unknown");
});

test("저장된 기억 행은 전부 생성 때 정한 행(origin=creation)이다", () => {
  const id = persistGenesis("chat-genesis-origin", EVAL_INPUT, EVAL_GENESIS);
  const rows = listMemoryItems(id);
  assert.equal(
    rows.length,
    EVAL_GENESIS.identity.length +
      EVAL_GENESIS.cast.length +
      EVAL_GENESIS.ongoing.length,
  );
  assert.ok(rows.every((r) => r.origin === "creation" && r.owner === "char"));
});

test("genesis_json에 입력과 결과 원본이 그대로 보존된다", () => {
  const id = persistGenesis("chat-genesis-json", EVAL_INPUT, EVAL_GENESIS);
  const raw = db
    .prepare(`SELECT genesis_json FROM characters WHERE id = ?`)
    .pluck()
    .get(id);
  assert.equal(typeof raw, "string");
  assert.deepEqual(JSON.parse(raw as string), {
    v: 2,
    input: EVAL_INPUT,
    output: EVAL_GENESIS,
  });
});

test("관계 첫 값은 존댓말로 고정되고 잘 통하는 것·조심할 것은 비운 채 시작한다", () => {
  const id = persistGenesis("chat-genesis-speech", EVAL_INPUT, EVAL_GENESIS);
  const rel = getRelationship(id);
  assert.ok(rel);
  assert.equal(rel.speech_level, "polite");
  assert.equal(rel.stage, EVAL_GENESIS.relationship.stage);
  assert.equal(rel.address_terms, EVAL_GENESIS.relationship.addressTerms);
  assert.equal(rel.speech_note, EVAL_GENESIS.relationship.speechNote);
  assert.equal(rel.feelings, EVAL_GENESIS.relationship.feelings);
  assert.equal(rel.rapport, null);
  assert.equal(rel.cautions, null);
});
