// 기억 표(memory_items)의 컬럼 규칙 — 항목별 전용 컬럼 비우기, 항목 옮기기, 오늘 메모 지우기, 영역 note — 를 검사한다.
//
// 저장 함수가 DB의 CHECK보다 먼저 항목에 안 맞는 컬럼을 비우는지, 진행 중인 일을 사실로 옮길 때
// 생성 행은 남기고 대화 행은 지우며 태그가 어느 쪽에 붙는지, 오늘 메모의 창이 아래는 닫히고 위는
// 열리는지, 영역 note가 null로 덮이지 않는지 본다. 생성 행의 upsert 거부와 memory.ts 쪽 래퍼는
// memory-identity.test.ts가 본다.
//
// DB는 임시 파일로 새로 만든다. 모델도 텔레그램도 부르지 않아 값이 안 든다.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

// DB 경로를 정한 뒤에 읽어야 임시 파일로 열린다 — 정적 import는 이 줄들보다 먼저 돈다.
const {
  db,
  addTodayNote,
  clearTodayNotes,
  findRefsByTags,
  getMemoryItemById,
  getTags,
  getTodayNotes,
  insertCharacter,
  insertCreationMemory,
  listAreas,
  listMemoryItems,
  markMemoriesRetrieved,
  moveMemoryItemType,
  setTags,
  upsertArea,
  upsertMemoryItem,
} = await import("../src/db.js");

const AT = "2026-09-07 10:00:00";
// 생성 기억이 딸려 오지 않게 캐릭터 행만 넣는다 — 목록 검사의 행 수를 여기서 다 세려고.
const characterId = insertCharacter("chat-memory-items", "{}", AT);

after(() => db.close());

// ── 항목별 전용 컬럼 ──────────────────────────────────────────────────────

test("사실 항목에 주변 인물·진행 중인 일 전용 값을 주면 비우고 캐릭터 쪽 interest는 남긴다", () => {
  const id = upsertMemoryItem({
    characterId,
    itemType: "fact",
    owner: "char",
    area: "취미",
    subject: "등산",
    value: "주말마다 간다",
    relation: "친구",
    contactMode: "자주",
    region: "서울",
    lastMentionedAt: AT,
    endCondition: "정상 찍으면",
    interest: "high",
    userKnows: "known",
    updatedAt: AT,
  });
  const row = getMemoryItemById(id);
  assert.equal(row?.relation, null);
  assert.equal(row?.contact_mode, null);
  assert.equal(row?.region, null);
  assert.equal(row?.last_mentioned_at, null);
  assert.equal(row?.end_condition, null);
  assert.equal(row?.interest, "high");
  assert.equal(row?.user_knows, "known");
  assert.equal(row?.origin, "conversation");
});

test("유저 쪽 행은 interest를 비우고 user_knows를 known으로 둔다", () => {
  const id = upsertMemoryItem({
    characterId,
    itemType: "person",
    owner: "user",
    area: "가족",
    subject: "동생",
    value: "대학생",
    relation: "동생",
    interest: "high",
    userKnows: "unknown",
    updatedAt: AT,
  });
  const row = getMemoryItemById(id);
  assert.equal(row?.interest, null);
  assert.equal(row?.user_knows, "known");
  assert.equal(row?.relation, "동생");
});

test("진행 중인 일은 끝나는 조건을 남기고 주변 인물 값은 비운다", () => {
  const id = upsertMemoryItem({
    characterId,
    itemType: "ongoing",
    owner: "char",
    area: "취미",
    subject: "책",
    value: "3장까지 읽었다",
    endCondition: "다 읽으면",
    relation: "친구",
    updatedAt: AT,
  });
  const row = getMemoryItemById(id);
  assert.equal(row?.end_condition, "다 읽으면");
  assert.equal(row?.relation, null);
});

