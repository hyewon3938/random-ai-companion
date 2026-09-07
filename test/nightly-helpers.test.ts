// 새벽 정리(nightly.ts)의 순수 도우미 — 결번 날짜, 아침 문안 순간, 날짜·분 더하기, 태그 다듬기, 각본 요약 — 를 검사한다.
//
// missingDiaryDates는 대화는 있는데 일기가 없는 날만 오래된 순으로 돌려주는지(대화 없는 날·일기
// 있는 날·오늘은 빠지고 새벽 5시 전 대화는 전날로 세는지), morningStyles는 기상 블록과 그 뒤 첫
// 일과에서 순간을 뽑고 잠 블록 끝으로 기상을 대신하며 11시 넘은 첫 일과는 빼는지, nextDate·addMin은
// 월말·자정 경계를 어떻게 다루는지, cleanTags는 공백·중복·빈값을 거르는지, planBrief가 블록을
// 시각 활동으로 잇는지 본다.
//
// DB는 임시 파일로 새로 만들고 Date만 고정한다. 모델 주소는 닫힌 포트라 값이 안 든다.
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";

// DB 경로를 정한 뒤에 읽어야 임시 파일로 열린다 — 정적 import는 이 줄들보다 먼저 돈다.
const { db, insertDiary, logMessage } = await import("../src/db.js");
const { createFixtureCharacter } = await import(
  "../src/eval/fixture-character.js"
);
const {
  addMin,
  cleanTags,
  missingDiaryDates,
  morningStyles,
  nextDate,
  planBrief,
} = await import("../src/nightly.js");
type PlanBlock = {
  start: string;
  end: string;
  activity: string;
  responsiveness: "instant" | "intermittent" | "unavailable";
  advance_known: boolean;
  category: "personal" | "social" | "official";
};

const CHAT = "chat-diary";
const characterId = createFixtureCharacter(CHAT);

const block = (
  start: string,
  end: string,
  activity: string,
  responsiveness: PlanBlock["responsiveness"] = "instant",
): PlanBlock => ({
  start,
  end,
  activity,
  responsiveness,
  advance_known: true,
  category: "personal",
});
const plan = (blocks: PlanBlock[]): string =>
  JSON.stringify({ date: "2026-09-07", blocks });

before(() => {
  // 2026-09-07 10:00 KST — 결번 날짜 계산의 '오늘'.
  mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 8, 7, 1, 0) });
});
after(() => {
  mock.timers.reset();
  db.close();
});

test("다음 날짜는 월말과 연말, 윤년 2월을 넘긴다", () => {
  assert.equal(nextDate("2026-08-31"), "2026-09-01");
  assert.equal(nextDate("2026-12-31"), "2027-01-01");
  assert.equal(nextDate("2028-02-28"), "2028-02-29");
});

test("분을 더하면 시가 올라가고 자정은 넘기지 않고 23:59에서 멈춘다", () => {
  assert.equal(addMin("08:45", 30), "09:15");
  assert.equal(addMin("00:00", 0), "00:00");
  assert.equal(addMin("23:50", 20), "23:59");
});

test("태그는 앞뒤 공백을 지우고 빈 값·중복·문자열 아닌 것을 거른다", () => {
  assert.deepEqual(cleanTags(["운동", " 운동 ", "", "  ", "책", 3, null]), [
    "운동",
    "책",
  ]);
});

test("태그가 배열이 아니면 빈 목록이고 상한을 주면 그만큼만 남긴다", () => {
  assert.deepEqual(cleanTags("운동"), []);
  assert.deepEqual(cleanTags(undefined), []);
  assert.deepEqual(cleanTags(["a", "b", "c"], 2), ["a", "b"]);
});

test("각본 요약은 블록을 시각 활동으로 잇고 24시 넘는 시각은 벽시계로 적는다", () => {
  const raw = plan([
    block("07:00", "09:00", "기상"),
    block("09:00", "18:00", "출근", "intermittent"),
    block("26:30", "31:00", "잠", "unavailable"),
  ]);
  assert.equal(planBrief(raw), "07:00 기상 / 09:00 출근 / 02:30 잠");
});

test("각본이 없거나 깨졌으면 요약은 빈 문자열이다", () => {
  assert.equal(planBrief(undefined), "");
  assert.equal(planBrief("{깨진 json"), "");
});

