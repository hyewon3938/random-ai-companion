// 캐릭터 생성이 진행 중인 일의 문화 스크립트 단계와 그 일이 있는 날을 정하는 자리(이슈 #474)를 검사한다.
//
// 날짜 계산은 코드가 하고 모델은 후보에서 고르기만 한다는 것이 이 기능의 전부라, 세 층을 따로 본다.
// 첫째, 원본만 보고 답하는 함수(dayMark·stepNoAt·stepWindows)가 모든 이벤트에서 서로 맞는지.
// 둘째, 코드가 뽑는 후보가 범위 안·오늘 아님·공휴일 아님을 지키고, 걸린 이벤트만 대상이 되는지 —
// 명절은 달력이 정하니 빠지고, 결혼기념일처럼 글자만 겹치는 말은 안 걸린다. 셋째, 모델의 답을
// 읽는 쪽이 후보 밖의 값과 오늘을 기준으로 한 말을 거르고, 두 번 다 어긋나거나 호출이 실패하면
// 첫 호출의 문장을 그대로 두는지.
//
// 모델은 부르지 않는다 — 정해 둔 답을 주는 ask를 넣는다. DB는 임시 파일로 새로 만든다.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CultureStageAnswer,
  GenesisOngoingRow,
  GenesisOutput,
} from "../src/character.js";
import type { CallMeta, chatJson } from "../src/llm.js";

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
  dayMark,
  getCharacterById,
  listMemoryItems,
  stepNoAt,
  stepWindows,
} = await import("../src/db.js");
const {
  cultureStagePromptText,
  cultureTargets,
  eventDateCandidates,
  persistGenesis,
  readCultureStage,
  stageCultureOngoing,
} = await import("../src/character.js");
const { config } = await import("../src/config.js");
const { holidaysInMonth, shiftDate } = await import("../src/kst.js");
const { EVAL_GENESIS, EVAL_INPUT } =
  await import("../src/eval/fixture-character.js");

after(() => {
  db.close();
});

const TODAY = "2026-09-20";
const MOVING = CULTURE_SCRIPTS.find(
  (s) => s.event === "이사" && s.role === "본인",
);
assert.ok(MOVING, "이사 본인 원본이 있어야 한다");
const MOVING_DAYS = MOVING.steps.map((s) => s.daysBefore);

const clone = (): GenesisOutput => structuredClone(EVAL_GENESIS);

const isHoliday = (date: string): boolean =>
  holidaysInMonth(date.slice(0, 7)).some((h) => h.date === date);

const daysBetween = (from: string, to: string): number =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
  86_400_000;

// ── 원본만 보고 답하는 함수 ────────────────────────────────────────────

test("dayMark는 당일·D-숫자·D+숫자로 적는다", () => {
  assert.equal(dayMark(0), "당일");
  assert.equal(dayMark(7), "D-7");
  assert.equal(dayMark(-1), "D+1");
});

test("stepNoAt은 때가 온 단계의 수를 센다", () => {
  assert.equal(stepNoAt(MOVING_DAYS, 61), 0, "첫 단계도 오기 전");
  assert.equal(stepNoAt(MOVING_DAYS, 45), 1);
  assert.equal(stepNoAt(MOVING_DAYS, 30), 2, "단계의 날 당일은 그 단계");
  assert.equal(stepNoAt(MOVING_DAYS, 0), 7, "같은 날 오는 두 단계는 둘 다 센다");
  assert.equal(stepNoAt(MOVING_DAYS, -7), MOVING_DAYS.length);
});

test("stepWindows는 이사 본인의 단계마다 남은 날 수의 범위를 준다", () => {
  assert.deepEqual(
    stepWindows(MOVING_DAYS).map((w) => [w.stepNo, w.minDays, w.maxDays]),
    [
      [1, 31, 60],
      [2, 15, 30],
      [3, 8, 14],
      [4, 2, 7],
      [5, 1, 1],
      [7, 0, 0],
      [8, -6, -1],
    ],
    "다음 단계와 같은 날인 6단계와 마지막 9단계는 빠진다",
  );
});

