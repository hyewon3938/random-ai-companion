// 관리 대시보드의 태그 검색(tools/db-tag-search.ts)이 답장 경로와 같은 제외·상한·격리 규칙으로 행을 고르는지 검사한다 — 모델은 부르지 않는다.
//
// 고르는 순서와 프롬프트 문안은 recall.test.ts가 보므로 여기서는 배선만 본다 — 발화에서 글자가
// 맞는 태그가 고른 태그에 합쳐지는지, 캐릭터 정체성·최근 일기·다가오는 일정 슬롯이 사유와 함께
// 빠지는지, 개수 상한에 걸린 후보가 dropped에 남는지, 다른 캐릭터의 태그와 기억이 섞이지 않는지.
// 표는 src/db.js의 마이그레이션이 만든 임시 DB에 직접 INSERT해 채운다.
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

// DB 경로를 정한 뒤에 읽어야 임시 파일로 열린다.
const { db } = await import("../src/db.js");
const { kstDateString, shiftDate } = await import("../src/kst.js");
const {
  RECENT_DIARY_DAYS,
  SEARCH_LIMIT,
  TAG_PICK_MAX,
  UPCOMING_SCHEDULE_DAYS,
  UPCOMING_SCHEDULE_MAX,
} = await import("../src/thresholds.js");
const { listCharacters, runTagSearch } = await import(
  "../src/tools/db-tag-search.js"
);

after(() => {
  db.close();
});

// ── 표 채우기 ───────────────────────────────────────────────────────────

const newCharacter = (chatId: string): number =>
  Number(
    db
      .prepare(
        `INSERT INTO characters (chat_id, status, genesis_json, created_at)
         VALUES (?, 'active', '{}', '2026-09-01 12:00:00') RETURNING id`,
      )
      .pluck()
      .get(chatId),
  );

const tagRows = (
  characterId: number,
  kind: "memory" | "diary" | "schedule",
  refId: number,
  tags: string[],
): void => {
  for (const tag of tags)
    db.prepare(
      `INSERT INTO tags (character_id, kind, ref_id, tag) VALUES (?, ?, ?, ?)`,
    ).run(characterId, kind, refId, tag);
};

interface MemorySeed {
  item_type: "fact" | "ongoing" | "person";
  owner: "char" | "user";
  area: string;
  subject: string;
  value: string;
  updated_at?: string;
  tags: string[];
}

