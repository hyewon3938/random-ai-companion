// 데모용 백스테이지 뷰: 실제 DB에서 우진의 세계(관계도·기억·온도·일기·삶의 흐름)를
// 자립형 HTML 한 장으로 렌더링해 stdout으로 출력한다. 발표에서 "설계의 실물"을 보여주는 용도.
// 사용: 배포 서버에서 docker exec <container> npx tsx src/tools/render-map.ts > map.html
// 주의: 출력물에 실제 대화 파생 데이터가 담기므로 저장소·공개 영역에 커밋하지 않는다.
import {
  db,
  getCast,
  getDayPlan,
  getRelationshipState,
  getUpcomingSchedules,
  getArcs,
  getMonthSeeds,
  getSchedulesInMonth,
  type CharacterRow,
} from "../db.js";
import type { Bible } from "../character.js";
import { blockCategory, type DayPlan } from "../day-plan.js";
import { RESPONSIVENESS_NAME } from "../labels.js";
import { kstClock, kstDateString, kstDescription } from "../kst.js";

const row = db
  .prepare(
    `SELECT * FROM characters WHERE status = 'active' ORDER BY id DESC LIMIT 1`,
  )
  .get() as CharacterRow | undefined;

if (!row) {
  console.log("<html><body>no active character</body></html>");
  process.exit(0);
}

const bible = JSON.parse(row.genesis_json) as Bible;
const cast = getCast(row.id, "char");
const userCast = getCast(row.id, "user");
const state = getRelationshipState(row.id);
const arcs = getArcs(row.id);
const schedules = getUpcomingSchedules(row.id, "2000-01-01", 50);
const today = kstDateString();
const nowHM = kstClock();
const todayPlanRaw = getDayPlan(row.id, today);
const todayBlocks: DayPlan["blocks"] = todayPlanRaw
  ? (JSON.parse(todayPlanRaw) as DayPlan).blocks
  : [];

// 연락 가용성(bot.ts blockDelayMs와 같은 규칙) — 지금 실제로 얼마나 빨리 답하는지
const metRow = db
  .prepare(`SELECT met_at FROM relationships WHERE character_id = ?`)
  .get(row.id) as { met_at: string } | undefined;
const relDays = metRow
  ? (Date.now() -
      new Date(metRow.met_at.replace(" ", "T") + "+09:00").getTime()) /
    86_400_000
  : 999;
const curBlock = todayBlocks.find((b) => b.start <= nowHM && nowHM < b.end);
const curDeepSleep = curBlock
  ? curBlock.responsiveness === "unavailable" &&
    /잠|수면|숙면/.test(curBlock.activity) &&
    !/준비/.test(curBlock.activity)
  : false;
const availabilityNow = !curBlock
  ? "—"
  : curDeepSleep
    ? "자는 시간이지만 연락하면 바로 답 (즉답)"
    : curBlock.responsiveness === "instant"
      ? "여유 → 0~2분"
      : curBlock.responsiveness === "intermittent"
        ? "틈틈이 → 몇 분 내"
        : blockCategory(curBlock) === "official"
          ? "손이 묶임 → 그 일정이 끝날 때"
          : "자리 비움 → 그 일정이 끝날 때 (붙잡으면 접고 곁에)";
const ym = kstDateString().slice(0, 7);
const monthSeeds = getMonthSeeds(row.id, ym);
const monthEvents = getSchedulesInMonth(row.id, ym, "char");
const eventByDate = new Map<string, string>();
for (const e of monthEvents)
  eventByDate.set(
    e.date,
    `${eventByDate.get(e.date) ? eventByDate.get(e.date) + "; " : ""}${e.time_hint ? e.time_hint + " " : ""}${e.content}`,
  );
const diaries = db
  .prepare(
    `SELECT date, entry_json FROM diary_entries WHERE character_id = ? ORDER BY date`,
  )
  .all(row.id) as { date: string; entry_json: string }[];
const msgStats = db
  .prepare(
    `SELECT count(*) total, sum(role='user') u, sum(role='assistant') c FROM messages WHERE chat_id = ?`,
  )
  .get(row.chat_id) as { total: number; u: number; c: number };

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface DiaryParsed {
  date: string;
  diary?: string;
  closeness?: string;
  user_mood?: string;
  plan_vs_actual?: string;
}
const parsedDiaries: DiaryParsed[] = diaries.map((d) => {
  try {
    return { date: d.date, ...(JSON.parse(d.entry_json) as object) };
  } catch {
    return { date: d.date };
  }
});

