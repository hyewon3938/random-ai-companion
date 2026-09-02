// 모듈 색인을 코드에서 뽑아 CLAUDE.md에 써 넣는다.
//
// 색인을 손으로 맞추면 밀린다. 코드를 고치는 사람이 보는 자리에 설명을 두고(파일 맨 위 주석)
// 그 첫 줄만 여기로 옮겨서, 설명이 코드와 같은 커밋에서 움직이게 한다.
//
// 쓰는 법: `node scripts/gen-modules.mjs` 로 다시 쓰고, `--check` 를 붙이면 밀렸는지만 본다.
// 커밋 훅이 --check 를 부른다.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CLAUDE = "CLAUDE.md";
const SRC = "src";
const START = "<!-- modules:start -->";
const END = "<!-- modules:end -->";

// 하위 디렉터리는 파일마다 한 줄을 두면 색인이 길어지기만 해서 묶어서 한 줄로 적는다.
// 새 디렉터리를 만들면 여기에 한 줄 더한다.
const DIRS = {
  "src/prompts/": "캐릭터가 내보내는 글의 고정 문안. 어느 층에 어느 순서로 넣을지는 context.ts가 정한다.",
  "src/eval/": "표기 규칙 통과율과 답 고르기 규칙을 재는 검사. 프롬프트 규칙을 고치면 여기로 다시 잰다.",
  "src/tools/": "직접 실행하는 도구. 새벽 정리, 관리 대시보드, 백업, 데이터 이관, 캐릭터 생성.",
};

// 아직 파일 맨 위 주석으로 옮기지 못한 설명. 옮기면 여기서 지운다 — 비어 있는 것이 정상이다.
const PENDING = {};

/**
 * 파일 맨 위 주석 블록에서 한 줄 요약을 뽑는다.
 * 첫 문단(빈 주석 줄이 나오기 전까지)을 이어 붙이고 첫 문장만 쓴다 — 줄바꿈으로 잘린 요약을 막는다.
 */
const summaryOf = (file) => {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const para = [];
  if (lines[0]?.startsWith("//")) {
    for (const l of lines) {
      if (!l.startsWith("//")) break;
      const t = l.replace(/^\/\/\s?/, "").trim();
      if (!t) break;
      para.push(t);
    }
  } else if (lines[0]?.startsWith("/**")) {
    for (const l of lines.slice(1)) {
      if (l.trim().startsWith("*/")) break;
      const t = l.replace(/^\s*\*\s?/, "").trim();
      if (!t) { if (para.length) break; continue; }
      para.push(t);
    }
  }
  if (!para.length) return null;
  const text = para.join(" ");
  const end = text.match(/^(.*?[.])\s/);
  return end ? end[1] : text;
};

const tracked = new Set(
  execFileSync("git", ["ls-files", `${SRC}/*.ts`], { encoding: "utf8" }).split("\n").filter(Boolean)
);
const files = fs
  .readdirSync(SRC)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => path.join(SRC, f))
  .filter((f) => tracked.has(f))
  .sort();

const missing = [];
const rows = [];
for (const f of files) {
  const s = summaryOf(f) ?? PENDING[f] ?? null;
  if (s === null) missing.push(f);
  if (!summaryOf(f) && !PENDING[f]) continue;
  rows.push(`- \`${f}\` — ${s}`);
}
for (const [d, s] of Object.entries(DIRS)) rows.push(`- \`${d}\` — ${s}`);

const block = [
  START,
  "",
  "> 이 목록은 `node scripts/gen-modules.mjs`가 각 파일 맨 위 주석의 첫 줄에서 만든다. 손으로 고치지 않는다.",
  "> 자세한 설명은 그 파일 맨 위에 있고, 실행 단위로 묶어 본 그림은 modules.md에 있다.",
  "",
  ...rows,
  "",
  END,
].join("\n");

const doc = fs.readFileSync(CLAUDE, "utf8");
const s = doc.indexOf(START);
const e = doc.indexOf(END);
if (s === -1 || e === -1) {
  console.error(`[gen-modules] ${CLAUDE}에 ${START} / ${END} 표시가 없습니다.`);
  process.exit(1);
}
const next = doc.slice(0, s) + block + doc.slice(e + END.length);

if (process.argv.includes("--check")) {
  if (next !== doc) {
    console.error("[gen-modules] CLAUDE.md의 모듈 색인이 코드와 다릅니다. `node scripts/gen-modules.mjs`로 다시 쓰고 스테이지하세요.");
    process.exit(1);
  }
  if (missing.length) {
    console.error(`[gen-modules] 맨 위 주석이 없는 파일: ${missing.join(", ")}`);
    process.exit(1);
  }
  const pend = Object.keys(PENDING);
  if (pend.length) {
    console.warn(`[gen-modules] 설명이 아직 파일 밖에 있습니다(scripts/gen-modules.mjs의 PENDING): ${pend.join(", ")}`);
  }
  console.log("[gen-modules] 모듈 색인 최신입니다.");
} else {
  fs.writeFileSync(CLAUDE, next);
  console.log(`[gen-modules] 모듈 ${rows.length}줄을 ${CLAUDE}에 썼습니다.`);
  if (missing.length) console.warn(`[gen-modules] 맨 위 주석이 없는 파일: ${missing.join(", ")}`);
}
