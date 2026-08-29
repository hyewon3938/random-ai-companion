// 관리 대시보드 — 캐릭터 생성 데이터 읽기 화면.
//
// 캐릭터를 만들 때 정한 값은 표 네 곳에 나뉘어 들어간다. 생성 원본(characters.genesis_json),
// 생성 시점 기억(memory_items 중 origin='creation'), 관계 여덟 항목(relationships),
// 삶의 흐름과 영역(arcs·areas). 이 네 자리를 자립형 HTML 한 장으로 묶어 stdout으로 내보낸다.
//
// 읽기만 한다 — 기억의 꺼낸 횟수와 마지막으로 꺼낸 시각을 건드리지 않으려고 검색 함수를
// 쓰지 않고 SQL로 직접 읽는다.
//
// 사용: docker exec <container> npx tsx src/tools/render-character.ts [--id N] > dashboard-character.html
// 주의: 출력물에 실제 대화에서 나온 값이 담기므로 저장소·공개 영역에 커밋하지 않는다.
import {
  db,
  getArcs,
  getRelationship,
  listAreas,
  type CharacterRow,
  type MemoryRow,
} from "../db.js";
import type { Bible, CharacterInput, GenesisOutput } from "../character.js";
import {
  INTEREST_NAME,
  MEMORY_ITEM_TYPE_NAME,
  MEMORY_OWNER_NAME,
  SPEECH_LEVEL_NAME,
  type MemoryItemType,
} from "../labels.js";

// ── 읽기 ──────────────────────────────────────────────────────────────────
const argIndex = process.argv.indexOf("--id");
const wantedId =
  argIndex >= 0 && process.argv[argIndex + 1]
    ? Number(process.argv[argIndex + 1])
    : null;

const character = (
  wantedId
    ? db.prepare(`SELECT * FROM characters WHERE id = ?`).get(wantedId)
    : db
        .prepare(
          `SELECT * FROM characters WHERE status = 'active' ORDER BY id DESC LIMIT 1`,
        )
        .get()
) as CharacterRow | undefined;

if (!character) {
  console.log(
    `<!doctype html><html lang="ko"><meta charset="utf-8"><title>캐릭터 대시보드</title><body><p>캐릭터가 없습니다.</p></body></html>`,
  );
  process.exit(0);
}

interface GenesisV2 {
  v: number;
  input: CharacterInput;
  output: GenesisOutput;
}

type Genesis =
  | { kind: "v2"; data: GenesisV2 }
  | { kind: "legacy"; data: Bible }
  | { kind: "unknown"; raw: string };

/** 저장 형식 두 가지를 가른다. 초기에 만든 캐릭터는 옛 설정 JSON, 지금 생성 경로는 {v:2,…}. */
const parseGenesis = (raw: string): Genesis => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unknown", raw };
  }
  if (!parsed || typeof parsed !== "object") return { kind: "unknown", raw };
  const obj = parsed as Record<string, unknown>;
  if (obj.v === 2 && obj.output && obj.input)
    return { kind: "v2", data: obj as unknown as GenesisV2 };
  if ("identity" in obj && "voice" in obj)
    return { kind: "legacy", data: obj as unknown as Bible };
  return { kind: "unknown", raw };
};

const genesis = parseGenesis(character.genesis_json);

const creationRows = db
  .prepare(
    `SELECT * FROM memory_items
      WHERE character_id = ? AND origin = 'creation'
      ORDER BY item_type, owner, area, subject`,
  )
  .all(character.id) as MemoryRow[];

const tagsOf = new Map<number, string[]>();
for (const t of db
  .prepare(`SELECT ref_id, tag FROM tags WHERE character_id = ? AND kind = 'memory'`)
  .all(character.id) as { ref_id: number; tag: string }[]) {
  const list = tagsOf.get(t.ref_id);
  if (list) list.push(t.tag);
  else tagsOf.set(t.ref_id, [t.tag]);
}

const conversationCounts = db
  .prepare(
    `SELECT item_type, count(*) n FROM memory_items
      WHERE character_id = ? AND origin = 'conversation' GROUP BY item_type`,
  )
  .all(character.id) as { item_type: MemoryItemType; n: number }[];

