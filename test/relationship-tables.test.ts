// 관계를 쌓는 표 넷의 저장·조회 함수를 검사한다 — 모델은 부르지 않는다.
//
// 이 표들은 아직 읽는 코드가 없어서, 값이 잘못 들어가도 대화가 이상해지는 것으로는 드러나지
// 않는다. 한 번만 일어나는 일을 두 번 넣으려 할 때 조용히 버리는지, 반응 점수와 오늘의 의도가
// 같은 키로 다시 들어올 때 덮어쓰는지, 보관 기간이 지난 의도만 지우는지, 신호를 두 시각
// 사이에서만 꺼내는지를 여기서 잡는다.
//
// DB는 임시 파일로 새로 만들고 캐릭터는 평가용 고정 캐릭터로 세운다.
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

// DB 경로를 정한 뒤에 읽어야 임시 파일로 열린다 — 정적 import는 이 줄들보다 먼저 돈다.
const {
  db,
  insertFirst,
  getConfirmedFirsts,
  getUnconfirmedFirsts,
  hasFirst,
  confirmFirst,
  deleteUnconfirmedFirst,
  getReactionScores,
  saveReactionScore,
  getRelationshipIntent,
  saveRelationshipIntent,
  pruneRelationshipIntents,
  insertRelationshipSignal,
  getRelationshipSignals,
  getStage,
  raiseStage,
} = await import("../src/db.js");
const { createFixtureCharacter } =
  await import("../src/eval/fixture-character.js");
const { kstDateString, getKstNow } = await import("../src/kst.js");

const CHAT = "chat-rel";
const OTHER = "chat-rel-2";
const charId = createFixtureCharacter(CHAT);
const otherId = createFixtureCharacter(OTHER);

after(() => {
  db.close();
});

test("캐릭터를 만들면 단계 1과 시작일이 함께 들어간다", () => {
  const stage = getStage(charId);
  assert.ok(stage);
  assert.equal(stage.stage_no, 1);
  assert.match(stage.stage_since, /^\d{4}-\d{2}-\d{2}$/);
});

test("단계는 올라가기만 하고 같거나 낮은 값은 시작일도 안 건드린다", () => {
  assert.equal(raiseStage(charId, 2, "2026-09-10"), true);
  assert.deepEqual(getStage(charId), {
    stage_no: 2,
    stage_since: "2026-09-10",
  });
  assert.equal(raiseStage(charId, 2, "2026-09-11"), false);
  assert.equal(raiseStage(charId, 1, "2026-09-11"), false);
  assert.deepEqual(getStage(charId), {
    stage_no: 2,
    stage_since: "2026-09-10",
  });
  // 다른 캐릭터의 단계는 그대로다
  assert.equal(getStage(otherId)?.stage_no, 1);
});

test("처음은 종류마다 한 번만 들어가고 두 번째는 조용히 버린다", () => {
  const id = insertFirst({
    characterId: charId,
    chatId: CHAT,
    kind: "first_laugh",
    by: "character",
    happenedAt: "2026-09-10 21:00:00",
    messageId: 12,
  });
  assert.ok(id);
  assert.equal(hasFirst(charId, "first_laugh"), true);
  assert.equal(hasFirst(charId, "first_nickname"), false);
  // 다른 캐릭터는 같은 종류를 따로 가진다
  assert.equal(hasFirst(otherId, "first_laugh"), false);

  assert.equal(
    insertFirst({
      characterId: charId,
      chatId: CHAT,
      kind: "first_laugh",
      by: "user",
      happenedAt: "2026-09-11 09:00:00",
    }),
    undefined,
  );
  assert.equal(getUnconfirmedFirsts(charId).length, 1);
  assert.equal(getUnconfirmedFirsts(charId)[0]?.by, "character");
});

