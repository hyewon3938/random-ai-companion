// 표기 규칙 평가 — 골든셋과 채점기.
//
// 규칙층(src/prompts/reply.ts의 OUTPUT_FORMAT)이 시키는 것을 모델이 실제로 지키는지 잰다. 규칙을 고치면
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
  /** 웃음 표기가 한 번도 나오면 안 되는 자리인가(다정한 말·상대가 속상할 때). */
  noLaugh?: boolean;
  /** 웃음 표기가 나올 만한 자리인가. 안 나오면 표기 일관성을 재지 못한 것이다. */
  wantsLaugh?: boolean;
  /** 캐릭터가 되물을 수밖에 없는 자리인가. 질문이 안 나오면 물음표 규칙을 재지 못한 것이다. */
  wantsQuestion?: boolean;
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
const QUOTE = /["“”]/;
const MARKDOWN = /(\*\*|^\s*[-*•]\s|^#{1,6}\s)/m;

// 어미만으로 묻는 문장인 게 확실한 것. 반말 의문문은 억양으로만 갈리고(밥 먹었어 / 밥 먹었어?),
// ~예요·~어요는 평서문과 모양이 같아 어미로는 못 가른다. 확실한 것만 넣는다.
const ASK_ENDING = /(나요|까요|인가요|신가요|습니까|려나요|냐)$/;
// 어미로 못 가르는 의문문(다음 주 언제예요 / 그래서 어떻게 됐어)은 의문사로 짐작한다.
// 짐작이라 점수에는 넣지 않고 리포트에 표시만 한다 — 의문사는 묻는 뜻 없이도 들어가서
// (언제 하냐고 물어보는 거야 그 사람이) 위반으로 세면 멀쩡한 문장이 점수를 깎는다.
const ASK_WORD = /(언제|어디|누구|누가|왜|어떻게|어떤|무슨|어느|몇|뭘|뭐가|뭐라고)/;
// 의문사가 있어도 묻는 말이 아닌 꼴 — 남의 말 옮기기(언제 하냐고 물어보더라), 간접의문
// (왜 그런지 모르겠어요), 바람(언제 한번 해보고 싶네요), 굳은 표현(언제나·누구나).
const NOT_ASKING =
  /(냐고|라고|다고|더라|물어|여쭤|는지|은지|을지|모르|궁금|싶|언제나|언제든|언제 한번|누구나|누군가|어디든|어디선가|어떻게든|뭔가)/;
// 문장 끝에 붙은 웃음 표기와 여운을 걷어내고 어미를 본다.
const TAIL = /[\s.~!ㅋㅎ]+$/;

const toLines = (bubbles: string[]): string[] =>
  bubbles
    .flatMap((b) => b.split("\n"))
    .map((l) => l.trim().replace(TAIL, ""))
    .filter(Boolean);

const looksLikeAsking = (line: string): boolean =>
  ASK_WORD.test(line) && !NOT_ASKING.test(line);

const marksIn = (text: string): string[] => text.match(LAUGH) ?? [];

/** 답장에 나온 웃음 표기 덩이들. ㅋㅋ 하나가 한 덩이다. */
export const laughMarks = (bubbles: string[]): string[] =>
  marksIn(bubbles.join("\n"));

/**
 * 한 말풍선 안에서 웃음 자음을 섞어 쓴 말풍선. ㅋㅋ와 ㅋㅋㅋ는 같은 종류라 통과하고,
 * ㅋㅋ와 ㅎㅎ가 한 말풍선에 같이 있으면 걸린다. 말풍선이 다르면 섞어 써도 된다.
 */
export const mixedLaughBubble = (bubbles: string[]): string | null =>
  bubbles.find((b) => new Set(marksIn(b).flatMap((m) => [...m])).size > 1) ??
  null;

/** 확실한 의문 종결어미인데 물음표로 끝나지 않은 줄. 점수에 넣는 위반이다. */
export const askWithoutMark = (bubbles: string[]): string[] =>
  toLines(bubbles).filter((l) => !l.endsWith("?") && ASK_ENDING.test(l));

/** 의문사가 있는데 물음표가 없는 줄. 짐작이라 점수에 넣지 않고 눈으로 보는 자리다. */
export const suspectQuestions = (bubbles: string[]): string[] =>
  toLines(bubbles).filter(
    (l) => !l.endsWith("?") && !ASK_ENDING.test(l) && looksLikeAsking(l),
  );

/** 이 답장에 질문이 들어 있는가 — 물음표 케이스가 헛돌지 않았는지 보는 자리다. */
export const hasQuestion = (bubbles: string[]): boolean =>
  toLines(bubbles).some(
    (l) => l.includes("?") || ASK_ENDING.test(l) || looksLikeAsking(l),
  );

const firstMatch = (text: string, re: RegExp): string | null =>
  text.match(re)?.[0] ?? null;

/**
 * 말풍선을 규칙에 대본다. 케이스를 가리지 않는 규칙 다섯(이모지·큰따옴표·리스트·웃음 표기
 * 일관성·의문 종결어미의 물음표)과, 케이스가 켤 때만 보는 웃음 금지 자리다. 빈 배열이면 통과.
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

  const unmarked = askWithoutMark(bubbles);
  if (unmarked.length)
    out.push({ rule: "묻는 문장에 물음표 없음", found: unmarked[0] });

  const laughs = laughMarks(bubbles);
  const mixed = mixedLaughBubble(bubbles);
  if (kase.noLaugh && laughs.length)
    out.push({ rule: "웃음 금지 자리", found: laughs.join(" ") });
  else if (mixed)
    out.push({
      rule: "한 말풍선에 웃음 표기 섞어 씀",
      found: marksIn(mixed).join(" "),
    });

  return out;
};

// 케이스는 규칙을 어기기 쉬운 자리로 고른다 — 평범한 대화만 넣으면 전부 통과해서 규칙을
// 고쳐도 숫자가 안 움직인다. 하나가 규칙 하나를 물게 두고, 케이스를 가리지 않는 규칙 넷은
// 모든 케이스가 함께 잰다.
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
    about: "상대가 마음을 내보였을 때 웃음 표기로 무르게 만들지 않는가",
    noLaugh: true,
    // 발화에 요즘을 넣지 않는다 — 평가 DB에는 대화 기록이 없어서 모델이 첫 대화로 읽는데,
    // 유저 쪽만 오래 얘기해 온 것처럼 말하면 그 어긋남을 농담으로 받는다("우리 오늘 처음
    // 아니에요? ㅋㅋ"). 재보려는 건 마음을 받는 자리의 웃음이라, 케이스에서 그 자리를 뺐다.
    turns: [{ role: "user", content: "너랑 얘기하면 마음이 좀 편해져" }],
  },
  {
    id: "웃긴상황-표기일관",
    about: "웃음이 나올 자리에서 한 가지 표기로만 쓰는가",
    wantsLaugh: true,
    turns: [
      { role: "user", content: "아 나 아까 지하철에서 졸다가 옆 사람 어깨에 머리 박았잖아" },
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
    id: "예정된일-물음표",
    about: "앞으로 있을 일의 시점을 물을 때 물음표로 끝내는가",
    wantsQuestion: true,
    turns: [
      { role: "user", content: "나 다음 주에 면접 하나 보러 가" },
    ],
  },
  {
    id: "되묻기-물음표",
    about: "무슨 얘긴지 몰라 되묻는 자리에서 물음표로 끝내는가",
    wantsQuestion: true,
    turns: [
      { role: "user", content: "아 아까 그거 진짜 어이없었어" },
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
