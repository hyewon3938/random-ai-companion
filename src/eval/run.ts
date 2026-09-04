// 표기 규칙 평가 실행기 — 골든셋을 실제 모델에 태우고 규칙 위반을 센다.
//
//   yarn eval              케이스마다 한 번씩
//   yarn eval --runs=3     케이스마다 세 번 (모델이 흔들리는 폭까지 본다)
//   yarn eval --pass=0.9   표기 통과율 하한 (기본 1.0, 미달이면 종료 코드 1)
//   yarn eval --json-pass=0.9   형식 유지율 하한 (기본 0.8)
//   yarn eval --note-pass=0.8   메모 통과율 하한 (기본 0 — 아래 설명)
//   yarn eval --only=메모   이름에 그 글자가 든 케이스만 (고치는 자리를 반복해 잴 때)
//   yarn eval --note="웃음 규칙 고친 뒤"   결과 기록에 남길 메모
//   yarn eval --no-log     이번 실행은 eval-runs.jsonl에 남기지 않는다
//
// 프롬프트는 운영과 같은 buildSystemBlocks로 만든다 — 규칙층을 베껴 두면 규칙을 고쳤을 때
// 평가만 옛 문안을 재고 통과한다. 대신 DB는 평가 전용 파일을 쓴다(DB_PATH=./data/eval.db).
// 대화 기록·일기·관계가 매일 달라지는 운영 DB로 재면 프롬프트를 안 고친 날에도 숫자가 움직여서,
// 무엇이 바꾼 것인지 가릴 수 없다.
import "./guard-db.js"; // db.js보다 먼저 — 운영 DB로 도는 것을 막는다
import { db, type CharacterRow } from "../db.js";
import { createFixtureCharacter } from "./fixture-character.js";
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
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split("=")
    .slice(1)
    .join("=");

const runs = Math.max(1, Math.round(numArg("runs", 1)));
const passLine = numArg("pass", 1);
// 형식 하한은 표기와 달리 100%로 두지 않는다. 평가는 모델을 한 번만 부르고, 운영은 형식이
// 깨지면 한 번 더 불러 나은 쪽을 쓴다(reply-ask.ts). 한 번 만에 다 맞기를 요구하면 운영에서
// 아무 문제가 없는 날에도 평가가 실패한다. 되묻는 자리처럼 답이 한 줄로 짧은 케이스가 주로
// 흘리는데, 지금 그 폭이 10회 중 1~4회다. 하한은 그 아래에 둬서 규칙을 고쳐 형식이 무너진
// 날에만 걸리게 한다. 케이스 한 바퀴(--runs=1)는 표본이 적어 이 하한을 믿을 자리가 아니다.
const jsonLine = numArg("json-pass", 0.8);
// 메모 하한의 기본값이 아직 0인 이유는 남은 실패가 메모의 실패가 아니기 때문이다. 기록의 답장
// 객체에 빈 메모 칸을 심고 나서(이슈 #259) 긴 기록 케이스는 50회 중 50회가 됐는데, 케이스 전체를
// 돌리면 10회 중 6회·9회로 내려간다. 내려간 회차는 답이 객체로 안 온 회차라 실을 칸 자체가 없던
// 것이라, 하한을 걸면 형식이 흔들릴 때마다 메모 이름으로 걸린다. 형식이 자리를 잡으면 그때
// 올린다. 그 전까지 회귀는 화면의 메모 ○/✕와 eval-runs.jsonl의 noteHits로 본다.
const noteLine = numArg("note-pass", 0);

// 케이스를 골라 돌리면 통과율은 고른 것만의 값이라 기준선과 나란히 두면 안 된다 — 기록에
// 남기지 않고, 어느 케이스를 골랐는지 화면에 적는다.
const only = strArg("only");
const cases = only ? CASES.filter((c) => c.id.includes(only)) : CASES;
if (!cases.length) {
  console.log(`--only=${only}에 걸리는 케이스가 없다.`);
  process.exit(1);
}

const activeCharacter = (): { id: number; chatId: string } => {
  const row = db
    .prepare(
      `SELECT * FROM characters WHERE status = 'active' ORDER BY id DESC LIMIT 1`,
    )
    .get() as CharacterRow | undefined;
  if (row) return { id: row.id, chatId: row.chat_id };
  return { id: createFixtureCharacter(EVAL_CHAT_ID), chatId: EVAL_CHAT_ID };
};

interface Result {
  caseId: string;
  parse: string;
  bubbles: string[];
  violations: Violation[];
  /** 케이스가 노린 것이 답에 안 나온 경우. 위반은 아니고, 못 쟀다는 표시다. */
  missed: string;
  /**
   * 오늘 메모를 재는 케이스에서 note 신호가 실려 왔는지. 재지 않는 케이스는 undefined다.
   * 메모를 만드는 자리가 답장 호출 밖으로 옮겨 가면 이 값을 채우는 줄만 바꾼다(이슈 #257).
   */
  gotNote?: string | null;
  /** 물음표가 빠진 것 같은데 확실하지 않은 줄. 점수에 넣지 않고 사람이 본다. */
  suspects: string[];
}

