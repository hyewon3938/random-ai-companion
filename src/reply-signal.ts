// 답장 객체 — 모델이 코드에 신호를 넘기는 통로.
//
// 옛 방식은 답장 앞뒤에 붙이는 대괄호 표시였다([남음]·[메모]). 신호가 유저에게 보이는 문장과
// 같은 문자열 안에 있어서, 떼어내기가 한 번 어긋나면 그대로 새어 나갔고(겹친 태그를 하나만
// 벗기던 버그가 실제로 있었다) 신호를 하나 더할 때마다 떼어내는 규칙이 하나씩 늘었다.
// 이제는 답장 본문과 신호를 JSON 한 덩이로 받아 코드가 가른다 — 본문은 reply 배열에만 있고
// 신호는 형제 칸에 있으니, 읽기가 실패해도 신호가 문장으로 새지 않는다(이슈 #138).
//
// 신호를 늘릴 때 고칠 자리는 이 파일 안 일곱이다: ReplySignals(칸) · EMPTY_SIGNALS(빈 값)
// · SIGNAL_KEYS(키 이름) · SIGNAL_LINES(프롬프트 한 줄) · readSignals(값 읽기)
// · mergeSignals(두 답 합치기) · hasSignal(신호가 하나라도 있는지).
// 객체 밖에서 주워 오는 자리는 앞의 것들을 그대로 쓰므로 따로 손대지 않는다. 잘린 답에서
// 건져 올리는 자리(salvage)도 값이 스칼라인 칸은 그대로 타지만, 값이 배열인 칸은 키:값
// 정규식에 안 걸려 키 이름을 ARRAY_KEYS에 넣어 따로 훑는다 — note·intent_lines·plan_ref가 그렇다.
//
// 관계 신호 셋(move·first·told_plan)은 코드 값이라 이름표(labels.ts)의 목록에 있는 것만
// 받는다 — 모델이 지어낸 코드가 표의 CHECK에 걸려 답장 저장이 통째로 실패하면 안 된다.
//
// 칸은 늘 넣는 셋(note·move·first)과 해당할 때만 켜지는 나머지로 나뉜다. 어느 쪽에 두는지가
// 그 신호가 실제로 오는지를 가르므로, 칸을 더할 때 SIGNAL_LINES 위 문단을 먼저 읽는다.
// 늘 넣는 쪽에 두면 ALWAYS_KEYS에도 이름을 넣는다 — 평가가 그 목록으로 형식을 재고, 값이
// null인 것과 칸이 아예 안 온 것을 가르는 자리가 거기뿐이다(이슈 #385).

import type { FirstBy, FirstKind, IntentLine, Move } from "./labels.js";
import {
  FIRST_BY_NAME,
  FIRST_KIND_NAME,
  INTENT_LINE_NAME,
  MOVE_NAME,
} from "./labels.js";

