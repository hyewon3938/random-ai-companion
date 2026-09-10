// 상대의 지금 상태를 판정하는 user-state.ts의 순수 부분을 검사한다 — 모델은 부르지 않는다.
//
// 판정 호출에 넣는 대화 모양, 모델 답을 판정으로 읽는 규칙(깨진 형식·정해진 값 밖·since 되돌리기),
// 프롬프트와 트레이스가 함께 쓰는 한 줄 표기를 본다. 판정 자체(judgeUserState)는 최근 대화에
// 유저 말이 없으면 호출 없이 그대로라고 답하는 경계만 본다.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "user-state-")), "t.db");
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

const { db, logMessage } = await import("../src/db.js");
const { createFixtureCharacter } = await import("../src/eval/fixture-character.js");
const {
  judgeUserState,
  parseUserStateVerdict,
  readOpenSignals,
  userStateLabel,
  userStateTranscript,
} = await import("../src/user-state.js");
type MessageRow = import("../src/db.js").MessageRow;

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

test("열림 4항목은 예/아니오 셋이 다 있을 때만 읽고 직전 플러팅이 없으면 반응은 늘 none이다", () => {
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