test("모든 원본에서 범위의 양 끝을 stepNoAt이 그 단계로 센다", () => {
  for (const s of CULTURE_SCRIPTS) {
    const days = s.steps.map((x) => x.daysBefore);
    for (let i = 1; i < days.length; i++)
      assert.ok(
        days[i] <= days[i - 1],
        `${s.event}(${s.role}) 단계가 당일 쪽으로 가지 않는다`,
      );
    const windows = stepWindows(days);
    assert.ok(windows.length, `${s.event}(${s.role})에 고를 단계가 없다`);
    for (const w of windows) {
      assert.ok(w.stepNo < days.length, "마지막 단계는 고르지 않는다");
      assert.equal(stepNoAt(days, w.minDays), w.stepNo);
      assert.equal(stepNoAt(days, w.maxDays), w.stepNo);
    }
  }
});

// ── 코드가 뽑는 후보 ───────────────────────────────────────────────

test("후보는 토·일·평일 하나씩, 범위 한가운데에 가까운 날이다", () => {
  assert.deepEqual(eventDateCandidates(TODAY, 31, 60), [
    "2026-11-05",
    "2026-11-07",
    "2026-11-08",
  ]);
});

test("후보에서 공휴일과 오늘을 뺀다", () => {
  // 2026-09-26(토)은 추석 연휴라 그 주 토요일이 빠진다.
  assert.deepEqual(eventDateCandidates(TODAY, 2, 7), [
    "2026-09-23",
    "2026-09-27",
  ]);
  assert.deepEqual(eventDateCandidates(TODAY, 0, 0), [], "오늘뿐인 범위");
  assert.deepEqual(eventDateCandidates(TODAY, -6, -1), [
    "2026-09-17",
    "2026-09-19",
  ]);
});

test("어느 날에 만들어도 후보는 범위 안이고 오늘·공휴일이 아니며 요일 갈래가 겹치지 않는다", () => {
  for (const today of ["2026-01-01", "2026-09-20", "2026-12-28"])
    for (const [min, max] of [
      [301, 330],
      [41, 100],
      [8, 14],
      [2, 3],
      [-13, 0],
    ]) {
      const dates = eventDateCandidates(today, min, max);
      assert.ok(dates.length <= 3);
      const kinds = dates.map((d) => {
        const w = new Date(`${d}T00:00:00Z`).getUTCDay();
        return w === 6 ? "토" : w === 0 ? "일" : "평일";
      });
      assert.equal(new Set(kinds).size, kinds.length, `${today} ${min}~${max}`);
      for (const d of dates) {
        const left = daysBetween(today, d);
        assert.ok(left >= min && left <= max, `${d}는 범위 밖`);
        assert.notEqual(d, today);
        assert.ok(!isHoliday(d), `${d}는 공휴일`);
      }
    }
});

test("평가용 캐릭터에서는 이사 준비 한 줄만 대상이 된다", () => {
  const targets = cultureTargets(EVAL_GENESIS.ongoing, TODAY);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].no, 2);
  assert.deepEqual(
    targets[0].events.map((e) => e.event),
    ["이사"],
  );
  const role = targets[0].events[0].roles;
  assert.deepEqual(
    role.map((r) => r.role),
    ["본인"],
  );
  assert.deepEqual(
    role[0].choices.map((c) => c.stepNo),
    [1, 2, 3, 4, 5, 8],
    "7단계는 오늘뿐이라 후보가 없어 빠진다",
  );
});

test("명절과 글자만 겹치는 말은 대상이 아니고, 결혼은 역할을 전부 싣는다", () => {
  const row = (subject: string, value: string): GenesisOngoingRow => ({
    area: "생활",
    subject,
    value,
    endCondition: "끝나면 끝난다",
  });
  assert.deepEqual(
    cultureTargets(
      [
        row("추석 준비", "추석에 청주 본가에 내려간다"),
        row("부모님 선물", "부모님 결혼기념일 선물을 고른다"),
        row("회사 일", "이사회 보고 자료를 만든다"),
      ],
      TODAY,
    ),
    [],
  );
  const wedding = cultureTargets(
    [row("누나 결혼", "누나 결혼식 준비를 돕는다")],
    TODAY,
  );
  assert.deepEqual(
    wedding[0].events[0].roles.map((r) => r.role),
    ["본인", "형제자매", "친구"],
  );
});

