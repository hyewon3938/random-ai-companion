// 태그로 찾은 기억을 고르고 프롬프트 줄로 옮기는 자리(recall.ts)를 검사한다 — 모델은 부르지 않는다.
//
// 저장 항목 순서·최신순·항목별 상한으로 자르는 규칙, 한 글자 태그를 어절로만 맞추는 규칙,
// 기억·옛 일기·일정 절의 문안을 손으로 만든 행으로 본다. 이 모듈은 DB를 열지 않으므로
// 임시 DB 없이 그대로 읽는다.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { MemoryRow, ScheduleStateRow } from "../src/db.js";
import {
  SEARCH_LIMITS,
  capHits,
  matchTagNames,
  memoryBlock,
  memoryKeyOf,
  memoryLine,
  memorySection,
  oldDiarySection,
  pickMemories,
  scheduleHitLine,
  scheduleSearchSection,
  searchable,
} from "../src/recall.js";

const row = (id: number, over: Partial<MemoryRow> = {}): MemoryRow => ({
  id,
  character_id: 1,
  item_type: "fact",
  owner: "user",
  area: "일",
  subject: "프로젝트",
  value: "마감 앞둠",
  origin: "conversation",
  user_knows: "known",
  relation: null,
  contact_mode: null,
  region: null,
  last_mentioned_at: null,
  end_condition: null,
  interest: null,
  occurred_on: null,
  last_retrieved_at: null,
  retrieval_count: 0,
  updated_at: "2026-09-01 12:00:00",
  ...over,
});

const schedule = (
  id: number,
  over: Partial<ScheduleStateRow> = {},
): ScheduleStateRow => ({
  id,
  owner: "char",
  date: "2026-09-08",
  time_hint: null,
  content: "치과",
  status: "active",
  ...over,
});

test("검색으로 넣을 수 있는 기억은 캐릭터 쪽 사실을 뺀 나머지다", () => {
  assert.equal(searchable(row(1, { item_type: "fact", owner: "char" })), false);
  assert.equal(searchable(row(2, { item_type: "fact", owner: "user" })), true);
  assert.equal(
    searchable(row(3, { item_type: "ongoing", owner: "char" })),
    true,
  );
  assert.equal(
    searchable(row(4, { item_type: "person", owner: "char" })),
    true,
  );
});

test("고른 기억은 진행 중인 일·주변 인물·사실 순이고 항목 안에서는 최신 것이 앞이다", () => {
  const candidates = [
    row(5, {
      item_type: "fact",
      owner: "char",
      updated_at: "2026-09-06 10:00:00",
    }),
    row(4, {
      item_type: "fact",
      owner: "user",
      updated_at: "2026-09-04 10:00:00",
    }),
    row(1, {
      item_type: "ongoing",
      owner: "char",
      updated_at: "2026-09-01 10:00:00",
    }),
    row(3, {
      item_type: "person",
      owner: "char",
      updated_at: "2026-09-03 10:00:00",
    }),
    row(2, {
      item_type: "ongoing",
      owner: "user",
      updated_at: "2026-09-05 10:00:00",
    }),
  ];
  assert.deepEqual(
    pickMemories(candidates).map((r) => r.id),
    [2, 1, 3, 4],
  );
});

test("항목별 상한을 넘긴 후보는 빠지고 그 키가 dropped에 적힌다", () => {
  assert.deepEqual(SEARCH_LIMITS, { ongoing: 3, person: 3, fact: 5 });

  const ongoing = [1, 2, 3, 4].map((n) =>
    row(n, {
      item_type: "ongoing",
      subject: `작업${n}`,
      updated_at: `2026-09-0${n} 10:00:00`,
    }),
  );

  const dropped: string[] = [];
  assert.deepEqual(
    pickMemories(ongoing, { dropped }).map((r) => r.id),
    [4, 3, 2],
  );
  assert.deepEqual(dropped, ["상대 · 일 · 작업1"]);

  const droppedTight: string[] = [];
  assert.deepEqual(
    pickMemories(ongoing, {
      limits: { ongoing: 1 },
      dropped: droppedTight,
    }).map((r) => r.id),
    [4],
  );
  assert.deepEqual(droppedTight, [
    "상대 · 일 · 작업3",
    "상대 · 일 · 작업2",
    "상대 · 일 · 작업1",
  ]);
});

