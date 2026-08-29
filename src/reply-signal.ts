// 답장 봉투 — 모델이 코드에 신호를 넘기는 통로.
//
// 옛 방식은 답장 앞뒤에 붙이는 대괄호 표시였다([남음]·[메모]). 신호가 유저에게 보이는 문장과
// 같은 문자열 안에 있어서, 떼어내기가 한 번 어긋나면 그대로 새어 나갔고(겹친 태그를 하나만
// 벗기던 버그가 실제로 있었다) 신호를 하나 더할 때마다 떼어내는 규칙이 하나씩 늘었다.
// 이제는 답장 본문과 신호를 JSON 한 덩이로 받아 코드가 가른다 — 본문은 reply 배열에만 있고
// 신호는 형제 칸에 있으니, 읽기가 실패해도 신호가 문장으로 새지 않는다(이슈 #138).
//
// 신호를 늘릴 때 고칠 자리는 이 파일 안 넷이다: ReplySignals(칸) · SIGNAL_LINES(프롬프트 한 줄)
// · readSignals(값 읽기) · mergeSignals(두 답 합치기). 잘린 답에서 건져 올리는 자리는
// readSignals를 그대로 쓰므로 따로 손대지 않는다.

/** 답장에 함께 실려 오는 신호. 값이 없으면 신호가 없는 것이다. */
export interface ReplySignals {
  /** 조정 가능한 자기 일정을 접거나 미루고 남기로 했다(옛 [남음]). */
  stay: boolean;
  /** 오늘 메모로 남길 한 줄(옛 [메모]). */
  note: string | null;
}

/** 답을 어느 길로 읽었는지 — 운영에서 형식이 얼마나 지켜지는지 보려고 남긴다. */
export type ReplyParse = "json" | "salvage" | "plain" | "empty";

export interface ReplyOutput {
  /** 그대로 내보낼 말풍선. 비어 있으면 보낼 답이 없다는 뜻이다. */
  bubbles: string[];
  signals: ReplySignals;
  parse: ReplyParse;
}

export const EMPTY_SIGNALS: ReplySignals = { stay: false, note: null };

// 봉투 키·따옴표가 본문 밖에서 토큰을 쓰고, 잘리면 본문 일부가 아니라 JSON 한 덩이가 통째로
// 못 쓰게 된다. 실제로 쓴 만큼만 과금되므로 상한은 여유 있게 둔다.
export const REPLY_MAX_TOKENS = 1200;

// 신호 칸 설명 — 언제 넣는지는 규칙층(context.ts NOTE_RULE·CATEGORY_RULE)이 따로 말한다.
// 여기는 어느 칸에 무엇을 담는지만 적는다.
const SIGNAL_LINES = [
  `- stay: 하려던 일을 접거나 미루고 상대 곁에 남기로 했을 때만 true.`,
  `- note: 오늘 메모로 남길 한 문장.`,
].join("\n");