const relationship = getRelationship(character.id);
const arcs = getArcs(character.id);
const areas = listAreas(character.id);

// ── 그리기 ────────────────────────────────────────────────────────────────
const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const nl = (s: string): string => esc(s).replace(/\n/g, "<br>");

const dash = "<span class=\"dim\">(없음)</span>";
const val = (s: string | null | undefined): string =>
  s && s.trim() ? nl(s.trim()) : dash;

const pills = (list: string[]): string =>
  list.length
    ? list.map((t) => `<span class="pill">${esc(t)}</span>`).join("")
    : dash;

const rowsOf = (type: MemoryItemType): MemoryRow[] =>
  creationRows.filter((r) => r.item_type === type);

const identityRows = rowsOf("fact");
const personRows = rowsOf("person");
const ongoingRows = rowsOf("ongoing");

/** 영역 이름을 유지한 채 묶는다. 같은 영역의 항목이 표에서 붙어 보이게. */
const groupByArea = (rows: MemoryRow[]): [string, MemoryRow[]][] => {
  const map = new Map<string, MemoryRow[]>();
  for (const r of rows) {
    const list = map.get(r.area);
    if (list) list.push(r);
    else map.set(r.area, [r]);
  }
  return [...map.entries()];
};

const KNOWS_NAME: Record<string, string> = {
  known: "유저가 안다",
  unknown: "유저가 모른다",
  waiting: "꺼낼 자리를 기다린다",
};

const identityTable = (): string => {
  if (!identityRows.length)
    return `<p class="tnote">생성 시점에 기록된 정체성이 없습니다.</p>`;
  return groupByArea(identityRows)
    .map(
      ([area, rows]) => `
    <table class="tbl grp">
      <tr class="area"><td colspan="3">${esc(area)}</td></tr>
      ${rows
        .map(
          (r) => `<tr>
        <td class="sub">${esc(r.subject)}</td>
        <td>${val(r.value)}${
          r.user_knows !== "known"
            ? `<span class="pill warn">${esc(KNOWS_NAME[r.user_knows] ?? r.user_knows)}</span>`
            : ""
        }${
          r.interest && r.interest !== "medium"
            ? `<span class="pill">관심 ${esc(INTEREST_NAME[r.interest])}</span>`
            : ""
        }</td>
        <td class="tg">${pills(tagsOf.get(r.id) ?? [])}</td>
      </tr>`,
        )
        .join("")}
    </table>`,
    )
    .join("");
};

const personTable = (): string =>
  personRows.length
    ? `<table class="tbl">
      <tr><th>이름</th><th>어떤 사이</th><th>만나는 방식</th><th>사는 곳</th><th>적어 둔 내용</th></tr>
      ${personRows
        .map(
          (r) => `<tr>
        <td class="sub">${esc(r.subject)}<span class="pill">${esc(MEMORY_OWNER_NAME[r.owner])} 쪽</span></td>
        <td>${val(r.relation)}</td>
        <td>${val(r.contact_mode)}</td>
        <td>${val(r.region)}</td>
        <td>${val(r.value)}</td>
      </tr>`,
        )
        .join("")}
    </table>`
    : "";

const ongoingTable = (): string =>
  ongoingRows.length
    ? `<table class="tbl">
      <tr><th>영역 · 무엇</th><th>지금 어디까지</th><th>끝나는 조건</th></tr>
      ${ongoingRows
        .map(
          (r) => `<tr>
        <td class="sub">${esc(r.area)} · ${esc(r.subject)}</td>
        <td>${val(r.value)}</td>
        <td>${val(r.end_condition)}</td>
      </tr>`,
        )
        .join("")}
    </table>`
    : "";

const conversationNote = (): string => {
  const named = conversationCounts
    .map((c) => `${MEMORY_ITEM_TYPE_NAME[c.item_type]} ${c.n}건`)
    .join(" · ");
  return named
    ? `<p class="tnote">대화로 쌓인 기억은 이 화면에 넣지 않았습니다. 지금 ${esc(named)}이 대화 쪽에 들어 있습니다.</p>`
    : "";
};

