// 데모용 유저 백스테이지 뷰: 시스템이 '유저'에 대해 아는 것을 자립형 HTML 한 장으로 낸다.
// 대화로 알게 된 것(추출) vs 행동에서 측정한 것(신호)을 구분해 보여주고, 이게 매칭·캐릭터 생성의
// 재료가 됨을 설명한다. 발표용. 사용: docker exec random-ai-companion npx tsx src/tools/render-user.ts > user.html
// 주의: 실제 대화 파생 데이터(사생활) 포함 — 저장소·공개 영역에 커밋 금지.
import {
  db,
  getCast,
  getRelationshipState,
  getUserPreferences,
  recentUserGaps,
  type CharacterRow,
} from "../db.js";
import { kstDescription } from "../kst.js";

const row = db
  .prepare(
    `SELECT * FROM characters WHERE status = 'active' ORDER BY id DESC LIMIT 1`,
  )
  .get() as CharacterRow | undefined;
if (!row) {
  console.log("<html><body>no active character</body></html>");
  process.exit(0);
}

const state = getRelationshipState(row.id);
const userCast = getCast(row.id, "user");
const schedules = db
  .prepare(
    `SELECT date, time_hint, content FROM schedules WHERE character_id = ? AND owner = 'user' AND status = 'active' ORDER BY date`,
  )
  .all(row.id) as { date: string; time_hint: string | null; content: string }[];

const msgs = db
  .prepare(
    `SELECT sent_at, text FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY id`,
  )
  .all(row.chat_id) as { sent_at: string; text: string }[];

const prefs = getUserPreferences(row.chat_id);

// 측정 신호 (LLM 없이 정량)
const lens = msgs.map((m) => m.text.length).sort((a, b) => a - b);
const medianLen = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
const maxLen = lens.length ? lens[lens.length - 1] : 0;
// 호감 스파이크는 '한 턴'(유저가 연달아 보낸 말풍선 묶음) 단위로 본다 — 우진의 한 마디에
// 유저가 평소보다 많은 말풍선/글자로 반응했는가. 단일 메시지 길이보다 진짜 몰입에 가깝다.
type UTurn = {
  ts: string;
  bubbles: number;
  chars: number;
  text: string;
  prompt: string;
};
const allWithText = db
  .prepare(
    `SELECT role, sent_at, text FROM messages WHERE chat_id = ? ORDER BY id`,
  )
  .all(row.chat_id) as { role: string; sent_at: string; text: string }[];
const turns: UTurn[] = [];
let lastCharText = "";
for (let i = 0; i < allWithText.length; i++) {
  const m = allWithText[i];
  if (m.role === "assistant") {
    lastCharText = m.text;
    continue;
  }
  const contiguous = i > 0 && allWithText[i - 1].role === "user";
  const cur = turns[turns.length - 1];
  if (contiguous && cur) {
    cur.bubbles += 1;
    cur.chars += m.text.length;
    cur.text += " " + m.text;
  } else {
    turns.push({
      ts: m.sent_at,
      bubbles: 1,
      chars: m.text.length,
      text: m.text,
      prompt: lastCharText,
    });
  }
}
const turnChars = turns.map((t) => t.chars).sort((a, b) => a - b);
const medianTurnChars = turnChars.length
  ? turnChars[Math.floor(turnChars.length / 2)]
  : 0;
const spikeCharCut = Math.max(40, Math.round(medianTurnChars * 1.8));
const spikeTurns = turns
  .filter((t) => t.chars >= spikeCharCut || t.bubbles >= 3)
  .slice(-10);

// 대화량(메시지 개수)도 몰입 신호 — 하루(새벽5시 경계)별 유저 메시지 수
const dayOf = (ts: string): string =>
  new Date(new Date(ts.replace(" ", "T") + "+09:00").getTime() - 5 * 3600_000)
    .toISOString()
    .slice(0, 10);
const perDay = new Map<string, number>();
for (const m of msgs)
  perDay.set(dayOf(m.sent_at), (perDay.get(dayOf(m.sent_at)) ?? 0) + 1);
const dayCounts = [...perDay.entries()].sort((a, b) =>
  a[0].localeCompare(b[0]),
);
const avgPerDay = dayCounts.length
  ? Math.round(msgs.length / dayCounts.length)
  : 0;