// 답장 경로에서만 프롬프트 맨 끝에 붙는다(context.ts BuildOptions.signals).
// 형식 설명을 읽는 코드 옆에 두는 이유는 하나다 — 프롬프트가 시키는 모양과 파서가 기다리는
// 모양이 따로 놀면 답장이 통째로 사라지므로, 둘을 한 파일에서 같이 고치게 한다.
export const REPLY_ENVELOPE = `[내보내는 형식 — 이번 답장에만 해당한다]
- 답장은 JSON 객체 하나로만 쓴다. 코드펜스도 설명도 붙이지 않고 { 로 시작해 } 로 끝낸다.
- reply: 말풍선을 담는 배열. 원소 하나가 말풍선 하나다. 이 답장에서 말풍선을 나누는 자리는 줄바꿈이 아니라 배열 원소다. 한 덩이로 보낼 말이면 원소가 하나인 배열로 쓴다.
- 아래 칸은 해당할 때만 넣는다. 해당하지 않으면 키째 뺀다 — 빈 값이나 false로 채우지 않는다.
${SIGNAL_LINES}
- 예: {"reply": ["아 진짜요?", "그럼 오늘은 좀 일찍 자요"], "note": "상대가 다음 주 화요일에 면접을 본다"}
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
  text
    .split("\n")
    .map(stripLeadTag)
    .filter(Boolean);

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

// 참으로 읽는 값을 좁게 잡는다 — 형식이 흔들려도 신호는 명시적으로 켠 것만 켠다.
const asFlag = (v: unknown): boolean => v === true || v === "true";

const readSignals = (o: Record<string, unknown>): ReplySignals => ({
  stay: asFlag(o.stay),
  note: asText(o.note),
});

/** 첫 답이 비어 다시 부른 경우 — 두 답의 신호를 하나로 합친다(먼저 나온 값을 남긴다). */
export const mergeSignals = (
  a: ReplySignals,
  b: ReplySignals,
): ReplySignals => ({
  stay: a.stay || b.stay,
  note: a.note ?? b.note,
});

// 배열이면 원소마다, 문자열 하나면 그것만. 원소 안에 줄바꿈이 들어와도 말풍선으로 나눈다 —
// 모델이 배열과 줄바꿈을 섞어 쓰는 경우가 있고, 나눠도 손해가 없다.
const toBubbles = (v: unknown): string[] => {
  const raw: unknown[] = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  return capBubbles(
    raw.flatMap((el) => (typeof el === "string" ? lines(el) : [])),
  );
};

const braced = (t: string): string | null => {
  const i = t.indexOf("{");
  const j = t.lastIndexOf("}");
  return i >= 0 && j > i ? t.slice(i, j + 1) : null;
};

// 통째로 파싱해 보고, 안 되면 바깥 중괄호만 오려 다시 본다(앞뒤에 군말이 붙은 경우).
const readObject = (text: string): Record<string, unknown> | null => {
  for (const cand of [text, braced(text)]) {
    if (!cand) continue;
    try {
      const v: unknown = JSON.parse(cand);
      if (v && typeof v === "object" && !Array.isArray(v))
        return v as Record<string, unknown>;
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

// 봉투를 쓰려다 만 답(대개 상한에 걸려 잘린 경우)에서 온전한 조각만 건진다.
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

const salvage = (text: string): { bubbles: string[]; signals: ReplySignals } => {
  const head = text.search(/"reply"\s*:\s*\[/);
  const parts =
    head >= 0 ? arrayItems(text.slice(text.indexOf("[", head) + 1)) : [];
  // 신호는 온전히 닫힌 키:값 쌍만 모아 같은 readSignals에 넘긴다 — 칸이 늘어도 여기는 그대로다.
  const found: Record<string, unknown> = {};
  for (const m of text.matchAll(
    /"([A-Za-z_]+)"\s*:\s*(true|false|"(?:[^"\\]|\\.)*")/g,
  )) {
    found[m[1]] =
      m[2] === "true" ? true : m[2] === "false" ? false : unquote(m[2]);
  }
  return { bubbles: capBubbles(parts), signals: readSignals(found) };
};

/**
 * 모델이 쓴 답 한 덩이를 말풍선과 신호로 가른다. 읽는 순서는 넷이다.
 * ① JSON으로 읽힌다 → 그대로 쓴다
 * ② 봉투를 쓰려다 만 답이다 → 온전한 조각만 건진다(salvage)
 * ③ 봉투를 아예 안 썼다 → 옛 방식대로 줄바꿈으로 나눠 그대로 내보낸다(plain)
 * ④ 아무것도 못 건졌다 → 빈 답(empty). 부른 쪽이 한 번 다시 부르고, 그래도 비면 보내지 않는다.
 * ②와 ③을 가르는 이유는 새어 나감을 막기 위해서다. 봉투를 쓰려던 흔적이 있으면 못 읽어도
 * 원문을 유저에게 보내지 않는다 — JSON 조각이 그대로 말풍선이 되는 것이 옛 버그의 재판이다.
 */
export const parseReplyOutput = (raw: string): ReplyOutput => {
  const text = stripFence(raw);
  const obj = readObject(text);
  if (obj) {
    const bubbles = toBubbles(obj.reply);
    return {
      bubbles,
      signals: readSignals(obj),
      parse: bubbles.length ? "json" : "empty",
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
  };
};

/** 트레이스에 적는 이름. */
export const PARSE_NAME: Record<ReplyParse, string> = {
  json: "JSON",
  salvage: "잘린 JSON에서 건짐",
  plain: "JSON 아님 — 본문 그대로",
  empty: "읽지 못함",
};