// 유저 쪽 행은 user_knows가 known이어야 표의 CHECK를 지난다.
const memory = (characterId: number, m: MemorySeed): number => {
  const id = Number(
    db
      .prepare(
        `INSERT INTO memory_items
           (character_id, item_type, owner, area, subject, value, user_knows, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .pluck()
      .get(
        characterId,
        m.item_type,
        m.owner,
        m.area,
        m.subject,
        m.value,
        m.owner === "user" ? "known" : "unknown",
        m.updated_at ?? "2026-08-10 12:00:00",
      ),
  );
  tagRows(characterId, "memory", id, m.tags);
  return id;
};

const diary = (characterId: number, date: string, tags: string[]): number => {
  const id = Number(
    db
      .prepare(
        `INSERT INTO diary_entries (character_id, date, entry_json)
         VALUES (?, ?, ?) RETURNING id`,
      )
      .pluck()
      .get(characterId, date, JSON.stringify({ summary: `${date} 일기` })),
  );
  tagRows(characterId, "diary", id, tags);
  return id;
};

interface ScheduleSeed {
  owner: "char" | "user";
  date: string;
  content: string;
  status?: "active" | "cancelled" | "deferred";
  time_hint?: string;
  tags: string[];
}

const schedule = (characterId: number, s: ScheduleSeed): number => {
  const id = Number(
    db
      .prepare(
        `INSERT INTO schedules
           (character_id, owner, date, time_hint, content, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '2026-08-01 12:00:00') RETURNING id`,
      )
      .pluck()
      .get(
        characterId,
        s.owner,
        s.date,
        s.time_hint ?? null,
        s.content,
        s.status ?? "active",
      ),
  );
  tagRows(characterId, "schedule", id, s.tags);
  return id;
};

const TODAY = kstDateString();
const charA = newCharacter("chat-tag-a");
const charB = newCharacter("chat-tag-b");
const charC = newCharacter("chat-tag-c");

// A의 기억 — 유저 쪽 사실 하나, 캐릭터 정체성 사실 하나, 캐릭터 쪽 진행 중인 일 하나,
// 그리고 기억 상한(SEARCH_LIMIT.fact)을 넘기려고 같은 태그의 유저 사실을 상한+1개.
memory(charA, {
  item_type: "fact",
  owner: "user",
  area: "일",
  subject: "프로젝트",
  value: "마감을 앞두고 있다",
  tags: ["프로젝트", "일"],
});
memory(charA, {
  item_type: "fact",
  owner: "char",
  area: "취미",
  subject: "영화",
  value: "혼자 극장에 간다",
  tags: ["영화"],
});
memory(charA, {
  item_type: "ongoing",
  owner: "char",
  area: "취미",
  subject: "영화모임",
  value: "동네 영화 모임에 나간다",
  tags: ["영화"],
});
for (let n = 1; n <= SEARCH_LIMIT.fact + 1; n += 1)
  memory(charA, {
    item_type: "fact",
    owner: "user",
    area: "취향",
    subject: `항목${n}`,
    value: `${n}번째 취향`,
    updated_at: `2026-08-${String(n).padStart(2, "0")} 12:00:00`,
    tags: ["취향"],
  });

// A의 일기 여섯 편 — 번호가 큰 RECENT_DIARY_DAYS편이 최근 일기다.
const DIARY_DATES = [
  "2026-08-01",
  "2026-08-02",
  "2026-08-03",
  "2026-08-04",
  "2026-08-05",
  "2026-08-06",
];
const DIARY_TAGS: Record<string, string[]> = {
  "2026-08-01": ["여행", "제주", "바다"],
  "2026-08-02": ["제주", "바다"],
  "2026-08-03": ["제주"],
  "2026-08-04": ["영화"],
  "2026-08-06": ["여행"],
};
for (const date of DIARY_DATES) diary(charA, date, DIARY_TAGS[date] ?? []);

// A의 일정 — 다가오는 일정 슬롯(UPCOMING_SCHEDULE_MAX)보다 하나 많은 앞날 일정, 지난 일정 하나,
// 취소한 앞날 일정 하나. 전부 같은 태그다.
for (let n = 1; n <= UPCOMING_SCHEDULE_MAX + 1; n += 1)
  schedule(charA, {
    owner: "char",
    date: shiftDate(TODAY, n),
    content: "치과 진료",
    tags: ["치과"],
  });
schedule(charA, {
  owner: "char",
  date: shiftDate(TODAY, -10),
  content: "치과 검진",
  tags: ["치과"],
});
schedule(charA, {
  owner: "user",
  date: shiftDate(TODAY, 2),
  content: "치과 예약",
  status: "cancelled",
  time_hint: "오후",
  tags: ["치과"],
});

// B는 A와 같은 태그 하나와 자기만의 태그 하나를 가진 기억이 있다. C는 태그가 없다.
memory(charB, {
  item_type: "fact",
  owner: "user",
  area: "일",
  subject: "프로젝트",
  value: "다른 사람의 마감",
  tags: ["프로젝트", "비밀"],
});

const A_TAG_POOL = [
  "프로젝트",
  "일",
  "영화",
  "취향",
  "여행",
  "제주",
  "바다",
  "치과",
].length;

const search = (characterId: number, tags: string[], text = "") =>
  runTagSearch(db, { characterId, tags, text });

// ── 검색 ────────────────────────────────────────────────────────────────

test("태그 없이 부르면 대조한 태그 수만 돌려주고 결과는 비어 있다", () => {
  const r = search(charA, []);
  assert.equal(r.characterId, charA);
  assert.equal(r.today, TODAY);
  assert.equal(r.pool, A_TAG_POOL);
  assert.equal(r.pickMax, TAG_PICK_MAX);
  assert.deepEqual(r.tags, []);
  assert.deepEqual(r.matched, []);
  assert.deepEqual(r.memories, []);
  assert.deepEqual(r.diaries, []);
  assert.deepEqual(r.schedules, []);
  assert.deepEqual(r.dropped, []);
  assert.deepEqual(r.excluded, []);
  assert.equal(r.prompt, "");
});

test("발화에 글자가 맞는 태그는 matched에 들어가고 고른 태그와 합쳐진다", () => {
  // 없는 태그는 버리고, 발화에서 맞은 태그는 뒤에 붙는다.
  const r = search(charA, ["일", "없는태그"], "프로젝트 얘기 좀 하자");
  assert.deepEqual(r.matched, ["프로젝트"]);
  assert.deepEqual(r.tags, ["일", "프로젝트"]);
  assert.equal(r.memories.length, 1);
  assert.equal(r.memories[0].label, "fact/user 일/프로젝트");
  assert.equal(r.memories[0].detail, "마감을 앞두고 있다");
  assert.equal(r.memories[0].hits, 2);
  assert.deepEqual(r.memories[0].tags, ["일", "프로젝트"]);
  assert.ok(r.prompt.startsWith("[지금 얘기와 관련해 기억나는 것]"));
  assert.ok(r.prompt.includes("마감을 앞두고 있다"));
});

test("캐릭터 쪽 사실은 검색에서 빼고 사유를 남긴다", () => {
  const r = search(charA, ["영화"]);
  assert.deepEqual(
    r.memories.map((m) => m.label),
    ["ongoing/char 취미/영화모임"],
  );
  const identity = r.excluded.find((e) => e.reason.includes("캐릭터 쪽 사실"));
  assert.ok(identity);
  assert.deepEqual(identity.rows, ["fact/char 취미/영화"]);
  assert.deepEqual(r.dropped, []);
});

test("최근 일기는 일간층에 있으니 빼고 사유를 남긴다", () => {
  const r = search(charA, ["여행"]);
  assert.deepEqual(
    r.diaries.map((d) => d.label),
    ["2026-08-01"],
  );
  assert.equal(
    r.diaries[0].detail,
    JSON.stringify({ summary: "2026-08-01 일기" }),
  );
  const recent = r.excluded.find((e) => e.reason.includes("최근 일기"));
  assert.ok(recent);
  assert.ok(recent.reason.includes(`최근 일기 ${RECENT_DIARY_DAYS}편`));
  assert.deepEqual(recent.rows, ["일기 2026-08-06"]);
  assert.ok(r.prompt.includes("[지금 얘기와 관련 있는 옛 일기]"));
});

test("일기 상한을 넘는 후보는 dropped에 라벨로 남는다", () => {
  // 두 태그가 다 맞는 두 편이 앞서고 한 태그만 맞는 한 편이 상한 밖으로 밀린다.
  const r = search(charA, ["제주", "바다"]);
  assert.equal(SEARCH_LIMIT.diary, 2);
  assert.deepEqual(r.diaries.map((d) => d.label).sort(), [
    "2026-08-01",
    "2026-08-02",
  ]);
  assert.ok(r.diaries.every((d) => d.hits === 2));
  assert.ok(
    r.diaries.every((d) => d.tags.includes("제주") && d.tags.includes("바다")),
  );
  assert.deepEqual(r.dropped, ["일기 2026-08-03"]);
});

test("기억 상한을 넘는 후보는 dropped에 키로 남는다", () => {
  const r = search(charA, ["취향"]);
  assert.equal(r.memories.length, SEARCH_LIMIT.fact);
  // 갱신 시각이 가장 오래된 행이 밀린다.
  assert.deepEqual(r.dropped, ["fact/user 취향/항목1"]);
  assert.ok(!r.memories.some((m) => m.label === "fact/user 취향/항목1"));
});

test("다가오는 일정 슬롯에 실린 행은 빼고 그 밖의 것만 싣는다", () => {
  const r = search(charA, ["치과"]);
  const upcoming = r.excluded.find((e) => e.reason.includes("[다가오는 일정]"));
  assert.ok(upcoming);
  assert.equal(upcoming.rows.length, UPCOMING_SCHEDULE_MAX);
  assert.ok(
    upcoming.rows.every(
      (row) => row.startsWith("일정 ") && row.endsWith(" 치과 진료"),
    ),
  );
  // 슬롯 밖으로 밀린 열세 번째 앞날 일정, 지난 일정, 취소한 일정이 검색 결과다.
  assert.deepEqual(
    r.schedules.map((s) => s.label).sort(),
    [
      `${shiftDate(TODAY, -10)} 치과 검진`,
      `${shiftDate(TODAY, 2)} 오후 치과 예약`,
      `${shiftDate(TODAY, UPCOMING_SCHEDULE_MAX + 1)} 치과 진료`,
    ].sort(),
  );
  const cancelled = r.schedules.find((s) => s.label.endsWith("치과 예약"));
  assert.ok(cancelled);
  assert.equal(cancelled.detail, "상대 쪽 · cancelled");
  assert.equal(r.schedules.length, SEARCH_LIMIT.schedule);
  assert.deepEqual(r.dropped, []);
  assert.ok(r.prompt.includes("[지금 얘기와 관련 있는 일정]"));
});

// 슬롯이 싣는 범위는 건수보다 날수가 먼저 자른다(이슈 #398). 이 도구가 범위를 따로 계산하면
// 화면에서 뺀 행과 실제 프롬프트에 실린 행이 갈려서, 그 뒤의 일정이 검색에서도 사라진다.
test("창 밖의 앞날 일정은 슬롯에서 빠지고 검색 결과로 온다", () => {
  const charD = newCharacter("chat-tag-window");
  schedule(charD, {
    owner: "char",
    date: shiftDate(TODAY, UPCOMING_SCHEDULE_DAYS),
    content: "창 마지막 날 검진",
    tags: ["검진"],
  });
  schedule(charD, {
    owner: "char",
    date: shiftDate(TODAY, UPCOMING_SCHEDULE_DAYS + 1),
    content: "창 밖 검진",
    tags: ["검진"],
  });
  const r = search(charD, ["검진"]);
  const upcoming = r.excluded.find((e) => e.reason.includes("[다가오는 일정]"));
  assert.ok(upcoming);
  assert.equal(upcoming.rows.length, 1);
  assert.ok(upcoming.rows[0]?.endsWith(" 창 마지막 날 검진"));
  assert.deepEqual(
    r.schedules.map((sc) => sc.label),
    [`${shiftDate(TODAY, UPCOMING_SCHEDULE_DAYS + 1)} 창 밖 검진`],
  );
});

test("다른 캐릭터의 태그와 기억은 섞이지 않는다", () => {
  // B만 가진 태그로 A를 찾으면 대조 목록에 없어 버려진다.
  const none = search(charA, ["비밀"]);
  assert.deepEqual(none.tags, []);
  assert.deepEqual(none.memories, []);
  assert.equal(none.pool, A_TAG_POOL);
  // 같은 이름의 태그라도 각자 자기 기억만 나온다.
  const a = search(charA, ["프로젝트"]);
  assert.deepEqual(
    a.memories.map((m) => m.detail),
    ["마감을 앞두고 있다"],
  );
  const b = search(charB, ["프로젝트"]);
  assert.deepEqual(
    b.memories.map((m) => m.detail),
    ["다른 사람의 마감"],
  );
  assert.equal(b.pool, 2);
});

test("listCharacters는 캐릭터마다 태그를 kind별로 세고 태그가 없으면 빈 목록이다", () => {
  const list = listCharacters(db);
  const a = list.find((c) => c.id === charA);
  const b = list.find((c) => c.id === charB);
  const c = list.find((c) => c.id === charC);
  assert.ok(a && b && c);
  assert.equal(a.chat_id, "chat-tag-a");
  assert.deepEqual(
    a.tags.find((t) => t.tag === "영화"),
    { tag: "영화", memory: 2, diary: 1, schedule: 0 },
  );
  assert.deepEqual(
    a.tags.find((t) => t.tag === "치과"),
    { tag: "치과", memory: 0, diary: 0, schedule: UPCOMING_SCHEDULE_MAX + 3 },
  );
  assert.deepEqual(
    a.tags.find((t) => t.tag === "프로젝트"),
    { tag: "프로젝트", memory: 1, diary: 0, schedule: 0 },
  );
  assert.equal(a.tags.length, A_TAG_POOL);
  assert.deepEqual(b.tags.map((t) => t.tag).sort(), ["비밀", "프로젝트"]);
  assert.deepEqual(c.tags, []);
});
