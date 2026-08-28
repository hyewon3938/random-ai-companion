// 쓰기 전환 관찰 도구: 새 저장 구조에 무엇이 쌓였는지 한 번에 본다. 읽기 전용이라 DB를 바꾸지 않는다.
// 사용: docker exec random-ai-companion npx tsx src/tools/check-writes.ts [--days 3] [--json]
import { db } from "../db.js";
import { kstLogicalDate } from "../kst.js";
import {
  MEMORY_ITEM_TYPE_NAME,
  MEMORY_OWNER_NAME,
  MEMORY_ORIGIN_NAME,
  type MemoryItemType,
  type MemoryOwner,
  type MemoryOrigin,
} from "../labels.js";

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const daysArg = argv.indexOf("--days");
const days = daysArg >= 0 ? Number(argv[daysArg + 1]) : 3;
if (!Number.isFinite(days) || days < 1) {
  console.error("--days 는 1 이상의 숫자여야 합니다");
  process.exit(1);
}

const all = <T>(sql: string, ...params: unknown[]): T[] =>
  db.prepare(sql).all(...params) as T[];
const one = <T>(sql: string, ...params: unknown[]): T | undefined =>
  db.prepare(sql).get(...params) as T | undefined;
const count = (sql: string, ...params: unknown[]): number =>
  (one<{ n: number }>(sql, ...params)?.n ?? 0);

