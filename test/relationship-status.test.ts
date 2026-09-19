// 관계 확인 도구(tools/relationship-status.ts)가 단계·처음·점수 위아래·오늘의 계획을 한 화면에 찍는지 검사한다 — 도구를 실제로 실행해서 본다.
//
// 도구가 파일 맨 아래에서 바로 도는 실행 스크립트라 가져다 쓸 수 없어, 자식 프로세스로 부른다.
// 값은 이 프로세스가 임시 DB에 심고 자식이 같은 DB를 읽는다. 모델도 슬랙도 부르지 않는다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "companion-test-"));
process.env.DB_PATH = join(dir, "test.db");
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

const {
  confirmFirst,
  insertFirst,
  raiseStage,
  saveReactionScore,
  saveRelationshipIntent,
} = await import("../src/db.js");
const { createFixtureCharacter } =
  await import("../src/eval/fixture-character.js");
const { kstLogicalDate, kstStamp, shiftDate } = await import("../src/kst.js");
const { FIRST_KIND_NAME } = await import("../src/labels.js");
const { dateLabel } = await import("../src/trace/format.js");

// DB_PATH는 늘 임시 경로로 덮어쓴다 — 비워 두면 도구가 기본값인 운영 DB를 연다.
const run = (dbPath: string): { status: number | null; stdout: string; stderr: string } => {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/tools/relationship-status.ts"],
    { cwd: root, encoding: "utf8", env: { ...process.env, DB_PATH: dbPath } },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

test("살아 있는 캐릭터가 없으면 그렇게 말하고 끝난다", () => {
  const r = run(join(dir, "empty.db"));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no active character/);
});

test("단계·다음 단계 조건·처음·점수 위아래·오늘의 계획을 한 화면에 찍는다", () => {
  const CHAT_ID = "1";
  const id = createFixtureCharacter(CHAT_ID);
  const today = kstLogicalDate();
  const now = kstStamp();
  raiseStage(id, 2, shiftDate(today, -3));

  const laugh = insertFirst({
    characterId: id,
    chatId: CHAT_ID,
    kind: "first_laugh",
    by: "character",
    happenedAt: "2026-09-10 21:03:00",
    messageId: 42,
  });
  assert.ok(laugh);
  confirmFirst(laugh);
  insertFirst({
    characterId: id,
    chatId: CHAT_ID,
    kind: "first_nickname",
    by: "user",
    happenedAt: "2026-09-11 22:00:00",
  });

  saveReactionScore(CHAT_ID, "remember", 0.8, 3, now);
  saveReactionScore(CHAT_ID, "nickname", 0.4, 5, now);
  saveReactionScore(CHAT_ID, "scene", 0.1, 1, now);
  saveReactionScore(CHAT_ID, "anticipate", 0, 2, now);
  saveReactionScore(CHAT_ID, "laugh", -0.3, 2, now);

  saveRelationshipIntent(
    id,
    today,
    {
      dig: "주말 등산",
      move: "remember",
      moveNote: "저녁에 지나가듯",
      basisJson: JSON.stringify({ dig: "어제 21:10 등산 얘기" }),
    },
    now,
  );

  const r = run(process.env.DB_PATH as string);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trimEnd().split("\n");
  const has = (line: string): void =>
    assert.ok(lines.includes(line), `찍혀야 한다: ${line}\n---\n${r.stdout}`);

  assert.match(lines[0] ?? "", new RegExp(`^관계 확인 · 캐릭터 #${id} · \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} 기준$`));
  has(`단계: 2단계 편해진 사이 · ${dateLabel(shiftDate(today, -3))}부터 · 머문 날 3일`);
  assert.ok(
    lines.some((l) => /^다음 단계: 3단계 마음을 드러내는 사이 · 오늘 새벽 정리 기준 (조건 다 찼음|아직)$/.test(l)),
    r.stdout,
  );
  assert.ok(lines.some((l) => l.startsWith("  - 체류 일수 3/")), r.stdout);
  has(`처음: 확정 1/${Object.keys(FIRST_KIND_NAME).length}`);
  has("  - 웃기기 · 캐릭터 · 09-10 21:03 · 메시지 #42");
  has("확인 전 1개");
  has("  - 별명 · 유저 · 09-11 22:00");
  has("반응 점수: 플러팅 5개");
  has(
    "  위: 기억해서 챙기기 0.80 (표본 3) · 별명 부르기 0.40 (표본 5) · 지금 보고 있는 장면 묘사 0.10 (표본 1)",
  );
  has("  아래: 웃기기 −0.30 (표본 2) · 다음 기대 만들기 0.00 (표본 2)");
  has(`오늘의 대화 계획 · ${dateLabel(today)}`);
  has("  더 물어볼 것: 주말 등산");
  has("    근거: 어제 21:10 등산 얘기");
  has("  시도할 플러팅: 기억해서 챙기기 저녁에 지나가듯");
});