// 관계도 노드 좌표 (우진 중심 방사형)
const W = 760;
const H = 420;
const cx = W / 2;
const cy = H / 2;
const nodes = cast.map((c, i) => {
  const angle = (Math.PI * 2 * i) / cast.length - Math.PI / 2;
  const r = 150;
  return {
    ...c,
    x: cx + Math.cos(angle) * r,
    y: cy + Math.sin(angle) * r,
  };
});

const castSvg = [
  ...nodes.map(
    (n) =>
      `<line x1="${cx}" y1="${cy}" x2="${n.x}" y2="${n.y}" stroke="#d8d3c8" stroke-width="1.5"/>`,
  ),
  `<line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - 150}" stroke="none"/>`,
  ...nodes.map(
    (n) => `
  <g>
    <circle cx="${n.x}" cy="${n.y}" r="34" fill="#f4f1ea" stroke="#c9c2b2" stroke-width="1.5"/>
    <text x="${n.x}" y="${n.y - 2}" text-anchor="middle" font-size="13" font-weight="600" fill="#3d3a33">${esc(n.name)}</text>
    <text x="${n.x}" y="${n.y + 14}" text-anchor="middle" font-size="10" fill="#8a8272">${esc(n.relation_label)}</text>
  </g>`,
  ),
  `
  <g>
    <circle cx="${cx}" cy="${cy}" r="46" fill="#3d3a33" stroke="#3d3a33"/>
    <text x="${cx}" y="${cy + 1}" text-anchor="middle" font-size="15" font-weight="700" fill="#f7f5f0">${esc(bible.identity.name)}</text>
    <text x="${cx}" y="${cy + 18}" text-anchor="middle" font-size="9" fill="#cdc7b8">${esc(bible.identity.age_band)}</text>
  </g>`,
].join("\n");

const li = (arr: string[]): string =>
  arr.length
    ? arr.map((s) => `<li>${esc(s)}</li>`).join("")
    : "<li class='empty'>(아직 없음)</li>";

// 이번 달 리듬 스트립: 하루 한 칸, 기력=배경색, 기상 성향=마크, 이벤트=점
const energyColor = (e: string): string =>
  e === "낮음" ? "#c8d3dc" : e === "높음" ? "#efd9ba" : "#ece7db";
// 이번 달 리듬 — 달력(일~토) 격자. 각 칸: 기력=배경색, 기상 성향=마크, 이벤트=점. 호버 시 CSS 툴팁(즉시).
const seedByDate = new Map(monthSeeds.map((s) => [s.date, s]));
const [calYear, calMonth] = ym.split("-").map(Number);
const firstDow = new Date(`${ym}-01T12:00:00Z`).getUTCDay(); // 0=일요일
const daysInMonth = new Date(Date.UTC(calYear, calMonth, 0)).getUTCDate();
const calHeader = ["일", "월", "화", "수", "목", "금", "토"]
  .map(
    (d, i) =>
      `<div class="calhdr${i === 0 ? " sun" : i === 6 ? " sat" : ""}">${d}</div>`,
  )
  .join("");
const DOW = ["일", "월", "화", "수", "목", "금", "토"];
const calCells: string[] = [];
for (let i = 0; i < firstDow; i++)
  calCells.push(`<div class="dcell empty"></div>`);
