// 대화 기록을 모델에 넘길 턴으로 옮기는 자리.
//
// 두 가지를 한다. ① 연속된 같은 역할 메시지를 하나로 합치고, 시간이 벌어진 자리에 시간
// 마커를 넣는다 — 기록에 시간이 없으면 모델이 며칠 전 대화를 방금 일로 읽는다(프롬프트가
// 전부 '지금' 기준이라 날짜 없는 기록은 오늘로 수렴한다). ② 캐릭터 발화를 답장과 같은
// 객체(JSON)로 적는다.
//
// ②가 필요한 이유는 형식이 지시 한 문단만으로는 지켜지지 않기 때문이다(이슈 #190). 답장은
// {"reply": [...]}로 받기로 해 놓고 기록에는 줄바꿈으로 나눈 평문 답장이 20턴씩 붙어 있어서,
// 모델이 시키는 말보다 앞의 예시를 따라 평문으로 답했다. 그 길로 온 답은 본문은 살아도
// 신호가 통째로 사라진다 — 오늘 메모도 관계 갱신도 그 칸으로만 오기 때문이다.
//
// 봇 모듈에서 떼어 둔 이유는 하나다. bot.ts는 불러오는 것만으로 봇을 만들어서 이 변환만
// 따로 돌려 볼 수 없다.
import type { MessageRow } from "./db.js";
import { timeMarkerFor } from "./kst.js";
import type { ChatTurn } from "./llm.js";

type Role = "user" | "assistant";

/** 마커 하나에 딸린 덩이. 시간이 벌어져 마커가 새로 붙는 자리에서 갈린다. */
interface Chunk {
  marker: string | null;
  lines: string[];
}

const bubblesOf = (lines: string[]): string[] =>
  lines
    .flatMap((line) => line.split("\n"))
    .map((s) => s.trim())
    .filter(Boolean);

// 마커는 객체 밖 앞자리에 둔다. 안에 넣으면 모델이 그 칸을 흉내 내 말풍선에 시각을 찍고,
// 그 말은 그대로 상대에게 간다(reply-signal.ts의 stripLeadTag가 뒤늦게 지우는 자국이 이것이다).
const chunkText = (role: Role, c: Chunk): string => {
  const head = c.marker ? `[${c.marker}] ` : "";
  if (role === "user") {
    const body = c.lines.join("\n").trim();
    return body ? head + body : "";
  }
  const bubbles = bubblesOf(c.lines);
  return bubbles.length ? head + JSON.stringify({ reply: bubbles }) : "";
};

export const toTurns = (rows: MessageRow[]): ChatTurn[] => {
  const groups: { role: Role; chunks: Chunk[] }[] = [];
  let prevTs: string | null = null;
  for (const row of rows) {
    const role: Role = row.role === "user" ? "user" : "assistant";
    const marker = timeMarkerFor(row.sent_at, prevTs);
    prevTs = row.sent_at;
    let group = groups[groups.length - 1];
    if (!group || group.role !== role) {
      group = { role, chunks: [] };
      groups.push(group);
    }
    const last = group.chunks[group.chunks.length - 1];
    // 마커가 붙는 자리마다 객체를 나눈다 — 캐릭터가 몇 시간 뒤에 먼저 말을 건 자리가 여기다.
    if (!last || marker) group.chunks.push({ marker, lines: [row.text] });
    else last.lines.push(row.text);
  }

  const turns: ChatTurn[] = [];
  for (const g of groups) {
    const content = g.chunks
      .map((c) => chunkText(g.role, c))
      .filter(Boolean)
      .join("\n");
    if (!content) continue;
    // 빈 덩이를 걸러 낸 자리에서 같은 역할이 이웃하면 합친다 — 역할 교대 규약을 지킨다.
    const last = turns[turns.length - 1];
    if (last && last.role === g.role) last.content += `\n${content}`;
    else turns.push({ role: g.role, content });
  }
  if (turns[0]?.role === "assistant")
    turns.unshift({ role: "user", content: "(대화 시작)" });
  return turns;
};
