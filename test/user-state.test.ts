// 상대의 지금 상태를 판정하는 user-state.ts의 순수 부분을 검사한다 — 모델은 부르지 않는다.
//
// 판정 호출에 넣는 대화 모양, 모델 답을 판정으로 읽는 규칙(깨진 형식·정해진 값 밖·since 되돌리기),
// 프롬프트와 트레이스가 함께 쓰는 한 줄 표기를 본다. 직전에 쓴 플러팅은 판정할 상대 말 바로 앞
// 캐릭터 말들에서 대화 기록을 읽어 모두 모으는지 본다. 판정 자체(judgeUserState)는 최근 대화에
// 유저 말이 없으면 호출 없이 그대로라고 답하는 경계만 본다.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "user-state-")), "t.db");
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

const { db, getRecentMessages, logMessage } = await import("../src/db.js");
const { createFixtureCharacter } = await import("../src/eval/fixture-character.js");
const {
  judgeUserState,
  parseUserStateVerdict,
  pendingCharRun,
  pendingMoves,
  pendingMovesBlock,
  readOpenSignals,
  userStateLabel,
  userStateTranscript,
} = await import("../src/user-state.js");
type MessageRow = import("../src/db.js").MessageRow;
type Move = import("../src/labels.js").Move;

const row = (
  id: number,
  role: "user" | "assistant",
  text: string,
  sent_at: string,
): MessageRow => ({ id, role, text, sent_at });

const ROWS: MessageRow[] = [
  row(1, "assistant", "통화 끝나고 연락할게", "2026-09-06 20:10:00"),
  row(2, "user", "왜 연락 안 했어", "2026-09-06 21:30:00"),
  row(3, "assistant", "미안 진짜", "2026-09-06 21:31:00"),
  row(4, "user", "됐어", "2026-09-07 00:20:00"),
];

after(() => {
  db.close();
});

test("대화는 시각과 누구 말인지로 적고 논리일이 바뀌는 줄에만 날짜를 붙인다", () => {
  assert.equal(userStateTranscript([]), "(없음)");
  // 00:20은 논리일로 9/6이라 마지막 줄과 같은 날이고 날짜를 붙이지 않는다
  assert.equal(
    userStateTranscript(ROWS),
    [
      "[20:10] 캐릭터: 통화 끝나고 연락할게",
      "[21:30] 상대: 왜 연락 안 했어",
      "[21:31] 캐릭터: 미안 진짜",
      "[00:20] 상대: 됐어",
    ].join("\n"),
  );
  const nextDay = [...ROWS, row(5, "user", "어제 일은 잊자", "2026-09-07 09:00:00")];
  assert.ok(userStateTranscript(nextDay).startsWith("[9/6 20:10] 캐릭터:"));
  assert.ok(userStateTranscript(nextDay).endsWith("[09:00] 상대: 어제 일은 잊자"));
});

test("대화는 플러팅을 쓴 캐릭터 말에만 플러팅 이름을 붙인다", () => {
  // 상대 말 번호에 걸린 플러팅은 무시한다
  const flirts = new Map<number, Move>([
    [3, "remember"],
    [2, "laugh"],
  ]);
  assert.equal(
    userStateTranscript(ROWS, flirts),
    [
      "[20:10] 캐릭터: 통화 끝나고 연락할게",
      "[21:30] 상대: 왜 연락 안 했어",
      "[21:31] 캐릭터(플러팅: 기억해서 챙기기): 미안 진짜",
      "[00:20] 상대: 됐어",
    ].join("\n"),
  );
});

test("판정할 상대 말 바로 앞 캐릭터 말들은 그 앞 상대 말 뒤부터 끝에 이어진 상대 말 앞까지다", () => {
  const rows = [
    row(1, "assistant", "a", "2026-09-08 12:00:00"),
    row(2, "user", "b", "2026-09-08 12:01:00"),
    row(3, "assistant", "c", "2026-09-08 12:02:00"),
    row(4, "assistant", "d", "2026-09-08 12:03:00"),
    row(5, "user", "e", "2026-09-08 12:04:00"),
    row(6, "user", "f", "2026-09-08 12:05:00"),
  ];
  assert.deepEqual(pendingCharRun(rows).map((r) => r.id), [3, 4]);
  // 앞선 상대 말이 창 밖이면 창의 첫 줄부터다
  assert.deepEqual(pendingCharRun(rows.slice(2)).map((r) => r.id), [3, 4]);
  // 끝줄이 캐릭터 말이면 판정할 상대 말이 없다
  assert.deepEqual(pendingCharRun(rows.slice(0, 4)), []);
  // 상대 말만 이어졌으면 없다
  assert.deepEqual(pendingCharRun([rows[1]!, rows[4]!]), []);
  assert.deepEqual(pendingCharRun([]), []);
});