test("아침 순간은 기상과 첫 일과 시작, 첫 일과 도중 셋을 뽑는다", () => {
  const styles = morningStyles(
    plan([
      block("23:30", "07:00", "잠", "unavailable"),
      block("07:00", "07:30", "기상"),
      block("07:30", "08:30", "출근 준비"),
      block("08:30", "09:20", "출근길", "unavailable"),
    ]),
  );
  assert.equal(styles.length, 3);
  assert.deepEqual(styles[0], {
    moment: "막 일어난 참 (기상 07:00쯤)",
    start: "07:00",
    end: "07:25",
  });
  assert.deepEqual(styles[1], {
    moment: "오늘 첫 일과인 '출근 준비'을 막 시작할 무렵 (07:30쯤)",
    start: "07:30",
    end: "07:55",
  });
  assert.deepEqual(styles[2], {
    moment: "'출근 준비' 하다가 한숨 돌린 참 (07:50쯤)",
    start: "07:40",
    end: "08:20",
  });
});

test("첫 일과가 불가 구간이면 도중 순간은 빠진다", () => {
  const styles = morningStyles(
    plan([
      block("07:00", "07:20", "기상"),
      block("07:20", "08:30", "출근길 운전", "unavailable"),
    ]),
  );
  assert.equal(styles.length, 2);
  assert.equal(styles[1]?.start, "07:20");
});

test("기상 블록이 없으면 잠 블록의 끝을 기상 시각으로 삼는다", () => {
  const styles = morningStyles(
    plan([
      block("00:30", "08:00", "잠", "unavailable"),
      block("08:10", "08:40", "아침 식사"),
    ]),
  );
  assert.equal(styles[0]?.start, "08:00");
  assert.match(styles[0]?.moment ?? "", /기상 08:00쯤/);
  assert.equal(styles[1]?.start, "08:10");
});

test("첫 일과가 11시 이후면 기상 순간만 남는다", () => {
  const styles = morningStyles(
    plan([block("10:40", "11:00", "기상"), block("11:00", "12:30", "브런치")]),
  );
  assert.equal(styles.length, 1);
  assert.equal(styles[0]?.start, "10:40");
});

test("기상도 잠도 없으면 5시 이후 첫 블록을 첫 일과로 잡는다", () => {
  const styles = morningStyles(
    plan([block("08:10", "08:40", "아침 식사"), block("09:00", "12:00", "업무")]),
  );
  assert.equal(styles.length, 2);
  assert.match(styles[0]?.moment ?? "", /'아침 식사'을 막 시작할 무렵/);
});

test("각본이 없거나 깨졌으면 아침 순간은 빈 목록이다", () => {
  assert.deepEqual(morningStyles(undefined), []);
  assert.deepEqual(morningStyles("{깨진 json"), []);
});

test("결번 날짜는 대화는 있고 일기는 없는 날만 오래된 순으로 돌려준다", () => {
  // 어제(09-06): 대화만 → 결번. 09-05: 대화와 일기 → 빠짐. 09-04: 대화 없음 → 빠짐.
  // 09-03 새벽 3시 대화는 09-02 창(05:00~다음날 05:00)에 든다 → 09-02 결번, 09-03은 아님.
  // 오늘(09-07) 대화는 아직 창이 닫히지 않아 세지 않는다. 8일 전(08-30)은 기본 회고 밖이다.
  logMessage(CHAT, characterId, "user", "어제 대화", "2026-09-06 12:00:00");
  logMessage(CHAT, characterId, "user", "그저께 대화", "2026-09-05 12:00:00");
  insertDiary(characterId, "2026-09-05", "{}");
  logMessage(CHAT, characterId, "user", "새벽 대화", "2026-09-03 03:00:00");
  logMessage(CHAT, characterId, "user", "오늘 대화", "2026-09-07 09:00:00");
  logMessage(CHAT, characterId, "user", "여드레 전", "2026-08-30 12:00:00");

  assert.deepEqual(missingDiaryDates(characterId, CHAT), [
    "2026-09-02",
    "2026-09-06",
  ]);
  assert.deepEqual(missingDiaryDates(characterId, CHAT, 8), [
    "2026-08-30",
    "2026-09-02",
    "2026-09-06",
  ]);
});

test("대화가 한 줄도 없는 대화방은 결번이 없다", () => {
  const quiet = createFixtureCharacter("chat-diary-quiet");
  assert.deepEqual(missingDiaryDates(quiet, "chat-diary-quiet"), []);
});
