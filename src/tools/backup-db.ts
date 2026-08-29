// 운영 DB의 일관 스냅샷을 파일 하나로 뜬다.
//
// SQLite 온라인 백업 API를 쓰므로 봇이 돌아가는 중에 실행해도 안전하고, WAL에만 있고 본체로
// 아직 옮겨지지 않은 내용까지 함께 담긴다. 파일을 그냥 복사하면 그 내용이 빠져 복원이 깨진다.
//
// 뜬 파일은 그 자리에서 검사한다 — 올리기 전에 걸러내는 편이 복원할 때 발견하는 것보다 싸다.
// 표별 행 수를 함께 찍어 두면 나중에 복원한 DB와 대조할 기준이 된다.
//
// DB는 읽기 전용으로 열고, 마이그레이션과 API 키 요구를 타지 않으려고
// src/db.ts·src/config.ts를 거치지 않는다.
//
// 사용: npx tsx src/tools/backup-db.ts <저장할 경로>
//       npx tsx src/tools/backup-db.ts --check <파일>   (이미 있는 파일을 검사만)

import Database from "better-sqlite3";
import { statSync } from "node:fs";

interface Report {
  path: string;
  bytes: number;
  userVersion: number;
  integrity: string;
  foreignKeyViolations: number;
  totalRows: number;
  tables: Record<string, number>;
}

const inspect = (file: string): Report => {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma("integrity_check", { simple: true }) as string;
    const violations = db.pragma("foreign_key_check") as unknown[];
    const userVersion = db.pragma("user_version", { simple: true }) as number;
    const names = (
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
           ORDER BY name`,
        )
        .all() as { name: string }[]
    ).map((r) => r.name);

    const tables: Record<string, number> = {};
    let totalRows = 0;
    for (const name of names) {
      // 표 이름은 sqlite_master에서 읽은 값이라 바인딩할 자리가 아니다(식별자는 바인딩이 안 된다)
      const row = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as {
        n: number;
      };
      tables[name] = row.n;
      totalRows += row.n;
    }

    return {
      path: file,
      bytes: statSync(file).size,
      userVersion,
      integrity,
      foreignKeyViolations: violations.length,
      totalRows,
      tables,
    };
  } finally {
    db.close();
  }
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const checkOnly = args[0] === "--check";
  const target = checkOnly ? args[1] : args[0];
  if (!target) {
    console.error(
      "사용: npx tsx src/tools/backup-db.ts <저장할 경로> | --check <파일>",
    );
    process.exit(1);
  }

  if (!checkOnly) {
    const source = process.env.DB_PATH ?? "./data/companion.db";
    const src = new Database(source, { readonly: true, fileMustExist: true });
    try {
      await src.backup(target);
    } finally {
      src.close();
    }
  }

  const report = inspect(target);
  console.log(JSON.stringify(report));

  if (report.integrity !== "ok" || report.foreignKeyViolations > 0) {
    console.error(
      `[backup] 검사 실패 — integrity=${report.integrity} fk=${report.foreignKeyViolations}`,
    );
    process.exit(1);
  }
};

main().catch((e) => {
  console.error("[backup] 실패:", e);
  process.exit(1);
});
