// 표기 규칙 평가 실행기 — 골든셋을 실제 모델에 태우고 규칙 위반을 센다.
//
//   yarn eval              케이스마다 한 번씩
//   yarn eval --runs=3     케이스마다 세 번 (모델이 흔들리는 폭까지 본다)
//   yarn eval --pass=0.9   통과율 하한 (기본 1.0, 미달이면 종료 코드 1)
//   yarn eval --note="웃음 규칙 고친 뒤"   결과 기록에 남길 메모
//   yarn eval --no-log     이번 실행은 eval-runs.jsonl에 남기지 않는다
//
// 프롬프트는 운영과 같은 buildSystemBlocks로 만든다 — 규칙층을 베껴 두면 규칙을 고쳤을 때
// 평가만 옛 문안을 재고 통과한다. 대신 DB는 평가 전용 파일을 쓴다(DB_PATH=./data/eval.db).
// 대화 기록·일기·관계가 매일 달라지는 운영 DB로 재면 프롬프트를 안 고친 날에도 숫자가 움직여서,
// 무엇이 바꾼 것인지 가릴 수 없다.
import "./guard-db.js"; // db.js보다 먼저 — 운영 DB로 도는 것을 막는다
import { db, type CharacterRow } from "../db.js";
import { createDaepyoCharacter } from "../character.js";
import { buildSystemBlocks } from "../context.js";
import { chat } from "../llm.js";
import { config } from "../config.js";
import {
  parseReplyOutput,
  PARSE_NAME,
  REPLY_MAX_TOKENS,
} from "../reply-signal.js";
import { appendRun, gitState } from "./log.js";
import {
  CASES,
  checkOutputRules,
  hasQuestion,
  laughMarks,
  suspectQuestions,
  type Violation,
} from "./output-rules.js";

const EVAL_CHAT_ID = "eval";

const numArg = (name: string, fallback: number): number => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const v = hit ? Number(hit.split("=")[1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
};

const strArg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const runs = Math.max(1, Math.round(numArg("runs", 1)));
const passLine = numArg("pass", 1);

const activeCharacter = (): { id: number; chatId: string } => {
  const row = db
    .prepare(
      `SELECT * FROM characters WHERE status = 'active' ORDER BY id DESC LIMIT 1`,
    )
    .get() as CharacterRow | undefined;
  if (row) return { id: row.id, chatId: row.chat_id };
  const made = createDaepyoCharacter(EVAL_CHAT_ID);
  return { id: made.id, chatId: EVAL_CHAT_ID };
};

interface Result {
  caseId: string;
  parse: string;
  bubbles: string[];
  violations: Violation[];
  /** 케이스가 노린 것이 답에 안 나온 경우. 위반은 아니고, 못 쟀다는 표시다. */
  note: string;
  /** 물음표가 빠진 것 같은데 확실하지 않은 줄. 점수에 넣지 않고 사람이 본다. */
  suspects: string[];
}

const character = activeCharacter();
// 케이스가 바뀌어도 시스템 프롬프트는 같다 — 한 번만 만들어 프롬프트 캐시를 그대로 태운다.
const blocks = buildSystemBlocks(character.id, character.chatId, {
  signals: true,
});

console.log(
  `표기 규칙 평가 — 케이스 ${CASES.length} × ${runs}회 · ${config.model}\n`,
);

const results: Result[] = [];
for (const kase of CASES) {
  for (let i = 0; i < runs; i++) {
    const raw = await chat(blocks, kase.turns, REPLY_MAX_TOKENS, config.model, {
      purpose: "tool",
      characterId: character.id,
    });
    const out = parseReplyOutput(raw);
    // 케이스가 노린 것이 답에 아예 안 나오면 그 케이스는 통과가 아니라 못 잰 것이다.
    const missing: string[] = [];
    if (kase.wantsQuestion && !hasQuestion(out.bubbles)) missing.push("질문 없음");
    if (kase.wantsLaugh && !laughMarks(out.bubbles).length) missing.push("웃음 없음");
    results.push({
      caseId: kase.id,
      parse: PARSE_NAME[out.parse],
      bubbles: out.bubbles,
      violations: checkOutputRules(out.bubbles, kase),
      note: missing.length ? `  ${missing.join(" · ")}(못 잼)` : "",
      suspects: suspectQuestions(out.bubbles),
    });
  }
}

// 한글은 터미널에서 두 칸을 먹는다 — 글자 수로 맞추면 표가 어긋난다.
const wide = (s: string): number =>
  [...s].reduce((n, ch) => n + (/[\u1100-\uD7FF]/.test(ch) ? 2 : 1), 0);

const pad = (s: string, n: number): string =>
  s + " ".repeat(Math.max(0, n - wide(s)));

const width = Math.max(...CASES.map((c) => wide(c.id)));
for (const r of results) {
  const ok = r.violations.length === 0;
  console.log(
    `  ${ok ? "○" : "✕"} ${pad(r.caseId, width)}  ${r.parse}` +
      (ok ? "" : `  ${r.violations.map((v) => `${v.rule}(${v.found})`).join(" · ")}`) +
      r.note,
  );
  if (!ok) console.log(`      ${r.bubbles.join(" / ")}`);
  for (const line of r.suspects)
    console.log(`      물음표 확인(점수 밖) ${line}`);
}

const passed = results.filter((r) => r.violations.length === 0).length;
const asJson = results.filter((r) => r.parse === PARSE_NAME.json).length;
const rate = passed / results.length;

console.log(
  `\n표기 통과 ${passed}/${results.length} (${(rate * 100).toFixed(1)}%)` +
    `  ·  형식 JSON ${asJson}/${results.length}`,
);

if (!process.argv.includes("--no-log")) {
  const byCase: Record<string, string> = {};
  for (const kase of CASES) {
    const mine = results.filter((r) => r.caseId === kase.id);
    byCase[kase.id] = `${mine.filter((r) => !r.violations.length).length}/${mine.length}`;
  }
  const violations: Record<string, number> = {};
  for (const r of results)
    for (const v of r.violations)
      violations[v.rule] = (violations[v.rule] ?? 0) + 1;

  const { commit, dirty } = gitState();
  appendRun({
    at: new Date().toISOString(),
    commit,
    dirty,
    model: config.model,
    cases: CASES.length,
    runs,
    pass: passed,
    total: results.length,
    rate: Number(rate.toFixed(4)),
    json: asJson,
    byCase,
    violations,
    suspects: results.reduce((n, r) => n + r.suspects.length, 0),
    missed: results.filter((r) => r.note).length,
    ...(strArg("note") ? { note: strArg("note") } : {}),
  });
  console.log(`기록 남김 — eval-runs.jsonl (${commit}${dirty ? ", 커밋 안 된 변경 있음" : ""})`);
}

if (rate < passLine) {
  console.log(`하한 ${(passLine * 100).toFixed(1)}% 미달`);
  process.exit(1);
}
