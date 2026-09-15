// 프롬프트 재료 읽기가 작품 사실 카드 가운데 무엇을 싣는지 검사한다 — 모델은 부르지 않는다.
//
// 카드는 찾는 곳에 제목이 나온 작품만 싣는다(#287·#458). 답장 경로는 최근 대화·태그로 꺼낸
// 기억·태그로 꺼낸 지난 일기를, 선톡 경로는 방금까지 오간 말·어제 일기의 내일 챙길 것·대화 계획의
// 내 얘기 줄·상황 문단을 보고, 두 경로 모두 그 뒤에 오늘 각본과 진행 중인 일을 본다. 자유 서술은
// 제목을 뽑아내지 않고 이미 카드가 있는 제목이 그 글에 나오는지만 본다 — 없는 제목을 지어 읽는
// 경로를 만들지 않으려는 것이다.
//
// DB는 임시 파일로 새로 만들고, 캐릭터는 검사마다 따로 만들어 서로의 기억과 대화가 섞이지 않게 한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CharacterRow } from "../src/db.js";
import type { BuildTrace } from "../src/context/input.js";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

const {
  db,
  saveDayPlan,
  saveWorkFact,
  logMessage,
  insertDiary,
  setTags,
  saveRelationshipIntent,
} = await import("../src/db.js");
const { saveMemory } = await import("../src/memory.js");
const { readContextInput } = await import("../src/context/input.js");
const { kstLogicalDate, shiftDate } = await import("../src/kst.js");
const { WORK_FACT_MAX_PER_REPLY } = await import("../src/thresholds.js");

const TODAY = kstLogicalDate();

let chatNo = 0;
const newCharacter = (): CharacterRow => {
  chatNo += 1;
  const c = db
    .prepare(
      `INSERT INTO characters (chat_id, status, genesis_json, created_at)
       VALUES (?, 'active', '{}', '2026-08-30 12:00:00') RETURNING *`,
    )
    .get(String(chatNo)) as CharacterRow;
  db.prepare(
    `INSERT INTO relationships (character_id, met_at, stage_no, stage_since)
     VALUES (?, '2026-08-30 12:00:00', 1, '2026-08-30')`,
  ).run(c.id);
  return c;
};

const cards = (characterId: number, titles: string[]) => {
  for (const title of titles)
    saveWorkFact(
      characterId,
      {
        title,
        summary: `${title} 줄거리`,
        scenes: [`${title} 장면`],
        differences: null,
      },
      "2026-09-10 05:00:00",
    );
};

const say = (c: CharacterRow, role: "user" | "assistant", text: string) =>
  logMessage(c.chat_id, c.id, role, text, "2026-09-14 20:00:00");

const planWith = (characterId: number, work: string) =>
  saveDayPlan(
    characterId,
    TODAY,
    JSON.stringify({
      date: TODAY,
      blocks: [
        {
          start: "20:00",
          end: "22:00",
          activity: "영화 보기",
          responsiveness: "instant",
          advance_known: true,
          category: "personal",
          work,
        },
      ],
    }),
    "nightly",
  );

const newTrace = (): BuildTrace => ({
  tags: [],
  tagPool: 0,
  memories: [],
  oldDiaries: [],
  schedules: [],
  upcoming: [],
  dropped: [],
});

const pick = (tags: string[]) => ({
  tags,
  pool: tags.length,
  by: "match" as const,
  callId: null,
});

const titlesOf = (input: { workFacts: { title: string }[] }) =>
  input.workFacts.map((f) => f.title);