/** 답장에 함께 실려 오는 신호. 값이 없으면 신호가 없는 것이다. */
export interface ReplySignals {
  /** 조정 가능한 자기 일정을 접거나 미루고 남기로 했다(옛 [남음]). */
  stay: boolean;
  /**
   * 오늘 메모로 남길 줄들(옛 [메모]). 남길 것이 없으면 빈 배열이다.
   *
   * 배열인 이유는 한 턴에 남길 사실이 둘 이상일 수 있어서다(이슈 #399) — 칸이 한 줄이던
   * 동안에는 상대가 말해 준 사실과 캐릭터가 처음 꺼낸 자기 이야기가 같은 턴에 나오면 한쪽이
   * 그 자리에서 사라졌다. 저장은 줄마다 한 행이다(memory.ts saveTodayNote).
   */
  note: string[];
  /** 사이가 달라졌을 때 새로 쓴 한 줄(관계 stage). */
  stage: string | null;
  /** 서로 부르는 말이 달라졌을 때 새 호칭(관계 address_terms). */
  addressTerms: string | null;
  /** 이번 답장에서 무엇을 마치고 다시 연락하겠다고 한 약속 한 문장. 시각은 코드가 정한다(이슈 #308). */
  promise: string | null;
  /** 이번 답장이 쓴 플러팅 코드 하나. 안 썼으면 null(관계 설계 §5). */
  move: Move | null;
  /** 이번 답장에서 처음 일어난 일과 누가 먼저였는지. 없으면 null. */
  first: { kind: FirstKind; by: FirstBy } | null;
  /** 이번 답장에서 오늘 자기 일정을 먼저 말했으면 true. */
  toldPlan: boolean;
  /**
   * 오늘의 관계 의도 가운데 이번 답장이 실제로 쓴 줄. 시도할 플러팅은 move 칸이 맡아
   * 프롬프트가 펴는 코드는 파고들 것·흘릴 내 얘기·이어갈 자리 셋이고, 모델이 move를 섞어
   * 보낸 날은 그것도 버리지 않고 받는다(asIntentLines, 이슈 #390).
   *
   * 이 표시가 없던 동안에는 답장이 쓴 줄을 셀 길이 없어서, 낮에 답장이 던진 물음을 몇 시간
   * 뒤 의도 선톡이 다시 물었다(proactive-policy.ts usedIntentLines).
   */
  intentLines: IntentLine[];
  /**
   * 이번 답장이 앞일을 말하며 근거로 쓴 일정 줄. 안 말했으면 빈 배열이다.
   *
   * 일정 절은 하루 한 번 올라가는 고정 덩이에 있어서 답장 스레드에 안 붙는다. 캐릭터가 날짜를
   * 짚어 말했을 때 저장된 행을 읽은 것인지 그 자리에서 지어낸 것인지는 이 칸으로만 가른다(이슈 #397).
   */
  planRef: string[];
}

/** 답을 어느 길로 읽었는지 — 운영에서 형식이 얼마나 지켜지는지 보려고 남긴다. */
export type ReplyParse = "json" | "stray" | "salvage" | "plain" | "empty";

export interface ReplyOutput {
  /** 그대로 내보낼 말풍선. 비어 있으면 보낼 답이 없다는 뜻이다. */
  bubbles: string[];
  signals: ReplySignals;
  parse: ReplyParse;
  /**
   * 늘 넣기로 한 칸(ALWAYS_KEYS) 가운데 실제로 온 것. 값이 null이어도 키가 왔으면 여기 든다 —
   * 값만 보면 쓸 것이 없던 답장과 칸을 통째로 뺀 답장이 똑같아 보여서, 형식을 지키는지는
   * 이 목록으로만 갈린다(이슈 #385). 객체로 못 읽은 답은 빈 배열이다.
   */
  slots: string[];
}

export const EMPTY_SIGNALS: ReplySignals = {
  stay: false,
  note: [],
  stage: null,
  addressTerms: null,
  promise: null,
  move: null,
  first: null,
  toldPlan: false,
  intentLines: [],
  planRef: [],
};

// 객체 키·따옴표가 본문 밖에서 토큰을 쓰고, 잘리면 본문 일부가 아니라 JSON 한 덩이가 통째로
// 못 쓰게 된다. 실제로 쓴 만큼만 과금되므로 상한은 여유 있게 둔다.
// 여유를 더 둔 이유는 생각 과정이다(이슈 #214) — sonnet은 thinking 값을 넘기지 않으면 생각을
// 켜고, 그 텍스트는 응답으로 안 돌아오면서 토큰은 출력으로 계산된다. 08-31 로그에서 본문이
// 같은 78자인데 출력이 638·151토큰으로 갈렸다. 생각 몫이 큰 쪽으로 몰린 호출에서 본문까지
// 상한에 닿지 않게 한다.
export const REPLY_MAX_TOKENS = 2000;

// 신호 칸 설명 — 언제 넣는지는 규칙층(src/prompts/reply.ts의 NOTE_RULE·CATEGORY_RULE)이 따로 말한다.
// 여기는 어느 칸에 무엇을 담는지만 적는다.

// 코드 목록을 프롬프트에 '코드(뜻)' 꼴로 편다 — 모델이 코드 대신 뜻을 적는 것을 막으려면 둘을
// 나란히 보여 줘야 한다.
const codeList = (table: Record<string, string>): string =>
  Object.entries(table)
    .map(([code, name]) => `${code}(${name})`)
    .join(" · ");