// 생성 원본 — 저장 형식 두 가지를 각각 그린다.
const CHEMISTRY_NAME: Record<string, string> = {
  warmth: "다정함",
  humor: "유머",
  mode: "대화 방식",
  rhythm: "말 속도",
  richness: "말의 분량",
};

const legacyOrigin = (b: Bible): string => `
  <table class="tbl">
    <tr class="area"><td colspan="2">기본</td></tr>
    <tr><td class="sub">이름</td><td>${val(b.identity?.name)}</td></tr>
    <tr><td class="sub">나이대</td><td>${val(b.identity?.age_band)}</td></tr>
    <tr><td class="sub">하는 일</td><td>${val(b.identity?.job)}</td></tr>
    <tr><td class="sub">사는 모양</td><td>${val(b.identity?.living)}</td></tr>
  </table>
  <table class="tbl grp">
    <tr class="area"><td colspan="2">지나온 이야기</td></tr>
    <tr><td class="sub">가족</td><td>${val(b.backstory?.family)}</td></tr>
    <tr><td class="sub">그늘</td><td>${val(b.backstory?.wound)}</td></tr>
    <tr><td class="sub">이야기 씨앗</td><td>${
      b.backstory?.story_seeds?.length
        ? b.backstory.story_seeds.map((s) => nl(s)).join("<br>")
        : dash
    }</td></tr>
  </table>
  <table class="tbl grp">
    <tr class="area"><td colspan="2">말투와 취향</td></tr>
    <tr><td class="sub">웃음</td><td>${val(b.voice?.laugh)}</td></tr>
    <tr><td class="sub">입버릇</td><td>${val(b.voice?.tic)}</td></tr>
    <tr><td class="sub">종결어미</td><td>${val(b.voice?.ending)}</td></tr>
    <tr><td class="sub">태도</td><td>${val(b.manner)}</td></tr>
    <tr><td class="sub">취향</td><td>${b.tastes?.length ? pills(b.tastes) : dash}</td></tr>
  </table>
  <table class="tbl grp">
    <tr class="area"><td colspan="2">대화 성향</td></tr>
    ${(Object.keys(CHEMISTRY_NAME) as (keyof Bible["chemistry"])[])
      .map(
        (k) =>
          `<tr><td class="sub">${esc(CHEMISTRY_NAME[k])}</td><td>${val(b.chemistry?.[k])}</td></tr>`,
      )
      .join("")}
  </table>
  <table class="tbl grp">
    <tr class="area"><td colspan="2">생활</td></tr>
    <tr><td class="sub">매주 루틴</td><td>${
      b.life?.weekly?.length
        ? b.life.weekly.map((w) => `${esc(w.day)} ${esc(w.activity)}`).join("<br>")
        : dash
    }</td></tr>
    <tr><td class="sub">지금 흐름</td><td>${val(b.life?.current_arc)}</td></tr>
    <tr><td class="sub">첫 인사</td><td>${val(b.first_greeting)}</td></tr>
  </table>`;

const v2Origin = (g: GenesisV2): string => `
  <table class="tbl">
    <tr class="area"><td colspan="2">유저가 넣은 입력</td></tr>
    <tr><td class="sub">성별</td><td>${val(g.input.gender)}</td></tr>
    <tr><td class="sub">나이대</td><td>${val(g.input.ageBand)}</td></tr>
    <tr><td class="sub">성격</td><td>${val(g.input.personality)}</td></tr>
    <tr><td class="sub">관계</td><td>${val(g.input.relationship)}</td></tr>
    <tr><td class="sub">바라는 모습</td><td>${val(g.input.wish)}</td></tr>
  </table>
  <table class="tbl grp">
    <tr class="area"><td colspan="2">생성이 내놓은 결과</td></tr>
    <tr><td class="sub">정체성</td><td>${g.output.identity?.length ?? 0}개 항목</td></tr>
    <tr><td class="sub">주변 인물</td><td>${
      g.output.cast?.length
        ? pills(g.output.cast.map((c) => `${c.name} · ${c.relation}`))
        : dash
    }</td></tr>
    <tr><td class="sub">진행 중인 일</td><td>${
      g.output.ongoing?.length
        ? pills(g.output.ongoing.map((o) => `${o.area}/${o.subject}`))
        : dash
    }</td></tr>
    <tr><td class="sub">첫 인사</td><td>${val(g.output.firstGreeting)}</td></tr>
  </table>`;

