// 유저 프로필을 프롬프트 한 덩이로 만드는 user-profile.ts를 검사한다 — 모델은 부르지 않는다.
//
// 나이대는 저장하지 않고 생년에서 계산하니 경계(열 살 미만·백스무 살 이상·끝자리 3과 4·6과 7)를
// 짚고, 성별·나이대는 환경변수가 저장값보다 먼저 온다는 규칙을 본다. 환경변수는 import 전에
// 빈 값으로 못 박아 저장값 경로를 기본으로 두고(dotenv는 이미 있는 키를 덮지 않는다), 환경변수가
// 이기는 경우는 config 값을 잠시 바꿔 본다. 상대를 부르는 법 블록은 아는 값이 있는 줄만 붙는지 본다.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";
// 성별·나이대 환경변수는 비워 둔다 — 로컬 .env에 값이 있어도 dotenv가 덮지 않으니 저장값 경로가 기본이 된다.
process.env.USER_GENDER = "";
process.env.USER_AGE_BAND = "";

// DB 경로와 환경변수를 정한 뒤에 읽어야 한다 — 정적 import는 이 줄들보다 먼저 돈다.
const { db } = await import("../src/db.js");
const { config } = await import("../src/config.js");
const { ageBandOf, effectiveProfile, renderUserBlock } =
  await import("../src/user-profile.js");

const putProfile = (
  chatId: string,
  p: { gender?: string; birthYear?: number; job?: string; region?: string },
): void => {
  db.prepare(
    `INSERT INTO user_profile (chat_id, gender, birth_year, job, region, updated_at)
     VALUES (?, ?, ?, ?, ?, '2026-09-06 10:00:00')`,
  ).run(
    chatId,
    p.gender ?? null,
    p.birthYear ?? null,
    p.job ?? null,
    p.region ?? null,
  );
};

const STORED = "chat-stored";
const JOB_ONLY = "chat-job";
putProfile(STORED, { gender: "여성", birthYear: 1994, job: "간호사", region: "부산" });
putProfile(JOB_ONLY, { job: "개발자" });

// 저장된 생년에서 오늘 기준으로 계산한 나이대. 해가 바뀌어도 테스트가 깨지지 않게 같은 함수로 만든다.
const storedBand = ageBandOf(1994);

after(() => {
  db.close();
});

test("생년이 없거나 나이가 열 살 미만이거나 백스무 살 이상이면 나이대를 만들지 않는다", () => {
  const now = new Date(2026, 0, 1);
  assert.equal(ageBandOf(undefined, now), undefined);
  assert.equal(ageBandOf(0, now), undefined);
  assert.equal(ageBandOf(2017, now), undefined);
  assert.equal(ageBandOf(2016, now), "10대 초반");
  assert.equal(ageBandOf(1907, now), "110대 후반");
  assert.equal(ageBandOf(1906, now), undefined);
});

test("나이 끝자리 0에서 3은 초반, 4에서 6은 중반, 7에서 9는 후반으로 나눈다", () => {
  const now = new Date(2026, 0, 1);
  assert.equal(ageBandOf(1996, now), "30대 초반");
  assert.equal(ageBandOf(1993, now), "30대 초반");
  assert.equal(ageBandOf(1992, now), "30대 중반");
  assert.equal(ageBandOf(1990, now), "30대 중반");
  assert.equal(ageBandOf(1989, now), "30대 후반");
  assert.equal(ageBandOf(1987, now), "30대 후반");
  assert.equal(ageBandOf(1986, now), "40대 초반");
});

test("저장된 프로필이 없으면 네 값이 모두 비어 있다", () => {
  const empty = {
    gender: undefined,
    ageBand: undefined,
    job: undefined,
    region: undefined,
  };
  assert.deepEqual(effectiveProfile(), empty);
  assert.deepEqual(effectiveProfile("chat-none"), empty);
});

test("저장된 프로필은 성별과 생년에서 계산한 나이대, 하는 일, 사는 곳으로 온다", () => {
  assert.notEqual(storedBand, undefined);
  assert.deepEqual(effectiveProfile(STORED), {
    gender: "여성",
    ageBand: storedBand,
    job: "간호사",
    region: "부산",
  });
  assert.deepEqual(effectiveProfile(JOB_ONLY), {
    gender: undefined,
    ageBand: undefined,
    job: "개발자",
    region: undefined,
  });
});

test("환경변수의 성별과 나이대가 저장값보다 먼저 오고 하는 일과 사는 곳은 저장값 그대로다", () => {
  const saved = { ...config.userProfile };
  config.userProfile.gender = "남성";
  config.userProfile.ageBand = "20대 후반";
  try {
    assert.deepEqual(effectiveProfile(STORED), {
      gender: "남성",
      ageBand: "20대 후반",
      job: "간호사",
      region: "부산",
    });
    assert.deepEqual(effectiveProfile(), {
      gender: "남성",
      ageBand: "20대 후반",
      job: undefined,
      region: undefined,
    });
  } finally {
    config.userProfile.gender = saved.gender;
    config.userProfile.ageBand = saved.ageBand;
  }
});

test("아는 값이 없으면 성별을 모른다는 줄과 고정 규칙 세 줄만 붙는다", () => {
  const lines = renderUserBlock("chat-none").split("\n");
  assert.equal(lines.length, 5);
  assert.equal(lines[0], "[상대를 부르는 법 — 절대 규칙]");
  assert.ok(lines[1]?.startsWith("- 상대의 성별을 아직 모른다."));
  assert.ok(lines[2]?.startsWith('- 상대를 "야"라고 부르지 않는다'));
  assert.ok(lines[3]?.startsWith("- 상대에게 특정 호칭을 시키지 않는다."));
  assert.ok(lines[4]?.startsWith("- 상대를 부르는 호칭·말투는 이미 대화에서 자리 잡은 것을"));
  assert.ok(!lines.some((l) => l.includes("상대에 대해 아는 것")));
  assert.deepEqual(renderUserBlock().split("\n"), lines);
});

test("아는 값이 있으면 아는 것 줄과 성별 전제 줄이 붙고 하는 일과 사는 곳은 참고 줄로 따로 붙는다", () => {
  const full = renderUserBlock(STORED).split("\n");
  assert.equal(full.length, 7);
  assert.equal(
    full[1],
    `- 상대에 대해 아는 것: 성별은 여성, 나이대는 ${storedBand}, 하는 일은 간호사, 사는 곳은 부산. 확정된 사실이니 다시 넘겨짚지 않는다.`,
  );
  assert.equal(
    full[2],
    "- 상대의 하는 일·사는 곳은 연락이 닿을 시간대나 거리 감각을 가늠할 때 참고한다. 아는 것을 굳이 꺼내 보이거나 다시 캐묻지 않는다.",
  );
  assert.ok(full[3]?.startsWith("- 상대의 성별이 여성임을 전제로 말한다."));

  const jobOnly = renderUserBlock(JOB_ONLY).split("\n");
  assert.equal(jobOnly.length, 7);
  assert.equal(
    jobOnly[1],
    "- 상대에 대해 아는 것: 하는 일은 개발자. 확정된 사실이니 다시 넘겨짚지 않는다.",
  );
  assert.ok(jobOnly[2]?.startsWith("- 상대의 하는 일은 연락이 닿을 시간대나"));
  assert.ok(jobOnly[3]?.startsWith("- 상대의 성별을 아직 모른다."));
});