for (let d = 1; d <= daysInMonth; d++) {
  const date = `${ym}-${String(d).padStart(2, "0")}`;
  const s = seedByDate.get(date);
  const ev = eventByDate.get(date);
  const dowNum = (firstDow + d - 1) % 7;
  const dow = DOW[dowNum];
  const weekend = dowNum === 0 || dowNum === 6;
  // 기상 성향 → 대략 시각 (평일/주말 다름). 시드는 성향만 있어 근사치.
  const wakeApprox = (hint: string): string =>
    weekend
      ? hint === "이른"
        ? "7시쯤"
        : hint === "늦잠"
          ? "10시 무렵"
          : "8~9시"
      : hint === "이른"
        ? "5시 반쯤"
        : hint === "늦잠"
          ? "7시 무렵"
          : "6시쯤";
  const wakeTag =
    s?.wake_hint === "이른"
      ? `<span class="wtag early">일찍</span>`
      : s?.wake_hint === "늦잠"
        ? `<span class="wtag late">늦잠</span>`
        : "";
  const evShort = ev ? esc(ev.length > 9 ? ev.slice(0, 9) + "…" : ev) : "";
  const tip =
    `<b>${date} (${dow})</b>` +
    (s
      ? `<br>기력 <b>${s.energy}</b> · 기상 ${s.wake_hint} (${wakeApprox(s.wake_hint)})<br>${esc(s.mood)}${s.reason ? `<br><span class="tnote">${esc(s.reason)}</span>` : ""}`
      : "<br>(리듬 없음)") +
    (ev ? `<br><span class="tev">일정 · ${esc(ev)}</span>` : "");
  calCells.push(
    `<div class="dcell${date === today ? " dtoday" : ""}" style="background:${s ? energyColor(s.energy) : "#f4f1ea"}"><div class="dtop"><span class="dn">${d}</span>${wakeTag}</div>${ev ? `<div class="devt">${evShort}</div>` : ""}<div class="tip">${tip}</div></div>`,
  );
}
const calendar = calHeader + calCells.join("");

// 오늘의 하루 각본: 시간 블록 + 답장 여건(즉답/틈틈이/불가) 색 구분, 지금 블록 하이라이트
const respStyle = (r: string): { bg: string; label: string } =>
  r === "instant"
    ? { bg: "#e3efe1", label: "답장 즉시" }
    : r === "intermittent"
      ? { bg: "#f5ecd8", label: "틈틈이 (몇 분 뒤)" }
      : { bg: "#e6e3dc", label: "자리 비움 (일정 끝나고)" };
const nowBlock = todayBlocks.find((b) => b.start <= nowHM && nowHM < b.end);
const planRows = todayBlocks
  .map((b) => {
    const isNow = b === nowBlock;
    const s = respStyle(b.responsiveness);
    return `<div class="prow${isNow ? " now" : ""}"><span class="ptime">${b.start}–${b.end}</span><span class="pact">${esc(b.activity)}${b.advance_known ? "" : " <span class='sudden'>· 갑자기</span>"}</span><span class="pbadge" style="background:${s.bg}">${RESPONSIVENESS_NAME[b.responsiveness]} · ${s.label}</span>${isNow ? "<span class='pnow'>지금</span>" : ""}</div>`;
  })
  .join("");

