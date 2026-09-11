// 처리 여부 세 칸이 없던 v11 DB가 v12로 올라가는 자리를 검사한다(#400).
//
// 새 칸은 전부 비워도 되는 자리라 표를 다시 만들지 않고 ALTER로 붙인다. 여기서 봐야 할 것은
// 이미 쌓인 표시가 그대로 남고 전부 처리 전으로 시작하는지다 — 표를 다시 만드는 절차였다면
// 슬랙에서 모은 지적이 통째로 사라진다.
//
// DB는 임시 파일로 새로 만들고, v11 모양은 이 파일이 손으로 세운다. 모델도 텔레그램도
// 부르지 않아 값이 안 든다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const DB_PATH = join(mkdtempSync(join(tmpdir(), "companion-test-")), "test.db");
process.env.DB_PATH = DB_PATH;
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

// v11 시절의 call_feedback — 처리 여부 세 칸이 아직 없다.
const seed = new Database(DB_PATH);
seed.exec(`
  CREATE TABLE call_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER,
    call_id INTEGER,
    slack_ts TEXT NOT NULL,
    trace_kind TEXT,
    source TEXT NOT NULL CHECK (source IN ('reaction','reply')),
    kind TEXT CHECK (kind IN ('fact','tone','timing','good')),
    slack_user TEXT,
    text TEXT,
    reply_ts TEXT,
    dedupe_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    removed_at TEXT
  );
`);
const insert = seed.prepare(
  `INSERT INTO call_feedback
     (slack_ts, trace_kind, source, kind, slack_user, text, reply_ts, dedupe_key, created_at, removed_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
insert.run(
  "1757100000.000100",
  "reply",
  "reaction",
  "fact",
  "U1",
  null,
  null,
  "react:1757100000.000100:fact:U1",
  "2026-09-09 12:00:00",
  null,
);
insert.run(
  "1757100000.000100",
  "reply",
  "reply",
  null,
  "U1",
  "이 장면은 각본에 없다",
  "1757100100.000200",
  "reply:1757100100.000200",
  "2026-09-09 12:05:00",
  null,
);
// 슬랙에서 뗀 표시 — 처리 표시와 뜻이 다르므로 올라간 뒤에도 뗀 시각이 그대로 있어야 한다.
insert.run(
  "1757100000.000300",
  "reply",
  "reaction",
  "tone",
  "U1",
  null,
  null,
  "react:1757100000.000300:tone:U1",
  "2026-09-09 13:00:00",
  "2026-09-09 14:00:00",
);
seed.pragma("user_version = 11");
seed.close();

// DB 경로를 정하고 v11 모양을 세운 뒤에 읽어야 이 파일이 열린다 — 읽는 순간 마이그레이션이 돈다.
const { db, openFeedback, feedbackByIds, resolveFeedback } =
  await import("../src/db.js");

test("v11 DB가 지금 스키마 버전까지 올라간다", () => {
  assert.equal(db.pragma("user_version", { simple: true }), 13);
});

test("이미 쌓인 표시는 그대로 남고 처리 여부 세 칸이 붙는다", () => {
  const cols = (
    db.pragma(`table_info(call_feedback)`) as { name: string }[]
  ).map((c) => c.name);
  for (const name of ["resolved_at", "issue_no", "resolution"])
    assert.ok(cols.includes(name), `${name} 칸이 없다`);

  const rows = db
    .prepare(
      `SELECT id, text, removed_at, resolved_at FROM call_feedback ORDER BY id`,
    )
    .all() as {
    id: number;
    text: string | null;
    removed_at: string | null;
    resolved_at: string | null;
  }[];
  assert.equal(rows.length, 3);
  assert.equal(rows[1].text, "이 장면은 각본에 없다");
  assert.equal(rows[2].removed_at, "2026-09-09 14:00:00");
  assert.ok(rows.every((r) => r.resolved_at === null));
});

test("올라온 표시는 전부 처리 전으로 시작하고 뗀 것만 목록에서 빠진다", () => {
  assert.deepEqual(
    openFeedback().map((r) => r.id),
    [1, 2],
  );
});

test("올라온 표시에도 처리 표시를 찍을 수 있다", () => {
  assert.equal(resolveFeedback([1, 2], "fixed", 400, "2026-09-11 15:00:00"), 2);
  const rows = feedbackByIds([1, 2]);
  assert.ok(rows.every((r) => r.resolution === "fixed" && r.issue_no === 400));
  assert.deepEqual(openFeedback(), []);
});