const character = activeCharacter();
// 케이스가 바뀌어도 시스템 프롬프트는 같다 — 한 번만 만들어 프롬프트 캐시를 그대로 태운다.
const blocks = buildSystemBlocks(character.id, character.chatId, {
  signals: true,
});

console.log(
  `표기 규칙 평가 — 케이스 ${cases.length} × ${runs}회 · ${config.model}` +
    (only ? ` · --only=${only} (기록 안 남김)\n` : "\n"),
);

const results: Result[] = [];
for (const kase of cases) {
  for (let i = 0; i < runs; i++) {
    const raw = await chat(blocks, kase.turns, REPLY_MAX_TOKENS, config.model, {
      purpose: "tool",
      characterId: character.id,
    });
    const out = parseReplyOutput(raw);
    // 케이스가 노린 것이 답에 아예 안 나오면 그 케이스는 통과가 아니라 못 잰 것이다.
    const missing: string[] = [];
    if (kase.wantsQuestion && !hasQuestion(out.bubbles))
      missing.push("질문 없음");
    if (kase.wantsLaugh && !laughMarks(out.bubbles).length)
      missing.push("웃음 없음");
    results.push({
      caseId: kase.id,
      parse: PARSE_NAME[out.parse],
      bubbles: out.bubbles,
      violations: checkOutputRules(out.bubbles, kase),
      missed: missing.length ? `  ${missing.join(" · ")}(못 잼)` : "",
      ...(kase.wantsNote ? { gotNote: out.signals.note } : {}),
      suspects: suspectQuestions(out.bubbles),
    });
  }
}

// 한글은 터미널에서 두 칸을 먹는다 — 글자 수로 맞추면 표가 어긋난다.
const wide = (s: string): number =>
  [...s].reduce((n, ch) => n + (/[\u1100-\uD7FF]/.test(ch) ? 2 : 1), 0);

const pad = (s: string, n: number): string =>
  s + " ".repeat(Math.max(0, n - wide(s)));

const width = Math.max(...cases.map((c) => wide(c.id)));
for (const r of results) {
  const ok = r.violations.length === 0;
  // 메모는 표기와 별개로 세므로 표시도 따로 붙인다 — 표기를 지켰는데 메모가 안 온 줄이 ○ 하나로
  // 보이면, 고치려는 자리가 리포트에서 사라진다.
  const noteMark =
    r.gotNote === undefined ? "" : r.gotNote ? "  메모 ○" : "  메모 ✕";
  console.log(
    `  ${ok ? "○" : "✕"} ${pad(r.caseId, width)}  ${r.parse}` +
      (ok
        ? ""
        : `  ${r.violations.map((v) => `${v.rule}(${v.found})`).join(" · ")}`) +
      noteMark +
      r.missed,
  );
  if (!ok) console.log(`      ${r.bubbles.join(" / ")}`);
  if (r.gotNote) console.log(`      메모: ${r.gotNote}`);
  for (const line of r.suspects)
    console.log(`      물음표 확인(점수 밖) ${line}`);
}

const passed = results.filter((r) => r.violations.length === 0).length;
const asJson = results.filter((r) => r.parse === PARSE_NAME.json).length;
const rate = passed / results.length;
const jsonRate = asJson / results.length;

// 메모는 재는 케이스에서만 센다. 케이스가 하나도 없으면 100%로 두고 하한을 안 건드린다.
const noteCases = results.filter((r) => r.gotNote !== undefined);
const noteHits = noteCases.filter((r) => r.gotNote).length;
const noteRate = noteCases.length ? noteHits / noteCases.length : 1;

console.log(
  `\n표기 통과 ${passed}/${results.length} (${(rate * 100).toFixed(1)}%)` +
    `  ·  형식 JSON ${asJson}/${results.length} (${(jsonRate * 100).toFixed(1)}%)` +
    (noteCases.length
      ? `  ·  메모 ${noteHits}/${noteCases.length} (${(noteRate * 100).toFixed(1)}%)`
      : ""),
);

if (!process.argv.includes("--no-log") && !only) {
  const byCase: Record<string, string> = {};
  for (const kase of cases) {
    const mine = results.filter((r) => r.caseId === kase.id);
    byCase[kase.id] =
      `${mine.filter((r) => !r.violations.length).length}/${mine.length}`;
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
    cases: cases.length,
    runs,
    pass: passed,
    total: results.length,
    rate: Number(rate.toFixed(4)),
    json: asJson,
    byCase,
    violations,
    suspects: results.reduce((n, r) => n + r.suspects.length, 0),
    missed: results.filter((r) => r.missed).length,
    noteHits,
    noteTotal: noteCases.length,
    ...(strArg("note") ? { note: strArg("note") } : {}),
  });
  console.log(
    `기록 남김 — eval-runs.jsonl (${commit}${dirty ? ", 커밋 안 된 변경 있음" : ""})`,
  );
}

const under: string[] = [];
if (rate < passLine) under.push(`표기 하한 ${(passLine * 100).toFixed(1)}%`);
if (jsonRate < jsonLine)
  under.push(`형식 하한 ${(jsonLine * 100).toFixed(1)}%`);
if (noteRate < noteLine)
  under.push(`메모 하한 ${(noteLine * 100).toFixed(1)}%`);
if (under.length) {
  console.log(`${under.join(" · ")} 미달`);
  process.exit(1);
}