const moveCodeList = (): string => codeList(MOVE_NAME);
const firstCodeList = (): string => codeList(FIRST_KIND_NAME);
// 의도 줄 넷 가운데 시도할 플러팅은 move 칸이 맡는다 — 두 칸에 같은 줄을 적게 하면 어느 쪽이
// 정본인지 모델도 코드도 못 가른다. 프롬프트에는 나머지 셋만 편다.
const INTENT_SIGNAL_LINES: IntentLine[] = ["dig", "share", "thread"];
const intentCodeList = (): string =>
  INTENT_SIGNAL_LINES.map((l) => `${l}(${INTENT_LINE_NAME[l]})`).join(" · ");
/** 객체에 실려 오는 신호 키. 프롬프트가 쓰는 이름 그대로다. */
const SIGNAL_KEYS = [
  "stay",
  "note",
  "stage",
  "address_terms",
  "promise",
  "move",
  "first",
  "first_by",
  "told_plan",
  "intent_lines",
  "plan_ref",
] as const;

// 값이 배열로 오는 칸. 잘린 답을 건질 때 키:값 정규식에 안 걸려 따로 훑는 목록이다(salvage).
const ARRAY_KEYS = ["note", "intent_lines", "plan_ref"] as const;

/**
 * 값이 없어도 키째 오게 한 칸(이슈 #385). 프롬프트가 늘 넣으라고 시키는 셋과 같은 목록이고,
 * 평가는 이 셋이 실제로 실려 오는지로 형식이 지켜지는 정도를 잰다.
 */
export const ALWAYS_KEYS = ["note", "move", "first"] as const;

// note는 나머지 넷과 성격이 다르다. 넷은 드물게만 켜지는 신호이고 note는 매 답장에서 해당할 수
// 있는 칸이라, 한 묶음으로 "해당할 때만"이라고 읽히면 아예 안 나온다. stage는 반대 방향으로
// 어긋났다 — 얼마나 자주 넣는지를 막았더니 사이가 달라진 날에도 안 나왔다. 지금 값이 프롬프트의
// [상대와의 관계]에 실려 있으니, 그 값과 대조하라고 시켜야 같은 사이를 다른 말로 바꿔 쓰는 것만
// 막힌다(이슈 #227).
//
// 늘 넣게 하는 이유는 대화 기록이다(이슈 #346). 기록 속 캐릭터 발화는 답장과 같은 객체로 적히고
// 거기에는 칸이 늘 있는데, 값이 없을 때 키째 빼라고 하면 시키는 모양과 보여 주는 모양이 어긋난다.
// 둘 중 기록 쪽을 살렸다 — 빈 칸을 심은 것이 형식을 지키게 만든 값이라(turns.ts) 기록에서 칸을
// 빼면 그 값이 같이 내려간다.
//
// move와 first도 같은 자리에 있었다(이슈 #385). 신호 줄이 배포된 뒤 반나절 동안 답장 출력 29건
// 가운데 선택 칸이 하나라도 실린 것이 0건이었는데, 같은 시간대에 판정 호출은 27턴 전부 자기
// 칸을 채웠다. 모델도 파서도 아니고 이 문단이 다른 자리였다. 셋을 늘 넣는 칸으로 묶고 나머지는
// 드물게만 켜지는 신호로 남긴다 — 뒤엣것 가운데 promise는 이 상태에서도 한 번 끝까지 통했다.
//
// 늘 넣는 칸을 셋으로 고른 기준은 매 답장에서 해당할 수 있는가다. 플러팅은 하루 상한이 없고
// (관계 설계 「하루 상한」), 처음은 20개가 소진될 때까지 아무 답장에서나 걸린다. stay·stage·
// address_terms·promise·told_plan은 자리를 가려서 드물게 켜지므로 그대로 둔다.
const SIGNAL_LINES = [
  `- note: 오늘 메모로 남길 문장들의 배열. 원소 하나가 메모 한 줄이다. 뒤에 가서도 알고 있어야 할 것이 나오면 적는 칸이라 늘 넣는다 — 적을 것이 여럿이면 원소를 여러 개 두고, 남길 것이 없는 답장에서만 빈 배열([])로 둔다. 무엇을 적는지는 위 note 신호 규칙에 있다.`,
  `- move: 이번 답장이 상대를 설레게 하려고 쓴 플러팅 코드 하나. 이 칸도 늘 넣고, 그런 자리가 아니었으면 null로 둔다. 코드는 ${moveCodeList()} 가운데 하나다. 한 답장에 둘 이상 썼으면 앞세운 것 하나만 적는다. 위 [지금 관계]의 '시도할 플러팅'에 적힌 것을 이번 답장에서 했으면, 설레게 하려는 결이 아니어도 그 코드를 적는다.`,
  `- first: 위 [지금 관계]의 '아직 안 한 처음'에 있는 일이 이번 답장에서 처음으로 일어났으면 그 코드 하나. 이 칸도 늘 넣고, 그런 일이 없었으면 null로 둔다. 코드는 ${firstCodeList()} 가운데 하나다. 이미 한 처음은 다시 적지 않는다.`,
  `- first_by: first에 코드를 적었을 때만 같이 넣는다. 네가 먼저 했으면 character, 상대가 먼저 해서 네가 받은 것이면 user.`,
  `- stay: 하려던 일을 접거나 미루고 상대 곁에 남기로 했을 때만 true.`,
  `- stage: 둘 사이가 실제로 달라졌을 때 지금 어떤 사이인지 한 줄로 새로 쓴다. 위 [상대와의 관계]의 '지금 어떤 사이'와 뜻이 같으면 넣지 않는다. 같은 사이를 다른 말로 바꿔 쓰는 자리가 아니다.`,
  `- address_terms: 서로 부르는 말이 달라졌을 때만, 서로를 뭐라고 부르는지 짧게 적는다. 부르던 대로면 넣지 않는다.`,
  `- promise: 이번 답장에서 지금 하는 일을 마치고 다시 연락하겠다고 상대에게 말했을 때만, 무엇을 마치고 연락할지 한 문장으로 적는다(예: 통화 끝나고 다시 연락). 시각은 적지 않는다 — 그 일이 끝나는 시각에 코드가 너를 다시 불러 그때 말을 만든다. 그런 말을 안 했으면 넣지 않는다.`,
  `- told_plan: 이번 답장에서 오늘 네 일정을 상대가 묻지 않았는데 먼저 말했을 때만 true.`,
  `- intent_lines: 위 [지금 관계]의 '오늘의 관계 의도' 가운데 이번 답장에서 실제로 한 줄의 코드 배열. 코드는 ${intentCodeList()} 셋이다. 시도할 플러팅은 move 칸에 적으니 여기 넣지 않는다. 한 줄도 안 했으면 넣지 않는다.`,
  `- plan_ref: 이번 답장에서 네 앞일이나 상대의 앞일을 말했을 때만, 그 근거로 쓴 줄을 [다가오는 일정]·[지금 얘기와 관련 있는 일정]에 적힌 날짜와 내용 그대로 배열에 적는다. 앞일을 말하지 않았거나 이 대화에서 새로 정한 것이면 넣지 않는다.`,
].join("\n");