test("각본의 작품 칸과 진행 중인 일에 나온 작품은 경로와 상관없이 싣는다", () => {
  const c = newCharacter();
  planWith(c.id, "여름 언덕");
  // 진행 중인 일에 제목이 나오는 작품 — 각본에는 없다.
  saveMemory({
    characterId: c.id,
    itemType: "ongoing",
    owner: "char",
    area: "독서",
    subject: "당신 인생의 이야기",
    value: "세 번째 단편을 읽는 중이다",
    tags: ["책"],
    endCondition: "완독",
  });
  cards(c.id, ["여름 언덕", "당신 인생의 이야기", "지난달에 본 영화"]);

  for (const opts of [{}, { signals: true }]) {
    const input = readContextInput(c.id, c.chat_id, opts);
    // 조회는 제목순으로 오지만 고른 순서로 다시 맞춘다 — 각본이 진행 중인 일보다 앞이다.
    assert.deepEqual(titlesOf(input), ["여름 언덕", "당신 인생의 이야기"]);
    assert.deepEqual(input.workFacts[1]?.scenes, ["당신 인생의 이야기 장면"]);
    assert.ok(!titlesOf(input).includes("지난달에 본 영화"));
  }
});

test("답장 경로는 최근 대화에 제목이 나온 작품을 띄어쓰기가 달라도 싣는다", () => {
  const c = newCharacter();
  cards(c.id, ["지난달에 본 영화", "여름 언덕"]);
  say(c, "user", "너 지난달에본 영화 어땠어?");

  const trace = newTrace();
  const input = readContextInput(c.id, c.chat_id, { signals: true, trace });
  assert.deepEqual(titlesOf(input), ["지난달에 본 영화"]);
  assert.deepEqual(trace.works, ["지난달에 본 영화(대화)"]);

  // 선톡 경로는 recent를 켠 만큼만 대화를 본다 — 켜지 않으면 대화에서 찾지 않는다.
  assert.deepEqual(titlesOf(readContextInput(c.id, c.chat_id)), []);
});

test("답장 경로는 태그로 꺼낸 기억과 지난 일기에서 찾고, 정체성·최근 일기 본문·안 꺼낸 기억은 보지 않는다", () => {
  const c = newCharacter();
  cards(c.id, ["긴 겨울밤", "파란 문", "밤의 도서관", "첫눈 오는 날"]);
  saveMemory({
    characterId: c.id,
    itemType: "fact",
    owner: "user",
    area: "취미",
    subject: "영화",
    value: "긴 겨울밤을 극장에서 봤다",
    tags: ["영화"],
  });
  // 캐릭터 쪽 사실은 늘 실리는 정체성이라 태그 검색에 안 걸린다 — 제목이 있어도 카드를 붙이지 않는다.
  saveMemory({
    characterId: c.id,
    itemType: "fact",
    owner: "char",
    area: "취미",
    subject: "좋아하는 영화",
    value: "첫눈 오는 날",
    tags: ["영화"],
  });
  const old = insertDiary(
    c.id,
    "2026-08-01",
    JSON.stringify({ summary: "파란 문 마지막 권을 읽었다" }),
  );
  setTags(c.id, "diary", old, ["책"]);
  // 최근 일기 3편 — 지난 일기가 최근 일기 범위 밖으로 밀리게 하고, 본문에 제목을 하나 넣는다.
  insertDiary(c.id, "2026-09-10", JSON.stringify({ summary: "산책" }));
  insertDiary(
    c.id,
    "2026-09-11",
    JSON.stringify({ summary: "밤의 도서관을 읽었다" }),
  );
  insertDiary(c.id, "2026-09-12", JSON.stringify({ summary: "청소" }));

  const trace = newTrace();
  const input = readContextInput(c.id, c.chat_id, {
    signals: true,
    pick: pick(["영화", "책"]),
    trace,
  });
  assert.deepEqual(titlesOf(input), ["긴 겨울밤", "파란 문"]);
  assert.deepEqual(trace.works, ["긴 겨울밤(기억)", "파란 문(지난 일기)"]);

  // 이번 발화의 태그에 안 걸리면 같은 기억이 있어도 카드를 붙이지 않는다.
  assert.deepEqual(
    titlesOf(readContextInput(c.id, c.chat_id, { signals: true })),
    [],
  );
});