test("프롬프트는 걸린 일의 절차와 단계별 후보만 싣는다", () => {
  assert.equal(
    cultureStagePromptText(
      { ...clone(), ongoing: [clone().ongoing[0]] },
      TODAY,
    ),
    null,
    "걸린 일이 없으면 문안도 없다",
  );
  const text = cultureStagePromptText(EVAL_GENESIS, TODAY);
  assert.ok(text);
  assert.match(text.user, /오늘은 2026-09-20\(일\)이다/);
  assert.match(text.user, /## 2번 — 이사/);
  assert.match(text.user, /1단계 D-60: /);
  assert.match(text.user, /9단계 D\+7: /);
  assert.ok(
    text.user.includes("- 1단계: 2026-11-05(목) 2026-11-07(토) 2026-11-08(일)"),
  );
  assert.ok(!text.user.includes("- 9단계:"), "마지막 단계는 후보가 없다");
  assert.ok(!text.user.includes("### 결혼"));
  assert.ok(!text.user.includes("### 명절"));
});

// ── 모델의 답 읽기 ────────────────────────────────────────────────

const GOOD_VALUE =
  "지금 원룸 계약이 끝나가서 11월 7일 토요일에 이사하는 걸 목표로 잡았다. 근처 매물을 틈틈이 보고 있고, 마음에 드는 집이 나오면 바로 계약금을 넣을 생각이다.";

const goodAnswer = (value = GOOD_VALUE): CultureStageAnswer => ({
  items: [
    {
      no: 2,
      event: "이사",
      role: "본인",
      stepNo: 1,
      eventDate: "2026-11-07",
      value,
    },
  ],
});

const read = (answer: CultureStageAnswer, ongoing = EVAL_GENESIS.ongoing) =>
  readCultureStage(
    answer,
    cultureTargets(ongoing, TODAY),
    ongoing,
    TODAY,
  );

const problemOf = (answer: CultureStageAnswer, ongoing?: GenesisOngoingRow[]) => {
  const r = read(answer, ongoing);
  return "problem" in r ? r.problem : null;
};

test("맞는 답은 새 문장과 genesis_json에 남길 자리가 된다", () => {
  const r = read(goodAnswer());
  assert.ok("picks" in r);
  assert.deepEqual(r.picks, [
    {
      no: 2,
      value: GOOD_VALUE,
      script: {
        event: "이사",
        role: "본인",
        eventDate: "2026-11-07",
        stepNo: 1,
        startedOn: "2026-09-08",
        firstValue: EVAL_GENESIS.ongoing[1].value,
      },
    },
  ]);
  assert.equal(shiftDate("2026-11-07", -60), "2026-09-08");
});

test("숫자 칸이 문자열로 와도 읽는다", () => {
  const answer = goodAnswer();
  const item = answer.items[0] as unknown as Record<string, unknown>;
  item.no = "2";
  item.stepNo = "1";
  assert.equal(problemOf(answer), null);
});

test("줄이 객체가 아니거나 value가 문자열이 아니면 던지지 않고 문제로 돌려준다", () => {
  assert.match(
    problemOf({ items: [null] } as unknown as CultureStageAnswer) ?? "",
    /객체여야 한다/,
  );
  const answer = goodAnswer();
  (answer.items[0] as unknown as Record<string, unknown>).value = 7;
  assert.match(problemOf(answer) ?? "", /2번 value: 비었다/);
});

test("event가 null이면 붙이지 않는다", () => {
  const r = read({ items: [{ no: 2, event: null }] });
  assert.ok("picks" in r);
  assert.deepEqual(r.picks, []);
});

test("후보 밖의 값을 거른다", () => {
  const with_ = (patch: Partial<CultureStageAnswer["items"][number]>) => ({
    items: [{ ...goodAnswer().items[0], ...patch }],
  });
  assert.match(problemOf({ items: [] }) ?? "", /빠진 번호: 2/);
  assert.match(
    problemOf({ items: "x" } as unknown as CultureStageAnswer) ?? "",
    /items 목록/,
  );
  assert.match(problemOf(with_({ no: 1 })) ?? "", /1번은 정할 일이 아니다/);
  assert.match(
    problemOf({ items: [goodAnswer().items[0], goodAnswer().items[0]] }) ?? "",
    /두 번 나왔다/,
  );
  assert.match(problemOf(with_({ event: "결혼" })) ?? "", /event는 이사/);
  assert.match(problemOf(with_({ role: "손님" })) ?? "", /role은 본인/);
  assert.match(
    problemOf(with_({ stepNo: 9 })) ?? "",
    /고를 수 있는 단계는 1·2·3·4·5·8단계/,
  );
  assert.match(problemOf(with_({ stepNo: 6 })) ?? "", /고를 수 있는 단계/);
  assert.match(
    problemOf(with_({ eventDate: "2026-11-14" })) ?? "",
    /후보 2026-11-05·2026-11-07·2026-11-08/,
  );
});

test("새 문장에 날짜가 없거나 D-숫자·오늘 기준의 말이 있으면 거른다", () => {
  assert.match(problemOf(goodAnswer("")) ?? "", /비었다/);
  assert.match(
    problemOf(goodAnswer("11월 중순쯤 이사하려고 매물을 본다.")) ?? "",
    /"11월 7일"로 적어야/,
  );
  assert.match(
    problemOf(goodAnswer("1월 7일에 이사한다.")) ?? "",
    /"11월 7일"로 적어야/,
  );
  assert.match(
    problemOf(goodAnswer("11월 7일에 이사한다. 지금은 D-48이라 집을 본다.")) ??
      "",
    /D-숫자/,
  );
  assert.match(
    problemOf(goodAnswer("11월 7일에 이사한다. 다음 달에 짐을 싼다.")) ?? "",
    /"다음 달"/,
  );
  assert.equal(
    problemOf(goodAnswer("11월7일에 이사하려고 집을 본다.")),
    null,
    "월과 일 사이 띄어쓰기는 가리지 않는다",
  );
});

test("올해가 아닌 날은 해까지 적어야 한다", () => {
  const today = "2026-11-20";
  const ongoing = EVAL_GENESIS.ongoing;
  const targets = cultureTargets(ongoing, today);
  const choice = targets[0].events[0].roles[0].choices.find(
    (c) => c.stepNo === 1,
  );
  const date = choice?.dates.find((d) => d.startsWith("2027"));
  assert.ok(date, "11월 말에 만들면 1단계 후보가 해를 넘긴다");
  const [, m, d] = date.split("-").map(Number);
  const answer = (value: string): CultureStageAnswer => ({
    items: [
      { no: 2, event: "이사", role: "본인", stepNo: 1, eventDate: date, value },
    ],
  });
  const problem = (value: string) => {
    const r = readCultureStage(answer(value), targets, ongoing, today);
    return "problem" in r ? r.problem : null;
  };
  assert.match(problem(`${m}월 ${d}일에 이사한다.`) ?? "", /해까지/);
  assert.equal(problem(`2027년 ${m}월 ${d}일에 이사한다.`), null);
});

test("이벤트 이름이 키에도 문장에도 없으면 거른다", () => {
  const ongoing: GenesisOngoingRow[] = [
    {
      area: "생활",
      subject: "집 구하기",
      value: "원룸 계약이 끝나 이사 갈 집을 본다",
      endCondition: "새 집에 들어가면 끝난다",
    },
  ];
  const answer = (value: string): CultureStageAnswer => ({
    items: [
      {
        no: 1,
        event: "이사",
        role: "본인",
        stepNo: 1,
        eventDate: "2026-11-07",
        value,
      },
    ],
  });
  assert.match(
    problemOf(answer("11월 7일에 새 집으로 들어간다."), ongoing) ?? "",
    /"이사"라는 말/,
  );
  assert.equal(
    problemOf(answer("11월 7일에 이사하려고 집을 본다."), ongoing),
    null,
  );
});

// ── 생성 흐름에 붙은 자리 ─────────────────────────────────────────

interface Call {
  user: string;
  maxTokens: number;
  model: string;
  meta?: CallMeta;
}

/** 차례대로 정해 둔 답을 주는 모델. Error를 넣으면 그 차례에 던진다. */
const fakeAsk = (answers: (CultureStageAnswer | Error)[]) => {
  const calls: Call[] = [];
  const ask = (async (
    _system: unknown,
    user: string,
    maxTokens: number,
    model: string,
    meta?: CallMeta,
  ) => {
    calls.push({ user, maxTokens, model, meta });
    const answer = answers[calls.length - 1];
    if (answer instanceof Error) throw answer;
    return answer;
  }) as typeof chatJson;
  return { ask, calls };
};

test("걸린 일이 없으면 부르지 않고 그대로 돌려준다", async () => {
  const out = { ...clone(), ongoing: [clone().ongoing[0]] };
  const { ask, calls } = fakeAsk([]);
  assert.equal(await stageCultureOngoing(out, TODAY, "chat-x", ask), out);
  assert.equal(calls.length, 0);
});

test("맞는 답이면 그 줄만 새 문장과 자리로 바꾼다", async () => {
  const out = clone();
  const { ask, calls } = fakeAsk([goodAnswer()]);
  const staged = await stageCultureOngoing(out, TODAY, "chat-x", ask);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, config.modelDeep);
  assert.deepEqual(calls[0].meta, { purpose: "genesis", chatId: "chat-x" });
  assert.deepEqual(staged.ongoing[0], EVAL_GENESIS.ongoing[0]);
  assert.equal(staged.ongoing[1].value, GOOD_VALUE);
  assert.equal(staged.ongoing[1].endCondition, EVAL_GENESIS.ongoing[1].endCondition);
  assert.equal(staged.ongoing[1].script?.eventDate, "2026-11-07");
  assert.deepEqual(out, EVAL_GENESIS, "받은 결과는 고치지 않는다");
});