test("itemTypes를 주면 그 항목만 고르고 다른 항목은 dropped에도 적지 않는다", () => {
  const candidates = [
    ...[1, 2, 3, 4].map((n) =>
      row(n, { item_type: "ongoing", updated_at: `2026-09-0${n} 10:00:00` }),
    ),
    row(5, {
      item_type: "person",
      area: "친구",
      subject: "민수",
      updated_at: "2026-09-05 10:00:00",
    }),
    row(6, {
      item_type: "person",
      area: "친구",
      subject: "지영",
      updated_at: "2026-09-06 10:00:00",
    }),
    row(7, { item_type: "fact", updated_at: "2026-09-07 10:00:00" }),
  ];

  const dropped: string[] = [];
  assert.deepEqual(
    pickMemories(candidates, { itemTypes: ["person"], dropped }).map(
      (r) => r.id,
    ),
    [6, 5],
  );
  assert.deepEqual(dropped, []);

  assert.deepEqual(
    pickMemories(candidates, { itemTypes: ["fact"] }).map((r) => r.id),
    [7],
  );
  // 프롬프트 줄의 앞부분과 같은 글자다 — 이 글자로 스레드를 검색해 그 기억을 찾는다(#397).
  assert.equal(memoryKeyOf(candidates[6]), "상대 · 일 · 프로젝트");
  assert.ok(memoryBlock([candidates[6]]).includes(memoryKeyOf(candidates[6])));
});

test("두 글자 이상 태그는 글자 포함으로 맞추고 한 글자 태그는 어절로만 맞춘다", () => {
  assert.deepEqual(
    matchTagNames(
      ["일", "돈", "운동", "집", "일요일"],
      "일요일에 운동 갔다가 집에 들렀어.",
    ),
    ["운동", "집", "일요일"],
  );
  assert.deepEqual(matchTagNames(["일", "돈"], "오늘 일이 많아서 돈이야 뭐"), [
    "일",
    "돈",
  ]);
  assert.deepEqual(matchTagNames(["집"], "(집)"), ["집"]);
  assert.deepEqual(matchTagNames(["일"], "생일 축하해"), []);
  assert.deepEqual(matchTagNames(["일"], "   "), []);
});

test("기억 줄은 영역·무엇·값과 갱신 날짜를 적고 검색 블록은 항목 이름 아래 주인을 붙인다", () => {
  const ongoing = row(1, {
    item_type: "ongoing",
    owner: "char",
    area: "일",
    subject: "이직 준비",
    value: "면접 앞둠",
    updated_at: "2026-09-01 12:00:00",
  });
  const fact = row(2, {
    item_type: "fact",
    owner: "user",
    area: "음식",
    subject: "매운 것",
    value: "잘 못 먹음",
    updated_at: "2026-08-15 09:00:00",
  });
  const person = row(3, {
    item_type: "person",
    owner: "user",
    area: "친구",
    subject: "민수",
    value: "같은 동네",
    updated_at: "2026-09-05 20:00:00",
  });

  assert.equal(memoryLine(ongoing), "- 일 · 이직 준비: 면접 앞둠 (9/1 갱신)");
  assert.equal(
    memoryBlock([fact, ongoing, person]),
    [
      "[진행 중인 일]\n- 너 · 일 · 이직 준비: 면접 앞둠 (9/1 갱신)",
      "[주변 인물]\n- 상대 · 친구 · 민수: 같은 동네 (9/5 갱신)",
      "[사실]\n- 상대 · 음식 · 매운 것: 잘 못 먹음 (8/15 갱신)",
    ].join("\n\n"),
  );
  assert.equal(memorySection([]), "");
  const section = memorySection([ongoing]);
  assert.ok(
    section.startsWith(
      "[지금 얘기와 관련해 기억나는 것]\n[진행 중인 일]\n- 너 · 일 · 이직 준비: 면접 앞둠 (9/1 갱신)\n",
    ),
  );
  // 절 끝에 두 날짜를 어떻게 읽는지 이르는 줄이 붙는다 — 시점이 빈 줄에서 아까·방금으로
  // 단정하지 않게 하는 자리다(#388).
  assert.ok(section.includes("'있었던 일'이 없는 줄은 언제 일인지 모르는 것이니"));
});

