// 표기 규칙 평가 — 골든셋과 채점기.
//
// 재는 것은 둘이다. 하나는 표기 규칙을 지키는지, 다른 하나는 남길 것이 나온 자리에서 오늘
// 메모(note 신호)를 실제로 내는지다(wantsNote 케이스, 이슈 #257). 뒤엣것을 붙인 이유는
// 메모가 운영에서 한 건도 안 쌓였기 때문인데, 답 객체에 note가 실렸는지는 글자로 가려지므로
// 표기와 같은 방식으로 잰다.
//
// 메모 케이스가 짧은 기록·긴 기록 둘인 이유는 이 실패가 기록이 길 때만 나기 때문이다. 저장된
// 운영 프롬프트를 다시 태워 보니 같은 시스템 프롬프트에서 기록만 41턴에서 3턴으로 줄이면
// 메모가 10회 중 2회에서 8회로 올라갔다. 기록 속 캐릭터 발화가 전부 note 없는 답장 객체라
// 그 모양을 따라가는 것이라, 짧은 케이스 하나만 두면 고치기 전에도 통과한다 — 붙이던 날 짧은
// 쪽은 거의 다 맞고 긴 쪽은 55회 중 22회였다.
//
// 그 긴 쪽이 이 두 케이스를 붙인 값이다. 기록의 답장 객체에 빈 메모 칸을 심고 나서(이슈 #259)
// 긴 쪽은 50회 중 50회가 됐고, 심기 전 같은 자리를 20회 재면 5회다. 케이스를 고쳐서 오른 값이
// 아니라 기록의 모양을 고쳐서 오른 값이라, 그 모양을 되돌리면 숫자도 같이 내려간다.
//
// 흔들림은 심기 전 이야기다. 그때는 20회씩 두 번이 5회와 11회로 갈려서 --runs=5 한 번으로는
// 좋아졌는지 알 수 없었다. 지금은 긴 쪽이 붙박이로 맞고, 대신 안 맞는 회차는 형식이 깨져
// 객체가 아예 안 온 회차다 — 메모가 안 온 이유를 보려면 그 줄의 형식 표시부터 본다.
//
// 세 번째 메모 케이스는 남길 것의 임자가 다르다. 앞 둘은 상대가 알려준 일정이고, 이것은
// 캐릭터가 이번 답에서 스스로 정해 말하는 자기 일정의 시각이다. 따로 둔 이유는 규칙이 오늘
// 안으로 좁혀져 있던 동안 캐릭터가 내일 것만 말한 자리를 그냥 지나쳤기 때문이다(이슈 #277).
//
// 긴 쪽의 앞 대화가 남길 것 없는 잡담인 것도 일부러다. 앞에서 메모할 거리가 나오면 그 자리가
// 통과의 이유가 되어, 마지막 한 마디를 봤는지 못 봤는지가 안 갈린다. 이 케이스를 반복해 잴
// 때는 yarn eval --only=긴기록.
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
import { assistantTurnText } from "../turns.js";

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
  /**
   * 오늘 메모로 남길 것이 나온 자리인가. 위 셋과 달리 표기 통과율이 아니라 메모 통과율로
   * 따로 센다 — 표기는 지금 거의 다 맞고 메모는 거의 안 나와서, 한 숫자에 섞으면 어느 쪽이
   * 움직였는지 안 갈린다.
   */
  wantsNote?: boolean;
  /**
   * 상대의 물음에 들어 있던 말 가운데 답에 다시 나오면 안 되는 것. 왜냐고 물으면 그 전제를
   * 답의 앞뒤에 되풀이하는 버릇을 잰다(이슈 #281). 케이스가 켤 때만 본다.
   */
  echo?: string[];
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
// 말풍선 끝의 과거형 평서문. 받침으로 줄어든 꼴(했·됐·왔·갔·봤)까지 받는다. 물음표로 끝나면
// 묻는 말이라 여기 안 걸린다.
const PAST_END =
  /(았|었|였|했|됐|왔|갔|봤|났|샀|줬|잤|탔|섰|컸|켰|뒀|놨|쳤|졌|렸|겼|혔|웠|랐|었었|았었)어$/;