test("짧은 제목은 글에 들어 있어도 안 싣고 태그나 각본 작품 칸과 똑같을 때만 싣는다", () => {
  const c = newCharacter();
  cards(c.id, ["봄날"]);
  say(c, "user", "오늘 봄날씨 좋다");
  assert.deepEqual(
    titlesOf(readContextInput(c.id, c.chat_id, { signals: true })),
    [],
  );

  saveMemory({
    characterId: c.id,
    itemType: "fact",
    owner: "user",
    area: "취미",
    subject: "드라마",
    value: "봄날 1화를 봤다",
    tags: ["봄날"],
  });
  const trace = newTrace();
  const input = readContextInput(c.id, c.chat_id, {
    signals: true,
    pick: pick(["봄날"]),
    trace,
  });
  assert.deepEqual(titlesOf(input), ["봄날"]);
  assert.deepEqual(trace.works, ["봄날(기억)"]);

  const d = newCharacter();
  cards(d.id, ["봄날"]);
  planWith(d.id, "봄날");
  assert.deepEqual(titlesOf(readContextInput(d.id, d.chat_id)), ["봄날"]);
});

test("상한을 넘으면 가까운 곳에서 찾은 작품부터, 같은 대화 안에서는 최근 말에 나온 작품부터 남긴다", () => {
  const c = newCharacter();
  cards(c.id, ["가을 방학", "겨울 방학", "여름 방학", "봄 방학 일기"]);
  planWith(c.id, "봄 방학 일기");
  say(c, "user", "겨울 방학 봤어?");
  say(c, "assistant", "응 가을 방학도 봤어");
  say(c, "user", "여름 방학은?");

  const input = readContextInput(c.id, c.chat_id, { signals: true });
  assert.equal(input.workFacts.length, WORK_FACT_MAX_PER_REPLY);
  assert.deepEqual(titlesOf(input), ["여름 방학", "가을 방학", "겨울 방학"]);
});

test("선톡 경로는 방금까지 오간 말·어제 일기의 내일 챙길 것·대화 계획·상황 문단 순으로 찾는다", () => {
  const c = newCharacter();
  cards(c.id, ["바다 편지", "새벽 기차", "푸른 정원", "달빛 서점"]);
  say(c, "user", "바다 편지 얘기 했었지");
  insertDiary(
    c.id,
    shiftDate(TODAY, -1),
    JSON.stringify({
      summary: "푸른 정원을 읽었다",
      tomorrow: ["새벽 기차 마저 보기"],
    }),
  );
  saveRelationshipIntent(
    c.id,
    TODAY,
    { share: "푸른 정원 읽은 얘기" },
    "2026-09-15 05:00:00",
  );
  const situation = "오늘 아침에는 달빛 서점 얘기를 꺼낸다";

  const trace = newTrace();
  const full = readContextInput(c.id, c.chat_id, {
    recent: 5,
    situation,
    trace,
  });
  assert.deepEqual(titlesOf(full), ["바다 편지", "새벽 기차", "푸른 정원"]);
  assert.deepEqual(trace.works, [
    "바다 편지(대화)",
    "새벽 기차(어제 일기)",
    "푸른 정원(대화 계획)",
  ]);

  // 방금까지 오간 말을 안 넣는 선톡은 대화에서 찾지 않고, 비는 자리를 상황 문단이 채운다.
  const trace2 = newTrace();
  const noRecent = readContextInput(c.id, c.chat_id, {
    situation,
    trace: trace2,
  });
  assert.deepEqual(titlesOf(noRecent), ["새벽 기차", "푸른 정원", "달빛 서점"]);
  assert.deepEqual(trace2.works, [
    "새벽 기차(어제 일기)",
    "푸른 정원(대화 계획)",
    "달빛 서점(상황 문단)",
  ]);
});