// 유저가 '먼저 다가가는' 신호 — 호감의 핵심 지표
const allMsgs = db
  .prepare(
    `SELECT role, sent_at FROM messages WHERE chat_id = ? ORDER BY id`,
  )
  .all(row.chat_id) as { role: string; sent_at: string }[];
const ep = (ts: string): number =>
  new Date(ts.replace(" ", "T") + "+09:00").getTime();
let initiations = 0; // 3시간+ 침묵 뒤 유저가 먼저 연 횟수
let reReaches = 0; // 답장 없이 또 보냄(직전도 유저, 30분+ 뒤) = 강한 호감 신호
const initHours = new Array(24).fill(0) as number[];
for (let i = 0; i < allMsgs.length; i++) {
  const m = allMsgs[i];
  if (m.role !== "user") continue;
  const prev = allMsgs[i - 1];
  const hour = Number(m.sent_at.slice(11, 13));
  if (!prev) {
    initiations++;
    initHours[hour]++;
  } else if (
    prev.role === "assistant" &&
    ep(m.sent_at) - ep(prev.sent_at) > 3 * 3600_000
  ) {
    initiations++;
    initHours[hour]++;
  } else if (
    prev.role === "user" &&
    ep(m.sent_at) - ep(prev.sent_at) > 30 * 60_000
  ) {
    reReaches++;
    initHours[hour]++;
  }
}
const totalInit = initHours.reduce((a, b) => a + b, 0);
const topInitHour = totalInit
  ? initHours.reduce((best, c, h) => (c > initHours[best] ? h : best), 0)
  : -1;

const gaps = recentUserGaps(row.chat_id);
const sortedGaps = [...gaps].sort((a, b) => a - b);
const p80Gap = sortedGaps.length
  ? sortedGaps[Math.floor(sortedGaps.length * 0.8)]
  : 0;
const waitSec = Math.round(
  Math.max(20000, Math.min(40000, p80Gap * 1.4)) / 1000,
);

const EMOTION =
  /좋아|좋다|행복|설레|기대|보고 ?싶|기다렸|고마|감사|힘들|지쳤|피곤|속상|서운|우울|불안|걱정|외로|재밌|즐거|편해|안심|아쉽/g;
const emotionHits = msgs.reduce(
  (n, m) => n + (m.text.match(EMOTION)?.length ?? 0),
  0,
);

// 활동 시간대 히스토그램 (0~23시)
const hourCount = new Array(24).fill(0) as number[];
for (const m of msgs) hourCount[Number(m.sent_at.slice(11, 13))]++;
const hourMax = Math.max(1, ...hourCount);

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const li = (arr: string[]): string =>
  arr.length
    ? arr.map((s) => `<li>${esc(s)}</li>`).join("")
    : "<li class='empty'>(아직 없음)</li>";

// 막대는 전부 같은 바닥에서, 시각 라벨은 아래 별도 줄에(막대를 밀어올리지 않게)
const hourBars = hourCount
  .map(
    (c, h) =>
      `<div class="hbar" title="${h}시 · ${c}개"><div class="hfill" style="height:${Math.round((c / hourMax) * 100)}%"></div></div>`,
  )
  .join("");
const hourLabels = hourCount
  .map((_, h) => `<div class="hl">${h % 3 === 0 ? h : ""}</div>`)
  .join("");

