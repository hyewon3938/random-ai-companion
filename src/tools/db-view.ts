// 관리 대시보드 화면을 만드는 곳 — DB에 저장된 데이터를 표 단위로 보는 화면.
//
// 저장된 모양 그대로 보여준다. 표 하나가 화면의 한 구획이고, 의미로 다시 묶지 않는다.
// 컬럼은 PRAGMA table_info가 알려주는 그대로, 행은 전부 싣고, 빈 표도 감추지 않는다 —
// 비어 있다는 사실 자체가 정보다.
//
// 검색·정렬·펼치기는 만들어진 화면 안에서 돌아간다. 오른쪽 태그 검색 서랍만 서버에
// 물어본다 — 답장을 만들 때 도는 검색을 그대로 한 번 돌려야 해서, 화면 안에서 흉내 내지
// 않고 src/tools/db-tag-search.ts에 맡긴다(파일로 뽑은 화면에서는 그래서 돌지 않는다).
// DB는 읽기 전용으로 열고 마이그레이션을 타지 않으려고 src/db.ts를 거치지 않는다.
//
// 부르는 곳 둘이 같은 화면을 쓴다 — 파일로 뽑는 src/tools/render-db.ts와
// 요청마다 다시 그리는 src/tools/serve-db.ts.
// 주의: 화면에 실제 대화가 담기므로 저장소·공개 영역에 커밋하지 않는다.

import Database from "better-sqlite3";
import { basename } from "node:path";
import { listCharacters } from "./db-tag-search.js";

/** DB 하나를 읽어 화면 한 장을 만든다. 여닫는 것은 이 함수 안에서 끝낸다. */
export const renderDbHtml = (file: string): string => {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return build(db, file);
  } finally {
    db.close();
  }
};

