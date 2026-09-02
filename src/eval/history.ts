// 지난 실행 기록을 표로 본다 — 모델도 DB도 부르지 않는다.
// 사용: yarn eval:log        (기본 최근 20건)
//      yarn eval:log --all
import { readRuns } from "./log.js";

const runs = readRuns();
if (!runs.length) {
  console.log("기록 없음 — yarn eval을 한 번 돌리면 eval-runs.jsonl에 쌓인다.");
  process.exit(0);
}

const shown = process.argv.includes("--all") ? runs : runs.slice(-20);

for (const r of shown) {
  const day = r.at.slice(0, 16).replace("T", " ");
  const rate = `${(r.rate * 100).toFixed(1)}%`.padStart(6);
  const flags = [
    r.noteTotal ? `메모 ${r.noteHits}/${r.noteTotal}` : "",
    r.dirty ? "커밋 안 된 변경" : "",
    r.missed ? `못 잰 케이스 ${r.missed}` : "",
    r.suspects ? `물음표 확인 ${r.suspects}` : "",
  ].filter(Boolean);
  console.log(
    `${day}  ${r.commit.padEnd(8)} ${rate}  ${r.pass}/${r.total}` +
      `  (케이스 ${r.cases}×${r.runs})` +
      (flags.length ? `  · ${flags.join(" · ")}` : "") +
      (r.note ? `  — ${r.note}` : ""),
  );
  const broke = Object.entries(r.violations);
  if (broke.length)
    console.log(`    ${broke.map(([rule, n]) => `${rule} ${n}`).join(" · ")}`);
}

console.log(`\n총 ${runs.length}건 중 ${shown.length}건 표시`);
