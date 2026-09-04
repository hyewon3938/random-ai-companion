// 쓰기 전환 관찰 도구: 새 저장 구조에 무엇이 쌓였는지 한 번에 본다. 읽기 전용이라 DB를 바꾸지 않는다.
// 사용: docker exec random-ai-companion npx tsx src/tools/check-writes.ts [--days 3] [--json]
import { db } from "../db.js";
import { kstLogicalDate } from "../kst.js";
import {
  MEMORY_ITEM_TYPE_NAME,
  MEMORY_OWNER_NAME,
  MEMORY_ORIGIN_NAME,
  CALL_PURPOSE_NAME,
  type MemoryItemType,
  type MemoryOwner,
  type MemoryOrigin,
  type CallPurpose,
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
}>(
  `SELECT character_id, speech_level, updated_at,
     (CASE WHEN stage IS NOT NULL THEN '사이 ' ELSE '' END) ||
     (CASE WHEN speech_note IS NOT NULL THEN '말투 ' ELSE '' END) ||
     (CASE WHEN address_terms IS NOT NULL THEN '호칭 ' ELSE '' END) ||
     (CASE WHEN rapport IS NOT NULL THEN '잘통함 ' ELSE '' END) ||
     (CASE WHEN cautions IS NOT NULL THEN '조심 ' ELSE '' END) ||
     (CASE WHEN history IS NOT NULL THEN '지나온 ' ELSE '' END) ||
     (CASE WHEN feelings IS NOT NULL THEN '마음' ELSE '' END) AS filled
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

// 호출 원문 — 어떤 용도로 몇 번 불렀고, 무엇이 실패했고, 본문이 얼마나 쌓였는지.
const callsByPurpose = all<{
  purpose: CallPurpose;
  n: number;
  failed: number;
  retried: number;
  avg_ms: number | null;
}>(
  `SELECT purpose, COUNT(*) AS n,
     SUM(error IS NOT NULL) AS failed,
     SUM(attempt > 1) AS retried,
     AVG(latency_ms) AS avg_ms
   FROM llm_calls WHERE date(created_at) >= ?
   GROUP BY purpose ORDER BY n DESC`,
  since,
);
const callRecentFails = all<{
  created_at: string;
  purpose: string;
  model: string;
  error: string;
}>(
  `SELECT created_at, purpose, model, error FROM llm_calls
   WHERE error IS NOT NULL ORDER BY id DESC LIMIT 5`,
);
const callStore = {
  blobs: count(`SELECT COUNT(*) AS n FROM prompt_blobs`),
  bytes: one<{ n: number }>(`SELECT coalesce(SUM(bytes), 0) AS n FROM prompt_blobs`)?.n ?? 0,
  total: count(`SELECT COUNT(*) AS n FROM llm_calls`),
  // 보관 기간이 지나 본문을 비운 행 — 메타만 남아 있다.
  pruned: count(`SELECT COUNT(*) AS n FROM llm_calls WHERE turns_hash IS NULL`),
  withContext: count(
    `SELECT COUNT(*) AS n FROM llm_calls WHERE context_json IS NOT NULL AND date(created_at) >= ?`,
    since,
  ),
  replies: count(
    `SELECT COUNT(*) AS n FROM llm_calls WHERE purpose = 'reply' AND date(created_at) >= ?`,
    since,
  ),
};

// 유저 반응 신호 — messages에 이미 있는 것을 집계만 한다.
// 답장·선톡이 나간 뒤 유저가 다시 말하기까지 걸린 시간, 그 뒤로 이어진 발화 수.
const REACTION_WINDOW_MIN = 360;
const PROACTIVE_KINDS = new Set(["morning", "away", "catchup", "goodnight"]);

const msgRows = all<{
  chat_id: string;
  role: string;
  sent_at: string;
  meta_json: string | null;
}>(
  `SELECT chat_id, role, sent_at, meta_json FROM messages
   WHERE date(sent_at) >= ? ORDER BY chat_id, sent_at, id`,
  since,
);
const kindOf = (meta: string | null): string => {
  if (!meta) return "";
  try {
    return String((JSON.parse(meta) as { kind?: string }).kind ?? "");
  } catch {
    return "";
  }
};
const minutesBetween = (a: string, b: string): number =>
  (Date.parse(`${b.replace(" ", "T")}Z`) - Date.parse(`${a.replace(" ", "T")}Z`)) /
  60000;
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.floor(s.length / 2)] ?? 0);
};

const replyGaps: number[] = [];
const proactiveGaps: number[] = [];
let proactiveSent = 0;
const proactiveTurns: number[] = [];
for (let i = 0; i < msgRows.length; i++) {
  const m = msgRows[i];
  if (!m || m.role !== "assistant") continue;
  const kind = kindOf(m.meta_json);
  const isProactive = PROACTIVE_KINDS.has(kind);
  if (!isProactive && kind !== "reply" && kind !== "recover") continue;
  if (isProactive) proactiveSent++;
  // 같은 대화방에서 창 안에 온 유저 발화만 센다.
  let gap: number | null = null;
  let turns = 0;
  for (let j = i + 1; j < msgRows.length; j++) {
    const n = msgRows[j];
    if (!n || n.chat_id !== m.chat_id) break;
    const d = minutesBetween(m.sent_at, n.sent_at);
    if (d > REACTION_WINDOW_MIN) break;
    if (n.role !== "user") continue;
    if (gap === null) gap = d;
    turns++;
  }
  if (gap !== null) (isProactive ? proactiveGaps : replyGaps).push(gap);
  if (isProactive) proactiveTurns.push(turns);
}
const reaction = {
  windowMin: REACTION_WINDOW_MIN,
  replyAnswered: replyGaps.length,
  replyMedianMin: median(replyGaps),
  proactiveSent,
  proactiveAnswered: proactiveGaps.length,
  proactiveMedianMin: median(proactiveGaps),
  proactiveTurnsAvg: proactiveTurns.length
    ? Math.round(
        (proactiveTurns.reduce((a, b) => a + b, 0) / proactiveTurns.length) * 10,
      ) / 10
    : 0,
};

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
        callsByPurpose,
        callRecentFails,
        callStore,
        reaction,
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
    }`,
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

head("호출 원문");
if (callsByPurpose.length === 0) line("  기간 안 없음");
for (const c of callsByPurpose) {
  line(
    `  ${CALL_PURPOSE_NAME[c.purpose] ?? c.purpose} ${c.n}건 · 평균 ${
      c.avg_ms === null ? "-" : `${(c.avg_ms / 1000).toFixed(1)}초`
    } · 실패 ${c.failed} · 다시 물음 ${c.retried}`,
  );
}
line(
  `  전체 ${callStore.total}건(본문 비운 행 ${callStore.pruned}) · 본문 ${callStore.blobs}건 ${(
    callStore.bytes / 1048576
  ).toFixed(2)}MB`,
);
line(
  `  기간 안 답장 호출 ${callStore.replies}건 중 판단 근거가 붙은 것 ${callStore.withContext}건`,
);
for (const f of callRecentFails) {
  line(`  실패 ${f.created_at} ${f.purpose}/${f.model} — ${cut(f.error, 60)}`);
}

head("유저 반응 신호");
line(
  `  답장 뒤 ${reaction.windowMin / 60}시간 안에 유저가 다시 말한 것 ${
    reaction.replyAnswered
  }건 · 중앙값 ${reaction.replyMedianMin ?? "-"}분`,
);
line(
  `  선톡 ${reaction.proactiveSent}통 중 답 온 것 ${reaction.proactiveAnswered}통 · 중앙값 ${
    reaction.proactiveMedianMin ?? "-"
  }분 · 뒤이은 유저 발화 평균 ${reaction.proactiveTurnsAvg}턴`,
);

console.log(out.join("\n"));
