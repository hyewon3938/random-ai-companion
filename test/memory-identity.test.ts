// 기억의 키 검사·정체성 정렬·저장 규약(memory.ts)을 검사한다 — 모델은 부르지 않는다.
//
// keyProblem이 키를 거르는 경계와 orderedIdentity·identityValue가 생성 행과 대화 행을 읽는
// 순서는 손으로 만든 행으로 본다. 저장 쪽은 임시 DB에 실제로 넣어 본다 — 캐릭터 쪽 사실만 늘
// 들어가는지, 영역의 기본 갈래를 두 번 깔아도 늘지 않는지, 오늘 메모의 공백 정리, 진행 중인 일을
// 사실로 옮길 때의 반환값, 그리고 생성 때 정한 행(origin=creation)은 대화가 고치지 못한다는
// 규약까지. 텔레그램도 부르지 않는다.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MemoryRow } from "../src/db.js";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

// DB 경로를 정한 뒤에 읽어야 임시 파일로 열린다 — 정적 import는 이 줄들보다 먼저 돈다.
const { db, getMemoryItemById, getTags, listAreas } =
  await import("../src/db.js");
const {
  CORE_AREAS,
  alwaysIncluded,
  ensureCoreAreas,
  existingAreas,
  identityValue,
  keyProblem,
  moveMemory,
  orderedIdentity,
  saveCreationMemory,
  saveMemory,
  saveTodayNote,
  todayNotes,
} = await import("../src/memory.js");

after(() => {
  db.close();
});

const makeCharacter = (chatId: string): number =>
  Number(
    db
      .prepare(
        `INSERT INTO characters (chat_id, status, genesis_json, created_at)
         VALUES (?, 'active', '{}', '2026-08-30 12:00:00') RETURNING id`,
      )
      .pluck()
      .get(chatId),
  );

const row = (id: number, over: Partial<MemoryRow> = {}): MemoryRow => ({
  id,
  character_id: 1,
  item_type: "fact",
  owner: "char",
  area: "생활",
  subject: "잠",
  value: "일곱 시에 일어난다",
  origin: "conversation",
  user_knows: "known",
  relation: null,
  contact_mode: null,
  region: null,
  last_mentioned_at: null,
  end_condition: null,
  interest: null,
  last_retrieved_at: null,
  retrieval_count: 0,
  updated_at: "2026-09-01 12:00:00",
  ...over,
});

const ids = (rows: MemoryRow[]): number[] => rows.map((r) => r.id);

const memoryRowsOf = (characterId: number): MemoryRow[] =>
  db
    .prepare(`SELECT * FROM memory_items WHERE character_id = ? ORDER BY id`)
    .all(characterId) as MemoryRow[];

// ── keyProblem ────────────────────────────────────────────────────────────

test("영역과 무엇이 명사 한 덩어리면 키로 쓸 수 있다", () => {
  assert.equal(keyProblem("일", "프로젝트"), null);
  assert.equal(keyProblem("취미", "도면 스케치"), null);
});

test("영역이나 무엇이 비면 키를 만들 수 없다", () => {
  assert.equal(keyProblem("", "프로젝트"), "영역과 무엇이 모두 있어야 한다");
  assert.equal(keyProblem("일", "   "), "영역과 무엇이 모두 있어야 한다");
});

test("영역은 12자, 무엇은 20자까지만 받고 한 글자 넘으면 거른다", () => {
  assert.equal(keyProblem("가".repeat(12), "프로젝트"), null);
  assert.equal(keyProblem("가".repeat(13), "프로젝트"), "키가 너무 길다");
  assert.equal(keyProblem("일", "나".repeat(20)), null);
  assert.equal(keyProblem("일", "나".repeat(21)), "키가 너무 길다");
});

test("한 자리에 구분자로 여러 낱말을 묶은 키는 거른다", () => {
  const bad = "키 한 자리에 여러 낱말을 묶지 않는다";
  assert.equal(keyProblem("일/이", "프로젝트"), bad);
  assert.equal(keyProblem("취미", "책|영화"), bad);
  assert.equal(keyProblem("취미", "책, 영화"), bad);
  assert.equal(keyProblem("취미", "책·영화"), bad);
});

test("앞뒤 공백과 겹친 공백은 정리해서 보므로 길이에도 세지 않는다", () => {
  assert.equal(keyProblem("  일  ", " 프로젝트 "), null);
  assert.equal(keyProblem(`${"가".repeat(12)}   `, "프로젝트"), null);
  assert.equal(keyProblem("일", "도면    스케치"), null);
});

// ── orderedIdentity ───────────────────────────────────────────────────────

test("생성 행끼리는 번호 오름차순이다", () => {
  const out = orderedIdentity([
    row(5, { origin: "creation" }),
    row(2, { origin: "creation" }),
  ]);
  assert.deepEqual(ids(out), [2, 5]);
});

