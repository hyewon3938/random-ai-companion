// 문화 스크립트(#405)가 원본에서 표로, 표에서 월 리듬 프롬프트로 가는 자리를 검사한다.
//
// 이 표의 값어치는 "이 달에 걸린 것만 꺼낸다"에 있다. 표를 통째로 싣기 시작하면 이 달과 상관없는
// 절차가 한 달 내내 프롬프트에 앉아 있고, 모델은 빈자리를 채우려고 없는 이벤트를 만든다. 그래서
// 걸린 이벤트만 나오는지와 안 걸린 이벤트가 안 나오는지를 같은 무게로 본다.
//
// 원본 자체의 규칙도 여기서 지킨다 — 단계가 시간 순서대로 적혀 있는지, 이벤트마다 별칭 줄이
// 짝지어 있는지. 이벤트를 새로 더하면서 별칭을 빠뜨리면 이름이 그대로 적힌 문장만 걸리고
// 추석·부고처럼 실제로 쓰는 말은 하나도 안 걸린다.
//
// DB는 임시 파일로 새로 만든다. 모델도 텔레그램도 부르지 않아 값이 안 든다.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
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
  CULTURE_SCRIPTS,
  EVENT_ALIASES,
  findCultureEvents,
  getCultureEvent,
  getCultureScript,
  getSchedulesInMonth,
} = await import("../src/db.js");

// 표에 실제로 들어간 값을 본다 — 원본 배열이 아니라. 원본을 표로 옮기는 자리가 이 검사의 대상이라
// 양쪽 다 원본에서 뽑으면 아무것도 검사하지 않는 셈이 된다.
const eventsInTable = (): string[] =>
  (
    db
      .prepare(`SELECT DISTINCT event FROM culture_scripts WHERE locale = 'KR'`)
      .all() as { event: string }[]
  ).map((r) => r.event);
const rolesInTable = (event: string): string[] =>
  (
    db
      .prepare(
        `SELECT DISTINCT role FROM culture_scripts WHERE locale = 'KR' AND event = ?`,
      )
      .all(event) as { role: string }[]
  ).map((r) => r.role);
const { createFixtureCharacter } =
  await import("../src/eval/fixture-character.js");
const { saveMemory } = await import("../src/memory.js");
const { applyMonthPlan, culturePrompt } = await import("../src/life-plan.js");

let char = 0;
let other = 0;
let ongoingId = 0;
let otherOngoingId = 0;

before(() => {
  char = createFixtureCharacter("chat-culture");
  other = createFixtureCharacter("chat-culture-other");
  ongoingId = saveMemory({
    characterId: char,
    itemType: "ongoing",
    owner: "char",
    area: "가족",
    subject: "동생 결혼",
    value: "동생이 10월 말에 결혼한다",
  });
  otherOngoingId = saveMemory({
    characterId: other,
    itemType: "ongoing",
    owner: "char",
    area: "가족",
    subject: "동생 결혼",
    value: "동생이 10월 말에 결혼한다",
  });
});
after(() => {
  db.close();
});

// ── 원본과 표 ─────────────────────────────────────────────────────────────

test("원본에 적힌 이벤트·역할이 표에 그대로 들어간다", () => {
  const fromCode = [...new Set(CULTURE_SCRIPTS.map((s) => s.event))].sort();
  assert.deepEqual(eventsInTable().sort(), fromCode);
  assert.deepEqual(rolesInTable("결혼").sort(), ["본인", "친구", "형제자매"]);

  const steps = getCultureScript("결혼", "친구");
  const fromCodeSteps = CULTURE_SCRIPTS.find(
    (s) => s.event === "결혼" && s.role === "친구",
  )?.steps;
  assert.ok(fromCodeSteps);
  assert.deepEqual(
    steps.map((s) => [s.step_no, s.days_before, s.step]),
    fromCodeSteps.map((s, i) => [i + 1, s.daysBefore, s.step]),
  );
});

test("단계는 먼 날부터 가까운 날 순서로 적혀 있다", () => {
  for (const s of CULTURE_SCRIPTS) {
    const offsets = s.steps.map((st) => st.daysBefore);
    assert.deepEqual(
      offsets,
      [...offsets].sort((a, b) => b - a),
      `${s.event}/${s.role}의 단계가 시간 순서가 아니다: ${offsets.join(", ")}`,
    );
  }
});

test("이벤트마다 별칭 줄이 하나씩 짝지어 있다", () => {
  const events = [...new Set(CULTURE_SCRIPTS.map((s) => s.event))].sort();
  assert.deepEqual(EVENT_ALIASES.map((a) => a.event).sort(), events);
});

// ── 이름 찾기 ─────────────────────────────────────────────────────────────