test("정해진 값 밖의 종류와 확정 표시는 막힌다", () => {
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO firsts (character_id, chat_id, kind, by, happened_at)
         VALUES (?, ?, 'first_hug', 'user', '2026-09-10 21:00:00')`,
      )
      .run(charId, CHAT),
  );
  assert.throws(() =>
    db
      .prepare(`UPDATE firsts SET confirmed = 2 WHERE character_id = ?`)
      .run(charId),
  );
});

test("확정한 처음만 프롬프트 쪽으로 나오고 오래된 것부터 준다", () => {
  insertFirst({
    characterId: charId,
    chatId: CHAT,
    kind: "first_nickname",
    by: "character",
    happenedAt: "2026-09-09 20:00:00",
  });
  assert.deepEqual(getConfirmedFirsts(charId), []);

  for (const row of getUnconfirmedFirsts(charId)) confirmFirst(row.id);
  assert.deepEqual(
    getConfirmedFirsts(charId).map((r) => r.kind),
    ["first_nickname", "first_laugh"],
  );
  assert.deepEqual(getUnconfirmedFirsts(charId), []);
});

test("확정한 처음은 지워지지 않고 미확정만 지워진다", () => {
  const confirmed = getConfirmedFirsts(charId)[0];
  assert.ok(confirmed);
  deleteUnconfirmedFirst(confirmed.id);
  assert.equal(getConfirmedFirsts(charId).length, 2);

  const id = insertFirst({
    characterId: charId,
    chatId: CHAT,
    kind: "first_tease",
    by: "user",
    happenedAt: "2026-09-11 22:00:00",
  });
  assert.ok(id);
  deleteUnconfirmedFirst(id);
  assert.equal(hasFirst(charId, "first_tease"), false);
});

test("반응 점수는 대화방과 수가 키라 다시 저장하면 덮어쓴다", () => {
  saveReactionScore(CHAT, "laugh", 0.4, 5, "2026-09-10");
  saveReactionScore(CHAT, "remember", 0.9, 3, "2026-09-10");
  saveReactionScore(OTHER, "laugh", -0.2, 2, "2026-09-10");

  saveReactionScore(CHAT, "laugh", 0.7, 8, "2026-09-11");
  assert.deepEqual(
    getReactionScores(CHAT).map((r) => [r.move, r.score, r.sample_count]),
    [
      ["remember", 0.9, 3],
      ["laugh", 0.7, 8],
    ],
  );
  // 대화방이 다르면 따로 쌓인다
  assert.deepEqual(
    getReactionScores(OTHER).map((r) => [r.move, r.score]),
    [["laugh", -0.2]],
  );
});

test("점수가 -1~1 밖이거나 없는 수면 막힌다", () => {
  assert.throws(() =>
    saveReactionScore(CHAT, "laugh", 1.4, 1, "2026-09-11"),
  );
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO reaction_scores (chat_id, move, score, sample_count, updated_at)
         VALUES (?, 'wink', 0, 0, '2026-09-11 05:40:00')`,
      )
      .run(CHAT),
  );
});

test("오늘의 의도는 하루 한 행이고 다시 부르면 통째로 덮어쓴다", () => {
  saveRelationshipIntent(
    charId,
    "2026-09-11",
    {
      dig: "요즘 뭐에 지쳤는지",
      share: "어제 늦게까지 본 영화",
      move: "remember",
      moveNote: "지난주에 말한 시험 얘기를 먼저 묻는다",
      leadTone: "silent_care",
      thread: "이사 준비",
      basisJson: JSON.stringify({ dig: "어제 대화" }),
    },
    "2026-09-11",
  );
  const first = getRelationshipIntent(charId, "2026-09-11");
  assert.equal(first?.dig, "요즘 뭐에 지쳤는지");
  assert.equal(first?.move, "remember");
  assert.equal(first?.lead_tone, "silent_care");

  // 새벽 정리를 다시 돌린 경우 — 앞 값이 남지 않아야 한다
  saveRelationshipIntent(
    charId,
    "2026-09-11",
    { dig: "주말 계획" },
    "2026-09-11 06:10:00",
  );
  const again = getRelationshipIntent(charId, "2026-09-11");
  assert.equal(again?.id, first?.id);
  assert.equal(again?.dig, "주말 계획");
  assert.equal(again?.share, null);
  assert.equal(again?.move, null);
  assert.equal(again?.lead_tone, null);
  assert.equal(again?.created_at, "2026-09-11 06:10:00");

  assert.equal(getRelationshipIntent(charId, "2026-09-12"), undefined);
  assert.equal(getRelationshipIntent(otherId, "2026-09-11"), undefined);
});