const originBlock = (): string => {
  if (genesis.kind === "v2") return v2Origin(genesis.data);
  if (genesis.kind === "legacy") return legacyOrigin(genesis.data);
  return `<pre class="raw">${esc(genesis.raw)}</pre>`;
};

const FORMAT_NAME: Record<Genesis["kind"], string> = {
  v2: "지금 생성 경로",
  legacy: "초기 설정 형식",
  unknown: "읽지 못한 형식",
};

// 관계 여덟 항목 — 누가 채우는 값인지 함께 적는다.
const RELATION_FIELDS: {
  label: string;
  value: string | null | undefined;
  by: "생성" | "대화" | "코드";
}[] = [
  { label: "지금 어떤 사이", value: relationship?.stage, by: "생성" },
  {
    label: "지금 말투",
    value: relationship?.speech_level
      ? SPEECH_LEVEL_NAME[relationship.speech_level]
      : null,
    by: "코드",
  },
  { label: "말투 메모", value: relationship?.speech_note, by: "생성" },
  { label: "서로 부르는 말", value: relationship?.address_terms, by: "생성" },
  { label: "관계의 결", value: relationship?.texture, by: "생성" },
  { label: "잘 통하는 것", value: relationship?.rapport, by: "대화" },
  { label: "조심할 것", value: relationship?.cautions, by: "대화" },
  { label: "지나온 일", value: relationship?.history, by: "생성" },
  { label: "지금 마음", value: relationship?.feelings, by: "생성" },
];

const BY_CLASS: Record<string, string> = {
  생성: "by-ac",
  대화: "by-cy",
  코드: "by-nu",
};

