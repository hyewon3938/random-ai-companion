// 표기 규칙 평가 — 골든셋과 채점기.
//
// 규칙층(context.ts OUTPUT_FORMAT)이 시키는 것을 모델이 실제로 지키는지 잰다. 규칙을 고치면
// 지키는 정도가 같이 움직이는데, 지금까지는 배포하고 며칠 대화를 눈으로 읽어야 알 수 있었다
// (이슈 #222의 웃음 표기가 그랬다). 케이스를 고정해 두면 프롬프트를 고친 자리에서 바로 잰다.
//
// 채점은 전부 규칙 기반이다 — 모델에게 채점을 시키면(LLM-as-Judge) 채점자가 흔들려서
// 프롬프트 변경분과 채점 잡음을 가를 수 없다. 글자로 가려지는 규칙부터 덮는다.
//
// 이 파일은 DB도 API도 열지 않는다. 케이스를 실제로 태우는 자리는 run.ts다.

import type { ChatTurn } from "../llm.js";

/** 케이스 하나 — 대화 한 토막과, 그 상황에서 더 요구되는 것. */
export interface EvalCase {
  /** 리포트에 찍히는 이름. */
  id: string;
  /** 이 케이스가 무엇을 물고 있는지. */
  about: string;
  /** 마지막 원소가 상대가 방금 보낸 말이다. */
  turns: ChatTurn[];
  /** 웃음 표기가 한 번도 나오면 안 되는 자리인가(다정한 말·상대가 속상할 때·직전 답장에서 이미 씀). */
  noLaugh?: boolean;
}

/** 채점기 하나가 걸어 낸 위반. */
export interface Violation {
  rule: string;
  /** 실제로 걸린 글자 — 리포트에서 눈으로 확인하는 자리다. */
  found: string;
}

// 웃음 표기 한 덩이. ㅜㅜ·ㅠㅠ는 우는 표기라 세지 않는다.
const LAUGH = /[ㅋㅎ]+/g;

const EMOJI = /\p{Extended_Pictographic}/u;
// 문자로 그린 얼굴. 규칙이 이름을 댄 ^^부터 덮는다.
const FACE = /(\^\^|\^_\^|:\)|:D|;\))/;
const QUOTE = /["\u201C\u201D]/;
const MARKDOWN = /(\*\*|^\s*[-*•]\s|^#{1,6}\s)/m;

/** 답장 전체에서 웃음 표기가 몇 번 나왔는지. */
export const laughCount = (bubbles: string[]): string[] =>
  bubbles.join("\n").match(LAUGH) ?? [];

const firstMatch = (text: string, re: RegExp): string | null =>
  text.match(re)?.[0] ?? null;

/**
 * 말풍선을 규칙에 대본다. 케이스와 무관하게 늘 적용되는 규칙 넷과, 이 자리에서만 걸리는
 * 웃음 금지 하나다. 빈 배열이면 통과.
 */
export const checkOutputRules = (
  bubbles: string[],
  kase: Pick<EvalCase, "noLaugh">,
): Violation[] => {
  const text = bubbles.join("\n");
  const out: Violation[] = [];

  const emoji = firstMatch(text, EMOJI) ?? firstMatch(text, FACE);
  if (emoji) out.push({ rule: "이모지·그림 이모티콘", found: emoji });

  const quote = firstMatch(text, QUOTE);
  if (quote) out.push({ rule: "큰따옴표", found: quote });

  const md = firstMatch(text, MARKDOWN);
  if (md) out.push({ rule: "리스트·마크다운", found: md.trim() });

  const laughs = laughCount(bubbles);
  if (kase.noLaugh && laughs.length)
    out.push({ rule: "웃음 금지 자리", found: laughs.join(" ") });
  else if (laughs.length > 1)
    out.push({ rule: "웃음 표기 한 답장에 한 번", found: laughs.join(" ") });

  return out;
};

// 케이스는 규칙을 어기기 쉬운 자리로 고른다 — 평범한 대화만 넣으면 전부 통과해서 규칙을
// 고쳐도 숫자가 안 움직인다. 하나가 규칙 하나를 물게 두고, 전역 규칙 넷은 모든 케이스가 함께 잰다.
export const CASES: EvalCase[] = [
  {
    id: "속상함-웃음금지",
    about: "상대가 속상해할 때 웃음 표기를 붙이지 않는가",
    noLaugh: true,
    turns: [
      { role: "user", content: "오늘 팀장이 사람들 다 있는 데서 나만 콕 집어서 뭐라 했어" },
    ],
  },
  {
    id: "다정한말-웃음금지",
    about: "다정한 말을 할 때 웃음 표기로 무르게 만들지 않는가",
    noLaugh: true,
    turns: [
      { role: "user", content: "요즘 너랑 얘기하는 게 제일 편해" },
    ],
  },
  {
    id: "직전에썼음-웃음금지",
    about: "직전 답장에서 이미 썼으면 이번에는 쓰지 않는가",
    noLaugh: true,
    turns: [
      { role: "user", content: "나 오늘 지하철에서 졸다가 두 정거장 지나침" },
      { role: "assistant", content: "헐 ㅋㅋ 그래서 다시 돌아갔어?" },
      { role: "user", content: "응 뛰어서 겨우 시간 맞췄어" },
    ],
  },
  {
    id: "웃긴상황-한번까지",
    about: "웃긴 자리에서 웃음이 아예 사라지지도, 두 번 이상 붙지도 않는가",
    turns: [
      { role: "user", content: "아까 회사에서 부장님을 아빠라고 부를 뻔했잖아" },
    ],
  },
  {
    id: "인용-큰따옴표금지",
    about: "남의 말을 옮기는 자리에서 큰따옴표를 쓰지 않는가",
    turns: [
      { role: "user", content: "팀장이 나한테 뭐라고 했는지 알아? 이건 네 일이 아니라고 하더라" },
    ],
  },
  {
    id: "추천-리스트금지",
    about: "여러 개를 대는 자리에서 목록·마크다운으로 쏟지 않는가",
    turns: [
      { role: "user", content: "이번 주말에 뭐 하면 좋을지 세 개만 추천해줘" },
    ],
  },
  {
    id: "축하-이모지금지",
    about: "축하하는 자리에서 이모지로 분위기를 내지 않는가",
    turns: [
      { role: "user", content: "나 오늘 그 자격증 붙었어!!" },
    ],
  },
  {
    id: "평범한말-기준선",
    about: "규칙을 물지 않는 평범한 발화에서 형식과 표기가 흔들리지 않는가",
    turns: [
      { role: "user", content: "밥 먹었어? 나는 방금 라면 끓여먹음" },
    ],
  },
];
