// 빈 DB에서 relationships가 캐릭터 마음 칸 넷을 갖고 서는지 검사한다(#473).
//
// 정의부(TABLES)와 마이그레이션(v16)이 같은 칸을 가져야 새로 만든 DB와 올린 DB가 같은 모양이
// 된다. 올린 쪽은 schema-mind-upgrade.test.ts가 본다. 새로 만든 행은 마음 없음으로 읽히고,
// 저장 함수로 적고 비울 수 있어야 한다.
//
// DB는 임시 파일로 새로 만든다. 모델도 텔레그램도 부르지 않아 값이 안 든다.
import assert from "node:assert/strict";
import { test } from "node:test";
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
const { db, getRelationship, setMind } = await import("../src/db.js");
const { storedMind } = await import("../src/context/mind.js");

test("빈 DB의 relationships에 마음 칸 넷이 있다", () => {
  const cols = (
    db.prepare(`PRAGMA table_info(relationships)`).all() as {
      name: string;
      type: string;
    }[]
  ).map((c) => `${c.name} ${c.type}`);
  for (const col of [
    "mind_kind TEXT",
    "mind_level INTEGER",
    "mind_reason TEXT",
    "mind_since TEXT",
  ])
    assert.ok(cols.includes(col), `${col}이 없다`);
});

test("새 관계 행은 마음 없음이고, 저장 함수로 적고 비운다", () => {
  const { id } = db
    .prepare(
      `INSERT INTO characters (chat_id, status, genesis_json, created_at)
       VALUES ('1', 'active', '{}', '2026-09-20 10:00:00') RETURNING id`,
    )
    .get() as { id: number };
  db.prepare(
    `INSERT INTO relationships (character_id, met_at, stage_no, stage_since) VALUES (?, ?, 1, ?)`,
  ).run(id, "2026-09-20", "2026-09-20");
  assert.equal(storedMind(getRelationship(id)), null);
  setMind(id, {
    kind: "jealous",
    level: 3,
    reason: "동기 얘기를 오래 했다",
    since: "2026-09-20 21:00:00",
  });
  assert.deepEqual(storedMind(getRelationship(id)), {
    kind: "jealous",
    level: 3,
    reason: "동기 얘기를 오래 했다",
    since: "2026-09-20 21:00:00",
  });
  setMind(id, null);
  const rel = getRelationship(id);
  assert.equal(storedMind(rel), null);
  assert.equal(rel?.mind_reason, null);
});