test("같은 키의 생성 행이 대화 행보다 번호가 커도 앞에 선다", () => {
  const out = orderedIdentity([
    row(1, { origin: "conversation" }),
    row(3, { origin: "creation" }),
  ]);
  assert.deepEqual(ids(out), [3, 1]);
});

test("대화 행끼리는 오래 전에 고친 것이 앞이라 뒤쪽이 최신이다", () => {
  const out = orderedIdentity([
    row(1, { updated_at: "2026-09-06 10:00:00" }),
    row(2, { updated_at: "2026-09-01 10:00:00" }),
  ]);
  assert.deepEqual(ids(out), [2, 1]);
});

test("대화 행의 고친 시각이 같으면 번호 오름차순이다", () => {
  const out = orderedIdentity([row(7), row(4)]);
  assert.deepEqual(ids(out), [4, 7]);
});

test("행이 없으면 빈 목록이다", () => {
  assert.deepEqual(orderedIdentity([]), []);
});

// ── identityValue ─────────────────────────────────────────────────────────

test("키 하나가 맞으면 그 값이다", () => {
  const rows = [
    row(1, { area: "생활", subject: "잠", value: "일곱 시 기상" }),
    row(2, { area: "생활", subject: "운동", value: "주 이삼 회 달린다" }),
  ];
  assert.equal(identityValue(rows, "생활", "잠"), "일곱 시 기상");
});

test("같은 키에 생성 행과 대화 행이 있으면 번호와 상관없이 대화 행의 값이다", () => {
  const rows = [
    row(9, { origin: "creation", value: "일곱 시 기상" }),
    row(1, { origin: "conversation", value: "요즘은 여덟 시 기상" }),
  ];
  assert.equal(identityValue(rows, "생활", "잠"), "요즘은 여덟 시 기상");
});

test("대화 행이 둘이면 나중에 고친 값이다", () => {
  const rows = [
    row(1, { updated_at: "2026-09-06 10:00:00", value: "여덟 시 기상" }),
    row(2, { updated_at: "2026-09-01 10:00:00", value: "일곱 시 기상" }),
  ];
  assert.equal(identityValue(rows, "생활", "잠"), "여덟 시 기상");
});

test("맞는 키가 없으면 null이다", () => {
  assert.equal(identityValue([row(1)], "생활", "술"), null);
  assert.equal(identityValue([], "생활", "잠"), null);
});

// ── alwaysIncluded (DB) ───────────────────────────────────────────────────

test("늘 들어가는 기억은 캐릭터 쪽 사실뿐이다 — 유저 사실과 진행 중인 일은 빠진다", () => {
  const id = makeCharacter("chat-always");
  saveMemory({
    characterId: id,
    itemType: "fact",
    owner: "char",
    area: "생활",
    subject: "잠",
    value: "일곱 시에 일어난다",
  });
  saveMemory({
    characterId: id,
    itemType: "fact",
    owner: "char",
    area: "생활",
    subject: "운동",
    value: "주 이삼 회 달린다",
  });
  saveMemory({
    characterId: id,
    itemType: "fact",
    owner: "user",
    area: "일",
    subject: "프로젝트",
    value: "마감을 앞뒀다",
  });
  saveMemory({
    characterId: id,
    itemType: "ongoing",
    owner: "char",
    area: "독서",
    subject: "장편 소설",
    value: "절반쯤 읽었다",
    endCondition: "완독",
  });
  const rows = alwaysIncluded(id);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.owner === "char" && r.item_type === "fact"));
  assert.deepEqual(rows.map((r) => r.subject).sort(), ["운동", "잠"]);
});

test("캐릭터 쪽 사실이 없으면 늘 들어가는 기억도 없다", () => {
  const id = makeCharacter("chat-always-empty");
  saveMemory({
    characterId: id,
    itemType: "fact",
    owner: "user",
    area: "일",
    subject: "프로젝트",
    value: "마감을 앞뒀다",
  });
  assert.deepEqual(alwaysIncluded(id), []);
});

// ── ensureCoreAreas · existingAreas (DB) ──────────────────────────────────

test("기본 갈래 여덟 개를 깔고, 두 번 깔아도 늘지 않는다", () => {
  const id = makeCharacter("chat-areas");
  ensureCoreAreas(id);
  assert.equal(listAreas(id).length, CORE_AREAS.length);
  ensureCoreAreas(id);
  assert.equal(listAreas(id).length, CORE_AREAS.length);
  assert.deepEqual(existingAreas(id), [...CORE_AREAS]);
});

