// 캐릭터의 마음 판정을 읽고 저장하고 슬랙 줄로 옮기는 자리를 검사한다 — 모델은 부르지 않는다(#473).
//
// 판정 답의 마음 칸 넷을 상대 상태 칸과 따로 읽는지, 판정 입력 블록 넷(성격·단계·직전 마음·지금
// 시각)이 저장된 값을 옮기는지, applyMind가 종류·세기가 같으면 안 쓰고 종류가 바뀐 턴에만 생긴
// 시각을 새로 적는지, 슬랙 답장 게시의 캐릭터 마음 줄이 판정 실패·바뀜·그대로를 가르는지 본다.
// 평가용 고정 캐릭터를 임시 DB에 만든다.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { LlmCallRow } from "../src/db.js";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "character-mind-")),
  "t.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

const { db, getRelationship, setMind } = await import("../src/db.js");
const { createFixtureCharacter } =
  await import("../src/eval/fixture-character.js");
const { flawValue, wantedWayValue } = await import("../src/character.js");
const { nowBlock, personalityBlock, prevMindBlock, readMind, stageBlock } =
  await import("../src/user-state.js");
const { applyMind } = await import("../src/relationship-update.js");
const { mindTrace } = await import("../src/reply-compose.js");
const { renderReply } = await import("../src/trace/reply-render.js");

const CHAT = "chat-mind";
let characterId = 0;

before(() => {
  characterId = createFixtureCharacter(CHAT);
});
after(() => {
  db.close();
});

const mindCols = (): Record<string, unknown> =>
  db
    .prepare(
      `SELECT mind_kind, mind_level, mind_reason, mind_since
         FROM relationships WHERE character_id = ?`,
    )
    .get(characterId) as Record<string, unknown>;

describe("readMind", () => {
  const base = { changed: false, state: null };
  const raw = (mind: Record<string, unknown>): string =>
    JSON.stringify({ ...base, ...mind });

  it("평소(none)는 세기와 이유를 보지 않고 null로 둔다", () => {
    assert.deepEqual(
      readMind(
        raw({ mind_changed: true, mind: "none", mind_level: 0, mind_reason: "" }),
      ),
      { changed: true, kind: null, level: null, reason: null },
    );
    assert.deepEqual(readMind(raw({ mind_changed: false, mind: "none" })), {
      changed: false,
      kind: null,
      level: null,
      reason: null,
    });
  });

  it("목록 안의 마음은 세기 1~3과 이유가 있어야 읽고, 숫자 글자 세기도 받는다", () => {
    assert.deepEqual(
      readMind(
        raw({
          mind_changed: true,
          mind: "jealous",
          mind_level: 2,
          mind_reason: " 동기랑 둘이 밥 먹었다고 했다 ",
        }),
      ),
      {
        changed: true,
        kind: "jealous",
        level: 2,
        reason: "동기랑 둘이 밥 먹었다고 했다",
      },
    );
    assert.equal(
      readMind(
        raw({
          mind_changed: true,
          mind: "flutter",
          mind_level: "3",
          mind_reason: "보고 싶었다고 했다",
        }),
      )?.level,
      3,
    );
  });

  it("칸이 깨지면 null — 그 턴은 마음만 판정 실패로 둔다", () => {
    const ok = { mind_changed: true, mind: "hurt", mind_level: 1, mind_reason: "답이 짧았다" };
    assert.ok(readMind(raw(ok)));
    assert.equal(readMind(raw({ ...ok, mind: "angry" })), null);
    assert.equal(readMind(raw({ ...ok, mind: "constructor" })), null);
    assert.equal(readMind(raw({ ...ok, mind_level: 0 })), null);
    assert.equal(readMind(raw({ ...ok, mind_level: 4 })), null);
    assert.equal(readMind(raw({ ...ok, mind_level: "많이" })), null);
    assert.equal(readMind(raw({ ...ok, mind_reason: "  " })), null);
    const { mind_changed: _drop, ...noFlag } = ok;
    assert.equal(readMind(raw(noFlag)), null);
    assert.equal(readMind("판정 못 함"), null);
  });
});