test("직전에 쓴 플러팅은 판정할 상대 말 바로 앞 캐릭터 말들에서 모두 읽는다", () => {
  const chat = "chat-flirt";
  const characterId = createFixtureCharacter(chat);
  const log = (
    role: "user" | "assistant",
    text: string,
    at: string,
    meta?: Record<string, unknown>,
  ) => logMessage(chat, characterId, role, text, at, meta);
  // 앞선 상대 말보다 먼저 쓴 플러팅은 그 상대 말이 이미 받았다
  log("assistant", "그 카페 또 갔어?", "2026-09-08 12:00:00", { move: "laugh" });
  log("user", "응 갔지", "2026-09-08 12:05:00");
  const remember = log("assistant", "저번에 말한 면접 어떻게 됐어", "2026-09-08 12:06:00", {
    move: "remember",
  });
  // 플러팅 뒤에 말이 한 번 더 나가도 앞 플러팅을 놓치지 않는다
  log("assistant", "나 회의 들어가", "2026-09-08 12:10:00", { kind: "presence", proactive: true });
  const laugh = log("assistant", "끝나고 웃긴 얘기 해줄게", "2026-09-08 12:11:00", {
    move: "laugh",
  });
  log("assistant", "목록에 없는 코드", "2026-09-08 12:12:00", { move: "hug" });
  log("user", "붙었어", "2026-09-08 12:30:00");

  const rows = getRecentMessages(chat, characterId, 24);
  const moves = pendingMoves(chat, characterId, rows);
  assert.deepEqual(moves, [
    { id: remember, sentAt: "2026-09-08 12:06:00", move: "remember" },
    { id: laugh, sentAt: "2026-09-08 12:11:00", move: "laugh" },
  ]);
  assert.equal(pendingMovesBlock(moves, rows), "[12:06] 기억해서 챙기기\n[12:11] 웃기기");
  const transcript = userStateTranscript(rows, new Map(moves.map((m) => [m.id, m.move])));
  assert.ok(transcript.includes("[12:06] 캐릭터(플러팅: 기억해서 챙기기): 저번에 말한"));
  assert.ok(transcript.includes("[12:11] 캐릭터(플러팅: 웃기기): 끝나고"));
  assert.ok(transcript.includes("[12:00] 캐릭터: 그 카페"));

  // 판정 창 안에서만 찾는다
  assert.deepEqual(
    pendingMoves(chat, characterId, getRecentMessages(chat, characterId, 3)).map((m) => m.move),
    ["laugh"],
  );
  // 끝줄이 캐릭터 말이면 판정할 상대 말이 없어 플러팅도 없다
  log("assistant", "축하해", "2026-09-08 12:31:00");
  const later = getRecentMessages(chat, characterId, 24);
  assert.deepEqual(pendingMoves(chat, characterId, later), []);
  assert.equal(pendingMovesBlock([], later), "(없음)");
});

test("플러팅 목록은 마지막 대화와 다른 날이면 날짜를 붙인다", () => {
  const nextDay = [...ROWS, row(5, "user", "어제 일은 잊자", "2026-09-07 09:00:00")];
  assert.equal(
    pendingMovesBlock([{ id: 3, sentAt: "2026-09-06 21:31:00", move: "remember" }], nextDay),
    "[9/6 21:31] 기억해서 챙기기",
  );
});

test("모델 답은 정해진 값 안에서만 판정으로 읽고 since는 대화의 시각으로 되돌린다", () => {
  assert.deepEqual(
    parseUserStateVerdict(
      '```json\n{"changed":true,"state":"연락 약속을 안 지켜 서운함","cause":"char","tone":"bad","since":"21:30"}\n```',
      ROWS,
    ),
    {
      changed: true,
      state: {
        state: "연락 약속을 안 지켜 서운함",
        cause: "char",
        tone: "bad",
        since: "2026-09-06 21:30:00",
      },
    },
  );
  // 자정 뒤 표기도 그 줄의 시각으로 돌아간다
  assert.equal(
    parseUserStateVerdict(
      '{"changed":true,"state":"아직 서운함","cause":"char","tone":"bad","since":"24:20"}',
      ROWS,
    )?.state?.since,
    "2026-09-07 00:20:00",
  );
  // 대화에 없는 시각은 마지막 줄의 날짜에 붙이고, since가 없으면 마지막 줄의 시각이다
  assert.equal(
    parseUserStateVerdict(
      '{"changed":true,"state":"조금 풀림","cause":"char","tone":"neutral","since":"22:00"}',
      ROWS,
    )?.state?.since,
    "2026-09-07 22:00:00",
  );
  assert.equal(
    parseUserStateVerdict(
      '{"changed":true,"state":"조금 풀림","cause":"char","tone":"neutral"}',
      ROWS,
    )?.state?.since,
    "2026-09-07 00:20:00",
  );
  assert.deepEqual(parseUserStateVerdict('{"changed":false}', ROWS), {
    changed: false,
    state: null,
  });
  assert.deepEqual(parseUserStateVerdict('설명을 덧붙이면 {"changed":false} 이렇게', ROWS), {
    changed: false,
    state: null,
  });
  // 정해진 값 밖이거나 상태 글이 비면 형식이 깨진 것이다
  assert.equal(
    parseUserStateVerdict('{"changed":true,"state":"화남","cause":"self","tone":"bad"}', ROWS),
    null,
  );
  assert.equal(
    parseUserStateVerdict('{"changed":true,"state":"화남","cause":"char","tone":"angry"}', ROWS),
    null,
  );
  assert.equal(
    parseUserStateVerdict('{"changed":true,"state":" ","cause":"char","tone":"bad"}', ROWS),
    null,
  );
  assert.equal(parseUserStateVerdict("그냥 글", ROWS), null);
  assert.equal(parseUserStateVerdict("{깨진 json", ROWS), null);
});

