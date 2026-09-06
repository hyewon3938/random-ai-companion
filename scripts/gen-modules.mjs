// 영역 표를 areas.md에서 읽어 파일 색인을 영역별로 쓰고, 같은 표를 CLAUDE.md에 옮겨 적는다.
//
// 색인을 손으로 맞추면 밀린다. 코드를 고치는 사람이 보는 자리에 설명을 두고(파일 맨 위 주석)
// 그 첫 줄만 여기로 옮겨서, 설명이 코드와 같은 커밋에서 움직이게 한다. 어느 파일이 어느 영역인지는
// areas.md의 영역 표가 단일 소스다. 표에 없는 src 파일이 있으면 실패해서, 새 파일은 표에 넣어야 커밋된다.
//
// 쓰는 것 둘: areas.md의 `<!-- modules:start/end -->` 사이에 영역별 파일 색인,
// CLAUDE.md의 같은 표시 사이에 영역 표(영역·여기로 오는 변경·파일 세 열).
//
// 쓰는 법: `node scripts/gen-modules.mjs` 로 다시 쓰고, `--check` 를 붙이면 밀렸는지만 본다.
// 커밋 훅이 --check 를 부른다.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const AREAS = "areas.md";
const CLAUDE = "CLAUDE.md";
const SRC = "src";
const START = "<!-- modules:start -->";
const END = "<!-- modules:end -->";

// 아직 파일 맨 위 주석으로 옮기지 못한 설명. 옮기면 여기서 지운다 — 비어 있는 것이 정상이다.
const PENDING = {};

const fail = (msg) => {
  console.error(`[gen-modules] ${msg}`);
  process.exit(1);
};

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
      if (!t) {
        if (para.length) break;
        continue;
      }
      para.push(t);
    }
  }
  if (!para.length) return null;
  const text = para.join(" ");
  const end = text.match(/^(.*?[.])\s/);
  return end ? end[1] : text;
};

const lineCount = (file) => {
  const text = fs.readFileSync(file, "utf8");
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
};

/**
 * areas.md에서 머리글이 `| 영역 |`로 시작하는 첫 표를 읽는다.
 * 행마다 { name, change, files } — files는 파일 열을 쉼표로 나눈 토큰이다.
 */
const readAreaTable = (doc) => {
  const lines = doc.split("\n");
  const head = lines.findIndex((l) => /^\|\s*영역\s*\|/.test(l));
  if (head === -1)
    fail(`${AREAS}에 머리글이 '| 영역 |'로 시작하는 표가 없습니다.`);
  const rows = [];
  for (const l of lines.slice(head + 2)) {
    if (!l.startsWith("|")) break;
    const cells = l
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 3) fail(`영역 표의 행이 세 열이 아닙니다: ${l}`);
    rows.push({
      name: cells[0],
      change: cells[1],
      files: cells[2]
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    });
  }
  if (!rows.length) fail("영역 표에 행이 없습니다.");
  return rows;
};