test("어긋나면 문제를 붙여 한 번 다시 묻는다", async () => {
  const bad = goodAnswer();
  bad.items[0].eventDate = "2026-11-14";
  const { ask, calls } = fakeAsk([bad, goodAnswer()]);
  const staged = await stageCultureOngoing(clone(), TODAY, undefined, ask);
  assert.equal(calls.length, 2);
  assert.ok(!calls[0].user.includes("[직전 시도에서 거부된 문제"));
  assert.match(
    calls[1].user,
    /\[직전 시도에서 거부된 문제 — 이번에는 고칠 것\]\n2번 1단계의 eventDate는 후보/,
  );
  assert.equal(staged.ongoing[1].script?.stepNo, 1);
});

test("두 번 다 어긋나거나 호출이 실패하면 첫 호출의 문장을 둔다", async () => {
  const bad = goodAnswer("이사한다.");
  const twice = fakeAsk([bad, bad]);
  const out = clone();
  assert.equal(await stageCultureOngoing(out, TODAY, undefined, twice.ask), out);
  assert.equal(twice.calls.length, 2);

  const thrown = fakeAsk([new Error("model timeout")]);
  assert.equal(await stageCultureOngoing(out, TODAY, undefined, thrown.ask), out);
  assert.equal(thrown.calls.length, 1, "실패한 호출은 다시 묻지 않는다");
});

test("event가 null이면 문장도 자리도 그대로다", async () => {
  const { ask } = fakeAsk([{ items: [{ no: 2, event: null }] }]);
  const staged = await stageCultureOngoing(clone(), TODAY, undefined, ask);
  assert.deepEqual(staged, EVAL_GENESIS);
});

test("정한 자리는 genesis_json에, 새 문장은 진행 중인 일 기억 행에 저장된다", async () => {
  const { ask } = fakeAsk([goodAnswer()]);
  const staged = await stageCultureOngoing(clone(), TODAY, undefined, ask);
  const id = persistGenesis("chat-culture-stage", EVAL_INPUT, staged);
  const saved = JSON.parse(getCharacterById(id)?.genesis_json ?? "{}") as {
    output: GenesisOutput;
  };
  assert.equal(saved.output.ongoing[1].script?.event, "이사");
  assert.equal(
    saved.output.ongoing[1].script?.firstValue,
    EVAL_GENESIS.ongoing[1].value,
  );
  const moving = listMemoryItems(id, "ongoing").find(
    (r) => r.subject === EVAL_GENESIS.ongoing[1].subject,
  );
  assert.equal(moving?.value, GOOD_VALUE);
});