test("한 줄 표기는 상태 글에 시작 시각·원인·결을 괄호로 붙이고 다른 날이면 날짜를 앞세운다", () => {
  const rel = {
    user_state: "연락 약속을 안 지켜 서운함",
    user_state_cause: "char" as const,
    user_state_tone: "bad" as const,
    user_state_since: "2026-09-06 21:30:00",
  };
  assert.equal(
    userStateLabel(rel, "2026-09-06"),
    "연락 약속을 안 지켜 서운함 (21:30부터 · 나 때문 · 안 좋음)",
  );
  assert.equal(
    userStateLabel(rel, "2026-09-07"),
    "연락 약속을 안 지켜 서운함 (9/6 21:30부터 · 나 때문 · 안 좋음)",
  );
  assert.equal(
    userStateLabel({ ...rel, user_state_cause: "other", user_state_tone: "good" }, "2026-09-06"),
    "연락 약속을 안 지켜 서운함 (21:30부터 · 상대의 다른 일 · 좋음)",
  );
  assert.equal(userStateLabel({ ...rel, user_state: null }, "2026-09-06"), null);
  assert.equal(
    userStateLabel(
      { ...rel, user_state_cause: null, user_state_tone: null, user_state_since: null },
      "2026-09-06",
    ),
    "연락 약속을 안 지켜 서운함",
  );
});

test("열림 4항목은 예/아니오 셋이 다 있을 때만 읽고 직전 플러팅이 없으면 반응은 늘 none, 있으면 none을 받지 않는다", () => {
  const full =
    '{"changed":false,"opened_self":true,"asked_about_char":false,"said_affection":"true","move_reaction":"ignored"}';
  assert.deepEqual(readOpenSignals(full, "nickname"), {
    openedSelf: true,
    askedAboutChar: false,
    saidAffection: true,
    prevMove: "nickname",
    moveReaction: "ignored",
  });
  // 직전 플러팅이 없으면 모델이 뭐라고 적었든 none이다
  assert.deepEqual(readOpenSignals(full, null), {
    openedSelf: true,
    askedAboutChar: false,
    saidAffection: true,
    prevMove: null,
    moveReaction: "none",
  });
  // 상태 판정 모양만 있고 열림 칸이 없으면 null — 상태 판정은 그대로 읽힌다
  const stateOnly = '{"changed":false}';
  assert.equal(readOpenSignals(stateOnly, null), null);
  assert.deepEqual(parseUserStateVerdict(stateOnly, ROWS), { changed: false, state: null });
  // 셋 가운데 하나라도 빠지면 null
  assert.equal(
    readOpenSignals('{"changed":false,"opened_self":true,"asked_about_char":false}', null),
    null,
  );
  // 직전 플러팅이 있는데 반응이 목록 밖이면 null
  assert.equal(
    readOpenSignals(
      '{"changed":false,"opened_self":false,"asked_about_char":false,"said_affection":false,"move_reaction":"maybe"}',
      "nickname",
    ),
    null,
  );
  // 직전 플러팅이 있는데 반응을 none으로 적었으면 null — 플러팅을 쓴 턴을 해당 없음으로 남기지 않는다
  assert.equal(
    readOpenSignals(
      '{"changed":false,"opened_self":false,"asked_about_char":false,"said_affection":false,"move_reaction":"none"}',
      "remember",
    ),
    null,
  );
  assert.equal(readOpenSignals("답할 수 없다", null), null);
});

test("최근 대화에 유저 말이 없으면 판정 호출 없이 그대로라고 답한다", async () => {
  const characterId = createFixtureCharacter("chat-state");
  logMessage("chat-state", characterId, "assistant", "잘 자", "2026-09-06 23:00:00", {
    kind: "goodnight",
    proactive: true,
  });
  assert.deepEqual(await judgeUserState(characterId, "chat-state"), {
    changed: false,
    state: null,
    failed: false,
    callId: null,
    prev: null,
  });
  assert.deepEqual(await judgeUserState(characterId, "chat-nobody"), {
    changed: false,
    state: null,
    failed: false,
    callId: null,
    prev: null,
  });
});