test("같은 키로 다시 쓰면 행이 늘지 않고 내용만 바뀌며 같은 번호를 돌려준다", () => {
  const first = upsertMemoryItem({
    characterId,
    itemType: "fact",
    owner: "user",
    area: "일",
    subject: "직장",
    value: "이직 준비 중",
    updatedAt: AT,
  });
  const second = upsertMemoryItem({
    characterId,
    itemType: "fact",
    owner: "user",
    area: "일",
    subject: "직장",
    value: "이직했다",
    updatedAt: "2026-09-08 10:00:00",
  });
  assert.equal(second, first);
  assert.equal(getMemoryItemById(first)?.value, "이직했다");
  assert.equal(
    listMemoryItems(characterId, "fact").filter((r) => r.subject === "직장")
      .length,
    1,
  );
});

// ── 항목 옮기기 ───────────────────────────────────────────────────────────

test("생성 행을 사실로 옮기면 원본은 남고 새 대화 행에 태그만 복사된다", () => {
  const src = insertCreationMemory({
    characterId,
    itemType: "ongoing",
    owner: "char",
    area: "일",
    subject: "자격증 공부",
    value: "시험이 다음 달이다",
    endCondition: "시험 보면",
    interest: "medium",
    updatedAt: AT,
  });
  setTags(characterId, "memory", src, ["자격증", "공부"]);
  const moved = moveMemoryItemType(src, "fact", "2026-09-09 05:00:00");
  assert.notEqual(moved, src);
  const orig = getMemoryItemById(src);
  assert.equal(orig?.item_type, "ongoing");
  assert.equal(orig?.origin, "creation");
  const fresh = getMemoryItemById(moved);
  assert.equal(fresh?.item_type, "fact");
  assert.equal(fresh?.origin, "conversation");
  assert.equal(fresh?.end_condition, null);
  assert.equal(fresh?.subject, "자격증 공부");
  assert.deepEqual(getTags("memory", src), ["공부", "자격증"]);
  assert.deepEqual(getTags("memory", moved), ["공부", "자격증"]);
  assert.deepEqual(
    findRefsByTags(characterId, "memory", ["자격증"])
      .map((r) => r.ref_id)
      .sort((a, b) => a - b),
    [src, moved].sort((a, b) => a - b),
  );
});

test("대화 행을 사실로 옮기면 원본이 지워지고 태그가 새 행으로 옮겨진다", () => {
  const src = upsertMemoryItem({
    characterId,
    itemType: "ongoing",
    owner: "char",
    area: "취미",
    subject: "러닝 준비",
    value: "10km 대회 신청했다",
    endCondition: "대회 뛰면",
    updatedAt: AT,
  });
  setTags(characterId, "memory", src, ["러닝", "대회"]);
  const moved = moveMemoryItemType(src, "fact", "2026-09-09 05:00:00");
  assert.notEqual(moved, src);
  assert.equal(getMemoryItemById(src), undefined);
  assert.equal(getMemoryItemById(moved)?.item_type, "fact");
  assert.deepEqual(getTags("memory", src), []);
  assert.deepEqual(getTags("memory", moved), ["대회", "러닝"]);
  assert.deepEqual(
    findRefsByTags(characterId, "memory", ["러닝"]).map((r) => r.ref_id),
    [moved],
  );
});

test("같은 항목으로 옮기면 행을 지우지 않고 그 번호를 돌려준다", () => {
  const src = upsertMemoryItem({
    characterId,
    itemType: "fact",
    owner: "char",
    area: "기본",
    subject: "고향",
    value: "청주",
    updatedAt: AT,
  });
  assert.equal(moveMemoryItemType(src, "fact", "2026-09-09 05:00:00"), src);
  assert.equal(getMemoryItemById(src)?.value, "청주");
  assert.equal(moveMemoryItemType(999999, "fact", AT), 999999);
});

// ── 오늘 메모 ─────────────────────────────────────────────────────────────