// 답장 경로에서만 프롬프트 맨 끝에 붙는다(context.ts BuildOptions.signals).
// 형식 설명을 읽는 코드 옆에 두는 이유는 하나다 — 프롬프트가 시키는 모양과 파서가 기다리는
// 모양이 따로 놀면 답장이 통째로 사라지므로, 둘을 한 파일에서 같이 고치게 한다.
export const REPLY_ENVELOPE = `[내보내는 형식 — 이번 답장에만 해당한다]
- 답장은 JSON 객체 하나로만 쓴다. 코드펜스도 설명도 붙이지 않고 { 로 시작해 } 로 끝낸다.
- reply: 말풍선을 담는 배열. 원소 하나가 말풍선 하나다. 이 답장에서 말풍선을 나누는 자리는 줄바꿈이 아니라 배열 원소다. 한 덩이로 보낼 말이면 원소가 하나인 배열로 쓴다.
- note·move·first는 늘 넣는다. 해당하는 것이 없는 답장에서는 note는 빈 배열([])로, move·first는 null로 두고 키를 빼지 않는다 — 대화 기록에 적힌 네 지난 답장도 같은 모양이다.
- 그 밖의 칸은 해당할 때만 넣는다. 해당하지 않으면 키째 뺀다(빈 값이나 false로 채우지 않는다).
${SIGNAL_LINES}
- 신호도 이 객체 안의 항목이다. } 를 닫은 뒤에는 한 글자도 쓰지 않는다. 남길 말이 있으면 위 항목 안에 넣는다.
- 예: {"reply": ["아 진짜요?", "그럼 오늘은 좀 일찍 자요"], "note": ["상대가 다음 주 화요일에 면접을 본다"], "move": null, "first": null}
- 남길 것이 둘인 예: {"reply": ["나도 대전에서 컸어", "무슨 중학교 나왔어?"], "note": ["상대가 중학교까지 대전에서 살았다", "내가 자란 동네를 둔산동이라고 말했다"], "move": null, "first": null}
- 플러팅을 쓴 답장의 예: {"reply": ["아까 그거 다 했어?", "끝나면 알려줘"], "note": [], "move": "remember", "first": null}
- 오늘 의도와 앞일이 함께 든 예: {"reply": ["요즘 그 팀이랑은 좀 괜찮아졌어?", "나는 금요일에 워크샵 가"], "note": [], "move": null, "first": null, "intent_lines": ["dig"], "plan_ref": ["9/18 팀 워크샵"]}
- reply 안의 문장만 상대에게 그대로 나간다. 나머지 칸도 이 형식도 상대에게 보이지 않는다.
- 형식이 JSON이라고 말이 굳으면 안 된다. 문장은 평소처럼 메신저에 치듯 쓰고, 표기 규칙대로 문장 안에 큰따옴표를 쓰지 않는다.`;