// 유저 관계도 — 당신 중심 방사형(우진 관계도와 같은 형식). 이 캐릭터(우진)와의 대화에서 들은 사람들.
const UW = 760;
const UH = userCast.length > 4 ? 420 : 340;
const ucx = UW / 2;
const ucy = UH / 2;
// 노드 원(r=34)+라벨이 뷰박스 안에 들어오도록 배치 반지름을 제한(잘림 방지)
const rLayout = Math.min(125, ucy - 54, ucx - 70);
const uNodes = userCast.map((c, i) => {
  const angle = (Math.PI * 2 * i) / Math.max(1, userCast.length) - Math.PI / 2;
  return {
    ...c,
    x: ucx + Math.cos(angle) * rLayout,
    y: ucy + Math.sin(angle) * rLayout,
  };
});
const userGraph = [
  ...uNodes.map(
    (n) =>
      `<line x1="${ucx}" y1="${ucy}" x2="${n.x}" y2="${n.y}" stroke="#d8d3c8" stroke-width="1.5"/>`,
  ),
  ...uNodes.map(
    (n) =>
      `<g><circle cx="${n.x}" cy="${n.y}" r="34" fill="#eef2f6" stroke="#b9c6d4" stroke-width="1.5"/><text x="${n.x}" y="${n.y - 2}" text-anchor="middle" font-size="13" font-weight="600" fill="#3a5a80">${esc(n.name)}</text><text x="${n.x}" y="${n.y + 14}" text-anchor="middle" font-size="10" fill="#8a8272">${esc(n.relation_label)}</text></g>`,
  ),
  `<g><circle cx="${ucx}" cy="${ucy}" r="46" fill="#3a5a80" stroke="#3a5a80"/><text x="${ucx}" y="${ucy + 1}" text-anchor="middle" font-size="14" font-weight="700" fill="#fff">당신</text><text x="${ucx}" y="${ucy + 18}" text-anchor="middle" font-size="9" fill="#cdd8e4">유저</text></g>`,
].join("");