describe("판정 입력 블록", () => {
  it("[캐릭터 성격]은 원하는 방식·결점·애착 성향 세 줄이다", () => {
    assert.equal(
      personalityBlock(characterId),
      [
        `- 원하는 방식: ${wantedWayValue("silent_care")}`,
        `- 결점: ${flawValue("clumsy")}`,
        "- 애착 성향: 답이 늦어도 재촉하지 않고 기다린다. 서운하면 말수가 줄고, 며칠 지나 담백하게 한 번 꺼낸다",
      ].join("\n"),
    );
    assert.equal(personalityBlock(characterId + 999), "(없음)");
  });

  it("[관계 단계]는 번호와 이름, 없거나 목록 밖이면 (없음)", () => {
    assert.match(stageBlock(3), /^3단계 · \S/);
    assert.equal(stageBlock(undefined), "(없음)");
    assert.equal(stageBlock(7), "(없음)");
  });

  it("[직전 마음]은 종류·세기·생긴 시각과 지난 시간·이유를 한 줄로 적는다", () => {
    const rel = getRelationship(characterId);
    assert.ok(rel);
    assert.equal(prevMindBlock(rel, "2026-09-20 19:05:00"), "(없음)");
    assert.equal(prevMindBlock(undefined, "2026-09-20 19:05:00"), "(없음)");
    const hurt = {
      ...rel,
      mind_kind: "hurt",
      mind_level: 2,
      mind_reason: "주말 약속을 까먹었다",
      mind_since: "2026-09-20 16:40:00",
    };
    assert.equal(
      prevMindBlock(hurt, "2026-09-20 19:05:00"),
      "서운함, 세기 2/3 · 16:40부터(2시간 25분 지남) · 이유: 주말 약속을 까먹었다",
    );
    // 논리일이 바뀐 뒤에는 날짜를 붙이고, 방금이면 지난 시간을 뺀다
    assert.equal(
      prevMindBlock({ ...hurt, mind_reason: null }, "2026-09-21 09:00:00"),
      "서운함, 세기 2/3 · 9/20 16:40부터(16시간 20분 지남)",
    );
    assert.equal(
      prevMindBlock(hurt, "2026-09-20 16:40:10"),
      "서운함, 세기 2/3 · 16:40부터 · 이유: 주말 약속을 까먹었다",
    );
  });

  it("[지금 시각]은 논리일 M/D와 대화와 같은 시계 표기다", () => {
    assert.equal(nowBlock("2026-09-20 19:05:00"), "9/20 19:05");
    // 새벽 1시는 앞 논리일에 속한다 — 날짜는 앞날, 시계는 대화 줄처럼 01:10이다
    assert.equal(nowBlock("2026-09-21 01:10:00"), "9/20 01:10");
  });
});

describe("applyMind", () => {
  const T1 = "2026-09-20 16:40:00";
  const T2 = "2026-09-20 18:00:00";
  const T3 = "2026-09-20 19:30:00";

  it("판정이 없거나 그대로라고 했으면 쓰지 않는다", () => {
    setMind(characterId, null);
    assert.deepEqual(applyMind(characterId, undefined, T1), []);
    assert.deepEqual(
      applyMind(
        characterId,
        { changed: false, kind: "hurt", level: 2, reason: "답이 짧았다" },
        T1,
      ),
      [],
    );
    assert.equal(mindCols().mind_kind, null);
    // 없던 마음에 평소가 와도 쓸 것이 없다
    assert.deepEqual(
      applyMind(
        characterId,
        { changed: true, kind: null, level: null, reason: null },
        T1,
      ),
      [],
    );
  });

  it("새 마음은 생긴 시각을 지금으로 적고, 세기만 바뀌면 생긴 시각을 둔다", () => {
    setMind(characterId, null);
    assert.deepEqual(
      applyMind(
        characterId,
        { changed: true, kind: "hurt", level: 1, reason: "답이 짧았다" },
        T1,
      ),
      [{ field: "캐릭터 마음", from: null, to: "서운함 1" }],
    );
    assert.deepEqual(mindCols(), {
      mind_kind: "hurt",
      mind_level: 1,
      mind_reason: "답이 짧았다",
      mind_since: T1,
    });
    assert.deepEqual(
      applyMind(
        characterId,
        {
          changed: true,
          kind: "hurt",
          level: 2,
          reason: "약속을 다른 사람과 잡았다",
        },
        T2,
      ),
      [{ field: "캐릭터 마음", from: "서운함 1", to: "서운함 2" }],
    );
    assert.deepEqual(mindCols(), {
      mind_kind: "hurt",
      mind_level: 2,
      mind_reason: "약속을 다른 사람과 잡았다",
      mind_since: T1,
    });
  });

  it("종류와 세기가 같으면 바뀌었다고 해도 이유까지 그대로 둔다", () => {
    assert.deepEqual(
      applyMind(
        characterId,
        { changed: true, kind: "hurt", level: 2, reason: "다른 이유" },
        T3,
      ),
      [],
    );
    assert.equal(mindCols().mind_reason, "약속을 다른 사람과 잡았다");
  });

  it("종류가 바뀌면 생긴 시각을 새로 적고, 평소가 오면 네 칸을 비운다", () => {
    assert.deepEqual(
      applyMind(
        characterId,
        { changed: true, kind: "jealous", level: 2, reason: "동기 얘기를 오래 했다" },
        T3,
      ),
      [{ field: "캐릭터 마음", from: "서운함 2", to: "질투 2" }],
    );
    assert.equal(mindCols().mind_since, T3);
    assert.deepEqual(
      applyMind(
        characterId,
        { changed: true, kind: null, level: null, reason: null },
        T3,
      ),
      [{ field: "캐릭터 마음", from: "질투 2", to: "없음" }],
    );
    assert.deepEqual(mindCols(), {
      mind_kind: null,
      mind_level: null,
      mind_reason: null,
      mind_since: null,
    });
  });
});