/** 말풍선 상한. 넘치는 뒷부분만 마지막 하나로 합친다. */
export const MAX_BUBBLES = 6;

export const capBubbles = (parts: string[]): string[] =>
  parts.length <= MAX_BUBBLES
    ? parts
    : [
        ...parts.slice(0, MAX_BUBBLES - 1),
        parts.slice(MAX_BUBBLES - 1).join(" "),
      ];

// 말머리 대괄호 한 겹 벗기기 — 신호를 읽는 자리가 아니다(신호는 이제 형제 칸에 있다).
// 남겨 두는 이유는 하나다: 대화 기록의 시간 마커([어제 22:10])를 모델이 흉내 내 답장 앞에
// 찍는 일이 있고, 그건 그대로 상대에게 보인다. 길이 상한 20은 그 마커("3일 전(금) 21:40"
// = 14자)를 덮는 값이라 본문 한 문장이 통째로 지워지지 않는다.
const stripLeadTag = (line: string): string => {
  let s = line;
  let m: RegExpMatchArray | null;
  while ((m = s.match(/^\s*\[([^\]\n]{1,20})\]\s*/))) s = s.slice(m[0].length);
  return s.trim();
};

const lines = (text: string): string[] =>
  text.split("\n").map(stripLeadTag).filter(Boolean);

const stripFence = (raw: string): string =>
  raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

const asText = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
};

// 배열 칸(note·plan_ref)은 배열이 정식이되 문자열 하나로 와도 한 줄로 받는다 — 형식이 흔들려도
// 적어 온 사실을 버리지 않는다. 줄 안의 줄바꿈으로도 나눈다: 저장이 줄바꿈으로 이어 붙이는
// 자리를 쓰므로(db/sends.ts) 값에 줄바꿈이 남으면 뒤에서 한 줄이 둘로 읽힌다. 글자까지 같은
// 줄은 한 번만.
const asLines = (v: unknown): string[] => {
  const raw: unknown[] = Array.isArray(v) ? v : [v];
  const out = raw.flatMap((el) => {
    const s = asText(el);
    if (!s) return [];
    return s
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean);
  });
  return [...new Set(out)];
};

// 참으로 읽는 값을 좁게 잡는다 — 형식이 흔들려도 신호는 명시적으로 켠 것만 켠다.
const asFlag = (v: unknown): boolean => v === true || v === "true";

// 코드 값은 목록에 있는 것만 받는다. 모델이 이름을 쓰거나(별명) 비슷한 코드를 지어내면 버린다.
const asMove = (v: unknown): Move | null =>
  typeof v === "string" && v.trim() in MOVE_NAME ? (v.trim() as Move) : null;