const since = (() => {
  const d = new Date(`${kstLogicalDate()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().slice(0, 10);
})();

const cut = (s: string | null, n: number): string =>
  !s ? "" : [...s].length > n ? `${[...s].slice(0, n).join("")}…` : s;

// ---- 수집 ----

const schema = {
  userVersion: one<{ user_version: number }>("PRAGMA user_version")?.user_version ?? -1,
  integrity: one<{ integrity_check: string }>("PRAGMA integrity_check")?.integrity_check ?? "?",
  foreignKeyErrors: all("PRAGMA foreign_key_check").length,
};

const characters = all<{ id: number; chat_id: string; status: string }>(
  `SELECT id, chat_id, status FROM characters ORDER BY id`,
);

const memoryByKey = all<{
  item_type: MemoryItemType;
  owner: MemoryOwner;
  origin: MemoryOrigin;
  n: number;
}>(
  `SELECT item_type, owner, origin, COUNT(*) AS n FROM memory_items
   GROUP BY item_type, owner, origin ORDER BY item_type, owner, origin`,
);

const memoryRecent = all<{
  item_type: MemoryItemType;
  owner: MemoryOwner;
  area: string;
  subject: string;
  value: string;
  updated_at: string;
}>(
  `SELECT item_type, owner, area, subject, value, updated_at FROM memory_items
   WHERE origin = 'conversation' AND date(updated_at) >= ?
   ORDER BY updated_at DESC LIMIT 20`,
  since,
);

const memoryExtras = {
  personWithRelation: count(
    `SELECT COUNT(*) AS n FROM memory_items WHERE item_type = 'person' AND relation IS NOT NULL`,
  ),
  personMentioned: count(
    `SELECT COUNT(*) AS n FROM memory_items WHERE item_type = 'person' AND last_mentioned_at >= ?`,
    since,
  ),
  ongoingWithEnd: count(
    `SELECT COUNT(*) AS n FROM memory_items WHERE item_type = 'ongoing' AND end_condition IS NOT NULL`,
  ),
  retrieved: count(`SELECT COUNT(*) AS n FROM memory_items WHERE retrieval_count > 0`),
  untagged: count(
    `SELECT COUNT(*) AS n FROM memory_items m
     WHERE NOT EXISTS (SELECT 1 FROM tags t WHERE t.kind = 'memory' AND t.ref_id = m.id)`,
  ),
};

const tagsByKind = all<{ kind: string; n: number }>(
  `SELECT kind, COUNT(*) AS n FROM tags GROUP BY kind ORDER BY kind`,
);
const orphanTags = count(
  `SELECT COUNT(*) AS n FROM tags t
   WHERE (t.kind = 'memory' AND NOT EXISTS (SELECT 1 FROM memory_items m WHERE m.id = t.ref_id))
      OR (t.kind = 'diary' AND NOT EXISTS (SELECT 1 FROM diary_entries d WHERE d.id = t.ref_id))
      OR (t.kind = 'schedule' AND NOT EXISTS (SELECT 1 FROM schedules s WHERE s.id = t.ref_id))`,
);
const topTags = all<{ tag: string; n: number }>(
  `SELECT tag, COUNT(*) AS n FROM tags GROUP BY tag ORDER BY n DESC, tag LIMIT 10`,
);

const notesByDay = all<{ d: string; n: number }>(
  `SELECT date(created_at) AS d, COUNT(*) AS n FROM today_notes
   WHERE date(created_at) >= ? GROUP BY d ORDER BY d DESC`,
  since,
);
const notesRecent = all<{ created_at: string; note: string }>(
  `SELECT created_at, note FROM today_notes WHERE date(created_at) >= ?
   ORDER BY created_at DESC LIMIT 10`,
  since,
);

const actuals = all<{ date: string; block_start: string | null; intended: string; outcome: string }>(
  `SELECT date, block_start, intended, outcome FROM day_actuals
   WHERE date >= ? ORDER BY date DESC, recorded_at DESC LIMIT 10`,
  since,
);

const diaries = all<{ date: string }>(
  `SELECT date FROM diary_entries ORDER BY date DESC LIMIT ?`,
  days + 2,
);
const plans = all<{ date: string; made_by: string }>(
  `SELECT date, made_by FROM day_plans ORDER BY date DESC LIMIT ?`,
  days + 2,
);
const seedRunway = one<{ last: string | null; n: number }>(
  `SELECT MAX(date) AS last, COUNT(*) AS n FROM day_seeds WHERE date >= ?`,
  kstLogicalDate(),
);

const schedulesUpcoming = all<{ owner: string; origin: string; n: number }>(
  `SELECT owner, origin, COUNT(*) AS n FROM schedules
   WHERE date >= ? AND status = 'active' GROUP BY owner, origin ORDER BY owner, origin`,
  kstLogicalDate(),
);

const relationships = all<{
  character_id: number;
  speech_level: string | null;
  updated_at: string | null;
  filled: string;
  legacy: number;
}>(
  `SELECT character_id, speech_level, updated_at,
     (CASE WHEN stage IS NOT NULL THEN '사이 ' ELSE '' END) ||
     (CASE WHEN speech_note IS NOT NULL THEN '말투 ' ELSE '' END) ||
     (CASE WHEN address_terms IS NOT NULL THEN '호칭 ' ELSE '' END) ||
     (CASE WHEN texture IS NOT NULL THEN '결 ' ELSE '' END) ||
     (CASE WHEN rapport IS NOT NULL THEN '잘통함 ' ELSE '' END) ||
     (CASE WHEN cautions IS NOT NULL THEN '조심 ' ELSE '' END) ||
     (CASE WHEN history IS NOT NULL THEN '지나온 ' ELSE '' END) ||
     (CASE WHEN feelings IS NOT NULL THEN '마음' ELSE '' END) AS filled,
     length(coalesce(legacy_state_json, '')) AS legacy
   FROM relationships ORDER BY character_id`,
);

const pending = all<{ status: string; n: number }>(
  `SELECT status, COUNT(*) AS n FROM pending_replies GROUP BY status ORDER BY status`,
);
const pendingNotes = count(
  `SELECT COUNT(*) AS n FROM pending_replies WHERE note_to_save IS NOT NULL AND date(created_at) >= ?`,
  since,
);
const scheduledMsgs = all<{ date: string; kind: string; status: string; skip_reason: string | null }>(
  `SELECT date, kind, status, skip_reason FROM scheduled_messages
   WHERE date >= ? ORDER BY date DESC, id DESC LIMIT 10`,
  since,
);

const msgsByDay = all<{ d: string; role: string; n: number }>(
  `SELECT date(sent_at) AS d, role, COUNT(*) AS n FROM messages
   WHERE date(sent_at) >= ? GROUP BY d, role ORDER BY d DESC, role`,
  since,
);

const usage = all<{ date: string; model: string; calls: number; cw: number; cr: number; out: number }>(
  `SELECT date, model, calls, cache_write_tokens AS cw, cache_read_tokens AS cr, output_tokens AS out
   FROM llm_usage WHERE date >= ? ORDER BY date DESC, model`,
  since,
);

// ---- 출력 ----

if (asJson) {
  console.log(
    JSON.stringify(
      {
        since,
        schema,
        characters,
        memoryByKey,
        memoryRecent,
        memoryExtras,
        tagsByKind,
        orphanTags,
        topTags,
        notesByDay,
        actuals,
        diaries,
        plans,
        seedRunway,
        schedulesUpcoming,
        relationships,
        pending,
        pendingNotes,
        scheduledMsgs,
        msgsByDay,
        usage,
      },
      null,
      1,
    ),
  );
  process.exit(0);
}

const out: string[] = [];
const line = (s = "") => out.push(s);
const head = (s: string) => {
  line();
  line(`## ${s}`);
};

line(`# 쓰기 전환 관찰 — ${kstLogicalDate()} 기준, ${since}부터 ${days}일`);
line(
  `스키마 v${schema.userVersion} · integrity ${schema.integrity} · 외래키 오류 ${schema.foreignKeyErrors}건 · 캐릭터 ${characters
    .map((c) => `#${c.id}(${c.status})`)
    .join(" ")}`,
);

head("기억");
for (const r of memoryByKey) {
  line(
    `  ${MEMORY_ITEM_TYPE_NAME[r.item_type]} · ${MEMORY_OWNER_NAME[r.owner]} · ${
      MEMORY_ORIGIN_NAME[r.origin]
    } — ${r.n}건`,
  );
}
line(
  `  전용 컬럼: 인물 관계 ${memoryExtras.personWithRelation} · 진행 끝나는 조건 ${memoryExtras.ongoingWithEnd}`,
);
line(
  `  기간 안 인물 등장 갱신 ${memoryExtras.personMentioned}건 · 검색된 적 있는 기억 ${memoryExtras.retrieved}건 · 태그 없는 기억 ${memoryExtras.untagged}건`,
);
if (memoryRecent.length === 0) line("  기간 안에 대화로 저장된 기억 없음");
for (const r of memoryRecent) {
  line(
    `  ${r.updated_at} ${MEMORY_ITEM_TYPE_NAME[r.item_type]}/${MEMORY_OWNER_NAME[r.owner]} ${r.area}/${r.subject} — ${cut(r.value, 40)}`,
  );
}

head("태그");
line(`  ${tagsByKind.map((t) => `${t.kind} ${t.n}`).join(" · ") || "없음"} · 참조가 끊긴 태그 ${orphanTags}건`);
line(`  많이 쓰인 태그: ${topTags.map((t) => `${t.tag}(${t.n})`).join(" ") || "없음"}`);

head("오늘 메모");
line(`  ${notesByDay.map((n) => `${n.d} ${n.n}건`).join(" · ") || "기간 안 없음"}`);
for (const n of notesRecent) line(`  ${n.created_at} ${cut(n.note, 50)}`);

head("각본과 달라진 기록");
if (actuals.length === 0) line("  기간 안 없음");
for (const a of actuals) {
  line(`  ${a.date} ${a.block_start ?? "-"} ${cut(a.intended, 20)} → ${cut(a.outcome, 30)}`);
}

head("하루 준비");
line(`  일기: ${diaries.map((d) => d.date).join(" ") || "없음"}`);
line(`  각본: ${plans.map((p) => `${p.date}(${p.made_by})`).join(" ") || "없음"}`);
line(`  컨디션 시드 남은 날: ${seedRunway?.n ?? 0}일 (마지막 ${seedRunway?.last ?? "-"})`);
line(
  `  앞으로의 일정: ${
    schedulesUpcoming.map((s) => `${s.owner}/${s.origin} ${s.n}`).join(" · ") || "없음"
  }`,
);

head("관계");
for (const r of relationships) {
  line(
    `  #${r.character_id} 말투 ${r.speech_level ?? "-"} · 갱신 ${r.updated_at ?? "없음"} · 채워진 항목 ${
      r.filled.trim() || "없음"
    } · 옛 JSON ${r.legacy}자`,
  );
}

head("발송 대기");
line(`  대기 답장: ${pending.map((p) => `${p.status} ${p.n}`).join(" · ") || "없음"}`);
line(`  기간 안 답장에 딸린 메모: ${pendingNotes}건`);
for (const s of scheduledMsgs) {
  line(`  선톡 ${s.date} ${s.kind} ${s.status}${s.skip_reason ? ` (${s.skip_reason})` : ""}`);
}

head("대화량과 모델 사용");
line(`  ${msgsByDay.map((m) => `${m.d} ${m.role} ${m.n}`).join(" · ") || "기간 안 없음"}`);
for (const u of usage) {
  line(`  ${u.date} ${u.model} 호출 ${u.calls} · 캐시쓰기 ${u.cw} · 캐시읽기 ${u.cr} · 출력 ${u.out}`);
}

console.log(out.join("\n"));
