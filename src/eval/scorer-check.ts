// 채점기 자체를 검사한다 — 모델도 DB도 부르지 않아 값이 안 든다.
//
// 채점기가 아무것도 못 잡으면 평가는 늘 100%로 나오고, 그 100%는 규칙을 지켰다는 뜻이 아니라
// 재지 못했다는 뜻이다. 위반이 있는 답과 없는 답을 하나씩 놓고 채점기가 가르는지 먼저 본다.
// 사용: yarn eval:check
import { parseReplyOutput } from "../reply-signal.js";
import { checkOutputRules, CASES } from "./output-rules.js";

const fixtures: { name: string; raw: string; noLaugh: boolean; want: string[] }[] = [
  { name: "깨끗한 답", raw: '{"reply":["헐 진짜?","그래서 어떻게 됐어"]}', noLaugh: true, want: [] },
  { name: "웃음 1회(허용)", raw: '{"reply":["아 ㅋㅋ 뭐야"]}', noLaugh: false, want: [] },
  { name: "웃음 2회", raw: '{"reply":["아 ㅋㅋ 뭐야","진짜 웃기다 ㅎㅎ"]}', noLaugh: false, want: ["웃음 표기 한 답장에 한 번"] },
  { name: "위로 자리 웃음", raw: '{"reply":["에고 힘들었겠다 ㅎㅎ"]}', noLaugh: true, want: ["웃음 금지 자리"] },
  { name: "이모지", raw: '{"reply":["축하해 🎉"]}', noLaugh: false, want: ["이모지·그림 이모티콘"] },
  { name: "얼굴 문자", raw: '{"reply":["좋다 ^^"]}', noLaugh: false, want: ["이모지·그림 이모티콘"] },
  { name: "큰따옴표", raw: '{"reply":["팀장이 \\"네 일 아니다\\" 그랬다고?"]}', noLaugh: false, want: ["큰따옴표"] },
  { name: "곡선 따옴표", raw: '{"reply":["팀장이 “네 일 아니다” 그랬대"]}', noLaugh: false, want: ["큰따옴표"] },
  { name: "리스트", raw: '{"reply":["- 영화\\n- 산책"]}', noLaugh: false, want: ["리스트·마크다운"] },
  { name: "별표 강조", raw: '{"reply":["진짜 **대박**이다"]}', noLaugh: false, want: ["리스트·마크다운"] },
  { name: "우는 표기는 웃음 아님", raw: '{"reply":["아 ㅠㅠ 어떡해","진짜 속상하겠다"]}', noLaugh: true, want: [] },
  { name: "형식 안 지킨 답", raw: "그냥 줄글로 답함", noLaugh: false, want: [] },
];

let bad = 0;
for (const f of fixtures) {
  const out = parseReplyOutput(f.raw);
  const got = checkOutputRules(out.bubbles, { noLaugh: f.noLaugh }).map((v) => v.rule);
  const ok = got.length === f.want.length && f.want.every((w) => got.includes(w));
  if (!ok) bad++;
  console.log(`${ok ? "○" : "✕"} ${f.name} — parse=${out.parse} 기대[${f.want}] 나옴[${got}]`);
}
console.log(`\n채점기 픽스처 ${fixtures.length - bad}/${fixtures.length} 통과`);
console.log(`골든셋 케이스 ${CASES.length}건, 웃음 금지 자리 ${CASES.filter((c) => c.noLaugh).length}건`);

if (bad) process.exit(1);