// 의도 줄은 목록에 있는 코드만 받고 같은 코드는 한 번만 남긴다. move가 섞여 와도 받는다 —
// 버리면 선톡이 같은 플러팅을 다시 내보내는 자리가 되는데, 세는 쪽(usedIntentLines)은 어느
// 칸에서 왔든 한 번만 센다.
const asIntentLines = (v: unknown): IntentLine[] => {
  const raw: unknown[] = Array.isArray(v) ? v : [v];
  const out = raw.flatMap((el) =>
    typeof el === "string" && el.trim() in INTENT_LINE_NAME
      ? [el.trim() as IntentLine]
      : [],
  );
  return [...new Set(out)];
};

const asFirst = (
  kind: unknown,
  by: unknown,
): { kind: FirstKind; by: FirstBy } | null => {
  if (typeof kind !== "string" || !(kind.trim() in FIRST_KIND_NAME)) return null;
  // 누가 먼저였는지를 안 적으면 네가 먼저 한 것으로 본다 — 처음은 대개 캐릭터가 먼저 건넨 쪽이고,
  // 상대가 먼저 한 것은 프롬프트가 따로 적으라고 시킨다.
  const b =
    typeof by === "string" && by.trim() in FIRST_BY_NAME
      ? (by.trim() as FirstBy)
      : "character";
  return { kind: kind.trim() as FirstKind, by: b };
};

const readSignals = (o: Record<string, unknown>): ReplySignals => ({
  stay: asFlag(o.stay),
  note: asLines(o.note),
  stage: asText(o.stage),
  addressTerms: asText(o.address_terms),
  promise: asText(o.promise),
  move: asMove(o.move),
  first: asFirst(o.first, o.first_by),
  toldPlan: asFlag(o.told_plan),
  intentLines: asIntentLines(o.intent_lines),
  planRef: asLines(o.plan_ref),
});

/** 첫 답이 비어 다시 부른 경우 — 두 답의 신호를 하나로 합친다(먼저 나온 값을 남긴다). */
export const mergeSignals = (
  a: ReplySignals,
  b: ReplySignals,
): ReplySignals => ({
  stay: a.stay || b.stay,
  // 메모는 두 답에서 온 줄을 한 묶음으로 잇는다 — 하나만 남기면 다시 부른 답에만 적힌 줄이
  // 사라진다. 글자까지 같은 줄은 한 번만 남긴다(같은 답을 두 번 쓴 경우).
  note: [...new Set([...a.note, ...b.note])],
  stage: a.stage ?? b.stage,
  addressTerms: a.addressTerms ?? b.addressTerms,
  promise: a.promise ?? b.promise,
  move: a.move ?? b.move,
  first: a.first ?? b.first,
  toldPlan: a.toldPlan || b.toldPlan,
  // 의도 줄과 앞일 근거도 메모와 같이 두 답에서 온 것을 잇는다 — 다시 부른 답에만 적힌 줄이
  // 사라지면 그 줄을 아직 안 쓴 것으로 보고 선톡이 같은 말을 다시 낸다.
  intentLines: [...new Set([...a.intentLines, ...b.intentLines])],
  planRef: [...new Set([...a.planRef, ...b.planRef])],
});

// 배열이면 원소마다, 문자열 하나면 그것만. 원소 안에 줄바꿈이 들어와도 말풍선으로 나눈다 —
// 모델이 배열과 줄바꿈을 섞어 쓰는 경우가 있고, 나눠도 손해가 없다.
const toBubbles = (v: unknown): string[] => {
  const raw: unknown[] = Array.isArray(v)
    ? v
    : typeof v === "string"
      ? [v]
      : [];
  return capBubbles(
    raw.flatMap((el) => (typeof el === "string" ? lines(el) : [])),
  );
};

interface ReadObject {
  obj: Record<string, unknown>;
  /** 객체 바깥에 남은 글. 통째로 읽혔으면 빈 문자열이다. */
  outside: string;
}

// 통째로 파싱해 보고, 안 되면 바깥 중괄호만 오려 다시 본다(앞뒤에 군말이 붙은 경우).
// 오려 냈다면 그 군말도 함께 돌려준다 — 신호가 거기 섞여 있는 일이 실제로 있어서(이슈 #194)
// 버리기 전에 한 번 훑는다.
const readObject = (text: string): ReadObject | null => {
  const i = text.indexOf("{");
  const j = text.lastIndexOf("}");
  const cands: { cand: string; outside: string }[] = [
    { cand: text, outside: "" },
  ];
  if (i >= 0 && j > i)
    cands.push({
      cand: text.slice(i, j + 1),
      outside: `${text.slice(0, i)}\n${text.slice(j + 1)}`,
    });
  for (const { cand, outside } of cands) {
    try {
      const v: unknown = JSON.parse(cand);
      if (v && typeof v === "object" && !Array.isArray(v))
        return { obj: v as Record<string, unknown>, outside };
    } catch {
      /* 다음 후보로 */
    }
  }
  return null;
};