const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>당신에 대해 시스템이 아는 것 — 백스테이지</title>
<style>
  body { font-family: -apple-system, "Apple SD Gothic Neo", sans-serif; margin:0; background:#faf8f4; color:#3d3a33; }
  .wrap { max-width:980px; margin:0 auto; padding:36px 28px 60px; }
  h1 { font-size:21px; margin:0 0 4px; }
  .sub { color:#8a8272; font-size:12.5px; margin-bottom:24px; }
  h2 { font-size:14px; margin:30px 0 10px; color:#6b6455; letter-spacing:.03em; }
  .kicker { display:inline-block; font-size:11px; font-weight:700; padding:2px 9px; border-radius:9px; margin-right:8px; vertical-align:2px; }
  .k1 { background:#e6efe3; color:#4c7043; }
  .k2 { background:#e8e6f2; color:#5a5080; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:12px 20px; }
  .card { background:#fff; border:1px solid #e7e2d6; border-radius:10px; padding:16px 18px; }
  ul { margin:0; padding-left:18px; font-size:13px; line-height:1.75; }
  .empty { color:#b5ad9c; list-style:none; margin-left:-18px; }
  .stat { display:flex; gap:26px; font-size:13px; color:#6b6455; margin-bottom:8px; flex-wrap:wrap; }
  .stat b { font-size:19px; color:#3d3a33; display:block; }
  .metric { display:flex; gap:28px; flex-wrap:wrap; }
  .metric .m b { font-size:20px; } .metric .m span { font-size:11.5px; color:#8a8272; }
  .hist { display:flex; align-items:flex-end; gap:2px; height:72px; margin-top:6px; border-bottom:1px solid #e0dacb; }
  .hbar { flex:1; height:100%; display:flex; align-items:flex-end; justify-content:center; }
  .hfill { width:72%; background:#c8b78a; border-radius:2px 2px 0 0; min-height:1px; }
  .hlabels { display:flex; gap:2px; margin-top:3px; }
  .hl { flex:1; text-align:center; font-size:9px; color:#a8a08e; }
  .umap { background:#fff; border:1px solid #e7e2d6; border-radius:10px; }
  .spike { font-size:12.5px; line-height:1.7; }
  .spike .s { color:#9a3b30; }
  .flow { background:#fff; border:1px solid #e7e2d6; border-radius:10px; padding:16px 18px; font-size:13px; line-height:1.85; }
  .flow code { background:#f2efe7; padding:1px 6px; border-radius:4px; font-size:12px; }
  .ptopic { font-size:13px; line-height:1.85; }
  .ptopic .pt { font-weight:600; color:#3d3a33; }
  .facet { display:flex; align-items:baseline; gap:8px; font-size:13px; margin-bottom:7px; line-height:1.5; }
  .rtag { flex:none; font-size:10px; font-weight:700; padding:1px 8px; border-radius:9px; }
  .r-high { background:#e0efdb; color:#4a7040; }
  .r-low { background:#efdcdc; color:#9a4a44; }
  .r-mid { background:#ece7db; color:#7a725f; }
  .note { color:#8a8272; font-size:11.5px; margin-top:30px; }
</style></head><body><div class="wrap">
<h1>당신에 대해 시스템이 아는 것 — 백스테이지</h1>
<div class="sub">대화로 알게 된 것과 행동에서 측정한 것. 이 데이터가 '더 잘 맞는 상대'를 찾는 재료가 된다. 실제 DB 스냅샷 (${esc(kstDescription())})</div>

<div class="stat"><span><b>${msgs.length}</b>보낸 메시지</span><span><b>${state.user_facts.length}</b>알게 된 사실</span><span><b>${userCast.length}</b>당신의 사람들</span><span><b>${schedules.length}</b>당신의 일정</span></div>

<h2><span class="kicker k1">추출</span>당신의 주변 사람들 — 이 대화에서 들은 관계도</h2>
<svg class="umap" viewBox="0 0 ${UW} ${UH}" width="100%">${userGraph}</svg>
<div style="font-size:11.5px;color:#8a8272;margin-top:6px">우진과의 대화에서 당신이 들려준 사람들이다. 다른 캐릭터에게는 다르게 이야기할 수 있으므로, 이 관계도는 <b>우진-당신 사이에 국한</b>된다.</div>

<h2><span class="kicker k1">추출</span>대화로 알게 된 것</h2>
<div class="grid">
  <div class="card"><h2 style="margin-top:0">기억하는 사실 (user_facts)</h2><ul>${li(state.user_facts.map((f) => `${f.fact} — ${f.learned_at}`))}</ul></div>
  <div class="card"><h2 style="margin-top:0">당신의 일정</h2><ul>${li(schedules.map((s) => `${s.date}${s.time_hint ? ` ${s.time_hint}` : ""} ${s.content}`))}</ul></div>
  <div class="card"><h2 style="margin-top:0">이어갈 이야기 (오픈 루프)</h2><ul>${li(state.open_loops.filter((l) => l.status === "open").map((l) => l.content))}</ul></div>
</div>

<h2><span class="kicker k2">측정</span>행동에서 읽어낸 신호</h2>
<div class="grid">
  <div class="card"><h2 style="margin-top:0">답장 리듬</h2><div class="metric"><div class="m"><b>${p80Gap ? Math.round(p80Gap / 1000) + "초" : "—"}</b><span>이어 보내기 텀(상위)</span></div><div class="m"><b>${waitSec}초</b><span>맞춤 디바운스 대기</span></div></div><div style="font-size:11.5px;color:#8a8272;margin-top:8px">짧게 끊어 보내는지 길게 몰아 치는지를 재서 답장 대기를 맞춘다.</div></div>
  <div class="card"><h2 style="margin-top:0">대화량 · 메시지 길이</h2><div class="metric"><div class="m"><b>${avgPerDay}개</b><span>하루 평균 메시지</span></div><div class="m"><b>${medianLen}자</b><span>평소 길이(중앙값)</span></div><div class="m"><b>${spikeTurns.length}</b><span>반응 스파이크</span></div></div><div style="font-size:11.5px;color:#8a8272;margin-top:8px">몰입은 길이보다 <b>대화량</b>(그 화제를 얼마나 이어가는지)이 더 크게 말한다 — 진짜 판정은 밤 정리 몫(아래).</div></div>
  <div class="card"><h2 style="margin-top:0">먼저 다가가는 신호 <span style="font-size:11px;color:#c0685e">♥ 호감</span></h2><div class="metric"><div class="m"><b>${initiations}</b><span>먼저 말 건 횟수</span></div><div class="m"><b style="color:#c0685e">${reReaches}</b><span>답장 없어도 또 연락</span></div><div class="m"><b>${topInitHour >= 0 ? topInitHour + "시" : "—"}</b><span>주로 먼저 여는 때</span></div></div><div style="font-size:11.5px;color:#8a8272;margin-top:8px"><b>우진의 답장이 아직 없는데도 유저가 또 말을 거는 것</b> — 답을 기다리다 한 번 더 연락하는 것은 강한 호감 신호다. 언제 먼저 다가오는지(선호 시간대)도 매칭·선톡 타이밍의 재료가 된다.</div></div>
  <div class="card" style="grid-column:1/3"><h2 style="margin-top:0">활동 시간대 — 몇 시에 대화하나 (24시간)</h2><div class="hist">${hourBars}</div><div class="hlabels">${hourLabels}</div></div>
</div>

<h2><span class="kicker k1">추출</span>밤 정리가 뽑은 선호 (매칭 전용 · 캐릭터엔 비공개)</h2>
<div class="grid">
  <div class="card"><h2 style="margin-top:0">몰입하는 소재 (호감 소재)</h2>${prefs.topics.length ? `<div class="ptopic">${prefs.topics.map((t) => `<div><span class="pt">${esc(t.topic)}</span>${t.note ? ` — ${esc(t.note)}` : ""}</div>`).join("")}</div>` : "<div class='empty' style='font-size:13px'>(아직 없음 — 밤 정리가 대화 내용으로 뽑는다. 오늘 대화는 내일 새벽 반영)</div>"}</div>
  <div class="card"><h2 style="margin-top:0">우진의 어떤 모습에 반응이 좋나</h2>${prefs.facets.length ? prefs.facets.map((f) => `<div class="facet"><span class="rtag ${f.response === "높음" ? "r-high" : f.response === "낮음" ? "r-low" : "r-mid"}">${esc(f.response)}</span><span><b>${esc(f.facet)}</b>${f.note ? ` — ${esc(f.note)}` : ""}</span></div>`).join("") : "<div class='empty' style='font-size:13px'>(아직 없음 — 안정감·위트·직업·취미 등 우진의 성향별 반응을 밤 정리가 판정)</div>"}</div>
</div>

<h2><span class="kicker k2">측정</span>원시 신호 — 우진의 말에 평소보다 크게 반응한 순간 (위 '호감 소재'의 재료)</h2>
<div class="card spike">${
  spikeTurns.length
    ? spikeTurns
        .slice()
        .reverse()
        .map(
          (s) =>
            `<div style="margin-bottom:9px"><span class="s">${s.ts.slice(5, 16)} · 말풍선 ${s.bubbles}개 · ${s.chars}자</span>${s.prompt ? `<br><span style="color:#8a8272">우진: ${esc(s.prompt.replace(/\n/g, " ").slice(0, 46))}</span>` : ""}<br>나: ${esc(s.text.replace(/\n/g, " ").slice(0, 90))}</div>`,
        )
        .join("")
    : "(아직 없음)"
}</div>
<div style="font-size:11.5px;color:#8a8272;margin-top:6px">우진의 한 마디에 유저가 평소보다 많은 말풍선·글자로 답한 순간이다(단일 메시지가 아니라 한 턴 전체로 잰다). 무엇에 몰입했는지(진짜 선호 소재)는 밤 정리가 내용으로 판정해 <code>user_preferences</code>에 넣는다 — 양은 많아도 부정(불평)은 걸러서.</div>

<h2>이 데이터가 어떻게 쓰이나 — 선호에서 다음 만남으로</h2>
<div class="flow">
① 대화·행동에서 <b>선호 신호</b>를 모은다(호감 소재·대화량·감정·리듬·활동대).<br>
② 밤 정리가 내용으로 걸러 <code>user_preferences</code>에 쌓는다 — <b>소재 선호</b>(무엇에 몰입하나) + <b>성향 선호</b>(우진의 안정감·위트·직업·취미 중 무엇에 반응이 좋나). <b>매칭 시스템만 읽고 캐릭터엔 안 준다</b>(감시 아닌 관심).<br>
③ 새 캐릭터를 만들 때 이 선호로 <b>궁합</b>을 맞춘다 — <code>createCharacter(seedNote)</code>의 씨앗을 편향시켜, 취향을 복제한 예스맨이 아니라 <b>당신과 클릭할 결의 사람</b>을 뽑는다.<br>
④ 떠날 때의 이유(가장 값진 신호)까지 더해, <b>대화할수록 더 잘 맞는 상대</b>를 만나게 된다.
</div>

<div class="note">유저의 내부 데이터이며 시연을 위해서만 열람한다. 선호는 매칭 전용이라 캐릭터 화면·발화에는 노출되지 않는다.</div>
</div></body></html>`;

console.log(html);
