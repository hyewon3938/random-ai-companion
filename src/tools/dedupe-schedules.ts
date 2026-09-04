// 정리 도구: 같은 일정이 여러 줄로 쌓인 것을 한 줄로 줄인다 (이슈 #267).
//
// 같은 캐릭터·주인·날짜에 내용이 (공백·기호를 지우고) 같은 active 행들을 한 무리로 묶어,
// 가장 먼저 들어온 행(번호가 작은 것) 하나만 남기고 나머지를 지운다. 견주는 기준은 쓰는
// 자리와 같은 함수다(schedule-dedupe.ts) — 기준이 갈리면 새벽 정리가 남긴 행을 이 도구가
// 지운다.
//
// 상태를 바꾸지 않고 지우는 이유: schedules.status의 값은 active·cancelled·deferred 셋뿐이고
// 셋 다 '겹쳐서 접었다'는 뜻이 아니다. cancelled로 두면 프롬프트의 [이미 저장된 일정] 목록에
// (취소)로 실려서, 멀쩡히 남아 있는 일정을 캐릭터가 취소된 것으로 읽는다.
//
// 지운 행에 붙어 있던 주제 태그는 남는 행으로 옮긴다 — 태그로 이 일정을 꺼내는 경로가
// 있어서(context.ts), 그냥 지우면 찾을 길이 좁아진다.
//
// 각본 블록이 지워진 행을 source_id로 가리킬 수 있는데, 읽는 자리가 원본이 없는 경우를 이미
// 다룬다(reply-timing.ts의 knowsLine — 줄만 빼고 판정한다).
//
// 사용: npx tsx src/tools/dedupe-schedules.ts [--apply]
//   --apply 없이 돌리면 무엇을 지울지 보여주기만 한다.
import { db } from "../db.js";
import { normalizeScheduleContent } from "../schedule-dedupe.js";

const apply = process.argv.includes("--apply");

interface Row {
  id: number;
  character_id: number;
  owner: string;
  date: string;
  time_hint: string | null;
  content: string;
  origin: string;
  created_at: string;
}

const rows = db
  .prepare(
    `SELECT id, character_id, owner, date, time_hint, content, origin, created_at
       FROM schedules WHERE status = 'active' ORDER BY character_id, date, id`,
  )
  .all() as Row[];

// 글자·숫자가 하나도 없는 내용은 묶지 않는다 — 기호뿐인 줄끼리 한 무리가 되어 버린다.
const groups = new Map<string, Row[]>();
for (const r of rows) {
  const norm = normalizeScheduleContent(r.content);
  if (!norm) continue;
  const key = `${r.character_id}|${r.owner}|${r.date}|${norm}`;
  const bucket = groups.get(key);
  if (bucket) bucket.push(r);
  else groups.set(key, [r]);
}

const dupGroups = [...groups.values()].filter((g) => g.length > 1);
const cut = (s: string, n: number): string =>
  [...s].length > n ? `${[...s].slice(0, n).join("")}…` : s;
const label = (r: Row): string =>
  `#${r.id} ${r.date}${r.time_hint ? ` ${r.time_hint}` : ""} "${cut(r.content, 40)}" (${r.origin}, ${r.created_at.slice(0, 10)} 생성)`;

const tagCount = db.prepare(
  `SELECT COUNT(*) FROM tags WHERE kind = 'schedule' AND ref_id = ?`,
);

let removeCount = 0;
for (const g of dupGroups) {
  const [keep, ...drop] = g as [Row, ...Row[]];
  console.log(
    `[dedupe-schedules] 캐릭터 ${keep.character_id} · ${keep.owner === "user" ? "유저" : "캐릭터"} 쪽`,
  );
  console.log(`  남김 ${label(keep)}`);
  for (const d of drop) {
    const tags = Number(tagCount.pluck().get(d.id) ?? 0);
    console.log(`  지움 ${label(d)}${tags ? ` · 태그 ${tags}개 옮김` : ""}`);
    removeCount += 1;
  }
}

console.log(
  `[dedupe-schedules] 겹친 무리 ${dupGroups.length}개, 지울 행 ${removeCount}건 (살아 있는 일정 ${rows.length}건 중)`,
);

if (!removeCount) process.exit(0);

if (!apply) {
  console.log("[dedupe-schedules] --apply 를 붙이면 실제로 지운다");
  process.exit(0);
}

// 태그 옮기기와 삭제는 한 트랜잭션에서 — 중간에 끊기면 태그만 지워진 행이 남는다.
const run = db.transaction((): void => {
  const moveTags = db.prepare(
    `INSERT OR IGNORE INTO tags (character_id, kind, ref_id, tag)
       SELECT character_id, 'schedule', ?, tag FROM tags WHERE kind = 'schedule' AND ref_id = ?`,
  );
  const dropTags = db.prepare(
    `DELETE FROM tags WHERE kind = 'schedule' AND ref_id = ?`,
  );
  const dropRow = db.prepare(`DELETE FROM schedules WHERE id = ?`);
  for (const g of dupGroups) {
    const [keep, ...drop] = g as [Row, ...Row[]];
    for (const d of drop) {
      moveTags.run(keep.id, d.id);
      dropTags.run(d.id);
      dropRow.run(d.id);
    }
  }
});
run();

console.log(`[dedupe-schedules] 삭제 완료: ${removeCount}건`);
process.exit(0);
