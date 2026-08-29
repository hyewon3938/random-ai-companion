// 관리 대시보드 — DB에 저장된 데이터를 표 단위로 보는 화면.
//
// 저장된 모양 그대로 보여준다. 표 하나가 화면의 한 구획이고, 의미로 다시 묶지 않는다.
// 컬럼은 PRAGMA table_info가 알려주는 그대로, 행은 전부 싣고, 빈 표도 감추지 않는다 —
// 비어 있다는 사실 자체가 정보다.
//
// 검색·정렬·펼치기는 만들어진 화면 안에서 돌아가므로 다시 실행할 필요가 없다.
// DB는 읽기 전용으로 열고 마이그레이션을 타지 않으려고 src/db.ts를 거치지 않는다.
//
// 사용: DB_PATH=data/prod-snapshot.db npx tsx src/tools/render-db.ts > docs/dashboard.html
// 주의: 출력물에 실제 대화가 담기므로 저장소·공개 영역에 커밋하지 않는다.

import Database from "better-sqlite3";
import { basename } from "node:path";

const file = process.env.DB_PATH ?? "./data/companion.db";
const db = new Database(file, { readonly: true, fileMustExist: true });

// ── 읽기 ──────────────────────────────────────────────────────────────────

interface Col {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

const tableNames = (
  db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as { name: string }[]
).map((r) => r.name);

// 태그는 별도 표에 있어서 기억 행 옆에 조인해 붙인다. 지금 tags.kind는 memory 하나뿐이다.
const tagsOfMemory = new Map<number, string[]>();
for (const t of db
  .prepare(`SELECT ref_id, tag FROM tags WHERE kind = 'memory' ORDER BY tag`)
  .all() as { ref_id: number; tag: string }[]) {
  const list = tagsOfMemory.get(t.ref_id) ?? [];
  list.push(t.tag);
  tagsOfMemory.set(t.ref_id, list);
}

// 최근 것을 위에 두려고 id·date·created_at 순으로 내림차순 정렬 기준을 고른다.
const orderOf = (cols: Col[]): { sql: string; label: string } => {
  const has = (n: string) => cols.some((c) => c.name === n);
  if (has("id")) return { sql: ` ORDER BY id DESC`, label: "id 내림차순" };
  if (has("date")) return { sql: ` ORDER BY date DESC`, label: "date 내림차순" };
  if (has("created_at"))
    return { sql: ` ORDER BY created_at DESC`, label: "created_at 내림차순" };
  return { sql: "", label: "저장 순서" };
};

interface Table {
  name: string;
  cols: Col[];
  rows: Record<string, unknown>[];
  order: string;
}

const tables: Table[] = tableNames.map((name) => {
  const cols = db.prepare(`PRAGMA table_info("${name}")`).all() as Col[];
  const order = orderOf(cols);
  const rows = db
    .prepare(`SELECT * FROM "${name}"${order.sql}`)
    .all() as Record<string, unknown>[];
  return { name, cols, rows, order: order.label };
});

const totalRows = tables.reduce((n, t) => n + t.rows.length, 0);
const userVersion = db.pragma("user_version", { simple: true }) as number;

// ── 조판 ──────────────────────────────────────────────────────────────────

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const num = (n: number): string => n.toLocaleString("ko-KR");

// 저장된 값은 그대로 두고 줄바꿈만 넣어 읽히게 한다.
const pretty = (col: string, s: string): string | null => {
  const looks = col.endsWith("_json") || /^[[{]/.test(s.trim());
  if (!looks) return null;
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return null;
  }
};

const CLIP = 80; // 이 길이를 넘는 값은 접어 두고 눌러서 편다

const cell = (col: string, v: unknown): string => {
  if (v === null || v === undefined) return `<td class="nul">NULL</td>`;
  if (typeof v === "number") return `<td class="num">${num(v)}</td>`;
  if (v instanceof Uint8Array)
    return `<td class="nul">BLOB ${num(v.length)}B</td>`;
  const s = String(v);
  if (!s) return `<td class="nul">빈 값</td>`;
  const j = pretty(col, s);
  if (j !== null)
    return `<td class="lgc"><div class="lg"><pre>${esc(j)}</pre></div></td>`;
  if (s.length > CLIP)
    return `<td class="lgc"><div class="lg">${esc(s)}</div></td>`;
  return `<td>${esc(s)}</td>`;
};

const tagCell = (id: unknown): string => {
  const list = typeof id === "number" ? (tagsOfMemory.get(id) ?? []) : [];
  if (!list.length) return `<td class="nul">없음</td>`;
  return `<td class="tgc">${list
    .map((t) => `<button class="tag" data-t="${esc(t)}">${esc(t)}</button>`)
    .join("")}</td>`;
};

const section = (t: Table): string => {
  const joined = t.name === "memory_items";
  const head =
    t.cols
      .map(
        (c) =>
          `<th class="s"${c.pk ? ' data-pk="1"' : ""}><span>${esc(c.name)}</span><i>${esc(
            c.type || "—",
          )}${c.pk ? " · 키" : ""}</i></th>`,
      )
      .join("") + (joined ? `<th><span>tags</span><i>조인</i></th>` : "");

  const body = t.rows.length
    ? t.rows
        .map(
          (r) =>
            `<tr>${t.cols.map((c) => cell(c.name, r[c.name])).join("")}${
              joined ? tagCell(r.id) : ""
            }</tr>`,
        )
        .join("\n")
    : `<tr class="none"><td colspan="${t.cols.length + (joined ? 1 : 0)}">행 없음</td></tr>`;

  return `<section class="tb" id="t-${t.name}" data-name="${t.name}">
  <div class="th">
    <h2>${esc(t.name)}</h2>
    <span class="cnt"><b>${num(t.rows.length)}</b>행</span>
    <span class="meta">컬럼 ${t.cols.length}개 · ${esc(t.order)}${
      joined ? " · tags 표를 조인해 마지막 열에 붙임" : ""
    }</span>
  </div>
  <div class="scroll"><table>
    <thead><tr>${head}</tr></thead>
    <tbody>
${body}
    </tbody>
  </table></div>
</section>`;
};

const rail = tables
  .map(
    (t) =>
      `<a href="#t-${t.name}"${t.rows.length ? "" : ' class="empty"'}><span>${esc(
        t.name,
      )}</span><b data-for="${t.name}">${num(t.rows.length)}</b></a>`,
  )
  .join("\n");

const now = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  dateStyle: "medium",
  timeStyle: "short",
}).format(new Date());

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>관리 대시보드</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.min.css">
<style>
  :root {
    --page:#F4F4F6; --card:#FFFFFF; --surf:#FAFAFA; --surf2:#F3F3F5;
    --line:#EBEBEF; --line2:#DEDEE4;
    --t1:#141416; --t2:#34343B; --t3:#6C6C76; --t4:#9A9AA4;
    --ac:#6728FF; --ac-ink:#4A17C7; --ac-soft:rgba(103,40,255,.055); --ac-line:rgba(103,40,255,.20);
    --nu:#6C6C76; --nu-soft:rgba(20,20,22,.032); --nu-line:rgba(20,20,22,.10);
    --cy:#0895B2; --cy-ink:#046A80; --cy-soft:rgba(8,149,178,.09); --cy-line:rgba(8,149,178,.32);
    --bar:rgba(244,244,246,.86);
    --sh-s:0 1px 2px rgba(15,15,20,.05);
  }
  html[data-theme="dark"] {
    --page:#151516; --card:#1C1C1E; --surf:#212123; --surf2:#26262A;
    --line:#2D2D32; --line2:#3A3A41;
    --t1:#FFFFFF; --t2:#E3E3E7; --t3:#A2A2AC; --t4:#84848F;
    --ac:#8B5CFF; --ac-ink:#C6ACFF; --ac-soft:rgba(139,92,255,.13); --ac-line:rgba(139,92,255,.40);
    --nu:#A2A2AC; --nu-soft:rgba(255,255,255,.045); --nu-line:rgba(255,255,255,.13);
    --cy:#54D2EA; --cy-ink:#ADEBF7; --cy-soft:rgba(84,210,234,.16); --cy-line:rgba(84,210,234,.44);
    --bar:rgba(21,21,22,.86);
    --sh-s:0 1px 2px rgba(0,0,0,.4);
  }

  * { box-sizing:border-box; }
  body { margin:0; background:var(--page); color:var(--t2);
    font-family:'Pretendard Variable',Pretendard,-apple-system,'Apple SD Gothic Neo','Segoe UI',sans-serif;
    -webkit-font-smoothing:antialiased; }
  code, pre, .mono { font-family:'SF Mono',ui-monospace,Menlo,Consolas,monospace; }

  /* 상단 바 */
  .bar { position:sticky; top:0; z-index:60; background:var(--bar);
         backdrop-filter:saturate(180%) blur(14px); border-bottom:1px solid var(--line); }
  .bar-in { display:flex; align-items:center; gap:14px; padding:11px 22px; }
  .brand { font-size:14px; font-weight:800; color:var(--t1); letter-spacing:-.02em; white-space:nowrap; }
  .brand em { font-style:normal; color:var(--t4); font-weight:600; margin-left:8px; font-size:12px; }
  .search { flex:1; min-width:0; display:flex; align-items:center; gap:8px;
            background:var(--card); border:1px solid var(--line2); border-radius:9px; padding:0 10px;
            box-shadow:var(--sh-s); transition:border-color .15s; }
  .search:focus-within { border-color:var(--ac-line); }
  .search input { flex:1; min-width:0; border:0; outline:0; background:transparent; color:var(--t1);
                  font:inherit; font-size:13px; padding:8px 0; }
  .search input::placeholder { color:var(--t4); }
  .search .ico { color:var(--t4); font-size:12px; }
  .search .clr { border:0; background:transparent; color:var(--t4); cursor:pointer; font-size:15px;
                 line-height:1; padding:2px 4px; display:none; }
  .search.on .clr { display:block; }
  .sum { font-size:12px; color:var(--t3); white-space:nowrap; }
  .sum b { color:var(--ac-ink); font-weight:700; }
  .theme { border:1px solid var(--line2); background:var(--card); color:var(--t3); cursor:pointer;
           border-radius:8px; padding:7px 11px; font:inherit; font-size:12px; white-space:nowrap; }
  .theme:hover { color:var(--t1); }

  /* 뼈대 */
  .layout { display:grid; grid-template-columns:216px minmax(0,1fr); gap:26px;
            max-width:1560px; margin:0 auto; padding:20px 22px 80px; }
  aside { position:sticky; top:62px; align-self:start; max-height:calc(100vh - 82px); overflow:auto; }
  aside .cap { font-size:11px; font-weight:700; color:var(--t4); letter-spacing:.04em;
               padding:6px 10px; text-transform:uppercase; }
  aside a { display:flex; align-items:center; justify-content:space-between; gap:8px;
            padding:5px 10px; border-radius:7px; text-decoration:none; color:var(--t2);
            font-size:12.5px; }
  aside a span { font-family:'SF Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11.5px; }
  aside a b { color:var(--t4); font-weight:600; font-size:11px; font-variant-numeric:tabular-nums; }
  aside a:hover { background:var(--nu-soft); color:var(--t1); }
  aside a.empty span { color:var(--t4); }
  aside a.hide { display:none; }

  /* 표 구획 */
  .hero { background:var(--card); border:1px solid var(--line); border-radius:12px;
          padding:16px 18px; margin-bottom:20px; }
  .hero h1 { margin:0 0 8px; font-size:16px; color:var(--t1); letter-spacing:-.02em; }
  .hero dl { margin:0; display:flex; flex-wrap:wrap; gap:6px 26px; }
  .hero div { display:flex; gap:7px; align-items:baseline; }
  .hero dt { font-size:11.5px; color:var(--t4); }
  .hero dd { margin:0; font-size:12.5px; color:var(--t2); font-weight:600; }
  .hero p { margin:11px 0 0; font-size:12px; color:var(--t3); line-height:1.65; }

  section.tb { background:var(--card); border:1px solid var(--line); border-radius:12px;
               margin-bottom:16px; overflow:hidden; scroll-margin-top:70px; }
  section.tb.hide { display:none; }
  .th { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap;
        padding:12px 16px; border-bottom:1px solid var(--line); background:var(--surf); }
  .th h2 { margin:0; font-size:14px; color:var(--t1); letter-spacing:-.01em;
           font-family:'SF Mono',ui-monospace,Menlo,Consolas,monospace; font-weight:700; }
  .cnt { font-size:12px; color:var(--t3); }
  .cnt b { color:var(--ac-ink); font-weight:700; font-variant-numeric:tabular-nums; }
  .meta { font-size:11.5px; color:var(--t4); margin-left:auto; }

  .scroll { overflow-x:auto; max-height:640px; overflow-y:auto; }
  table { border-collapse:separate; border-spacing:0; width:100%; font-size:12.5px; }
  thead th { position:sticky; top:0; z-index:2; background:var(--surf2); text-align:left;
             padding:7px 11px; border-bottom:1px solid var(--line2); white-space:nowrap;
             vertical-align:bottom; }
  thead th span { display:block; color:var(--t1); font-weight:700; font-size:11.5px;
                  font-family:'SF Mono',ui-monospace,Menlo,Consolas,monospace; }
  thead th i { display:block; font-style:normal; color:var(--t4); font-size:10px; font-weight:500;
               margin-top:1px; }
  thead th[data-pk] span { color:var(--ac-ink); }
  thead th.s { cursor:pointer; user-select:none; }
  thead th.s:hover span { color:var(--ac); }
  thead th.asc span::after { content:' ↑'; color:var(--ac); }
  thead th.desc span::after { content:' ↓'; color:var(--ac); }

  tbody td { padding:6px 11px; border-bottom:1px solid var(--line);
             vertical-align:top; color:var(--t2); line-height:1.55;
             min-width:58px; max-width:460px; word-break:break-word; }
  tbody tr:hover td { background:var(--nu-soft); }
  tbody tr.hide { display:none; }
  tbody tr.none td { color:var(--t4); text-align:center; padding:20px; }
  td.num { text-align:right; font-variant-numeric:tabular-nums;
           font-family:'SF Mono',ui-monospace,Menlo,Consolas,monospace; color:var(--t3); }
  td.nul { color:var(--t4); font-size:11.5px; }
  td.lgc { padding-bottom:4px; }
  .lg { position:relative; min-width:240px; max-height:78px; overflow:hidden; cursor:zoom-in; }
  .lg::after { content:'전체 보기'; position:absolute; right:0; bottom:0;
               font-size:10px; color:var(--ac-ink); background:var(--card);
               padding:1px 5px 0 12px; border-radius:4px;
               box-shadow:-8px 0 10px -6px var(--card); }
  .lg.open { max-height:none; cursor:zoom-out; }
  .lg.open::after { content:'접기'; position:static; display:inline-block;
                    margin-top:5px; padding:1px 6px; box-shadow:none;
                    border:1px solid var(--ac-line); background:var(--ac-soft); }
  .lg pre { margin:0; font-size:11.5px; color:var(--t3); white-space:pre-wrap; }
  td.tgc { min-width:180px; }
  .tag { border:1px solid var(--cy-line); background:var(--cy-soft); color:var(--cy-ink);
         border-radius:20px; padding:1px 8px; font:inherit; font-size:11px; cursor:pointer;
         margin:0 3px 3px 0; }
  .tag:hover { background:var(--cy); color:#fff; border-color:var(--cy); }

  .foot { margin-top:22px; font-size:11.5px; color:var(--t4); line-height:1.7; }
  .nores { display:none; padding:40px 0; text-align:center; color:var(--t3); font-size:13px; }
  .nores.on { display:block; }

  @media (max-width:960px) {
    .layout { grid-template-columns:minmax(0,1fr); }
    aside { position:static; max-height:none; }
    .bar-in { flex-wrap:wrap; }
  }
</style>
</head>
<body>

<div class="bar"><div class="bar-in">
  <div class="brand">관리 대시보드<em>${esc(basename(file))}</em></div>
  <div class="search" id="sb">
    <span class="ico">검색</span>
    <input id="q" type="search" placeholder="값·컬럼·태그 아무거나 — 표마다 일치 건수를 셉니다" autocomplete="off">
    <button class="clr" id="clr" title="지우기">&times;</button>
  </div>
  <div class="sum" id="sum">표 <b>${num(tables.length)}</b>개 · 행 <b>${num(totalRows)}</b>건</div>
  <button class="theme" id="tg">테마</button>
</div></div>

<div class="layout">
  <aside>
    <div class="cap">표 ${num(tables.length)}개</div>
    <nav id="rail">
${rail}
    </nav>
  </aside>

  <main>
    <div class="hero">
      <h1>DB에 저장된 데이터</h1>
      <dl>
        <div><dt>파일</dt><dd>${esc(basename(file))}</dd></div>
        <div><dt>스키마 버전</dt><dd>${userVersion}</dd></div>
        <div><dt>표</dt><dd>${num(tables.length)}개</dd></div>
        <div><dt>행 합계</dt><dd>${num(totalRows)}건</dd></div>
        <div><dt>만든 시각</dt><dd>${esc(now)}</dd></div>
      </dl>
      <p>표 하나가 한 구획이고, 컬럼은 저장된 그대로입니다. 컬럼 머리글을 누르면 그 열로 정렬하고, 접힌 칸을 누르면 전체 값이 펼쳐집니다. 기억 표는 태그가 따로 저장되어 있어서 마지막 열에 조인해 붙였고, 태그를 누르면 그 태그로 검색합니다.</p>
    </div>

${tables.map(section).join("\n\n")}

    <div class="nores" id="nores">검색어와 일치하는 행이 없습니다.</div>

    <p class="foot">읽기 전용 화면입니다. 값을 고치려면 DB를 직접 손봐야 합니다.<br>
    실제 대화에서 나온 값이 담겨 있으므로 저장소나 공개 영역에 올리지 않습니다.</p>
  </main>
</div>

<script>
(function(){
  var KEY = 'dashTheme';
  var root = document.documentElement;
  try { var t = localStorage.getItem(KEY); if (t) root.setAttribute('data-theme', t); } catch (e) {}
  document.getElementById('tg').addEventListener('click', function(){
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem(KEY, next); } catch (e) {}
  });

  var q = document.getElementById('q');
  var sb = document.getElementById('sb');
  var sum = document.getElementById('sum');
  var nores = document.getElementById('nores');
  var secs = [].slice.call(document.querySelectorAll('section.tb'));
  var index = null;

  function build(){
    index = secs.map(function(sec){
      var rows = [].slice.call(sec.querySelectorAll('tbody tr')).filter(function(r){
        return !r.classList.contains('none');
      });
      return {
        sec: sec,
        rows: rows,
        keys: rows.map(function(r){ return r.textContent.toLowerCase(); }),
        link: document.querySelector('#rail b[data-for="' + sec.dataset.name + '"]'),
        total: rows.length
      };
    });
  }

  function fmt(n){ return n.toLocaleString('ko-KR'); }

  function apply(){
    if (!index) build();
    var s = q.value.trim().toLowerCase();
    sb.classList.toggle('on', s.length > 0);
    var hitTables = 0, hitRows = 0;
    index.forEach(function(t){
      var n = 0;
      for (var i = 0; i < t.rows.length; i++) {
        var hit = !s || t.keys[i].indexOf(s) >= 0;
        t.rows[i].classList.toggle('hide', !hit);
        if (hit) n++;
      }
      if (t.link) t.link.textContent = fmt(n);
      var show = !s || n > 0;
      t.sec.classList.toggle('hide', !show);
      if (t.link) t.link.parentNode.classList.toggle('hide', !show);
      if (show && t.total > 0) hitTables++;
      hitRows += n;
      var cnt = t.sec.querySelector('.cnt');
      cnt.innerHTML = s
        ? '<b>' + fmt(n) + '</b>행 일치 <span style="color:var(--t4)">/ ' + fmt(t.total) + '</span>'
        : '<b>' + fmt(t.total) + '</b>행';
    });
    sum.innerHTML = s
      ? '표 <b>' + fmt(hitTables) + '</b>개 · 행 <b>' + fmt(hitRows) + '</b>건 일치'
      : '표 <b>' + fmt(index.length) + '</b>개 · 행 <b>' + fmt(hitRows) + '</b>건';
    nores.classList.toggle('on', !!s && hitRows === 0);
  }

  q.addEventListener('input', apply);
  document.getElementById('clr').addEventListener('click', function(){ q.value = ''; apply(); q.focus(); });
  document.addEventListener('keydown', function(e){
    if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); }
    if (e.key === 'Escape' && document.activeElement === q) { q.value = ''; apply(); }
  });

  document.addEventListener('click', function(e){
    var tag = e.target.closest('.tag');
    if (tag) { q.value = tag.dataset.t; apply(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    var box = e.target.closest('.lg');
    if (box) box.classList.toggle('open');
  });

  document.querySelectorAll('th.s').forEach(function(th){
    th.addEventListener('click', function(){
      var table = th.closest('table');
      var ci = [].indexOf.call(th.parentNode.children, th);
      var dir = th.classList.contains('asc') ? -1 : 1;
      table.querySelectorAll('th').forEach(function(o){ o.classList.remove('asc', 'desc'); });
      th.classList.add(dir === 1 ? 'asc' : 'desc');
      var tb = table.tBodies[0];
      var rows = [].slice.call(tb.rows).filter(function(r){ return !r.classList.contains('none'); });
      rows.sort(function(a, b){
        var x = a.cells[ci].innerText.trim(), y = b.cells[ci].innerText.trim();
        var nx = Number(x.replace(/,/g, '')), ny = Number(y.replace(/,/g, ''));
        if (x !== '' && y !== '' && !isNaN(nx) && !isNaN(ny)) return (nx - ny) * dir;
        return x.localeCompare(y, 'ko') * dir;
      });
      rows.forEach(function(r){ tb.appendChild(r); });
    });
  });

  apply();
})();
</script>
</body>
</html>`;

console.log(html);