const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>우진의 세계 — 백스테이지</title>
<style>
  body { font-family: -apple-system, "Apple SD Gothic Neo", sans-serif; margin: 0; background: #faf8f4; color: #3d3a33; }
  .wrap { max-width: 980px; margin: 0 auto; padding: 36px 28px 60px; }
  h1 { font-size: 21px; margin: 0 0 4px; }
  .sub { color: #8a8272; font-size: 12.5px; margin-bottom: 26px; }
  h2 { font-size: 14px; margin: 30px 0 10px; color: #6b6455; letter-spacing: .03em; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 28px; }
  .card { background: #fff; border: 1px solid #e7e2d6; border-radius: 10px; padding: 16px 18px; }
  ul { margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.75; }
  .empty { color: #b5ad9c; list-style: none; margin-left: -18px; }
  .map { background: #fff; border: 1px solid #e7e2d6; border-radius: 10px; }
  .temp { font-size: 13px; line-height: 1.7; }
  .temp b { display:inline-block; min-width: 84px; color: #6b6455; font-weight:600; }
  .diary { font-size: 13px; line-height: 1.8; }
  .diary .d { color: #6b6455; font-weight: 600; margin-top: 10px; }
  .stat { display:flex; gap: 26px; font-size: 13px; color:#6b6455; margin-bottom: 4px; }
  .stat b { font-size: 19px; color: #3d3a33; display:block; }
  .cal { display:grid; grid-template-columns:repeat(7,1fr); gap:4px; }
  .calhdr { text-align:center; font-size:11px; color:#8a8272; padding-bottom:2px; }
  .calhdr.sun { color:#c0685e; }
  .calhdr.sat { color:#5e7ec0; }
  .dcell { position:relative; min-height:56px; border-radius:6px; border:1px solid #e0dacb; padding:4px 5px 5px; }
  .dcell.empty { border:none; background:transparent!important; min-height:0; }
  .dcell.dtoday { outline:2px solid #c99a34; outline-offset:-1px; }
  .dtop { display:flex; align-items:center; justify-content:space-between; gap:2px; }
  .dcell .dn { font-size:11px; font-weight:600; color:#3d3a33; }
  .wtag { font-size:9px; padding:0 4px; border-radius:6px; line-height:15px; font-weight:600; white-space:nowrap; }
  .wtag.early { background:#dbe8f2; color:#3f6690; }
  .wtag.late { background:#f0e2cd; color:#8a6320; }
  .devt { margin-top:4px; font-size:9.5px; line-height:1.2; color:#9a3b30; background:rgba(192,57,43,.1); border-radius:3px; padding:1px 4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .dcell .tip { display:none; position:absolute; z-index:20; bottom:calc(100% + 6px); left:50%; transform:translateX(-50%); background:#38352e; color:#efeadf; font-size:11.5px; line-height:1.6; padding:9px 11px; border-radius:8px; width:max-content; max-width:230px; white-space:normal; text-align:left; box-shadow:0 4px 14px rgba(0,0,0,.28); pointer-events:none; }
  .dcell .tip b { color:#fff; font-weight:600; }
  .dcell .tip .tnote { color:#cfc59a; font-size:11px; }
  .dcell .tip .tev { color:#f2b3a6; }
  .dcell:hover .tip { display:block; }
  .legend { font-size:11.5px; color:#8a8272; margin-top:10px; display:flex; gap:14px; flex-wrap:wrap; align-items:center; }
  .legend .chip { display:inline-block; width:12px; height:12px; border-radius:3px; vertical-align:-2px; margin-right:4px; border:1px solid #e0dacb; }
  .pcur { font-size:13.5px; margin-bottom:10px; padding:8px 12px; background:#fdf8ec; border:1px solid #ecd9a8; border-radius:8px; }
  .plan { display:flex; flex-direction:column; gap:3px; }
  .prow { display:flex; align-items:center; gap:10px; padding:6px 10px; border-radius:7px; font-size:12.5px; border:1px solid transparent; }
  .prow.now { border-color:#d8b45c; background:#fdf8ec; }
  .ptime { color:#8a8272; font-variant-numeric:tabular-nums; min-width:92px; }
  .pact { flex:1; color:#3d3a33; }
  .pact .sudden { color:#c0392b; font-size:11px; }
  .pbadge { font-size:11px; color:#5c5647; padding:2px 9px; border-radius:10px; white-space:nowrap; border:1px solid rgba(0,0,0,.05); }
  .pnow { font-size:11px; font-weight:700; color:#a5792a; }
  .sched { list-style:none; padding-left:0; }
  .sched li { margin-bottom:4px; }
  .sched li.empty { color:#b5ad9c; }
  .who { display:inline-block; font-size:10px; padding:1px 7px; border-radius:9px; margin-right:5px; vertical-align:1px; font-weight:600; }
  .who.wu { background:#dce9f5; color:#3a5a80; }
  .who.wc { background:#efe1cd; color:#7a5a2a; }
  .note { color:#8a8272; font-size: 11.5px; margin-top: 34px; }
</style></head><body><div class="wrap">
<h1>${esc(bible.identity.name)}의 세계 — 백스테이지</h1>
<div class="sub">${esc(bible.identity.job)} · ${esc(bible.identity.living)} · 실제 DB 스냅샷 (${esc(kstDescription())})</div>

<div class="stat"><span><b>${msgStats.total}</b>주고받은 메시지</span><span><b>${parsedDiaries.length}</b>쌓인 일기</span><span><b>${state.user_facts.length}</b>상대에 대한 기억</span><span><b>${cast.length}</b>주변 사람</span></div>

<h2>오늘의 하루 각본 — 우진은 지금 무엇을 하나 (${esc(today)})</h2>
<div class="card">
  ${nowBlock ? `<div class="pcur">지금 ${esc(nowHM)} · <b>${esc(nowBlock.activity)}</b> — ${respStyle(nowBlock.responsiveness).label}<br><span style="color:#a5792a;font-size:12.5px">연락하면: ${esc(availabilityNow)} <span style="color:#8a8272">(관계 ${Math.floor(relDays)}일차)</span></span></div>` : ""}
  <div class="plan">${planRows || "<span class='empty'>(오늘 각본 아직 없음 — 그날 첫 대화나 밤 정리 때 생성)</span>"}</div>
  <div class="legend"><span><span class="chip" style="background:#e3efe1"></span>즉답</span><span><span class="chip" style="background:#f5ecd8"></span>틈틈이 (몇 분 뒤)</span><span><span class="chip" style="background:#e6e3dc"></span>불가 (일정 끝나고)</span><span><span style="color:#c0392b">· 갑자기</span> = 미리 알려지지 않은 일</span></div>
  <div class="legend" style="margin-top:6px">연락 가용성: 답장 여건과 활동 성격 두 태그로 텀이 정해진다 · 자는 시간에 연락이 와도 바로 답 · 개인·사회 일정은 유저가 붙잡으면 접거나 미루고 곁에 · 밤에 유저가 잠들면 밤 인사 챙김</div>
</div>

<h2>주변 사람들 — 대화와 삶에서 자라는 관계도</h2>
<svg class="map" viewBox="0 0 ${W} ${H}" width="100%">${castSvg}</svg>

<div class="grid">
  <div class="card"><h2 style="margin-top:0">상대(유저)에 대해 기억하는 것</h2><ul>${li(state.user_facts.map((f) => `${f.fact} — ${f.learned_at}`))}</ul></div>
  <div class="card"><h2 style="margin-top:0">자기에 대해 새로 말한 것 (누적 정체성)</h2><ul>${li((state.char_facts ?? []).map((f) => `${f.fact} — ${f.learned_at}`))}</ul></div>
  <div class="card"><h2 style="margin-top:0">이어갈 이야기 (오픈 루프)</h2><ul>${li(state.open_loops.filter((l) => l.status === "open").map((l) => l.content))}</ul></div>
  <div class="card"><h2 style="margin-top:0">알고 있는 일정</h2><ul class="sched">${schedules.length ? schedules.map((s) => `<li><span class="who ${s.owner === "user" ? "wu" : "wc"}">${s.owner === "user" ? "상대" : "우진"}</span> ${esc(s.date)}${s.time_hint ? ` ${esc(s.time_hint)}` : ""} ${esc(s.content)}</li>`).join("") : "<li class='empty'>(아직 없음)</li>"}</ul></div>
  <div class="card"><h2 style="margin-top:0">상대의 주변 사람들 (들은 것)</h2><ul>${li(userCast.map((c) => `${c.name} (${c.relation_label})${c.recent_note ? ` — ${c.recent_note}` : ""}`))}</ul></div>
</div>

<h2>관계의 온도 — 매일 밤 내부에 기록되는 한 줄 (유저에겐 보이지 않음)</h2>
<div class="card temp">${parsedDiaries.map((d) => `<div><b>${d.date}</b> ${esc(d.closeness ?? "—")}</div>`).join("") || "(아직 없음)"}</div>

<h2>삶의 큰 흐름</h2>
<div class="card temp">${(["year", "season", "month", "week"] as const).map((h) => (arcs[h] ? `<div><b>${{ year: "올해", season: "이 계절", month: "이번 달", week: "이번 주" }[h]}</b> ${esc(arcs[h])}</div>` : "")).join("")}</div>

<h2>이번 달 리듬 — 미리 깔린 컨디션·기상 (${esc(ym)}, 하루하루는 일기가 조정)</h2>
<div class="card">
  <div class="cal">${calendar}</div>
  <div class="legend">
    <span>칸 색 = 기력</span>
    <span><span class="chip" style="background:#c8d3dc"></span>낮음</span>
    <span><span class="chip" style="background:#ece7db"></span>보통</span>
    <span><span class="chip" style="background:#efd9ba"></span>높음</span>
    <span><span class="wtag early">일찍</span>(평일 ~5시반·주말 ~7시) <span class="wtag late">늦잠</span>(평일 ~7시·주말 ~10시) = 기상</span>
    <span>빨간 글씨 = 그날 일정 · 노란 테두리 = 오늘 · 커서 올리면 상세</span>
  </div>
</div>

<h2>일기 — 하루가 기억이 되는 자리</h2>
<div class="card diary">${parsedDiaries.map((d) => `<div class="d">${d.date}</div><div>${esc(d.diary ?? "")}</div>`).join("") || "(아직 없음)"}</div>

<div class="note">캐릭터의 내면 기록이며 시연을 위해서만 열람한다. 유저 화면에는 노출되지 않는다.</div>
</div></body></html>`;

console.log(html);