test("오늘 메모는 시작 시각은 포함하고 끝 시각은 빼고 지우며 구간 밖은 남긴다", () => {
  const since = "2026-09-06 05:00:00";
  const until = "2026-09-07 05:00:00";
  addTodayNote(characterId, "2026-09-06 04:59:59", "경계 앞");
  addTodayNote(characterId, since, "시작 시각 그대로");
  addTodayNote(characterId, "2026-09-06 15:00:00", "구간 안");
  addTodayNote(characterId, until, "끝 시각 그대로");
  addTodayNote(characterId, "2026-09-07 09:00:00", "경계 뒤");
  assert.equal(clearTodayNotes(characterId, since, until), 2);
  assert.deepEqual(
    getTodayNotes(characterId, "2026-09-06 00:00:00").map((n) => n.note),
    ["경계 앞", "끝 시각 그대로", "경계 뒤"],
  );
});

test("오늘 메모 지우기는 다른 캐릭터의 메모를 건드리지 않는다", () => {
  const other = insertCharacter("chat-memory-items-other", "{}", AT);
  addTodayNote(other, "2026-09-06 12:00:00", "남의 메모");
  assert.equal(
    clearTodayNotes(characterId, "2026-09-06 05:00:00", "2026-09-07 05:00:00"),
    0,
  );
  assert.equal(getTodayNotes(other, "2026-09-06 00:00:00").length, 1);
});

// ── 영역 ──────────────────────────────────────────────────────────────────

test("영역 note는 null로 덮지 않고 새 note를 주면 바뀐다", () => {
  upsertArea(characterId, "일", "직장과 커리어");
  upsertArea(characterId, "일", null);
  assert.equal(
    listAreas(characterId).find((a) => a.name === "일")?.note,
    "직장과 커리어",
  );
  upsertArea(characterId, "일");
  assert.equal(
    listAreas(characterId).find((a) => a.name === "일")?.note,
    "직장과 커리어",
  );
  upsertArea(characterId, "일", "일과 공부");
  assert.equal(
    listAreas(characterId).find((a) => a.name === "일")?.note,
    "일과 공부",
  );
  assert.equal(listAreas(characterId).filter((a) => a.name === "일").length, 1);
});

// ── 목록과 꺼낸 기록 ──────────────────────────────────────────────────────

test("기억 목록은 항목으로 거르고 최근 갱신 순으로 준다", () => {
  const fresh = insertCharacter("chat-memory-items-list", "{}", AT);
  const older = upsertMemoryItem({
    characterId: fresh,
    itemType: "fact",
    owner: "char",
    area: "기본",
    subject: "이름",
    value: "김하늘",
    updatedAt: "2026-09-01 10:00:00",
  });
  const newer = upsertMemoryItem({
    characterId: fresh,
    itemType: "fact",
    owner: "char",
    area: "기본",
    subject: "나이",
    value: "서른",
    updatedAt: "2026-09-05 10:00:00",
  });
  const person = upsertMemoryItem({
    characterId: fresh,
    itemType: "person",
    owner: "char",
    area: "가족",
    subject: "누나",
    value: "서울 산다",
    relation: "누나",
    updatedAt: "2026-09-03 10:00:00",
  });
  assert.deepEqual(
    listMemoryItems(fresh, "fact").map((r) => r.id),
    [newer, older],
  );
  assert.deepEqual(
    listMemoryItems(fresh).map((r) => r.id),
    [newer, person, older],
  );
  assert.deepEqual(listMemoryItems(fresh, "ongoing"), []);
});

test("꺼낸 기억은 꺼낸 시각이 적히고 횟수가 하나씩 오른다", () => {
  const id = upsertMemoryItem({
    characterId,
    itemType: "fact",
    owner: "char",
    area: "취미",
    subject: "커피",
    value: "드립을 내린다",
    updatedAt: AT,
  });
  assert.equal(getMemoryItemById(id)?.retrieval_count, 0);
  markMemoriesRetrieved([id], "2026-09-07 11:00:00");
  markMemoriesRetrieved([id], "2026-09-07 12:00:00");
  markMemoriesRetrieved([], "2026-09-07 13:00:00");
  const row = getMemoryItemById(id);
  assert.equal(row?.retrieval_count, 2);
  assert.equal(row?.last_retrieved_at, "2026-09-07 12:00:00");
});