const tracked = execFileSync("git", ["ls-files", `${SRC}/*.ts`], {
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean)
  .filter((f) => f.endsWith(".ts"))
  .sort();

const areasDoc = fs.readFileSync(AREAS, "utf8");
const areas = readAreaTable(areasDoc);

// 이름으로 적은 파일이 먼저, 남은 파일이 폴더 패턴(`tools/*`)으로 간다.
const assigned = new Map();
for (const a of areas) {
  a.members = [];
  for (const tok of a.files) {
    if (tok.endsWith("/*")) continue;
    const f = path.join(SRC, `${tok}.ts`);
    if (!tracked.includes(f))
      fail(`영역 표에 적힌 파일이 없습니다: ${tok} (${a.name})`);
    if (assigned.has(f)) fail(`파일이 영역 둘에 적혀 있습니다: ${tok}`);
    assigned.set(f, a);
    a.members.push(f);
  }
}
for (const a of areas) {
  for (const tok of a.files) {
    if (!tok.endsWith("/*")) continue;
    const prefix = path.join(SRC, tok.slice(0, -1));
    for (const f of tracked) {
      if (f.startsWith(prefix) && !assigned.has(f)) {
        assigned.set(f, a);
        a.members.push(f);
      }
    }
  }
}
const unmapped = tracked.filter((f) => !assigned.has(f));
if (unmapped.length)
  fail(
    `${AREAS}의 영역 표에 없는 파일: ${unmapped.join(", ")}. 표에 넣고 다시 돌리세요.`,
  );

const missing = [];
const indexLines = [];
let rowCount = 0;
for (const a of areas) {
  const total = a.members.reduce((n, f) => n + lineCount(f), 0);
  indexLines.push(`### ${a.name} · ${total.toLocaleString("en-US")}줄`, "");
  for (const f of a.members) {
    const s = summaryOf(f) ?? PENDING[f] ?? null;
    if (s === null) {
      missing.push(f);
      continue;
    }
    indexLines.push(`- \`${f}\` — ${s}`);
    rowCount += 1;
  }
  indexLines.push("");
}
indexLines.pop();

const indexBlock = [
  START,
  "",
  "> 이 색인은 `node scripts/gen-modules.mjs`가 위 영역 표와 각 파일 맨 위 주석의 첫 줄에서 만든다. 손으로 고치지 않는다. 줄 수는 영역에 든 파일의 합이다.",
  "",
  ...indexLines,
  "",
  END,
].join("\n");

const tableBlock = [
  START,
  "",
  "> 이 표는 `node scripts/gen-modules.mjs`가 areas.md의 영역 표에서 옮겨 쓴다. 손으로 고치지 않는다. 파일마다 한 줄 요약은 areas.md의 파일 색인에 있다.",
  "",
  "| 영역 | 여기로 오는 변경 | 파일 |",
  "| --- | --- | --- |",
  ...areas.map((a) => `| ${a.name} | ${a.change} | ${a.files.join(", ")} |`),
  "",
  END,
].join("\n");

const splice = (file, doc, block) => {
  const s = doc.indexOf(START);
  const e = doc.indexOf(END);
  if (s === -1 || e === -1)
    fail(`${file}에 ${START} / ${END} 표시가 없습니다.`);
  return doc.slice(0, s) + block + doc.slice(e + END.length);
};

const claudeDoc = fs.readFileSync(CLAUDE, "utf8");
const nextAreas = splice(AREAS, areasDoc, indexBlock);
const nextClaude = splice(CLAUDE, claudeDoc, tableBlock);

if (process.argv.includes("--check")) {
  const stale = [];
  if (nextAreas !== areasDoc) stale.push(AREAS);
  if (nextClaude !== claudeDoc) stale.push(CLAUDE);
  if (stale.length) {
    fail(
      `${stale.join("·")}의 색인이 코드와 다릅니다. \`node scripts/gen-modules.mjs\`로 다시 쓰고 스테이지하세요.`,
    );
  }
  if (missing.length) fail(`맨 위 주석이 없는 파일: ${missing.join(", ")}`);
  const pend = Object.keys(PENDING);
  if (pend.length) {
    console.warn(
      `[gen-modules] 설명이 아직 파일 밖에 있습니다(scripts/gen-modules.mjs의 PENDING): ${pend.join(", ")}`,
    );
  }
  console.log("[gen-modules] 모듈 색인 최신입니다.");
} else {
  fs.writeFileSync(AREAS, nextAreas);
  fs.writeFileSync(CLAUDE, nextClaude);
  console.log(
    `[gen-modules] 파일 ${rowCount}줄을 영역 ${areas.length}개로 ${AREAS}에 쓰고, 영역 표를 ${CLAUDE}에 썼습니다.`,
  );
  if (missing.length)
    console.warn(`[gen-modules] 맨 위 주석이 없는 파일: ${missing.join(", ")}`);
}
