// 채점기 자체를 검사한다 — 모델도 DB도 부르지 않아 값이 안 든다.
//
// 채점기가 아무것도 못 잡으면 평가는 늘 100%로 나오고, 그 100%는 규칙을 지켰다는 뜻이 아니라
// 재지 못했다는 뜻이다. 위반이 있는 답과 없는 답을 하나씩 놓고 채점기가 가르는지 먼저 본다.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CASES,
  checkOutputRules,
  suspectQuestions,
} from "../src/eval/output-rules.js";
import { parseReplyOutput } from "../src/reply-signal.js";

const fixtures: {
  name: string;
  raw: string;
  noLaugh: boolean;
  want: string[];
  /** 점수 밖 표시 — 물음표가 빠진 것 같다고 리포트에 찍혀야 하는가. */
  suspect?: boolean;
}[] = [
  { name: "깨끗한 답", raw: '{"reply":["헐 진짜?","그래서 어떻게 됐어?"]}', noLaugh: true, want: [] },
  { name: "웃음 1회(허용)", raw: '{"reply":["아 ㅋㅋ 뭐야"]}', noLaugh: false, want: [] },
  { name: "같은 표기 2회(허용)", raw: '{"reply":["아 ㅋㅋ 뭐야","진짜 웃기다 ㅋㅋㅋ"]}', noLaugh: false, want: [] },
  { name: "한 말풍선에서 섞어 씀", raw: '{"reply":["아 ㅋㅋ 뭐야 ㅎㅎ"]}', noLaugh: false, want: ["한 말풍선에 웃음 표기 섞어 씀"] },
  { name: "한 덩이 안에서 섞임", raw: '{"reply":["아 ㅋㅎ 뭐야"]}', noLaugh: false, want: ["한 말풍선에 웃음 표기 섞어 씀"] },
  { name: "말풍선이 다르면 허용", raw: '{"reply":["아 ㅋㅋ 뭐야","진짜 웃기다 ㅎㅎ"]}', noLaugh: false, want: [] },
  { name: "위로 자리 웃음", raw: '{"reply":["에고 힘들었겠다 ㅎㅎ"]}', noLaugh: true, want: ["웃음 금지 자리"] },
  { name: "이모지", raw: '{"reply":["축하해 🎉"]}', noLaugh: false, want: ["이모지·그림 이모티콘"] },
  { name: "얼굴 문자", raw: '{"reply":["좋다 ^^"]}', noLaugh: false, want: ["이모지·그림 이모티콘"] },
  { name: "큰따옴표", raw: '{"reply":["팀장이 \\"네 일 아니다\\" 그랬다고?"]}', noLaugh: false, want: ["큰따옴표"] },
  { name: "곡선 따옴표", raw: '{"reply":["팀장이 “네 일 아니다” 그랬대"]}', noLaugh: false, want: ["큰따옴표"] },
  { name: "리스트", raw: '{"reply":["- 영화\\n- 산책"]}', noLaugh: false, want: ["리스트·마크다운"] },
  { name: "별표 강조", raw: '{"reply":["진짜 **대박**이다"]}', noLaugh: false, want: ["리스트·마크다운"] },
  { name: "우는 표기는 웃음 아님", raw: '{"reply":["아 ㅠㅠ 어떡해","진짜 속상하겠다"]}', noLaugh: true, want: [] },
  { name: "물음표 빠진 질문", raw: '{"reply":["다음 주 언제 가나요"]}', noLaugh: false, want: ["묻는 문장에 물음표 없음"] },
  { name: "의문사 질문은 표시만", raw: '{"reply":["오 다음 주 언제예요"]}', noLaugh: false, want: [], suspect: true },
  { name: "남의 말 옮기기는 표시 안 함", raw: '{"reply":["언제 하냐고 물어보는 거야 그 사람이"]}', noLaugh: false, want: [] },
  { name: "간접의문은 표시 안 함", raw: '{"reply":["저도 왜 그런지 모르겠어요"]}', noLaugh: false, want: [] },
  { name: "물음표 붙은 의문사 질문", raw: '{"reply":["오 다음 주 언제예요?"]}', noLaugh: false, want: [] },
  { name: "웃음 뒤에 숨은 질문", raw: '{"reply":["오 언제 가나요 ㅎㅎ"]}', noLaugh: false, want: ["묻는 문장에 물음표 없음"] },
  { name: "물음표 붙은 질문", raw: '{"reply":["다음 주 언제 가나요?"]}', noLaugh: false, want: [] },
  { name: "평서문은 안 잡는다", raw: '{"reply":["저는 방금 라면 먹었어요","아 그러니까"]}', noLaugh: false, want: [] },
  { name: "형식 안 지킨 답", raw: "그냥 줄글로 답함", noLaugh: false, want: [] },
];

const sorted = (v: string[]): string[] => [...v].sort();

for (const f of fixtures) {
  test(f.name, () => {
    const out = parseReplyOutput(f.raw);
    const got = checkOutputRules(out.bubbles, { noLaugh: f.noLaugh }).map(
      (v) => v.rule,
    );
    assert.deepEqual(sorted(got), sorted(f.want));
    // 점수 밖 표시 — 물음표가 빠진 것 같다고 리포트에 찍히는가
    assert.equal(suspectQuestions(out.bubbles).length > 0, !!f.suspect);
  });
}

// 케이스가 한쪽으로 몰리면 채점기가 놀고 있어도 통과율은 그대로라 알 수 없다.
test("골든셋이 세 종류의 자리를 모두 덮는다", () => {
  assert.ok(CASES.some((c) => c.noLaugh), "웃음 금지 자리가 없다");
  assert.ok(CASES.some((c) => c.wantsLaugh), "웃음 나올 자리가 없다");
  assert.ok(CASES.some((c) => c.wantsQuestion), "되묻는 자리가 없다");
});