test("같은 이름의 영역을 저장으로 다시 올려도 목록에 겹치지 않는다", () => {
  const id = makeCharacter("chat-areas-dup");
  ensureCoreAreas(id);
  saveMemory({
    characterId: id,
    itemType: "fact",
    owner: "char",
    area: "일",
    subject: "직무",
    value: "도면 검토",
  });
  const areas = existingAreas(id);
  assert.equal(areas.length, CORE_AREAS.length);
  assert.equal(new Set(areas).size, areas.length);
});

test("대화로 생긴 영역은 기본 갈래와 함께 나오고 겹치지 않는다", () => {
  const id = makeCharacter("chat-areas-new");
  ensureCoreAreas(id);
  saveMemory({
    characterId: id,
    itemType: "fact",
    owner: "char",
    area: "독서",
    subject: "취향",
    value: "조용한 이야기",
  });
  const areas = existingAreas(id);
  assert.equal(areas.length, CORE_AREAS.length + 1);
  assert.ok(areas.includes("독서"));
  assert.equal(new Set(areas).size, areas.length);
});

test("저장된 영역이 하나도 없어도 기본 갈래는 목록에 나온다", () => {
  const id = makeCharacter("chat-areas-none");
  assert.deepEqual(existingAreas(id), [...CORE_AREAS]);
  assert.equal(listAreas(id).length, 0);
});

// ── saveTodayNote · todayNotes (DB) ───────────────────────────────────────

test("오늘 메모는 앞뒤 공백과 겹친 공백을 정리해 남긴다", () => {
  const id = makeCharacter("chat-note-tidy");
  saveTodayNote(id, "  러닝   5km \n");
  assert.deepEqual(todayNotes(id), ["러닝 5km"]);
});

test("공백뿐인 메모는 남기지 않는다", () => {
  const id = makeCharacter("chat-note-empty");
  saveTodayNote(id, "   \n ");
  assert.deepEqual(todayNotes(id), []);
});

test("메모 두 건은 적은 순서대로 나온다", () => {
  const id = makeCharacter("chat-note-order");
  saveTodayNote(id, "점심에 김밥을 먹었다고 했다");
  saveTodayNote(id, "저녁에 달리기를 간다고 했다");
  assert.deepEqual(todayNotes(id), [
    "점심에 김밥을 먹었다고 했다",
    "저녁에 달리기를 간다고 했다",
  ]);
});

// ── moveMemory (DB) ───────────────────────────────────────────────────────