const ARC_NAME: Record<string, string> = {
  year: "올해",
  season: "이 계절",
  month: "이번 달",
  week: "이번 주",
};

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>캐릭터 대시보드</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.min.css">
<style>
  :root {
    --page:#F4F4F6; --card:#FFFFFF; --surf:#FAFAFA; --surf2:#F3F3F5;
    --line:#EBEBEF; --line2:#DEDEE4;
    --t1:#141416; --t2:#34343B; --t3:#6C6C76; --t4:#9A9AA4;
    --ac:#6728FF; --ac-ink:#4A17C7; --ac-soft:rgba(103,40,255,.055); --ac-line:rgba(103,40,255,.20);
    --nu:#6C6C76; --nu-ink:#34343B; --nu-soft:rgba(20,20,22,.032); --nu-line:rgba(20,20,22,.10);
    --cy:#0895B2; --cy-ink:#046A80; --cy-soft:rgba(8,149,178,.09); --cy-line:rgba(8,149,178,.32);
    --wn:#C42FA8; --wn-soft:rgba(196,47,168,.07); --wn-line:rgba(196,47,168,.24);
    --bar:rgba(244,244,246,.82);
    --sh:0 12px 36px rgba(15,15,20,.11), 0 2px 6px rgba(15,15,20,.05);
    --sh-s:0 1px 2px rgba(15,15,20,.05);
  }
  html[data-theme="dark"] {
    --page:#151516; --card:#1C1C1E; --surf:#212123; --surf2:#26262A;
    --line:#2D2D32; --line2:#3A3A41;
    --t1:#FFFFFF; --t2:#E3E3E7; --t3:#A2A2AC; --t4:#84848F;
    --ac:#8B5CFF; --ac-ink:#C6ACFF; --ac-soft:rgba(139,92,255,.13); --ac-line:rgba(139,92,255,.40);
    --nu:#A2A2AC; --nu-ink:#E3E3E7; --nu-soft:rgba(255,255,255,.045); --nu-line:rgba(255,255,255,.13);
    --cy:#54D2EA; --cy-ink:#ADEBF7; --cy-soft:rgba(84,210,234,.16); --cy-line:rgba(84,210,234,.44);
    --wn:#E36BE0; --wn-soft:rgba(227,107,224,.12); --wn-line:rgba(227,107,224,.36);
    --bar:rgba(21,21,22,.82);
    --sh:0 18px 44px rgba(0,0,0,.58), 0 2px 8px rgba(0,0,0,.4);
    --sh-s:0 1px 2px rgba(0,0,0,.4);
  }

  * { box-sizing:border-box; }
  body { margin:0; background:var(--page); color:var(--t2);
    font-family:'Pretendard Variable',Pretendard,-apple-system,'Apple SD Gothic Neo','Segoe UI',sans-serif;
    -webkit-font-smoothing:antialiased; transition:background-color .25s ease, color .25s ease; }
  .wrap { max-width:1060px; margin:0 auto; padding:0 28px; }

  .bar { position:sticky; top:0; z-index:50; background:var(--bar); backdrop-filter:saturate(180%) blur(14px);
         border-bottom:1px solid var(--line); }
  .bar-in { max-width:1060px; margin:0 auto; padding:13px 28px; display:flex; align-items:center; gap:20px; }
  .brand { font-size:14px; font-weight:800; color:var(--t1); letter-spacing:-.02em; margin-right:2px; }
  .nav { display:flex; flex-wrap:wrap; gap:2px 0; flex:1; min-width:0; }
  .nav a { font-size:12.5px; color:var(--t3); text-decoration:none; padding:6px 9px; border-radius:8px; transition:.15s; white-space:nowrap; }
  .nav a:hover { color:var(--t1); background:var(--nu-soft); }
  .seg { display:flex; gap:2px; background:var(--surf2); border:1px solid var(--line); border-radius:999px; padding:3px; }
  .seg button { font-family:inherit; font-size:12px; color:var(--t3); background:none; border:0; cursor:pointer;
                padding:5px 12px; border-radius:999px; transition:.15s; }
  .seg button.on { background:var(--card); color:var(--t1); font-weight:600; box-shadow:var(--sh-s); }

  .hero { padding:52px 0 34px; }
  .hero h1 { margin:0; font-size:34px; font-weight:800; letter-spacing:-.035em; color:var(--t1); line-height:1.2; }
  .hero p { margin:12px 0 0; font-size:15.5px; color:var(--t3); letter-spacing:-.01em; }
  .keymap { display:flex; flex-wrap:wrap; align-items:center; gap:9px 20px;
            margin-top:22px; padding-top:18px; border-top:1px solid var(--line); }
  .keymap span { display:flex; align-items:center; gap:8px; font-size:12.5px; color:var(--t3); letter-spacing:-.01em; }
  .keymap b { font-size:12.5px; font-weight:700; color:var(--t1); }

  .card { background:var(--card); border:1px solid var(--line); border-radius:20px; padding:32px 34px 34px;
          margin-bottom:22px; scroll-margin-top:72px; transition:background-color .25s ease, border-color .25s ease; }
  .card-hd { display:flex; justify-content:space-between; align-items:flex-start; gap:26px; margin-bottom:26px; }
  .eyebrow { font-size:11.5px; font-weight:700; letter-spacing:.08em; color:var(--ac); margin-bottom:9px; }
  .card-hd h2 { margin:0; font-size:23px; font-weight:800; letter-spacing:-.03em; color:var(--t1); }
  .card-s { margin:8px 0 0; font-size:14.5px; color:var(--t3); letter-spacing:-.01em; line-height:1.5; }
  .legend { flex:none; display:flex; flex-direction:column; gap:8px; padding-top:4px; }
  .legend span { display:flex; align-items:center; gap:8px; font-size:12.5px; color:var(--t3); white-space:nowrap; }
  .legend i { width:9px; height:9px; border-radius:50%; display:block; }
  .lg-ac { background:var(--ac); } .lg-cy { background:var(--cy); } .lg-nu { background:var(--nu); }

  .tbl { width:100%; border-collapse:collapse; }
  .tbl.grp { margin-top:26px; }
  .tbl th { text-align:left; font-size:11.5px; font-weight:600; color:var(--t4); letter-spacing:.02em;
            padding:0 4px 9px; border-bottom:1px solid var(--line2); }
  .tbl td { padding:9px 4px; font-size:13.5px; color:var(--t2); border-bottom:1px solid var(--line);
            vertical-align:top; line-height:1.6; }
  .tbl tr:last-child td { border-bottom:0; }
  .tbl td.sub { color:var(--t1); font-weight:600; white-space:nowrap; width:130px; letter-spacing:-.01em; }
  .tbl td.tg { text-align:right; width:220px; }
  .tbl tr.area td { font-size:11.5px; font-weight:700; letter-spacing:.06em; color:var(--ac);
                    padding:0 4px 9px; border-bottom:1px solid var(--line2); }
  .tbl td.by { width:74px; text-align:right; white-space:nowrap; }

  .pill { display:inline-block; font-size:11.5px; color:var(--t3); background:var(--nu-soft);
          border:1px solid var(--line2); border-radius:999px; padding:2px 8px; margin:0 0 2px 4px; white-space:nowrap; }
  .pill.warn { color:var(--wn); background:var(--wn-soft); border-color:var(--wn-line); }
  .tag { display:inline-block; font-size:11.5px; color:var(--cy-ink); background:var(--cy-soft);
         border:1px solid var(--cy-line); border-radius:999px; padding:2px 8px; margin:0 0 2px 4px; }
  .by-ac { color:var(--ac-ink); } .by-cy { color:var(--cy-ink); } .by-nu { color:var(--t4); }
  .dim { color:var(--t4); }
  .raw { background:var(--surf); border:1px solid var(--line); border-radius:12px; padding:16px;
         font-size:12px; line-height:1.6; white-space:pre-wrap; word-break:break-all; color:var(--t3); }
  .tnote { margin:20px 0 0; font-size:12.5px; color:var(--t4); line-height:1.65; }
  .arc { display:grid; grid-template-columns:96px 1fr; gap:0; }
  .foot { margin:8px 0 60px; font-size:12.5px; color:var(--t4); line-height:1.7; }
  @media (max-width:760px) {
    .card { padding:24px 20px 26px; }
    .card-hd { flex-direction:column; gap:14px; }
    .legend { flex-direction:row; flex-wrap:wrap; }
    .tbl td.sub, .tbl td.tg { width:auto; white-space:normal; text-align:left; }
  }