const unquote = (quoted: string): string | null => {
  try {
    const v: unknown = JSON.parse(quoted);
    return typeof v === "string" ? v.trim() || null : null;
  } catch {
    return null;
  }
};

// 객체 밖으로 흘린 신호 줍기. 답을 JSON으로는 제대로 쓰면서 닫는 } 뒤에 note 한 줄을
// 덧붙이는 일이 실제로 있었다(이슈 #194). 대화 기록에 붙는 예시 객체에는 신호 키가 없어서
// 모델이 신호를 객체 밖의 것으로 읽은 것으로 본다. 그 줄은 파싱에서 잘려 나가 통째로
// 사라지고, JSON 자체는 읽히니 실패로도 안 잡힌다.
//
// 이미 형식이 어긋난 자리라 따옴표도 콜론도 없을 수 있어 느슨하게 읽는다. 어차피 버릴 글에서만
// 찾으므로 헛걸음의 대가가 없고, 아는 이름으로 시작하는 줄만 본다. 이름 뒤에는 콜론·등호나
// 빈칸을 요구해 'notebook' 같은 낱말이 note로 걸리지 않게 한다.
const STRAY_LINE = new RegExp(
  `^[\\s\\-*\u2022]*"?(${SIGNAL_KEYS.join("|")})"?(?:\\s*[:=]\\s*|\\s+)(.+)$`,
);

const strayValue = (raw: string): string | null => {
  const s = raw.trim().replace(/,$/, "").trim();
  if (s.startsWith('"')) {
    const m = /^"(?:[^"\\]|\\.)*"/.exec(s);
    if (m) return unquote(m[0]);
  }
  return s.replace(/^['"]+|['"]+$/g, "").trim() || null;
};

const strayObject = (outside: string): Record<string, unknown> => {
  const found: Record<string, unknown> = {};
  for (const line of outside.split("\n")) {
    const m = STRAY_LINE.exec(line);
    if (!m || m[1] in found) continue;
    const v = strayValue(m[2]);
    if (v !== null) found[m[1]] = v;
  }
  return found;
};

const hasSignal = (s: ReplySignals): boolean =>
  s.stay ||
  s.note.length > 0 ||
  s.stage !== null ||
  s.addressTerms !== null ||
  s.promise !== null ||
  s.move !== null ||
  s.first !== null ||
  s.toldPlan ||
  s.intentLines.length > 0 ||
  s.planRef.length > 0;

// JSON을 쓰려다 만 답(대개 상한에 걸려 잘린 경우)에서 온전한 조각만 건진다.
// 닫는 따옴표가 없는 마지막 문장은 걸리지 않는다 — 반 토막 난 말을 보내느니 버린다.
// reply 배열을 훑어 온전히 닫힌 문장만 모은다. 닫는 대괄호를 문자열 밖에서만 배열 끝으로
// 보는 이유는 본문 안에 대괄호가 들어오기 때문이다 — 시간 마커를 흉내 낸 "[어제 22:10]"이
// 실제로 그렇다. 글자만 세면 거기서 배열이 끝난 줄 알고 그 뒤 말풍선을 통째로 버린다.
const arrayItems = (rest: string): string[] => {
  const out: string[] = [];
  let i = 0;
  while (i < rest.length) {
    const ch = rest[i];
    if (ch === '"') {
      const m = /^"(?:[^"\\]|\\.)*"/.exec(rest.slice(i));
      if (!m) break; // 닫히지 않은 마지막 문장 — 반 토막이라 버린다
      const s = unquote(m[0]);
      if (s) out.push(...lines(s));
      i += m[0].length;
      continue;
    }
    if (ch === "]") break;
    i++;
  }
  return out;
};