test("대화로 쌓인 진행 중인 일을 사실로 옮기면 새 행 번호가 돌아오고 옛 행은 사라진다", () => {
  const id = makeCharacter("chat-move");
  const from = saveMemory({
    characterId: id,
    itemType: "ongoing",
    owner: "char",
    area: "독서",
    subject: "장편 소설",
    value: "다 읽었다",
    tags: ["책"],
    userKnows: "known",
    endCondition: "완독",
  });
  db.prepare(`UPDATE memory_items SET updated_at = ? WHERE id = ?`).run(
    "2026-01-01 00:00:00",
    from,
  );
  const to = moveMemory(from, "fact");
  assert.notEqual(to, from);
  assert.equal(getMemoryItemById(from), undefined);
  const moved = getMemoryItemById(to);
  assert.ok(moved);
  assert.equal(moved.item_type, "fact");
  assert.equal(moved.origin, "conversation");
  assert.equal(moved.value, "다 읽었다");
  assert.equal(moved.end_condition, null);
  assert.notEqual(moved.updated_at, "2026-01-01 00:00:00");
  assert.match(moved.updated_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.deepEqual(getTags("memory", to), ["독서", "장편 소설", "책"]);
  assert.deepEqual(getTags("memory", from), []);
});

test("생성 때 정한 진행 중인 일을 옮기면 원래 행은 그대로 두고 대화 행을 새로 만든다", () => {
  const id = makeCharacter("chat-move-creation");
  const from = saveCreationMemory({
    characterId: id,
    itemType: "ongoing",
    owner: "char",
    area: "생활",
    subject: "이사 준비",
    value: "계약을 새로 했다",
    tags: ["집"],
    endCondition: "계약을 새로 하면 끝난다",
  });
  const to = moveMemory(from, "fact");
  assert.notEqual(to, from);
  const kept = getMemoryItemById(from);
  assert.ok(kept);
  assert.equal(kept.item_type, "ongoing");
  assert.equal(kept.origin, "creation");
  const moved = getMemoryItemById(to);
  assert.ok(moved);
  assert.equal(moved.item_type, "fact");
  assert.equal(moved.origin, "conversation");
  assert.deepEqual(getTags("memory", from), ["생활", "이사 준비", "집"]);
  assert.deepEqual(getTags("memory", to), ["생활", "이사 준비", "집"]);
});

test("없는 행을 옮기면 그 번호를 그대로 돌려주고 아무것도 쓰지 않는다", () => {
  const before = Number(
    db.prepare(`SELECT count(*) FROM memory_items`).pluck().get(),
  );
  assert.equal(moveMemory(999_999, "fact"), 999_999);
  const after = Number(
    db.prepare(`SELECT count(*) FROM memory_items`).pluck().get(),
  );
  assert.equal(after, before);
});

// ── saveMemory · saveCreationMemory (DB) ──────────────────────────────────

test("생성 때 정한 행은 같은 키로 다시 저장해도 첫 값이 남고 번호도 그대로다", () => {
  const id = makeCharacter("chat-creation-keep");
  const first = saveCreationMemory({
    characterId: id,
    itemType: "fact",
    owner: "char",
    area: "기본",
    subject: "고향",
    value: "충북 청주",
  });
  const second = saveCreationMemory({
    characterId: id,
    itemType: "fact",
    owner: "char",
    area: "기본",
    subject: "고향",
    value: "부산",
  });
  assert.equal(second, first);
  assert.equal(getMemoryItemById(first)?.value, "충북 청주");
  assert.equal(memoryRowsOf(id).length, 1);
});

test("대화 저장은 생성 행을 고치지 않고 같은 키의 대화 행을 따로 둔다", () => {
  const id = makeCharacter("chat-creation-split");
  const creation = saveCreationMemory({
    characterId: id,
    itemType: "fact",
    owner: "char",
    area: "생활",
    subject: "잠",
    value: "일곱 시에 일어난다",
  });
  const conversation = saveMemory({
    characterId: id,
    itemType: "fact",
    owner: "char",
    area: "생활",
    subject: "잠",
    value: "요즘은 여덟 시에 일어난다",
  });
  assert.notEqual(conversation, creation);
  assert.equal(getMemoryItemById(creation)?.value, "일곱 시에 일어난다");
  assert.equal(getMemoryItemById(creation)?.origin, "creation");
  assert.equal(getMemoryItemById(conversation)?.origin, "conversation");
  assert.equal(memoryRowsOf(id).length, 2);
  // 프롬프트에는 둘 다 들어가고, 값을 물으면 대화 행이 이긴다.
  assert.equal(alwaysIncluded(id).length, 2);
  assert.equal(
    identityValue(alwaysIncluded(id), "생활", "잠"),
    "요즘은 여덟 시에 일어난다",
  );
});

test("대화 저장은 같은 키면 행을 늘리지 않고 값만 갈아 끼운다", () => {
  const id = makeCharacter("chat-upsert");
  const first = saveMemory({
    characterId: id,
    itemType: "fact",
    owner: "user",
    area: "일",
    subject: "프로젝트",
    value: "마감을 앞뒀다",
  });
  const second = saveMemory({
    characterId: id,
    itemType: "fact",
    owner: "user",
    area: "일",
    subject: "프로젝트",
    value: "마감을 넘겼다",
  });
  assert.equal(second, first);
  assert.equal(getMemoryItemById(first)?.value, "마감을 넘겼다");
  assert.equal(memoryRowsOf(id).length, 1);
});

test("태그에는 키의 두 낱말이 같이 들어가고 겹치는 것은 하나로 합쳐진다", () => {
  const id = makeCharacter("chat-tags");
  const memoryId = saveMemory({
    characterId: id,
    itemType: "ongoing",
    owner: "char",
    area: "독서",
    subject: "당신 인생의 이야기",
    value: "첫 단편을 읽는 중이다",
    tags: ["책", "독서", " 책 "],
    userKnows: "known",
    endCondition: "완독",
  });
  assert.deepEqual(getTags("memory", memoryId), [
    "당신 인생의 이야기",
    "독서",
    "책",
  ]);
});

test("같은 키를 다시 저장하면 태그도 새로 붙인 것으로 바뀐다", () => {
  const id = makeCharacter("chat-tags-replace");
  const write = (tags: string[]): number =>
    saveMemory({
      characterId: id,
      itemType: "fact",
      owner: "user",
      area: "취미",
      subject: "영화",
      value: "조용한 이야기를 좋아한다",
      tags,
    });
  const memoryId = write(["극장", "혼자"]);
  assert.deepEqual(getTags("memory", memoryId), [
    "극장",
    "영화",
    "취미",
    "혼자",
  ]);
  assert.equal(write(["OTT"]), memoryId);
  assert.deepEqual(getTags("memory", memoryId), ["OTT", "영화", "취미"]);
});

test("키가 형식에 안 맞으면 저장이 예외로 막힌다", () => {
  const id = makeCharacter("chat-bad-key");
  assert.throws(
    () =>
      saveMemory({
        characterId: id,
        itemType: "fact",
        owner: "user",
        area: "일/이",
        subject: "프로젝트",
        value: "마감을 앞뒀다",
      }),
    /키를 만들 수 없다\(일\/이\/프로젝트\): 키 한 자리에 여러 낱말을 묶지 않는다/,
  );
  assert.equal(memoryRowsOf(id).length, 0);
});