</style>
</head>
<body>
<div class="bar"><div class="bar-in">
  <div class="brand">캐릭터 대시보드</div>
  <nav class="nav">
    <a href="#origin">생성 원본</a>
    <a href="#identity">정체성</a>
    <a href="#relation">관계</a>
    <a href="#life">삶의 흐름</a>
  </nav>
  <div class="seg"><button data-t="">라이트</button><button data-t="dark">다크</button></div>
</div></div>

<div class="wrap">
  <div class="hero">
    <h1>캐릭터를 만들 때 정한 것</h1>
    <p>생성이 기록한 네 자리를 한 장에 모았습니다. 읽기 전용이라 값을 고치지 않습니다.</p>
    <div class="keymap">
      <span>캐릭터 <b>#${character.id}</b></span>
      <span>만든 날 <b>${esc(character.created_at)}</b></span>
      <span>저장 형식 <b>${esc(FORMAT_NAME[genesis.kind])}</b></span>
      <span>생성 시점 기억 <b>${creationRows.length}건</b></span>
      <span>영역 <b>${areas.length}개</b></span>
    </div>
  </div>

  <div class="card" id="origin">
    <div class="card-hd"><div>
      <div class="eyebrow">01 생성 원본</div>
      <h2>만들 때 받은 입력과 그 결과</h2>
      <p class="card-s">캐릭터를 만든 호출이 무엇을 받아 무엇을 내놓았는지 그대로 담아 둔 기록입니다. 대화와 새벽 정리는 이 원본을 읽지 않고, 아래 정체성 기억을 읽습니다.</p>
    </div></div>
    ${originBlock()}
  </div>

  <div class="card" id="identity">
    <div class="card-hd"><div>
      <div class="eyebrow">02 정체성</div>
      <h2>프롬프트에 항상 들어가는 설정</h2>
      <p class="card-s">생성이 정한 값이라 대화로는 고쳐지지 않습니다. 오른쪽 태그는 이 항목을 검색으로 찾을 때 쓰는 낱말입니다.</p>
    </div></div>
    ${identityTable()}
    ${conversationNote()}
  </div>

  ${
    personRows.length || ongoingRows.length
      ? `<div class="card" id="cast">
    <div class="card-hd"><div>
      <div class="eyebrow">03 주변 인물과 진행 중인 일</div>
      <h2>생성이 함께 만든 사람과 일</h2>
      <p class="card-s">인물은 이름이 그대로 키가 되고, 진행 중인 일은 끝나는 조건을 채우면 목록에서 빠집니다.</p>
    </div></div>
    ${personTable()}
    ${ongoingRows.length && personRows.length ? '<div style="height:26px"></div>' : ""}
    ${ongoingTable()}
  </div>`
      : ""
  }

  <div class="card" id="relation">
    <div class="card-hd"><div>
      <div class="eyebrow">04 관계</div>
      <h2>캐릭터와 유저 사이의 여덟 항목</h2>
      <p class="card-s">전부 프롬프트에 항상 들어갑니다. 생성이 첫 값을 채우고, 잘 통하는 것과 조심할 것은 대화가 쌓여야 알 수 있어 비운 채 시작합니다.</p>
    </div>
    <div class="legend">
      <span><i class="lg-ac"></i>생성이 채운 값</span>
      <span><i class="lg-cy"></i>새벽 정리가 채우는 값</span>
      <span><i class="lg-nu"></i>답장 경로가 정하는 값</span>
    </div></div>
    <table class="tbl">
      ${RELATION_FIELDS.map(
        (f) => `<tr>
        <td class="sub">${esc(f.label)}</td>
        <td>${val(f.value)}</td>
        <td class="by ${BY_CLASS[f.by]}">${esc(f.by)}</td>
      </tr>`,
      ).join("")}
    </table>
    <p class="tnote">처음 만난 날 ${esc(relationship?.met_at ?? "—")} · 마지막 연락 ${esc(relationship?.last_contact_at ?? "—")} · 마지막 갱신 ${esc(relationship?.updated_at ?? "—")}</p>
  </div>

  <div class="card" id="life">
    <div class="card-hd"><div>
      <div class="eyebrow">05 삶의 흐름과 영역</div>
      <h2>생성 두 번째 호출이 만든 흐름</h2>
      <p class="card-s">하루 각본이 이 흐름을 참고해 그날 할 일을 정합니다. 아래 영역은 기억을 저장할 때 쓰는 이름 목록입니다.</p>
    </div></div>
    <table class="tbl">
      ${(["year", "season", "month", "week"] as const)
        .map(
          (p) => `<tr>
        <td class="sub">${esc(ARC_NAME[p])}</td>
        <td>${val(arcs[p])}</td>
      </tr>`,
        )
        .join("")}
    </table>
    <table class="tbl grp">
      <tr class="area"><td>영역</td></tr>
      <tr><td>${areas.length ? pills(areas.map((a) => a.name)) : dash}</td></tr>
    </table>
  </div>

  <p class="foot">이 화면은 읽기만 합니다. 기억을 꺼낸 횟수와 마지막으로 꺼낸 시각은 그대로 둡니다.<br>실제 대화에서 나온 값이 담겨 있어 저장소와 공개 영역에 올리지 않습니다.</p>
</div>

<script>
(function(){
  var KEY='dashTheme';
  function apply(t){
    if(t) document.documentElement.setAttribute('data-theme',t);
    else document.documentElement.removeAttribute('data-theme');
    var b=document.querySelectorAll('.seg button');
    for(var i=0;i<b.length;i++){
      if((b[i].getAttribute('data-t')||'')===(t||'')) b[i].classList.add('on'); else b[i].classList.remove('on');
    }
    try{ localStorage.setItem(KEY,t||''); }catch(e){}
  }
  var b=document.querySelectorAll('.seg button');
  for(var i=0;i<b.length;i++){
    (function(x){ x.addEventListener('click',function(){ apply(x.getAttribute('data-t')||''); }); })(b[i]);
  }
  var saved=''; try{ saved=localStorage.getItem(KEY)||''; }catch(e){}
  if(saved!=='dark') saved='';
  apply(saved);
})();
</script>
</body>
</html>`;

console.log(html);