test("있었던 날이 있으면 갱신 날짜와 갈라 적고 같은 날이면 한 번만 적는다", () => {
  const base = {
    item_type: "ongoing" as const,
    owner: "char" as const,
    area: "일",
    subject: "이직 준비",
    value: "면접 앞둠",
    updated_at: "2026-09-12 12:00:00",
  };
  // 며칠 전 일을 오늘 다시 말해 갱신된 줄 — 있었던 날이 남아야 방금 일로 읽히지 않는다.
  assert.equal(
    memoryLine(row(1, { ...base, occurred_on: "2026-09-10" })),
    "- 일 · 이직 준비: 면접 앞둠 (9/10에 있었던 일 · 9/12 갱신)",
  );
  // 있었던 날과 고친 날이 같으면 같은 날짜를 두 번 적지 않는다.
  assert.equal(
    memoryLine(row(2, { ...base, occurred_on: "2026-09-12" })),
    "- 일 · 이직 준비: 면접 앞둠 (9/12에 있었던 일)",
  );
  // 모르면 비워 두고 예전처럼 갱신 날짜만 적는다.
  assert.equal(
    memoryLine(row(3, { ...base, occurred_on: null })),
    "- 일 · 이직 준비: 면접 앞둠 (9/12 갱신)",
  );
});

test("해가 다른 날은 해까지 적고 월·일이 같아도 접지 않는다", () => {
  const base = {
    item_type: "fact" as const,
    owner: "user" as const,
    area: "일",
    subject: "이직",
    value: "이직했다",
    updated_at: "2026-09-12 12:00:00",
  };
  // 월·일이 갱신 날짜와 같은 작년 일 — 해를 버리면 오늘 있었던 일과 같은 글자가 된다.
  assert.equal(
    memoryLine(row(4, { ...base, occurred_on: "2025-09-12" })),
    "- 일 · 이직: 이직했다 (2025년 9/12에 있었던 일 · 9/12 갱신)",
  );
  assert.equal(
    memoryLine(row(5, { ...base, occurred_on: "2020-02-15" })),
    "- 일 · 이직: 이직했다 (2020년 2/15에 있었던 일 · 9/12 갱신)",
  );
});

test("옛 일기 절은 날짜와 본문을 한 줄씩 잇고 없으면 빈 문자열이다", () => {
  assert.equal(oldDiarySection([]), "");
  assert.equal(
    oldDiarySection([
      { date: "2026-08-20", entry_json: '{"summary":"비"}' },
      { date: "2026-08-21", entry_json: '{"summary":"맑음"}' },
    ]),
    '[지금 얘기와 관련 있는 옛 일기]\n2026-08-20: {"summary":"비"}\n2026-08-21: {"summary":"맑음"}',
  );
});

test("일정 줄은 주인과 상태를 적고 지난 활성 일정은 지난 일로 표시한다", () => {
  const today = "2026-09-06";
  assert.equal(
    scheduleHitLine(
      schedule(1, {
        date: "2026-09-04",
        time_hint: "14:30",
        content: "영화 보기",
      }),
      today,
    ),
    "2026-09-04 14:30 영화 보기 (너 쪽 · 지난 일)",
  );
  assert.equal(
    scheduleHitLine(schedule(2, { owner: "user" }), today),
    "2026-09-08 치과 (상대 쪽 · 예정)",
  );
  assert.equal(
    scheduleHitLine(schedule(3, { date: today }), today),
    "2026-09-06 치과 (너 쪽 · 예정)",
  );
  assert.equal(
    scheduleHitLine(schedule(4, { status: "cancelled" }), today),
    "2026-09-08 치과 (너 쪽 · 취소)",
  );
  assert.equal(
    scheduleHitLine(
      schedule(5, { date: "2026-09-01", status: "deferred" }),
      today,
    ),
    "2026-09-01 치과 (너 쪽 · 미룸)",
  );

  assert.equal(scheduleSearchSection([], today), "");
  assert.equal(
    scheduleSearchSection(
      [schedule(2, { owner: "user" }), schedule(4, { status: "cancelled" })],
      today,
    ),
    "[지금 얘기와 관련 있는 일정]\n2026-09-08 치과 (상대 쪽 · 예정)\n2026-09-08 치과 (너 쪽 · 취소)\n- 괄호 안 상태가 '예정'이 아니면 아직 남은 약속이 아니다. 지나갔거나 없어진 일을 앞으로의 예정처럼 말하지 않는다.",
  );
});

test("상한으로 자른 검색 결과는 빠진 것을 라벨로 남긴다", () => {
  const dropped: string[] = [];
  assert.deepEqual(
    capHits([1, 2, 3, 4], 2, (n) => `#${n}`, dropped),
    [1, 2],
  );
  assert.deepEqual(dropped, ["#3", "#4"]);

  const none: string[] = [];
  assert.deepEqual(capHits([1, 2], 5, String, none), [1, 2]);
  assert.deepEqual(none, []);
  assert.deepEqual(capHits([1, 2, 3], 1, String), [1]);
});