test("별칭으로도 걸리고 이름이 없으면 아무것도 안 걸린다", () => {
  assert.deepEqual(findCultureEvents("가을: 추석에 본가에 내려간다"), ["명절"]);
  assert.deepEqual(findCultureEvents("친구 부고를 들었다"), ["장례"]);
  assert.deepEqual(findCultureEvents("요즘 아침 운동을 시작했다"), []);
});

test("이름을 품고 있어도 그 이벤트가 아닌 말은 안 걸린다", () => {
  assert.deepEqual(findCultureEvents("이사회에 들어가 이사님 보고를 한다"), []);
  assert.deepEqual(findCultureEvents("10-18 이삿짐 센터 견적"), ["이사"]);
});

test("한 문장에 둘이 걸리면 둘 다 나온다", () => {
  assert.deepEqual(findCultureEvents("동생 결혼식을 하고 집들이도 한다"), [
    "결혼",
    "집들이",
  ]);
});

// ── 월 리듬 프롬프트 ───────────────────────────────────────────────────────

test("걸린 이벤트의 역할을 전부 싣고 안 걸린 이벤트는 한 줄도 안 싣는다", () => {
  const out = culturePrompt("가족 · 동생 결혼: 동생이 10월 말에 결혼한다");

  for (const role of ["본인", "형제자매", "친구"])
    assert.ok(out.includes(`### 결혼 — ${role}`), `${role} 역할이 빠졌다`);
  // 역할을 코드가 고르지 않는다 — 형제의 결혼인지 친구의 결혼인지는 모델이 문장을 보고 고른다.
  assert.ok(out.includes("청모"), "단계 문장이 안 실렸다");

  for (const event of eventsInTable())
    if (event !== "결혼")
      assert.ok(!out.includes(`### ${event} —`), `${event}가 실렸다`);
});

test("날 수는 당일을 기준으로 앞뒤가 갈려 적힌다", () => {
  const out = culturePrompt("이번 달에 이사를 한다");
  assert.ok(out.includes("D-60 "), "앞선 단계가 D- 꼴이 아니다");
  assert.ok(out.includes("당일 "), "당일이 D-0으로 적혔다");
  assert.ok(out.includes("D+7 "), "당일 뒤 단계가 D+ 꼴이 아니다");
});

test("걸린 이벤트가 없으면 빈 문자열이라 블록 자체가 안 붙는다", () => {
  assert.equal(culturePrompt("요즘 아침 운동을 시작했다"), "");
  assert.equal(culturePrompt(""), "");
});

test("표를 읽는 자리는 이벤트 하나씩이다 — 전체를 꺼내는 함수가 없다", () => {
  assert.equal(getCultureEvent("집들이").length, 10);
  assert.equal(getCultureEvent("없는 이벤트").length, 0);
});

// ── 펼친 단계와 원본 링크 ──────────────────────────────────────────────────

test("진행 중인 일에서 펼친 단계는 그 기억 행을 가리킨다", () => {
  applyMonthPlan(char, "2026-10", {
    events: [
      {
        date: "2026-10-05",
        time_hint: "저녁",
        content: "동생 결혼식 청첩장 받고 그날 일정 비우기",
        from_ongoing: ongoingId,
      },
      { date: "2026-10-12", time_hint: null, content: "주말 등산" },
    ],
    days: [
      {
        date: "2026-10-05",
        energy: "보통",
        wake_hint: "보통",
        mood: "차분",
        note: "",
      },
    ],
  });

  const rows = getSchedulesInMonth(char, "2026-10", "char").map((s) =>
    db
      .prepare(
        `SELECT content, parent_kind, parent_id FROM schedules WHERE id = ?`,
      )
      .get(s.id),
  );
  assert.deepEqual(rows, [
    {
      content: "동생 결혼식 청첩장 받고 그날 일정 비우기",
      parent_kind: "memory",
      parent_id: ongoingId,
    },
    { content: "주말 등산", parent_kind: null, parent_id: null },
  ]);
});

test("이 캐릭터 것이 아닌 번호는 링크 없이 들어간다", () => {
  applyMonthPlan(char, "2026-11", {
    events: [
      {
        date: "2026-11-03",
        time_hint: null,
        content: "남의 진행 중인 일 번호",
        from_ongoing: otherOngoingId,
      },
      {
        date: "2026-11-04",
        time_hint: null,
        content: "없는 번호",
        from_ongoing: 99999,
      },
    ],
    days: [
      {
        date: "2026-11-03",
        energy: "보통",
        wake_hint: "보통",
        mood: "",
        note: "",
      },
    ],
  });

  const rows = getSchedulesInMonth(char, "2026-11", "char").map((s) =>
    db
      .prepare(`SELECT parent_kind, parent_id FROM schedules WHERE id = ?`)
      .get(s.id),
  );
  assert.deepEqual(rows, [
    { parent_kind: null, parent_id: null },
    { parent_kind: null, parent_id: null },
  ]);
});