const build = (db: Database.Database, file: string): string => {
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

  // 태그는 별도 표에 있어서 기억 행 옆에 조인해 붙인다. 일기·일정에 붙은 태그는 그 표에
  // 조인하지 않고 오른쪽 태그 검색 서랍에서 본다.
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

  // ── 옛 자리·안 쓰는 자리 ──────────────────────────────────────────────────
  //
  // 저장 구조를 다시 짜면서 대신할 자리가 생겼는데 아직 지우지 않은 표·컬럼과,
  // 자리만 만들어 두고 읽거나 쓰는 코드가 없는 표·컬럼을 손으로 적어 둔다.
  // 코드에서 자동으로 뽑지 않는 이유는 판정 기준이 "런타임에서 부르는 곳이 있는가"라서다 —
  // 정의는 남아 있고 부르는 곳만 없는 경우가 대부분이라 정적 분석으로는 구분되지 않는다.
  // 옛 경로를 정리할 때 이 표에서도 같이 지운다. 옛 자리는 이슈 #156에서 다 지워 지금은
  // 비어 있고, 표시하는 machinery는 다음 구조 변경 때 다시 쓰려고 남겨 둔다.

  type Mark = "old" | "idle";

  const MARK_NAME: Record<Mark, string> = {
    old: "옛 자리",
    idle: "안 쓰는 자리",
  };

  interface ColNote {
    mark: Mark;
    note: string;
  }

  interface TableNote {
    mark?: Mark;
    note?: string;
    cols?: Record<string, ColNote>;
  }

  /** 가입할 때 받기로 한 세 컬럼. 가입 절차가 없어서 넣는 코드도 없다. */
  const SIGNUP =
    "가입할 때 받기로 한 값. 가입 절차가 아직 없어서 넣는 코드도 없고, 지금 값은 손으로 넣은 것이다.";

  const NOTES: Record<string, TableNote> = {
    user_profile: {
      cols: {
        preferred_name: { mark: "idle", note: SIGNUP },
        gender: { mark: "idle", note: SIGNUP },
        birth_year: { mark: "idle", note: SIGNUP },
      },
    },
  };

  /** 표에 붙은 표시 전부. 왼쪽 목록 점과 머리말 숫자에 쓴다. */
  const marksOf = (name: string): Mark[] => {
    const n = NOTES[name];
    if (!n) return [];
    const out: Mark[] = n.mark ? [n.mark] : [];
    if (n.cols) out.push(...Object.values(n.cols).map((c) => c.mark));
    return out;
  };

  const allMarks = tables.flatMap((t) => marksOf(t.name));
  const oldCount = allMarks.filter((m) => m === "old").length;
  const idleCount = allMarks.filter((m) => m === "idle").length;
  // 없는 표시는 줄에서 뺀다 — 0곳이라고 적으면 무엇을 세는 줄인지가 오히려 흐려진다.
  const markSummary = [
    oldCount ? `옛 자리 ${oldCount}곳` : "",
    idleCount ? `안 쓰는 자리 ${idleCount}곳` : "",
  ]
    .filter(Boolean)
    .join(" · ");

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

  // 태그를 누르면 오른쪽 서랍이 그 태그로 검색한다 — 캐릭터마다 태그 어휘가 다르므로
  // 누른 행이 누구 것인지도 함께 넘긴다.
  const tagCell = (row: Record<string, unknown>): string => {
    const id = row.id;
    const list = typeof id === "number" ? (tagsOfMemory.get(id) ?? []) : [];
    if (!list.length) return `<td class="nul">없음</td>`;
    const owner = typeof row.character_id === "number" ? row.character_id : "";
    return `<td class="tgc">${list
      .map(
        (t) =>
          `<button class="tag" data-t="${esc(t)}" data-c="${owner}">${esc(t)}</button>`,
      )
      .join("")}</td>`;
  };

  /** 표 머리·컬럼 머리글에 붙는 작은 표시. 설명은 title로 함께 단다. */
  const badge = (m: Mark, note: string): string =>
    `<span class="bg b-${m}" title="${esc(note)}">${MARK_NAME[m]}</span>`;

  /** 표 머리 아래 설명 줄. 같은 설명을 쓰는 컬럼은 한 줄로 묶는다. */
  const noteLines = (name: string): string => {
    const n = NOTES[name];
    if (!n) return "";
    const out: string[] = [];
    if (n.mark && n.note)
      out.push(
        `<p class="tn n-${n.mark}"><b>${MARK_NAME[n.mark]}</b>${esc(n.note)}</p>`,
      );
    const grouped = new Map<string, { mark: Mark; note: string; cols: string[] }>();
    for (const [col, c] of Object.entries(n.cols ?? {})) {
      const key = `${c.mark}\u0000${c.note}`;
      const hit = grouped.get(key);
      if (hit) hit.cols.push(col);
      else grouped.set(key, { mark: c.mark, note: c.note, cols: [col] });
    }
    for (const g of grouped.values())
      out.push(
        `<p class="tn n-${g.mark}"><b>${MARK_NAME[g.mark]}</b><code>${g.cols
          .map(esc)
          .join("</code> <code>")}</code> ${esc(g.note)}</p>`,
      );
    return out.length ? `\n  ${out.join("\n  ")}` : "";
  };

  const section = (t: Table): string => {
    const joined = t.name === "memory_items";
    const note = NOTES[t.name];
    const head =
      t.cols
        .map((c) => {
          const cn = note?.cols?.[c.name];
          return `<th class="s"${c.pk ? ' data-pk="1"' : ""}><span>${esc(c.name)}</span><i>${esc(
            c.type || "—",
          )}${c.pk ? " · 키" : ""}</i>${cn ? badge(cn.mark, cn.note) : ""}</th>`;
        })
        .join("") + (joined ? `<th><span>tags</span><i>조인</i></th>` : "");

    const body = t.rows.length
      ? t.rows
          .map(
            (r) =>
              `<tr>${t.cols.map((c) => cell(c.name, r[c.name])).join("")}${
                joined ? tagCell(r) : ""
              }</tr>`,
          )
          .join("\n")
      : `<tr class="none"><td colspan="${t.cols.length + (joined ? 1 : 0)}">행 없음</td></tr>`;

    return `<section class="tb" id="t-${t.name}" data-name="${t.name}">
    <div class="th">
      <h2>${esc(t.name)}</h2>${
        note?.mark && note.note ? badge(note.mark, note.note) : ""
      }
      <span class="cnt"><b>${num(t.rows.length)}</b>행</span>
      <span class="meta">컬럼 ${t.cols.length}개 · ${esc(t.order)}${
        joined ? " · tags 표를 조인해 마지막 열에 붙임" : ""
      }</span>
    </div>${noteLines(t.name)}
    <div class="scroll"><table>
      <thead><tr>${head}</tr></thead>
      <tbody>
  ${body}
      </tbody>
    </table></div>
  </section>`;
  };

  const rail = tables
    .map((t) => {
      const ms = marksOf(t.name);
      const dot = ms.length
        ? `<i class="dot d-${ms.includes("old") ? "old" : "idle"}"></i>`
        : "";
      return `<a href="#t-${t.name}"${t.rows.length ? "" : ' class="empty"'}><span>${esc(
        t.name,
      )}</span>${dot}<b data-for="${t.name}">${num(t.rows.length)}</b></a>`;
    })
    .join("\n");

  // ── 태그 검색 서랍에 실을 목록 ────────────────────────────────────────────
  //
  // 검색은 서버가 돌리고(GET /tag-search) 화면에는 고를 수 있는 태그만 미리 싣는다.
  // 태그 이름과 붙어 있는 행 수뿐이라 화면 크기에 거의 얹히지 않는다.

  const tagIndex = listCharacters(db);
  const tagJson = JSON.stringify(tagIndex).replace(/</g, "\\u003c");
  const charOptions = tagIndex
    .map(
      (c) =>
        `<option value="${c.id}">캐릭터 ${c.id} · 태그 ${num(c.tags.length)}종</option>`,
    )
    .join("");

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
    --wn:#B26A00; --wn-ink:#8A5200; --wn-soft:rgba(178,106,0,.075); --wn-line:rgba(178,106,0,.28);
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
    --wn:#F5B454; --wn-ink:#FFD79A; --wn-soft:rgba(245,180,84,.13); --wn-line:rgba(245,180,84,.40);
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
  aside a .dot { width:5px; height:5px; border-radius:50%; flex:none; margin-left:auto; }
  aside a .d-old { background:var(--wn); }
  aside a .d-idle { background:var(--nu-line); }
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

  /* 옛 자리·안 쓰는 자리 표시 */
  .bg { display:inline-block; font-family:inherit; font-style:normal; font-size:10px;
        font-weight:700; line-height:1.6; padding:0 6px; border-radius:5px;
        white-space:nowrap; cursor:help; }
  .b-old { color:var(--wn-ink); background:var(--wn-soft); border:1px solid var(--wn-line); }
  .b-idle { color:var(--t3); background:var(--nu-soft); border:1px solid var(--nu-line); }
  thead th .bg { margin-top:3px; }
  .tn { margin:0; padding:8px 16px; border-bottom:1px solid var(--line);
        font-size:11.5px; color:var(--t3); line-height:1.65; }
  .tn b { font-weight:700; margin-right:7px; }
  .tn code { font-size:11px; }
  .tn.n-old { background:var(--wn-soft); }
  .tn.n-old b, .tn.n-old code { color:var(--wn-ink); }
  .tn.n-idle { background:var(--nu-soft); }
  .tn.n-idle b, .tn.n-idle code { color:var(--t2); }

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

  /* 태그 검색 서랍 */
  .drawer { position:fixed; top:0; right:0; z-index:80; width:min(520px,100vw); height:100vh;
            display:flex; flex-direction:column; background:var(--card);
            border-left:1px solid var(--line2); box-shadow:-18px 0 44px -26px rgba(15,15,20,.4); }
  .drawer[hidden] { display:none; }
  .dw-head { display:flex; align-items:baseline; gap:9px; padding:13px 16px;
             border-bottom:1px solid var(--line); background:var(--surf); }
  .dw-head h2 { margin:0; font-size:14px; color:var(--t1); letter-spacing:-.01em; }
  .dw-head em { font-style:normal; font-size:11.5px; color:var(--t4); }
  .dw-x { margin-left:auto; border:0; background:transparent; color:var(--t3); cursor:pointer;
          font-size:19px; line-height:1; padding:0 2px; }
  .dw-x:hover { color:var(--t1); }
  .dw-body { flex:1; overflow:auto; padding:14px 16px 60px; }
  .dw-note { margin:0 0 14px; padding:9px 11px; font-size:11.5px; color:var(--t3); line-height:1.7;
             background:var(--nu-soft); border:1px solid var(--line); border-radius:8px; }
  .fl { display:block; margin:0 0 6px; font-size:11px; font-weight:700; color:var(--t4);
        letter-spacing:.03em; }
  .fl em { font-style:normal; color:var(--ac-ink); font-weight:700; margin-left:6px; }
  .dw-body select, .dw-body textarea { width:100%; margin-bottom:14px; padding:7px 9px;
        font:inherit; font-size:12.5px; color:var(--t1); background:var(--surf);
        border:1px solid var(--line2); border-radius:8px; outline:0; }
  .dw-body textarea { resize:vertical; line-height:1.65; }
  .dw-body select:focus, .dw-body textarea:focus { border-color:var(--ac-line); }
  .chips { display:flex; flex-wrap:wrap; gap:5px; max-height:184px; overflow:auto;
           margin-bottom:14px; padding:9px; border:1px solid var(--line); border-radius:8px; }
  .chip { border:1px solid var(--line2); background:var(--surf); color:var(--t2); cursor:pointer;
          border-radius:20px; padding:2px 9px; font:inherit; font-size:11.5px; }
  .chip i { font-style:normal; font-size:10px; color:var(--t4); margin-left:5px; }
  .chip:hover { border-color:var(--ac-line); color:var(--t1); }
  .chip.on { background:var(--ac); border-color:var(--ac); color:#fff; }
  .chip.on i { color:rgba(255,255,255,.7); }
  .dw-act { display:flex; gap:8px; margin-bottom:18px; }
  .btn { border:1px solid var(--ac); background:var(--ac); color:#fff; cursor:pointer;
         border-radius:8px; padding:8px 17px; font:inherit; font-size:12.5px; font-weight:700; }
  .btn[disabled] { opacity:.45; cursor:default; }
  .btn2 { border:1px solid var(--line2); background:var(--card); color:var(--t3); cursor:pointer;
          border-radius:8px; padding:8px 12px; font:inherit; font-size:12.5px; }
  .btn2:hover { color:var(--t1); }
  .rs { border-top:1px solid var(--line); padding-top:14px; }
  .rs h3 { margin:18px 0 8px; font-size:12px; color:var(--t1); }
  .rs > h3:first-child { margin-top:0; }
  .rs > .tl { margin-bottom:14px; }
  .rs h3 em { font-style:normal; font-size:11px; font-weight:500; color:var(--t4); margin-left:6px; }
  .rs pre { margin:0 0 16px; padding:11px 12px; background:var(--surf); border:1px solid var(--line);
            border-radius:8px; font-size:11.5px; color:var(--t2); line-height:1.75;
            white-space:pre-wrap; word-break:break-word; }
  .tl { display:flex; flex-wrap:wrap; gap:4px; align-items:center; }
  .tl span { font-size:10.5px; color:var(--cy-ink); background:var(--cy-soft);
             border:1px solid var(--cy-line); border-radius:20px; padding:0 7px; }
  .tl span.m { color:var(--ac-ink); background:var(--ac-soft); border-color:var(--ac-line); }
  .tl b { font-size:10.5px; font-weight:600; color:var(--t4); }
  .hit { margin-bottom:7px; padding:8px 10px; border:1px solid var(--line); border-radius:8px; }
  .hit .hl { font-size:12px; font-weight:600; color:var(--t1); line-height:1.5; }
  .hit .hd { margin-top:3px; font-size:11.5px; color:var(--t3); line-height:1.65; }
  .hit .tl { margin-top:6px; }
  .out { margin:0 0 14px; padding-left:1px; font-size:11.5px; color:var(--t3); line-height:1.8; }
  .out b { display:block; margin-bottom:2px; font-size:11.5px; font-weight:700; color:var(--t2); }
  .warn { margin:0 0 14px; padding:9px 11px; font-size:11.5px; line-height:1.7;
          color:var(--wn-ink); background:var(--wn-soft); border:1px solid var(--wn-line);
          border-radius:8px; }
  .none2 { padding:13px 0 3px; font-size:12px; color:var(--t3); line-height:1.7; }

  @media (max-width:960px) {
    .layout { grid-template-columns:minmax(0,1fr); }
    aside { position:static; max-height:none; }
    .bar-in { flex-wrap:wrap; }
    .drawer { width:100vw; }
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
  <button class="theme" id="dwo">태그 검색</button>
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
${
          markSummary
            ? `        <div><dt>표시</dt><dd>${markSummary}</dd></div>`
            : ""
        }
      </dl>
      <p>표 하나가 한 구획이고, 컬럼은 저장된 그대로입니다. 컬럼 머리글을 누르면 그 열로 정렬하고, 접힌 칸을 누르면 전체 값이 펼쳐집니다. 기억 표는 태그가 따로 저장되어 있어서 마지막 열에 조인해 붙였고, 태그를 누르면 오른쪽에서 태그 검색이 열립니다.
      대신할 자리가 생겨 지울 표와 컬럼은 옛 자리로, 값을 넣는 코드가 없어 비어 있는 자리는 안 쓰는 자리로 표시했습니다. 표시가 하나도 없으면 그 줄은 나오지 않습니다.</p>
    </div>

${tables.map(section).join("\n\n")}

    <div class="nores" id="nores">검색어와 일치하는 행이 없습니다.</div>

    <p class="foot">읽기 전용 화면입니다. 값을 고치려면 DB를 직접 손봐야 합니다.<br>
    실제 대화에서 나온 값이 담겨 있으므로 저장소나 공개 영역에 올리지 않습니다.</p>
  </main>
</div>

<div class="drawer" id="dw" hidden>
  <div class="dw-head">
    <h2>태그 검색</h2><em>답장을 만들 때 도는 검색 그대로</em>
    <button class="dw-x" id="dwx" title="닫기">&times;</button>
  </div>
  <div class="dw-body">
    <p class="dw-note">답장을 만들기 전에 캐릭터는 태그로 기억·지난 일기·일정을 찾아 프롬프트에 넣습니다. 여기서 그 검색을 그대로 한 번 돌려, 무엇이 걸리고 무엇이 개수 상한에 밀렸는지 봅니다.<br>
    어떤 태그로 찾을지 모델이 고르는 단계는 API를 부르는 자리라 이 화면에서는 돌리지 않습니다. 태그를 직접 고르거나, 유저가 보낸 말을 넣어 글자가 일치하는 태그를 찾습니다.</p>
    <label class="fl" for="dwc">캐릭터</label>
    <select id="dwc">${charOptions}</select>
    <label class="fl" for="dwq">유저가 보낸 말<em>여기 적은 말과 글자가 일치하는 태그를 함께 찾습니다</em></label>
    <textarea id="dwq" rows="3" placeholder="예: 오늘 회사 어땠어? 밥은 먹었고?"></textarea>
    <label class="fl">고른 태그<em id="dwn">0개</em></label>
    <div class="chips" id="dwt"></div>
    <div class="dw-act">
      <button class="btn" id="dwgo">검색</button>
      <button class="btn2" id="dwclr">고른 태그 비우기</button>
    </div>
    <div id="dwr"><p class="none2">태그를 고르거나 유저가 보낸 말을 넣고 검색을 누릅니다.</p></div>
  </div>
</div>

<script type="application/json" id="tagdata">${tagJson}</script>

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
    if (tag) { openDrawer(tag.dataset.t, tag.dataset.c); return; }
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

  // ── 태그 검색 서랍 ────────────────────────────────────────────────────────
  // 고르는 규칙은 서버에 있다(GET /tag-search). 화면은 태그를 고르고 결과를 그리기만 한다.

  var TAGS = JSON.parse(document.getElementById('tagdata').textContent);
  var dw = document.getElementById('dw');
  var dwc = document.getElementById('dwc');
  var dwq = document.getElementById('dwq');
  var dwt = document.getElementById('dwt');
  var dwn = document.getElementById('dwn');
  var dwr = document.getElementById('dwr');
  var dwgo = document.getElementById('dwgo');
  var picked = [];
  var served = location.protocol === 'http:' || location.protocol === 'https:';
  var NEEDS_SERVER = '<p class="warn">파일로 뽑은 화면에서는 태그 검색이 돌지 않습니다. '
    + 'serve-db.ts로 띄운 화면에서 씁니다.</p>';

  function esc(s){
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function tagsOfChar(){
    for (var i = 0; i < TAGS.length; i++)
      if (String(TAGS[i].id) === dwc.value) return TAGS[i].tags;
    return [];
  }

  function paintChips(){
    var list = tagsOfChar();
    dwt.innerHTML = list.length
      ? list.map(function(t){
          var n = t.memory + t.diary + t.schedule;
          var on = picked.indexOf(t.tag) >= 0 ? ' on' : '';
          return '<button class="chip' + on + '" data-t="' + esc(t.tag) + '">'
            + esc(t.tag) + '<i>' + n + '</i></button>';
        }).join('')
      : '<span class="none2">이 캐릭터에 저장된 태그가 없습니다.</span>';
    dwn.textContent = picked.length + '개';
  }

  function openDrawer(tag, charId){
    if (charId && dwc.value !== charId) dwc.value = charId;
    // 표에서 누른 태그는 그 하나로 바꿔 본다. 여러 개를 겹쳐 보는 것은 서랍의 태그 목록에서.
    if (tag) picked = [tag];
    dw.hidden = false;
    paintChips();
    if (tag) run();
  }

  function tagList(list, matched){
    return '<div class="tl">' + list.map(function(t){
      var m = matched && matched.indexOf(t) >= 0;
      return '<span class="' + (m ? 'm' : '') + '">' + esc(t) + '</span>';
    }).join('') + '</div>';
  }

  function hitBox(h){
    return '<div class="hit"><div class="hl">' + esc(h.label) + '</div>'
      + '<div class="hd">' + esc(h.detail) + '</div>'
      + '<div class="tl"><b>겹친 태그 ' + h.hits + '개</b>'
      + h.tags.map(function(t){ return '<span>' + esc(t) + '</span>'; }).join('')
      + '</div></div>';
  }

  function group(title, rows){
    return '<h3>' + title + '<em>' + rows.length + '건</em></h3>'
      + (rows.length
          ? rows.map(hitBox).join('')
          : '<p class="none2">걸린 것이 없습니다.</p>');
  }

  function lines(rows){ return rows.map(esc).join('<br>'); }

  function render(r){
    if (!r.tags.length) {
      dwr.innerHTML = '<p class="none2">고른 태그가 없습니다. 이 캐릭터에 저장된 태그는 '
        + r.pool + '종입니다.</p>';
      return;
    }
    var out = ['<div class="rs">'];
    out.push('<h3>검색한 태그<em>' + r.tags.length + '개 · 저장된 태그 ' + r.pool
      + '종 · 오늘 ' + esc(r.today) + '</em></h3>');
    out.push(tagList(r.tags, r.matched));
    if (r.matched.length)
      out.push('<p class="out">보라색은 보낸 말에서 글자가 일치해 찾은 태그입니다.</p>');
    if (r.tags.length > r.pickMax)
      out.push('<p class="warn">답장을 만들 때는 모델이 태그를 ' + r.pickMax
        + '개까지만 고릅니다. 이 화면에서는 고른 것을 다 넣고 검색했습니다.</p>');
    out.push('<h3>프롬프트에 들어간 문안<em>'
      + (r.prompt ? r.prompt.length + '자' : '없음') + '</em></h3>');
    out.push(r.prompt
      ? '<pre>' + esc(r.prompt) + '</pre>'
      : '<p class="none2">걸린 것이 없어 프롬프트에 붙는 절도 없습니다.</p>');
    out.push(group('기억', r.memories));
    out.push(group('지난 일기', r.diaries));
    out.push(group('일정', r.schedules));
    if (r.dropped.length)
      out.push('<p class="out"><b>개수 상한에 밀린 후보 ' + r.dropped.length + '건</b>'
        + lines(r.dropped) + '</p>');
    r.excluded.forEach(function(e){
      out.push('<p class="out"><b>제외 ' + e.rows.length + '건 · ' + esc(e.reason) + '</b>'
        + lines(e.rows) + '</p>');
    });
    out.push('</div>');
    dwr.innerHTML = out.join('');
  }

  function run(){
    if (!served) { dwr.innerHTML = NEEDS_SERVER; return; }
    dwgo.disabled = true;
    dwr.innerHTML = '<p class="none2">검색하는 중입니다.</p>';
    var url = '/tag-search?c=' + encodeURIComponent(dwc.value)
      + '&t=' + encodeURIComponent(picked.join(','))
      + '&q=' + encodeURIComponent(dwq.value);
    fetch(url, { headers: { accept: 'application/json' } })
      .then(function(res){
        if (!res.ok) throw new Error('서버가 ' + res.status + '로 답했습니다');
        return res.json();
      })
      .then(render)
      .catch(function(err){
        dwr.innerHTML = '<p class="warn">검색하지 못했습니다 — ' + esc(err.message) + '</p>';
      })
      .then(function(){ dwgo.disabled = false; });
  }

  document.getElementById('dwo').addEventListener('click', function(){
    dw.hidden = !dw.hidden;
    if (!dw.hidden) paintChips();
  });
  document.getElementById('dwx').addEventListener('click', function(){ dw.hidden = true; });
  document.getElementById('dwclr').addEventListener('click', function(){
    picked = [];
    paintChips();
  });
  dwc.addEventListener('change', function(){ picked = []; paintChips(); });
  dwt.addEventListener('click', function(e){
    var chip = e.target.closest('.chip');
    if (!chip) return;
    var i = picked.indexOf(chip.dataset.t);
    if (i >= 0) picked.splice(i, 1);
    else picked.push(chip.dataset.t);
    paintChips();
  });
  dwgo.addEventListener('click', run);
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && !dw.hidden) dw.hidden = true;
  });
  paintChips();
  if (!served) dwr.innerHTML = NEEDS_SERVER;

  apply();
})();
</script>
</body>
</html>`;

  return html;
};
