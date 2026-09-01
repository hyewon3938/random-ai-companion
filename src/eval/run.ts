// 표기 규칙 평가 실행기 — 골든셋을 실제 모델에 태우고 규칙 위반을 센다.
//
//   yarn eval              케이스마다 한 번씩
//   yarn eval --runs=3     케이스마다 세 번 (모델이 흔들리는 폭까지 본다)
//   yarn eval --pass=0.9   준수율 하한 (기본 1.0, 미달이면 종료 코드 1)
//
// 프롬프트는 운영과 같은 buildSystemBlocks로 만든다 — 규칙층을 베껴 두면 규칙을 고쳤을 때
// 평가만 옛 문안을 재고 통과한다. 대신 DB는 평가 전용 파일을 쓴다(DB_PATH=./data/eval.db).
// 대화 기록·일기·관계가 매일 달라지는 운영 DB로 재면 프롬프트를 안 고친 날에도 숫자가 움직여서,
// 무엇이 바꾼 것인지 가릴 수 없다.
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
import { CASES, checkOutputRules, type Violation } from "./output-rules.js";

const EVAL_CHAT_ID = "eval";

const numArg = (name: string, fallback: number): number => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const v = hit ? Number(hit.split("=")[1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
};

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
    results.push({
      caseId: kase.id,
      parse: PARSE_NAME[out.parse],
      bubbles: out.bubbles,
      violations: checkOutputRules(out.bubbles, kase),
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
      (ok ? "" : `  ${r.violations.map((v) => `${v.rule}(${v.found})`).join(" · ")}`),
  );
  if (!ok) console.log(`      ${r.bubbles.join(" / ")}`);
}

const passed = results.filter((r) => r.violations.length === 0).length;
const asJson = results.filter((r) => r.parse === PARSE_NAME.json).length;
const rate = passed / results.length;

console.log(
  `\n표기 준수 ${passed}/${results.length} (${(rate * 100).toFixed(1)}%)` +
    `  ·  형식 JSON ${asJson}/${results.length}`,
);

if (rate < passLine) {
  console.log(`하한 ${(passLine * 100).toFixed(1)}% 미달`);
  process.exit(1);
}
