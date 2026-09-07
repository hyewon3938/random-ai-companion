// 슬랙 게시용 비교 — 두 글에서 달라진 자리만 표시하는 줄 단위·낱말 단위 비교.
//
// lineDiff는 하루 고정 프롬프트 덩이처럼 줄이 여럿인 글에 쓴다. 바뀐 줄만 `- `·`+ `로 남기고
// 같은 줄은 뺀다. wordDiff는 관계 항목·기억 값·진행 중인 일처럼 줄바꿈 없는 한 문단에 쓴다.
// 전문을 한 번만 적고 그 안에서 빠진 말을 `[-…-]`, 더한 말을 `{+…+}`로 감싼다 — 이전 값 전문과
// 새 값 전문을 나란히 두면 어디가 바뀌었는지 두 문단을 눈으로 견줘야 해서다(이슈 #312). 둘 다
// 가장 긴 공통 부분열로 같은 자리를 찾고, 표가 너무 커지면 통째로 바뀐 것으로 적는다.

/** 비교표 칸 수 상한. 넘으면 세밀한 비교를 포기하고 통째로 바뀐 것으로 적는다. */
const LCS_CELL_LIMIT = 250_000;

interface Op {
  op: "same" | "del" | "add";
  text: string;
}

/** 가장 긴 공통 부분열을 따라 두 배열을 같음·빠짐·더함으로 나눈다. */
const lcsOps = (a: string[], b: string[]): Op[] => {
  const w = b.length + 1;
  const dp = new Int32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1])
      out.push({ op: "del", text: a[i++] });
    else out.push({ op: "add", text: b[j++] });
  }
  while (i < a.length) out.push({ op: "del", text: a[i++] });
  while (j < b.length) out.push({ op: "add", text: b[j++] });
  return out;
};

/** 줄 단위 비교. 바뀐 줄만 `- `·`+ `를 앞에 붙여 적고, maxLines를 넘으면 뒤를 줄여 건수만 적는다. */
export const lineDiff = (
  before: string,
  after: string,
  maxLines = 60,
): string => {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > LCS_CELL_LIMIT)
    return `(줄 수 ${a.length} → ${b.length} — 너무 커서 줄 단위 비교는 생략)`;
  const out = lcsOps(a, b)
    .filter((o) => o.op !== "same")
    .map((o) => `${o.op === "del" ? "-" : "+"} ${o.text}`);
  if (!out.length) return "(줄 단위로는 같다 — 공백만 바뀌었다)";
  return out.length > maxLines
    ? [...out.slice(0, maxLines), `… ${out.length - maxLines}줄 더`].join("\n")
    : out.join("\n");
};

const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);

/**
 * 낱말 단위 비교. 공백으로 나눈 낱말을 견줘 전문 하나로 돌려준다. 빠진 낱말은 `[-…-]`, 더한
 * 낱말은 `{+…+}`로 감싸고, 이어진 변경은 한 묶음으로 적는다. 같은 자리에서 빠지고 더해지면
 * 빠진 쪽을 먼저 적는다. 두 글이 같으면 그 글을 그대로 돌려준다.
 */
export const wordDiff = (before: string, after: string): string => {
  const a = words(before);
  const b = words(after);
  if (!a.length && !b.length) return "";
  if (!a.length) return `{+${b.join(" ")}+}`;
  if (!b.length) return `[-${a.join(" ")}-]`;
  if (a.length * b.length > LCS_CELL_LIMIT)
    return `[-${a.join(" ")}-] {+${b.join(" ")}+}`;
  const parts: string[] = [];
  let del: string[] = [];
  let add: string[] = [];
  const flush = (): void => {
    if (del.length) parts.push(`[-${del.join(" ")}-]`);
    if (add.length) parts.push(`{+${add.join(" ")}+}`);
    del = [];
    add = [];
  };
  for (const o of lcsOps(a, b)) {
    if (o.op === "same") {
      flush();
      parts.push(o.text);
    } else if (o.op === "del") del.push(o.text);
    else add.push(o.text);
  }
  flush();
  return parts.join(" ");
};