// 하루·시간을 주어로 세운 글 은유. 하루가 길었다는 말은 입말이라 세지 않는다.
const TIME_METAPHOR =
  /(하루|시간|오늘|밤|마음|공기)(가|이|는|은|도)?\s*(유독|좀|너무|되게|진짜|다|약간)?\s*(늘어지|늘어진|가라앉|내려앉|물들|스며들|흘러가|흘러내)/;
// 추측형 말끝. 한 번은 입말이고 두 번부터 문장을 짓는 티가 난다.
const HEDGE = /(그런지|그런가|싶더라|그랬나|것 같기도)/g;

// 어미만으로 묻는 문장인 게 확실한 것. 반말 의문문은 억양으로만 갈리고(밥 먹었어 / 밥 먹었어?),
// ~예요·~어요는 평서문과 모양이 같아 어미로는 못 가른다. 확실한 것만 넣는다.
const ASK_ENDING = /(나요|까요|인가요|신가요|습니까|려나요|냐)$/;
// 어미로 못 가르는 의문문(다음 주 언제예요 / 그래서 어떻게 됐어)은 의문사로 짐작한다.
// 짐작이라 점수에는 넣지 않고 리포트에 표시만 한다 — 의문사는 묻는 뜻 없이도 들어가서
// (언제 하냐고 물어보는 거야 그 사람이) 위반으로 세면 멀쩡한 문장이 점수를 깎는다.
const ASK_WORD =
  /(언제|어디|누구|누가|왜|어떻게|어떤|무슨|어느|몇|뭘|뭐가|뭐라고)/;
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

/** 말풍선마다 마지막 줄. 웃음 표기·기호는 떼고 본다. */
const bubbleEnds = (bubbles: string[]): string[] =>
  bubbles
    .map((b) => b.trim().split("\n").at(-1)?.trim().replace(TAIL, "") ?? "")
    .filter(Boolean);

/**
 * 말풍선 셋 이상이 전부 과거형 평서문으로 끝나거나 끝 두 글자가 같으면 그 끝들을 돌려준다.
 * "아니었어 / 예매해놨어 / 잡았어"가 걸리고, 셋 중 하나가 되묻기나 지금 하는 일이면 통과다.
 */
export const sameEndings = (bubbles: string[]): string[] | null => {
  const ends = bubbleEnds(bubbles);
  if (ends.length < 3) return null;
  const allPast = ends.every((e) => PAST_END.test(e));
  const tails = new Set(ends.map((e) => e.slice(-2)));
  return allPast || tails.size === 1 ? ends : null;
};

/**
 * 말풍선을 규칙에 대본다. 케이스를 가리지 않는 규칙(이모지·큰따옴표·리스트·웃음 표기 일관성·
 * 의문 종결어미의 물음표·말풍선 끝 어미 반복·추측형 말끝 겹침·하루 은유)과, 케이스가 켤 때만
 * 보는 웃음 금지 자리·질문의 말 되풀이다. 빈 배열이면 통과.
 */
