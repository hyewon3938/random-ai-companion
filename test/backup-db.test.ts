// 백업 도구가 검사하며 만든 곁파일을 치우는지 검사한다 — 도구를 실제로 실행해서 본다.
//
// 읽기 전용으로 연 SQLite 연결은 닫을 때 -shm·-wal을 스스로 못 지워서, 백업을 뜰 때마다
// 한 쌍씩 남았다(이슈 #383). 여기서는 백업과 검사 뒤에 그 둘이 사라지는지, 열기 전부터
// 있던 곁파일과 내용이 든 -wal은 그대로 두는지 본다. 뒤의 둘을 지우면 돌고 있는 DB의
// 아직 본체로 옮겨지지 않은 내용이 사라진다.
//
// 도구가 파일 맨 아래에서 바로 도는 실행 스크립트라 가져다 쓸 수 없어, 자식 프로세스로
// 부른다. DB는 임시 디렉터리에 새로 만들고 밖으로 나가는 것은 없다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "backup-db-test-"));

/** WAL 방식으로 행 하나를 넣고 닫는다 — 닫으면 곁파일이 사라진 상태로 남는다. */
const makeDb = (name: string): string => {
  const file = join(dir, name);
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE t (a INTEGER)");
  db.prepare("INSERT INTO t VALUES (?)").run(1);
  db.close();
  return file;
};

const sideFiles = (file: string): string[] =>
  [`${file}-shm`, `${file}-wal`].filter((f) => existsSync(f));

const run = (
  args: string[],
  dbPath?: string,
): { status: number | null; stdout: string; stderr: string } => {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/tools/backup-db.ts", ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...(dbPath ? { DB_PATH: dbPath } : {}) },
    },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

test("백업을 뜨면 원본에도 뜬 파일에도 곁파일이 안 남는다", () => {
  const source = makeDb("source.db");
  const out = join(dir, "out.db");
  const r = run([out], source);
  assert.equal(r.status, 0, r.stderr);

  const report = JSON.parse(r.stdout.trim().split("\n").at(-1) as string) as {
    integrity: string;
    foreignKeyViolations: number;
    totalRows: number;
  };
  assert.equal(report.integrity, "ok");
  assert.equal(report.foreignKeyViolations, 0);
  assert.equal(report.totalRows, 1);

  assert.ok(existsSync(out));
  assert.deepEqual(sideFiles(out), []);
  assert.deepEqual(sideFiles(source), []);
});

test("이미 있는 파일을 검사만 해도 그때 생긴 곁파일은 지운다", () => {
  const file = makeDb("check-only.db");
  assert.deepEqual(sideFiles(file), []);
  const r = run(["--check", file]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(sideFiles(file), []);
});

test("돌고 있는 DB를 검사해도 내용이 든 -wal을 건드리지 않는다", () => {
  const file = makeDb("live.db");
  // 쓰기 연결을 연 채로 두면 -wal에 아직 본체로 안 옮겨진 내용이 남는다.
  const writer = new Database(file);
  writer.pragma("journal_mode = WAL");
  writer.prepare("INSERT INTO t VALUES (?)").run(2);
  const walBytes = statSync(`${file}-wal`).size;
  assert.ok(walBytes > 0);

  try {
    const r = run(["--check", file]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(sideFiles(file), [`${file}-shm`, `${file}-wal`]);
    assert.equal(statSync(`${file}-wal`).size, walBytes);
  } finally {
    writer.close();
  }
});

test("열기 전부터 있던 곁파일은 비어 있어도 남긴다", () => {
  const file = makeDb("kept.db");
  writeFileSync(`${file}-wal`, "");
  writeFileSync(`${file}-shm`, "");
  const r = run(["--check", file]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(sideFiles(file), [`${file}-shm`, `${file}-wal`]);
});