describe("mindTrace", () => {
  const rel = {
    mind_kind: "flutter",
    mind_level: 1,
    mind_reason: "보고 싶었다고 했다",
    mind_since: "2026-09-20 21:00:00",
  };

  it("실제로 바꿔 적은 턴만 바뀜이고 그때 직전 값과 이유를 남긴다", () => {
    assert.deepEqual(
      mindTrace(rel, [{ field: "캐릭터 마음", from: null, to: "설렘 1" }], false),
      {
        changed: true,
        failed: false,
        label: "설렘 1",
        prev: null,
        reason: "보고 싶었다고 했다",
      },
    );
    assert.deepEqual(mindTrace(rel, [], false), {
      changed: false,
      failed: false,
      label: "설렘 1",
      prev: null,
      reason: null,
    });
    assert.deepEqual(
      mindTrace(
        { ...rel, mind_kind: null, mind_level: null, mind_reason: null, mind_since: null },
        [{ field: "캐릭터 마음", from: "설렘 1", to: "없음" }],
        false,
      ),
      { changed: true, failed: false, label: null, prev: "설렘 1", reason: null },
    );
    assert.equal(mindTrace(undefined, [], true).failed, true);
  });
});

describe("슬랙 답장 게시의 캐릭터 마음 줄", () => {
  const row = (): LlmCallRow => ({
    id: 6,
    character_id: 1,
    chat_id: "1",
    purpose: "reply",
    model: "claude-sonnet-5",
    attempt: 1,
    system_hashes: null,
    turns_hash: null,
    output_hash: null,
    input_tokens: null,
    cache_write_tokens: null,
    cache_read_tokens: null,
    output_tokens: null,
    latency_ms: null,
    stop_reason: null,
    block_types: null,
    error: null,
    context_json: null,
    created_at: "2026-09-20 19:05:00",
  });

  it("바뀜은 이전 → 지금 · 이유, 그대로는 값이 있을 때만, 실패는 저장된 값과 함께 적는다", () => {
    const changed = renderReply(row(), {
      mind: {
        changed: true,
        failed: false,
        label: "서운함 2",
        prev: "서운함 1",
        reason: "약속을 다른 사람과 잡았다",
      },
    });
    assert.ok(
      changed.includes(
        "*캐릭터 마음* 바뀜 · 서운함 1 → 서운함 2 · 약속을 다른 사람과 잡았다",
      ),
    );
    const cleared = renderReply(row(), {
      mind: { changed: true, failed: false, label: null, prev: "질투 2", reason: null },
    });
    assert.ok(
      cleared.split("\n").includes("*캐릭터 마음* 바뀜 · 질투 2 → 없음"),
    );
    const same = renderReply(row(), {
      mind: { changed: false, failed: false, label: "설렘 1", prev: null, reason: null },
    });
    assert.ok(same.includes("*캐릭터 마음* 그대로 · 설렘 1"));
    // 평소가 그대로인 턴은 줄이 없다 — 대부분의 턴이라 늘 적으면 바뀐 턴이 묻힌다
    const quiet = renderReply(row(), {
      mind: { changed: false, failed: false, label: null, prev: null, reason: null },
    });
    assert.ok(!quiet.includes("*캐릭터 마음*"));
    const failed = renderReply(row(), {
      mind: { changed: false, failed: true, label: "서운함 2", prev: null, reason: null },
    });
    assert.ok(failed.includes("*캐릭터 마음* 판정 실패 · 서운함 2"));
    assert.ok(!renderReply(row(), {}).includes("*캐릭터 마음*"));
  });
});