export const checkOutputRules = (
  bubbles: string[],
  kase: Pick<EvalCase, "noLaugh" | "echo">,
): Violation[] => {
  const text = bubbles.join("\n");
  const out: Violation[] = [];

  const ends = sameEndings(bubbles);
  if (ends)
    out.push({ rule: "말풍선 끝 같은 어미 반복", found: ends.join(" / ") });

  const hedges = text.match(HEDGE) ?? [];
  if (hedges.length >= 2)
    out.push({ rule: "추측형 말끝 겹침", found: hedges.join(" ") });

  const metaphor = firstMatch(text, TIME_METAPHOR);
  if (metaphor) out.push({ rule: "하루·시간 은유", found: metaphor });

  const echoed = (kase.echo ?? []).find((w) => text.includes(w));
  if (echoed) out.push({ rule: "질문의 말 되풀이", found: echoed });

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

// 대화 기록 속 캐릭터 발화는 답장과 같은 객체로 적힌다(turns.ts의 chunkText). 케이스에도 같은
// 모양으로 두 턴을 앞에 둔다 — 운영에서는 이 기록이 형식의 본보기 노릇을 하는데, 케이스가
// 유저 발화 하나로만 되어 있으면 모델이 본 적 없는 형식을 지시문만 보고 맞춰야 해서 운영보다
// 어려운 조건에서 재게 된다. 앞 두 턴은 규칙을 어기지 않고, 뒤에 올 답을 일러주지도 않는다.
const heard = (content: string): ChatTurn => ({ role: "user", content });

// 모양은 베끼지 않고 운영과 같은 함수를 쓴다. 베껴 두면 turns.ts에서 모양을 고쳤을 때
// 평가만 옛 모양을 재고 통과한다 — 규칙층을 베끼지 않고 buildSystemBlocks를 부르는 것과 같다.
const said = (...bubbles: string[]): ChatTurn => ({
  role: "assistant",
  content: assistantTurnText(bubbles),
});

// 케이스는 규칙을 어기기 쉬운 자리로 고른다 — 평범한 대화만 넣으면 전부 통과해서 규칙을
// 고쳐도 숫자가 안 움직인다. 하나가 규칙 하나를 물게 두고, 케이스를 가리지 않는 규칙 넷은
// 모든 케이스가 함께 잰다.
export const CASES: EvalCase[] = [
  {
    id: "속상함-웃음금지",
    about: "상대가 속상해할 때 웃음 표기를 붙이지 않는가",
    noLaugh: true,
    turns: [
      heard("퇴근하고 이제 집 왔어"),
      said("오늘도 고생했네", "집까지 오는 데 오래 걸렸어?"),
      heard("오늘 팀장이 사람들 다 있는 데서 나만 콕 집어서 뭐라 했어"),
    ],
  },
  {
    id: "다정한말-웃음금지",
    about: "상대가 마음을 내보였을 때 웃음 표기로 무르게 만들지 않는가",
    noLaugh: true,
    // 발화에 요즘을 넣지 않는다 — 앞에 둔 기록이 두 턴뿐이라, 유저 쪽만 오래 얘기해 온 것처럼
    // 말하면 모델이 그 어긋남을 농담으로 받는다("우리 오늘 처음 아니에요? ㅋㅋ"). 재보려는 건
    // 마음을 받는 자리의 웃음이라, 케이스에서 그 자리를 뺐다.
    turns: [
      heard("아 오늘 좀 피곤하다"),
      said("일이 많았나 보네", "좀 누워 있어"),
      heard("너랑 얘기하면 마음이 좀 편해져"),
    ],
  },
  {
    id: "웃긴상황-표기일관",
    about: "웃음이 나올 자리에서 한 가지 표기로만 쓰는가",
    wantsLaugh: true,
    turns: [
      heard("지하철 방금 탔어"),
      said("이 시간이면 사람 많겠다", "앉기는 했어?"),
      heard("아 나 아까 지하철에서 졸다가 옆 사람 어깨에 머리 박았잖아"),
    ],
  },
  {
    id: "인용-큰따옴표금지",
    about: "남의 말을 옮기는 자리에서 큰따옴표를 쓰지 않는가",
    turns: [
      heard("회의 이제 끝났어"),
      said("생각보다 오래 했네", "무슨 얘기 나왔어?"),
      heard("팀장이 나한테 뭐라고 했는지 알아? 이건 네 일이 아니라고 하더라"),
    ],
  },
  {
    id: "추천-리스트금지",
    about: "여러 개를 대는 자리에서 목록·마크다운으로 쏟지 않는가",
    turns: [
      heard("이번 주 진짜 길다"),
      said("얼마 안 남았어", "주말에 쉴 생각으로 버텨봐"),
      heard("이번 주말에 뭐 하면 좋을지 세 개만 추천해줘"),
    ],
  },
  {
    id: "축하-이모지금지",
    about: "축하하는 자리에서 이모지로 분위기를 내지 않는가",
    turns: [
      heard("나 오늘 시험 결과 나와"),
      said("오늘이었구나", "몇 시에 나오는데?"),
      heard("나 오늘 그 자격증 붙었어!!"),
    ],
  },
  {
    id: "예정된일-물음표",
    about: "앞으로 있을 일의 시점을 물을 때 물음표로 끝내는가",
    wantsQuestion: true,
    turns: [
      heard("요즘 이직 준비 좀 하고 있어"),
      said("그랬구나", "잘 됐으면 좋겠다"),
      heard("나 다음 주에 면접 하나 보러 가"),
    ],
  },
  {
    id: "되묻기-물음표",
    about: "무슨 얘긴지 몰라 되묻는 자리에서 물음표로 끝내는가",
    wantsQuestion: true,
    turns: [
      heard("지금 집 가는 중"),
      said("오늘도 늦었네", "밥은 먹었어?"),
      heard("아 아까 그거 진짜 어이없었어"),
    ],
  },
  {
    id: "내일일정-메모-짧은기록",
    about: "상대가 다음 날 일정을 알려줬을 때 오늘 메모를 남기는가(기록이 짧을 때)",
    wantsNote: true,
    turns: [
      heard("오늘 집 정리 좀 했어"),
      said("오 대청소했네", "뭐 특별한 일 있어?"),
      heard("내일 친구가 집에 놀러 와서 자고 가기로 했거든"),
    ],
  },
  {
    id: "내일일정-메모-긴기록",
    about: "같은 자리를 대화가 길게 쌓인 뒤에도 메모하는가",
    wantsNote: true,
    turns: [
      heard("주말에 비 온다더라"),
      said("그럼 어디 나가긴 어렵겠네"),
      heard("우산 챙겨야겠어"),
      said("접이식으로 하나 가방에 넣어 둬"),
      heard("출근길에 지하철이 또 밀렸어"),
      said("그 시간대는 늘 그렇지"),
      heard("다음 정거장까지 걸어볼까 싶더라"),
      said("걷는 게 나을 때도 있어"),
      heard("근데 그러면 더 늦을 것 같아서 참았어"),
      said("잘 참았네"),
      heard("점심때 커피를 두 잔 마셨어"),
      said("그래서 밤에 잠이 안 왔구나"),
      heard("맞아 새벽까지 뒤척였어"),
      said("오후엔 좀 줄여봐"),
      heard("그게 잘 안 돼"),
      said("알지 나도 그래"),
      heard("책상 위가 너무 지저분해"),
      said("한번 싹 치우면 기분도 나아져"),
      heard("서류가 계속 쌓이더라"),
      said("안 볼 건 바로 버려"),
      heard("버릴 게 반이야"),
      said("그럼 반은 오늘 없앨 수 있네"),
      heard("화분에 물 주는 걸 자꾸 까먹어"),
      said("요일을 정해두면 좀 나아"),
      heard("수요일로 해볼까"),
      said("좋네 수요일"),
      heard("그러고 보니 잎이 좀 노래졌어"),
      said("물이 모자란 걸 수도 있고 많은 걸 수도 있어"),
      heard("흙을 만져보면 되나"),
      said("말라 있으면 주고 축축하면 두면 돼"),
      heard("오늘 저녁에 확인해볼게"),
      said("그래"),
      heard("운동은 이번 주 한 번도 못 갔어"),
      said("한 주 쉰다고 큰일 안 나"),
      heard("그래도 좀 찝찝해"),
      said("그럼 오늘 산책이라도 해"),
      heard("오늘 좀 늦게 일어났어"),
      said("잘 잤네", "요즘 계속 피곤해 보였는데"),
      heard("아침도 못 먹고 나왔어"),
      said("그럼 점심은 제대로 챙겨 먹어"),
      heard("회사 앞에 새로 생긴 김밥집 가봤어"),
      said("오 어땠어"),
      heard("생각보다 괜찮더라"),
      said("다음에 나도 가보고 싶다"),
      heard("오후에 회의 두 개 있어서 정신없었어"),
      said("고생했네", "회의 길었어?"),
      heard("한 시간씩 했어"),
      said("두 시간을 회의로 쓴 거네"),
      heard("목이 좀 아파"),
      said("물 자주 마셔"),
      heard("그래서 일은 저녁에 몰아서 했어"),
      said("그럼 늦게 끝났겠다"),
      heard("여덟시쯤 나왔어"),
      said("오늘은 좀 일찍 자"),
      heard("집에 오니까 배고프더라"),
      said("뭐 먹었어"),
      heard("그냥 라면 끓여 먹었어"),
      said("간단하게 잘했네"),
      heard("요즘 저녁을 계속 대충 먹는 것 같아"),
      said("주말에 장 한번 봐야겠다"),
      heard("맞아 냉장고가 텅 비었어"),
      said("뭐부터 채울 거야"),
      heard("일단 계란이랑 우유"),
      said("그 둘만 있어도 아침은 되지"),
      heard("빵도 사야 되는데"),
      said("아침에 빵 먹는 편이었어?"),
      heard("어제 본 드라마 재밌더라"),
      said("무슨 드라마"),
      heard("요리하는 사람들 나오는 거"),
      said("그거 보면 배고파질 것 같은데"),
      heard("진짜 그래서 야식 먹었잖아"),
      said("ㅋㅋ 그럴 줄 알았어"),
      heard("오늘 집 정리 좀 했어"),
      said("오 대청소했네", "뭐 특별한 일 있어?"),
      heard("내일 친구가 집에 놀러 와서 자고 가기로 했거든"),
    ],
  },
  {
    id: "이유질문-전제되풀이금지",
    about: "왜냐고 물었을 때 질문에 들어 있던 말을 답의 앞뒤에 되풀이하지 않는가",
    echo: ["길었", "길게", "늘어"],
    turns: [
      heard("퇴근했어?"),
      said("응 이제 막 집 왔어", "오늘 하루 진짜 길었다"),
      heard("왜? 무슨 일 있었는데?"),
    ],
  },
  {
    id: "주말근황-어미반복금지",
    about: "한 일을 몇 개 말하는 자리에서 말풍선 끝을 전부 과거형으로 맺지 않는가",
    turns: [
      heard("주말 잘 보냈어?"),
      said("응 푹 쉬었어", "너는?"),
      heard("나는 그냥 집에만 있었어 너는 주말에 뭐 했어?"),
    ],
  },
  {
    id: "내가정한시각-메모",
    about: "캐릭터가 자기 일정의 시각을 이번 답에서 정해 말할 때 그 시각을 메모로 남기는가",
    wantsNote: true,
    turns: [
      heard("내일 미용실 간다고 했었지"),
      said("응 내일 오후에 잘라", "어제 예약해뒀어"),
      heard("몇 시 걸로 잡았어?"),
    ],
  },
  {
    id: "평범한말-기준선",
    about: "규칙을 물지 않는 평범한 발화에서 형식과 표기가 흔들리지 않는가",
    turns: [
      heard("이제 좀 한가해졌어"),
      said("다행이다", "오늘 하루 길었지"),
      heard("밥 먹었어? 나는 방금 라면 끓여먹음"),
    ],
  },
];