test("보관 기간이 지난 의도만 지운다", () => {
  const dayBefore = (n: number): string =>
    kstDateString(new Date(getKstNow().getTime() - n * 86400000));
  saveRelationshipIntent(
    charId,
    dayBefore(40),
    { dig: "오래된 것" },
    "2026-08-01 05:40:00",
  );
  saveRelationshipIntent(
    charId,
    dayBefore(10),
    { dig: "아직 볼 것" },
    "2026-08-30 05:40:00",
  );
  assert.equal(pruneRelationshipIntents(), 1);
  assert.equal(getRelationshipIntent(charId, dayBefore(40)), undefined);
  assert.ok(getRelationshipIntent(charId, dayBefore(10)));
  assert.equal(pruneRelationshipIntents(), 0);
});

test("열림 신호는 창 안의 것만 오래된 것부터 준다", () => {
  const at = (t: string): number =>
    insertRelationshipSignal({
      characterId: charId,
      chatId: CHAT,
      at: t,
      openedSelf: true,
      askedAboutChar: false,
      saidAffection: false,
    });
  at("2026-09-10 23:50:00");
  at("2026-09-11 09:00:00");
  at("2026-09-11 21:30:00");
  at("2026-09-12 05:00:00");
  insertRelationshipSignal({
    characterId: otherId,
    chatId: OTHER,
    at: "2026-09-11 12:00:00",
    openedSelf: false,
    askedAboutChar: true,
    saidAffection: false,
  });

  // 논리일 창은 시작을 포함하고 끝을 뺀다
  assert.deepEqual(
    getRelationshipSignals(charId, "2026-09-11 05:00:00", "2026-09-12 05:00:00")
      .map((r) => r.at),
    ["2026-09-11 09:00:00", "2026-09-11 21:30:00"],
  );
  assert.equal(
    getRelationshipSignals(charId, "2026-09-13 05:00:00", "2026-09-14 05:00:00")
      .length,
    0,
  );
});

test("신호의 참거짓 셋은 0과 1로 저장되고 직전 수와 반응은 비워 둘 수 있다", () => {
  const id = insertRelationshipSignal({
    characterId: charId,
    chatId: CHAT,
    at: "2026-09-13 20:00:00",
    openedSelf: false,
    askedAboutChar: true,
    saidAffection: true,
    messageId: 88,
    prevMove: "nickname",
    moveReaction: "accepted",
    callId: 7,
  });
  const row = getRelationshipSignals(
    charId,
    "2026-09-13 05:00:00",
    "2026-09-14 05:00:00",
  )[0];
  assert.equal(row?.id, id);
  assert.equal(row?.opened_self, 0);
  assert.equal(row?.asked_about_char, 1);
  assert.equal(row?.said_affection, 1);
  assert.equal(row?.message_id, 88);
  assert.equal(row?.prev_move, "nickname");
  assert.equal(row?.move_reaction, "accepted");
  assert.equal(row?.call_id, 7);

  const bare = getRelationshipSignals(
    charId,
    "2026-09-11 05:00:00",
    "2026-09-12 05:00:00",
  )[0];
  assert.equal(bare?.prev_move, null);
  assert.equal(bare?.move_reaction, null);
  assert.equal(bare?.message_id, null);
});