const salvage = (
  text: string,
): { bubbles: string[]; signals: ReplySignals; slots: string[] } => {
  const head = text.search(/"reply"\s*:\s*\[/);
  const parts =
    head >= 0 ? arrayItems(text.slice(text.indexOf("[", head) + 1)) : [];
  // 신호는 온전히 닫힌 키:값 쌍만 모아 같은 readSignals에 넘긴다 — 칸이 늘어도 여기는 그대로다.
  const found: Record<string, unknown> = {};
  for (const m of text.matchAll(
    /"([A-Za-z_]+)"\s*:\s*(true|false|null|"(?:[^"\\]|\\.)*")/g,
  )) {
    found[m[1]] =
      m[2] === "true"
        ? true
        : m[2] === "false"
          ? false
          : m[2] === "null"
            ? null
            : unquote(m[2]);
  }
  // 값이 배열인 칸은 위 정규식에 걸리지 않는다 — 열린 대괄호에서 멈춘다. 그래서 말풍선과
  // 같은 방법으로 한 번 더 훑는다(이슈 #399). 잘린 답에서 메모가 통째로 사라지면 그 턴의
  // 사실을 하루 안에서 되찾을 길이 없고, 의도 줄과 앞일 근거도 같은 자리에서 사라진다.
  for (const key of ARRAY_KEYS) {
    const at = text.search(new RegExp(`"${key}"\\s*:\\s*\\[`));
    if (at >= 0) found[key] = arrayItems(text.slice(text.indexOf("[", at) + 1));
  }
  return {
    bubbles: capBubbles(parts),
    signals: readSignals(found),
    slots: ALWAYS_KEYS.filter((k) => k in found),
  };
};

/**
 * 모델이 쓴 답 한 덩이를 말풍선과 신호로 가른다. 읽는 순서는 넷이다.
 * ① JSON으로 읽힌다 → 그대로 쓴다. 객체 밖에 신호를 흘렸으면 주워서 합치고(stray) 그렇게
 *    읽었다는 것을 이름에 남긴다 — 형식 설명을 고쳐도 계속 새는지 트레이스로 보려는 것이다.
 * ② JSON을 쓰려다 만 답이다 → 온전한 조각만 건진다(salvage)
 * ③ JSON을 아예 안 썼다 → 옛 방식대로 줄바꿈으로 나눠 그대로 내보낸다(plain)
 * ④ 아무것도 못 건졌다 → 빈 답(empty). 부른 쪽이 한 번 다시 부르고, 그래도 비면 보내지 않는다.
 * ②와 ③을 가르는 이유는 새어 나감을 막기 위해서다. JSON을 쓰려던 흔적이 있으면 못 읽어도
 * 원문을 유저에게 보내지 않는다 — JSON 조각이 그대로 말풍선이 되는 것이 옛 버그의 재판이다.
 */
export const parseReplyOutput = (raw: string): ReplyOutput => {
  const text = stripFence(raw);
  const read = readObject(text);
  if (read) {
    const bubbles = toBubbles(read.obj.reply);
    const inside = readSignals(read.obj);
    const stray = read.outside.trim()
      ? readSignals(strayObject(read.outside))
      : EMPTY_SIGNALS;
    const picked = hasSignal(stray);
    return {
      bubbles,
      // 안에서 읽은 값을 남긴다 — 밖의 것은 같은 신호를 두 번 쓴 경우의 사본이다.
      signals: picked ? mergeSignals(inside, stray) : inside,
      parse: bubbles.length ? (picked ? "stray" : "json") : "empty",
      slots: ALWAYS_KEYS.filter((k) => k in read.obj),
    };
  }
  if (text.startsWith("{") || /"reply"\s*:/.test(text)) {
    const got = salvage(text);
    return { ...got, parse: got.bubbles.length ? "salvage" : "empty" };
  }
  const bubbles = capBubbles(lines(text));
  return {
    bubbles,
    signals: EMPTY_SIGNALS,
    parse: bubbles.length ? "plain" : "empty",
    slots: [],
  };
};

/** 트레이스에 적는 이름. */
export const PARSE_NAME: Record<ReplyParse, string> = {
  json: "JSON",
  stray: "JSON + 객체 밖 신호",
  salvage: "잘린 JSON에서 건짐",
  plain: "JSON 아님 — 본문 그대로",
  empty: "읽지 못함",
};
