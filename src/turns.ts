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

export interface TurnOptions {
  /**
   * 이 시각 이후 처음 오는 메시지에는 간격이 모자라도 시간 표시를 붙인다.
   *
   * 몰아 답장 자리에서만 켠다. 마커는 앞 발화와 한 시간 이상 벌어져야 붙는데 자리를 비우는
   * 구간은 대개 그보다 짧다(저녁 40분·씻기 25분). 그러면 모델이 보는 기록에서 나가기 직전
   * 발화와 구간 중에 온 말이 표시 없이 맞붙어, 그 사이에 한 시간 가까이 지나고 일정을 둘이나
   * 마친 사실이 기록에서 사라진다 — 아직 저녁을 안 먹었다고 답하는 길이 여기다(이슈 #238).
   */
  markFrom?: string;
  /**
   * 마커 문구의 기준이 되는 오늘(논리일 "YYYY-MM-DD"). 넘기지 않으면 지금 시각으로 잡는다.
   *
   * 어제·그저께·3일 전은 오늘이 언제냐에 따라 달라져서, 검사에서는 오늘을 고정해야 같은
   * 기록이 늘 같은 결과를 낸다.
   */
  todayLogical?: string;
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

/**
 * 최근 몇 턴만 남기고 앞을 자른다. 한 사람이 연달아 보낸 말은 몇 통이든 한 턴으로 센다.
 *
 * 행으로 세면 남는 대화 길이가 유저의 습관에 딸려 간다 — 한 번에 길게 쓰는 사람은 스무 번
 * 왕복이 남고, 짧게 끊어 보내는 사람은 열 번도 못 남는다. 세는 단위를 턴으로 옮겨 두 사람이
 * 같은 길이의 대화를 본다.
 *
 * 자르는 자리를 toTurns 앞에 두는 이유는 시간 마커다. 마커는 앞 발화와의 간격으로 붙는데,
 * 턴을 만든 뒤에 잘라 내면 남은 첫 턴이 이미 사라진 발화를 기준으로 마커를 못 받은 상태일
 * 수 있다. 행에서 먼저 자르면 남은 첫 행은 앞이 없으므로 언제나 마커를 받는다.
 */
export const lastTurns = (rows: MessageRow[], turns: number): MessageRow[] => {
  if (turns <= 0) return [];
  let kept = 0;
  let prev: Role | null = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row) continue;
    const role: Role = row.role === "user" ? "user" : "assistant";
    if (role === prev) continue;
    kept += 1;
    if (kept > turns) return rows.slice(i + 1);
    prev = role;
  }
  return rows;
};

export const toTurns = (
  rows: MessageRow[],
  opts: TurnOptions = {},
): ChatTurn[] => {
  const groups: { role: Role; chunks: Chunk[] }[] = [];
  let prevTs: string | null = null;
  let markFrom = opts.markFrom ?? null;
  for (const row of rows) {
    const role: Role = row.role === "user" ? "user" : "assistant";
    let marker = timeMarkerFor(row.sent_at, prevTs, opts.todayLogical);
    // 기준 시각을 넘어선 첫 메시지는 간격이 모자라도 마커를 받는다. 앞이 없는 것처럼 불러
    // 오늘·어제 표기를 같은 함수에서 그대로 가져온다. 한 번 준 뒤 기준을 내리는 이유는
    // 뒤이어 온 말까지 마커를 받으면 한 덩이로 붙을 말이 통마다 갈리기 때문이다.
    if (markFrom !== null && row.sent_at >= markFrom) {
      marker ??= timeMarkerFor(row.sent_at, null, opts.todayLogical);
      markFrom = null;
    }
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
