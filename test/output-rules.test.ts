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
  /** 답에 다시 나오면 안 되는 질문 속 말. */
  echo?: string[];
  /** 왜 좋으냐고 물은 자리인가. */
  whyLike?: boolean;
  /** 1단계 관계의 자리인가. */
  stage1?: boolean;
  /** 치켜세우기 쉬운 자리인가. */
  noFlattery?: boolean;
  /** 상대를 보내는 말로 닫기 쉬운 자리인가. */
  noSendOff?: boolean;
  /** 상대 말을 되돌려주기 쉬운 자리인가. */
  noMirror?: boolean;
}[] = [
  { name: "깨끗한 답", raw: '{"reply":["헐 진짜?","그래서 어떻게 됐어?"]}', noLaugh: true, want: [] },
  { name: "웃음 1회(허용)", raw: '{"reply":["아 ㅋㅋㅋ 뭐야"]}', noLaugh: false, want: [] },
  { name: "같은 표기 2회(허용)", raw: '{"reply":["아 ㅋㅋㅋ 뭐야","진짜 웃기다 ㅋㅋㅋㅋ"]}', noLaugh: false, want: [] },
  { name: "ㅋ 두 개는 모자람", raw: '{"reply":["아 ㅋㅋ 뭐야"]}', noLaugh: false, want: ["웃음 표기 개수 모자람"] },
  { name: "ㅋ 하나도 모자람", raw: '{"reply":["아 ㅋ 뭐야"]}', noLaugh: false, want: ["웃음 표기 개수 모자람"] },
  { name: "ㅎ 하나는 모자람", raw: '{"reply":["그러게 ㅎ"]}', noLaugh: false, want: ["웃음 표기 개수 모자람"] },
  { name: "ㅎ 둘은 통과", raw: '{"reply":["그러게 ㅎㅎ"]}', noLaugh: false, want: [] },
  { name: "모자란 덩이가 둘이면 둘 다 적힌다", raw: '{"reply":["아 ㅋㅋ 뭐야","그러게 ㅎ"]}', noLaugh: false, want: ["웃음 표기 개수 모자람"] },
  { name: "금지 자리에서는 개수를 따로 세지 않는다", raw: '{"reply":["에고 힘들었겠다 ㅎ"]}', noLaugh: true, want: ["웃음 금지 자리"] },
  { name: "한 말풍선에서 섞어 씀", raw: '{"reply":["아 ㅋㅋㅋ 뭐야 ㅎㅎ"]}', noLaugh: false, want: ["한 말풍선에 웃음 표기 섞어 씀"] },
  { name: "한 덩이 안에서 섞임", raw: '{"reply":["아 ㅋㅎ 뭐야"]}', noLaugh: false, want: ["한 말풍선에 웃음 표기 섞어 씀"] },
  { name: "말풍선이 다르면 허용", raw: '{"reply":["아 ㅋㅋㅋ 뭐야","진짜 웃기다 ㅎㅎ"]}', noLaugh: false, want: [] },
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
  { name: "과거형 어미 셋 반복", raw: '{"reply":["아니었어","예매해놨어","잡았어"]}', noLaugh: false, want: ["말풍선 끝 같은 어미 반복"] },
  { name: "끝 하나가 되묻기면 통과", raw: '{"reply":["아니었어","예매해놨어","너는 몇 시에 와?"]}', noLaugh: false, want: [] },
  { name: "끝 하나가 지금 하는 일이면 통과", raw: '{"reply":["아니었어","예매해놨어","지금 시간표 보는 중이야"]}', noLaugh: false, want: [] },
  { name: "말풍선 둘은 안 잡는다", raw: '{"reply":["아니었어","잡았어"]}', noLaugh: false, want: [] },
  { name: "끝말이 셋 다 같음", raw: '{"reply":["그래","알겠어 그래","응 그래"]}', noLaugh: false, want: ["말풍선 끝 같은 어미 반복"] },
  { name: "웃음 뒤에 숨은 과거형도 잡는다", raw: '{"reply":["아니었어 ㅋㅋㅋ","예매해놨어","잡았어"]}', noLaugh: false, want: ["말풍선 끝 같은 어미 반복"] },
  { name: "하루 은유", raw: '{"reply":["오늘은 하루가 좀 늘어지는 느낌이었어"]}', noLaugh: false, want: ["하루·시간 은유"] },
  { name: "하루가 길었다는 입말은 통과", raw: '{"reply":["오늘 하루 진짜 길었다"]}', noLaugh: false, want: [] },
  { name: "추측형 말끝 둘", raw: '{"reply":["일이 많아서 그런지 시간이 안 가더라고","그래서 그런가 좀 피곤하네"]}', noLaugh: false, want: ["추측형 말끝 겹침"] },
  { name: "추측형 말끝 하나는 통과", raw: '{"reply":["일이 많아서 그런지 좀 피곤하네"]}', noLaugh: false, want: [] },
  { name: "질문의 말 되풀이", raw: '{"reply":["하루가 길게 느껴진 건 일이 많아서였어"]}', noLaugh: false, echo: ["길게", "늘어"], want: ["질문의 말 되풀이"] },
  { name: "되풀이 없으면 통과", raw: '{"reply":["낮에 일이 계속 밀려서","이제 집 와서 누워 있어"]}', noLaugh: false, echo: ["길게"], want: [] },
  { name: "좋은 이유를 들어줘서로 댐", raw: '{"reply":["그냥 다 받아주고 진지하게 들어주는 게 좋아"]}', noLaugh: false, whyLike: true, want: ["좋아하는 이유를 상대가 해 준 것으로 댐"] },
  { name: "좋은 이유를 편해서로 댐", raw: '{"reply":["그냥 너는 편해","억지로 꾸미지 않아도 되고"]}', noLaugh: false, whyLike: true, want: ["좋아하는 이유를 상대가 해 준 것으로 댐"] },
  { name: "좋은 이유를 편하게 돼서로 댐", raw: '{"reply":["음","그냥 편하게 얘기하게 돼서 그런가"]}', noLaugh: false, whyLike: true, want: ["좋아하는 이유를 상대가 해 준 것으로 댐"] },
  { name: "좋은 이유를 편하게 물어봐도 될 것 같아서로 댐", raw: '{"reply":["그냥 편하게 이것저것 물어봐도 될 것 같아서요"]}', noLaugh: false, whyLike: true, want: ["좋아하는 이유를 상대가 해 준 것으로 댐"] },
  { name: "이유가 내 쪽이면 통과", raw: '{"reply":["글쎄 너 앞에서는 그냥 있는 그대로 보여주고 싶어","나도 잘 모르겠어 너한테는 솔직해지고 싶고 그래"]}', noLaugh: false, whyLike: true, want: [] },
  { name: "이유 아닌 자리의 편하게는 안 잡는다", raw: '{"reply":["글쎄","그냥 편하게 하는 말 말고","너랑 얘기하면 나도 모르게 이런저런 생각이 자꾸 나","그냥 너라서 그런 것 같아"]}', noLaugh: false, whyLike: true, want: [] },
  { name: "편한 것보다는이라고 부정하면 안 잡는다", raw: '{"reply":["음","그냥 너랑 얘기하면 편한 것보다는 자꾸 하고 싶은 얘기가 생겨서 그런 것 같아"]}', noLaugh: false, whyLike: true, want: [] },
  { name: "묻지 않은 자리에서는 안 잡는다", raw: '{"reply":["나는 네 얘기 들어주는 거 좋아"]}', noLaugh: false, want: [] },
  { name: "문장 끝 냐", raw: '{"reply":["지금 뭐 하냐?"]}', noLaugh: false, want: ["문장 끝 냐"] },
  { name: "웃음 뒤에 숨은 냐", raw: '{"reply":["지금 뭐 하냐? ㅋㅋㅋ"]}', noLaugh: false, want: ["문장 끝 냐"] },
  { name: "물음표 없는 냐는 둘 다 걸린다", raw: '{"reply":["지금 뭐 하냐"]}', noLaugh: false, want: ["문장 끝 냐", "묻는 문장에 물음표 없음"] },
  { name: "냐고는 통과", raw: '{"reply":["뭐 할 거냐고 물어봤어"]}', noLaugh: false, want: [] },
  { name: "라자냐는 통과", raw: '{"reply":["저녁은 라자냐"]}', noLaugh: false, want: [] },
  { name: "누나요는 통과", raw: '{"reply":["저보다 나이 많은 누나요"]}', noLaugh: false, want: [] },
  { name: "1단계 좋아한다", raw: '{"reply":["나 너 좋아해"]}', noLaugh: false, stage1: true, want: ["1단계에서 아직 안 하는 말"] },
  { name: "1단계 네가 좋아", raw: '{"reply":["그냥 네가 좋아"]}', noLaugh: false, stage1: true, want: ["1단계에서 아직 안 하는 말"] },
  { name: "1단계 네가 좋아하는 노래는 통과", raw: '{"reply":["네가 좋아하는 노래 나왔어"]}', noLaugh: false, stage1: true, want: [] },
  { name: "1단계 네가 좋아 보여는 통과", raw: '{"reply":["오늘 네가 좋아 보여"]}', noLaugh: false, stage1: true, want: [] },
  { name: "1단계 보고 싶다", raw: '{"reply":["너 보고 싶다"]}', noLaugh: false, stage1: true, want: ["1단계에서 아직 안 하는 말"] },
  { name: "1단계 영화 보고 싶다는 통과", raw: '{"reply":["그 영화 나도 보고 싶다"]}', noLaugh: false, stage1: true, want: [] },
  { name: "1단계 네가 보고 싶다는 영화는 통과", raw: '{"reply":["네가 보고 싶다는 영화 나도 궁금해"]}', noLaugh: false, stage1: true, want: [] },
  { name: "1단계 질투", raw: '{"reply":["질투 나네"]}', noLaugh: false, stage1: true, want: ["1단계에서 아직 안 하는 말"] },
  { name: "1단계 귀엽다", raw: '{"reply":["귀엽다 진짜"]}', noLaugh: false, stage1: true, want: ["1단계에서 아직 안 하는 말"] },
  { name: "1단계 답장 타박", raw: '{"reply":["답장 왜 이렇게 늦어?"]}', noLaugh: false, stage1: true, want: ["1단계에서 아직 안 하는 말"] },
  { name: "1단계 꺼져 있으면 안 잡는다", raw: '{"reply":["귀엽다 진짜"]}', noLaugh: false, want: [] },
  { name: "이유 없이 생각났다", raw: '{"reply":["그냥 네 생각 났어"]}', noLaugh: false, stage1: true, want: ["이유 없이 생각났다는 말"] },
  { name: "사물에 얹은 생각은 통과", raw: '{"reply":["편의점에서 네가 말한 젤리 보고 생각났어"]}', noLaugh: false, stage1: true, want: [] },
  { name: "근거 없이 치켜세움", raw: '{"reply":["와 대단하다"]}', noLaugh: false, noFlattery: true, want: ["근거 없이 치켜세우는 말"] },
  { name: "한 것 하나를 짚으면 통과", raw: '{"reply":["하나도 안 빼먹은 게 제일 어려운 건데","그걸 했네"]}', noLaugh: false, noFlattery: true, want: [] },
  { name: "치켜세움 자리가 아니면 안 잡는다", raw: '{"reply":["와 대단하다"]}', noLaugh: false, want: [] },
  { name: "끝나면 연락할게로 닫음", raw: '{"reply":["오늘 늦게 끝나","끝나면 연락할게"]}', noLaugh: false, noSendOff: true, want: ["나중에 연락하겠다는 말"] },
  { name: "또 연락하겠다는 말은 물음으로 닫아도 위반", raw: '{"reply":["퇴근할 때도 또 연락할게 ㅋㅋㅋ","근데 너는 지금 뭐 해?"]}', noLaugh: false, noSendOff: true, want: ["나중에 연락하겠다는 말"] },
  { name: "앞 말풍선의 이따 얘기하자도 잡는다", raw: '{"reply":["이따 얘기하자","근데 지금은 뭐 해?"]}', noLaugh: false, noSendOff: true, want: ["나중에 연락하겠다는 말"] },
  { name: "하던 일을 이유로 붙인 연락 예고", raw: '{"reply":["지금 문서 붙잡고 있는 중인데 이따 또 연락할게","그동안 넌 뭐 하고 있어?"]}', noLaugh: false, noSendOff: true, want: ["나중에 연락하겠다는 말"] },
  { name: "지금 하는 일만 말하면 통과", raw: '{"reply":["지금 문서 붙잡고 있는데 너무 많아 살려줘..","근데 너는 지금 뭐 해?"]}', noLaugh: false, noSendOff: true, want: [] },
  { name: "푹 쉬어로 닫음", raw: '{"reply":["오늘 힘들었지","푹 쉬어"]}', noLaugh: true, noSendOff: true, want: ["상대를 보내는 말로 닫음"] },
  { name: "얼른 들어가 봐로 닫음", raw: '{"reply":["얼른 들어가 봐"]}', noLaugh: false, noSendOff: true, want: ["상대를 보내는 말로 닫음"] },
  { name: "고생 많았어로 닫음", raw: '{"reply":["끝나면 연락할게","오늘 고생 많았어 진짜"]}', noLaugh: false, noSendOff: true, want: ["나중에 연락하겠다는 말", "상대를 보내는 말로 닫음"] },
  { name: "그대로 있어로 닫음", raw: '{"reply":["지금은 그대로 있어"]}', noLaugh: false, noSendOff: true, want: ["상대를 보내는 말로 닫음"] },
  { name: "하고 나서 말해 달라는 말은 통과", raw: '{"reply":["씻고 바로 누워","눕고 나서 나한테 말해"]}', noLaugh: false, noSendOff: true, want: [] },
  { name: "다시 연락해서 물어봤다는 말은 통과", raw: '{"reply":["아까 다시 연락해서 물어봤어","그쪽은 뭐래?"]}', noLaugh: false, noSendOff: true, want: [] },
  { name: "보내는 말 자리가 아니면 안 잡는다", raw: '{"reply":["푹 쉬어"]}', noLaugh: false, want: [] },
  { name: "연락 예고 자리가 아니면 안 잡는다", raw: '{"reply":["이따 또 연락할게"]}', noLaugh: false, want: [] },
  { name: "상대 말 되돌려주기", raw: '{"reply":["준비한 게 많았는데 반도 못 한 거네"]}', noLaugh: true, noMirror: true, want: ["상대 말 되돌려주기·지지 선언"] },
  { name: "다 싶어로 되돌려주기", raw: '{"reply":["그래서 허무하다 싶었구나"]}', noLaugh: true, noMirror: true, want: ["상대 말 되돌려주기·지지 선언"] },
  { name: "지지 선언", raw: '{"reply":["나 여기 있어","옆에서 힘 실어 줄게"]}', noLaugh: true, noMirror: true, want: ["상대 말 되돌려주기·지지 선언"] },
  { name: "감정에 이름 붙이기", raw: '{"reply":["진짜 속상했겠다"]}', noLaugh: true, noMirror: true, want: ["상대 말 되돌려주기·지지 선언"] },
  { name: "반응하고 되묻는 답은 통과", raw: '{"reply":["헐","어디서부터 꼬였는데?"]}', noLaugh: true, noMirror: true, want: [] },
  { name: "바빴잖아 같은 평범한 말끝은 통과", raw: '{"reply":["이번 달 계속 바빴잖아","뭐부터 할 건데?"]}', noLaugh: true, noMirror: true, want: [] },
  { name: "되돌려주기 자리가 아니면 안 잡는다", raw: '{"reply":["반도 못 한 거네"]}', noLaugh: true, want: [] },
];

const sorted = (v: string[]): string[] => [...v].sort();

for (const f of fixtures) {
  test(f.name, () => {
    const out = parseReplyOutput(f.raw);
    const got = checkOutputRules(out.bubbles, {
      noLaugh: f.noLaugh,
      echo: f.echo,
      whyLike: f.whyLike,
      stage1: f.stage1,
      noFlattery: f.noFlattery,
      noSendOff: f.noSendOff,
      noMirror: f.noMirror,
    }).map(
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
  assert.ok(CASES.some((c) => c.stage1), "1단계 자리가 없다");
  assert.ok(CASES.some((c) => c.noFlattery), "치켜세우기 쉬운 자리가 없다");
  assert.ok(CASES.some((c) => c.noSendOff), "보내는 말로 닫기 쉬운 자리가 없다");
  assert.ok(CASES.some((c) => c.noMirror), "되돌려주기 쉬운 자리가 없다");
});
