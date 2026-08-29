// 새벽 정리 트레이스 — 하루를 닫은 새벽 정리가 무엇을 바꿨는지 게시함에 쌓는다.
//
// 훅은 applyNightlyOutput 한 자리다. 봇 밖 스케줄러(tools/nightly-write)와 봇 안 폴백 크론이
// 둘 다 그 함수를 지나므로 한 곳이면 두 경로가 다 걸린다.
//
// 게시 기록은 반영 트랜잭션 바깥에서 남긴다 — 게시가 실패해도 새벽 정리는 되돌아가지 않는다.
// 이전 값과 새 값을 나란히 보여주려고, 트랜잭션을 부르기 전에 출력이 쓸 키의 행을 미리 읽어 둔다.
//
//   본문   — 반영 요약, 그날 오늘 메모, 각본과 달라진 하루, 관계 갱신(이전→새 값),
//            상대 프로필 갱신, 새 일정
//   스레드 — 기억 신규·덮어쓰기, 일기 전문, 오늘 선톡 문안과 발송 창, 새벽 정리가 부른 호출 원문
//
// 게시를 위한 모델 호출은 없다. 전부 DB 값과 코드 계산이다.

import {
  db,
  getBlob,
  getRelationship,
  getTags,
  getUserProfile,
  listMemoryItems,
  type MemoryRow,
  type RelationshipRow,
  type StoredUserProfile,
} from "./db.js";
import {
  chunked,
  dateLabel,
  esc,
  recordTraceEvent,
  traceEnabled,
} from "./trace.js";
import {
  CALL_PURPOSE_NAME,
  INTEREST_NAME,
  MEMORY_ITEM_TYPE_NAME,
  MEMORY_OWNER_NAME,
  SPEECH_LEVEL_NAME,
  type CallPurpose,
  type MemoryOrigin,
} from "./labels.js";
import { keyProblem } from "./memory.js";
import { getKstNow } from "./kst.js";
import type {
  DiaryOutput,
  MemoryExtract,
  NightlyGathered,
  NightlyOutput,
} from "./nightly.js";

// 새벽 정리가 부르는 호출 자리. 답장 트레이스(reply-trace)는 이 목록을 건너뛰고,
// 여기서 이전 값과 함께 스레드로 붙인다.
const NIGHTLY_PURPOSES = [
  "diary",
  "extract",
  "arc",
  "day_plan",
  "life_plan",
] as const;

// 호출 원문을 이번 새벽 정리 몫으로 볼 시간 창. 생성은 언제나 반영 직전에 일어나므로
// 뒤를 볼 필요가 없고, 창을 좁게 잡아 낮에 만든 임시 각본까지 딸려오지 않게 한다.
const CALL_WINDOW_MS = 2 * 3600_000;

const clock = (): string => getKstNow().toISOString().slice(11, 19);

const clip = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n)}… (${s.length}자)`;

const quote = (s: string): string =>
  s
    .split("\n")
    .map((l) => `> ${esc(l)}`)
    .join("\n");

const shortModel = (m: string): string => m.replace(/^claude-/, "");

const purposeName = (p: string): string =>
  p in CALL_PURPOSE_NAME ? CALL_PURPOSE_NAME[p as CallPurpose] : p;

const stampMinusMs = (ms: number): string => {
  const t = new Date(getKstNow().getTime() - ms);
  return t.toISOString().replace("T", " ").slice(0, 19);
};

/** 트랜잭션이 쓰는 것과 같은 키 — 저장 항목·주인·영역/무엇. */
const memKey = (
  itemType: string,
  owner: string,
  area: string,
  subject: string,
): string => `${itemType}|${owner}|${area.trim()}/${subject.trim()}`;

const rowKey = (r: MemoryRow): string =>
  memKey(r.item_type, r.owner, r.area, r.subject);

const extractKey = (m: MemoryExtract): string =>
  memKey(m.item_type, m.owner, m.area, m.subject);

const memLabel = (m: MemoryExtract): string =>
  `[${MEMORY_ITEM_TYPE_NAME[m.item_type]} · ${MEMORY_OWNER_NAME[m.owner]}] ${m.area.trim()}/${m.subject.trim()}`;

const tagLine = (now: string[], before?: string[]): string => {
  const cur = now.length ? now.join(" · ") : "(없음)";
  if (!before) return `태그: ${cur}`;
  const same =
    before.length === now.length && before.every((t, i) => t === now[i]);
  return same
    ? `태그: ${cur}`
    : `태그: ${cur} (이전 ${before.length ? before.join(" · ") : "없음"})`;
};

// ── 트랜잭션 전에 읽어 두는 값 ──────────────────────────────────────────

interface MemorySnap {
  value: string;
  origin: MemoryOrigin;
  tags: string[];
}

export interface NightlySnapshot {
  memories: Map<string, MemorySnap>;
  relationship: RelationshipRow | undefined;
  profile: StoredUserProfile;
}

/**
 * 반영 전 값 스냅샷. 게시가 꺼져 있으면 아무것도 읽지 않는다(null).
 * 읽기만 하므로 이 함수가 새벽 정리 결과를 바꿀 일은 없다.
 */
export const beforeNightlyTrace = (
  g: NightlyGathered,
  out: NightlyOutput,
): NightlySnapshot | null => {
  if (!traceEnabled()) return null;
  try {
    const wanted = new Set<string>();
    for (const m of out.extract?.memories ?? [])
      if (m.value?.trim() && m.area && m.subject) wanted.add(extractKey(m));
    const memories = new Map<string, MemorySnap>();
    if (wanted.size)
      for (const r of listMemoryItems(g.characterId)) {
        const k = rowKey(r);
        if (!wanted.has(k)) continue;
        // 트랜잭션과 같은 규칙 — 같은 키에 두 행이 있으면 대화로 쌓인 쪽이 지금 값이다.
        const cur = memories.get(k);
        if (cur && !(cur.origin !== "conversation" && r.origin === "conversation"))
          continue;
        memories.set(k, {
          value: r.value,
          origin: r.origin,
          tags: getTags("memory", r.id),
        });
      }
    return {
      memories,
      relationship: getRelationship(g.characterId),
      profile: getUserProfile(g.chatId),
    };
  } catch (err) {
    console.error("[trace] 새벽 정리 이전 값 읽기 실패:", err);
    return null;
  }
};

// ── 본문 ────────────────────────────────────────────────────────────────

const REL_FIELDS: [keyof RelationshipRow, string][] = [
  ["stage", "지금 어떤 사이"],
  ["speech_level", "말투"],
  ["speech_note", "말투의 결"],
  ["address_terms", "서로 부르는 말"],
  ["texture", "관계의 결"],
  ["rapport", "잘 통하는 것"],
  ["cautions", "조심할 것"],
  ["history", "지나온 이야기"],
  ["feelings", "지금 마음"],
];

const relValue = (
  r: RelationshipRow | undefined,
  f: keyof RelationshipRow,
): string => {
  const v = r?.[f] ?? null;
  if (!v) return "";
  return f === "speech_level" && (v === "polite" || v === "casual")
    ? SPEECH_LEVEL_NAME[v]
    : String(v);
};

const relationshipBlocks = (
  before: RelationshipRow | undefined,
  after: RelationshipRow | undefined,
): string[] => {
  const out: string[] = [];
  for (const [f, name] of REL_FIELDS) {
    const b = relValue(before, f);
    const a = relValue(after, f);
    if (b === a) continue;
    out.push(
      [
        `*${name}*`,
        `> 이전: ${esc(b || "(비어 있었음)")}`,
        `> 새 값: ${esc(a || "(비움)")}`,
      ].join("\n"),
    );
  }
  return out;
};

// 대화로 채우는 두 값만 본다 — 성별·나이대는 새벽 정리가 손대지 않는다.
const PROFILE_FIELDS: [keyof StoredUserProfile, string][] = [
  ["job", "하는 일"],
  ["region", "사는 곳"],
];

const profileBlocks = (
  before: StoredUserProfile,
  after: StoredUserProfile,
): string[] => {
  const out: string[] = [];
  for (const [f, name] of PROFILE_FIELDS) {
    const b = before[f] ?? "";
    const a = after[f] ?? "";
    if (b === a) continue;
    out.push(
      [
        `*${name}*`,
        `> 이전: ${esc(b || "(모르던 값)")}`,
        `> 새 값: ${esc(a || "(비움)")}`,
      ].join("\n"),
    );
  }
  return out;
};

const SILENCE_NOTE: Record<NightlyGathered["silenceTier"], string | null> = {
  normal: null,
  quiet: "각본·선톡은 만들지 않았다 — 일기·시드만",
  checkin: "각본은 만들지 않았다 — 저녁 안부 문안만",
  dormant: "각본·선톡은 만들지 않았다 — 일기·시드만",
};

const listSection = (
  title: string,
  items: string[],
  emptyNote?: string,
): string | null => {
  if (!items.length) return emptyNote ? `*${title}* ${emptyNote}` : null;
  return [`*${title}* ${items.length}건`, ...items.map((s) => `> ${esc(s)}`)].join(
    "\n",
  );
};

const headText = (
  g: NightlyGathered,
  out: NightlyOutput,
  snap: NightlySnapshot,
  after: RelationshipRow | undefined,
  afterProfile: StoredUserProfile,
  result: string,
): string => {
  const parts: string[] = [
    `:crescent_moon: *${dateLabel(g.diaryDate)} 새벽 정리* · ${clock()}`,
    quote(result),
  ];
  const silence = SILENCE_NOTE[g.silenceTier];
  if (silence)
    parts.push(
      `*침묵 ${g.silenceDays}일째(${g.silenceTier})* — ${esc(silence)}`,
    );
  const notes = listSection("오늘 메모", g.todayNotes, "없음");
  if (notes) parts.push(notes);
  // 수집이 붙여 둔 목록 표시(- )는 게시함에서 인용 부호와 겹쳐 떼고 넣는다.
  const actuals = listSection(
    "각본과 달라진 하루",
    g.dayActuals.map((s) => s.replace(/^-\s*/, "")),
    "없음",
  );
  if (actuals) parts.push(actuals);
  const rel = relationshipBlocks(snap.relationship, after);
  if (rel.length)
    parts.push([`*관계 갱신* ${rel.length}항목`, ...rel].join("\n"));
  const prof = profileBlocks(snap.profile, afterProfile);
  if (prof.length)
    parts.push([`*상대 프로필 갱신* ${prof.length}항목`, ...prof].join("\n"));
  const schedules = (out.extract?.schedules ?? [])
    .filter((s) => s.date && s.content)
    .map(
      (s) =>
        `${s.date}${s.time_hint ? ` ${s.time_hint}` : ""} · ${s.content} (${s.who === "user" ? "유저" : "캐릭터"} 쪽)`,
    );
  const sched = listSection("새 일정", schedules);
  if (sched) parts.push(sched);
  return parts.join("\n\n");
};

// ── 스레드 ──────────────────────────────────────────────────────────────

// 긴 본문은 게시함이 정한 한 덩이 크기로 잘라 여러 행으로 쌓는다.
// code=true면 자른 뒤에 각 덩이를 코드 울타리로 감싼다 — 울타리째 자르면 표시가 깨진다.
const pushChunks = (
  characterId: number,
  parentKey: string,
  kind: string,
  label: string,
  body: string,
  code = false,
): void => {
  const parts = chunked(body);
  parts.forEach((p, i) => {
    const head = parts.length > 1 ? `${label} (${i + 1}/${parts.length})` : label;
    recordTraceEvent({
      characterId,
      kind,
      parentKey,
      text: code ? `${head}\n\`\`\`\n${p}\n\`\`\`` : `${head}\n${p}`,
    });
  });
};

const memoryChild = (
  g: NightlyGathered,
  out: NightlyOutput,
  snap: NightlySnapshot,
  parentKey: string,
): void => {
  const ex = out.extract;
  if (!ex?.memories?.length) return;
  const fresh: string[] = [];
  const changed: string[] = [];
  const kept: string[] = [];
  const skipped: string[] = [];
  // 저장된 행의 태그는 반영 뒤에 읽는다 — 키가 같으면 한 행이므로 대화 쪽 행 하나만 본다.
  const nowTags = new Map<string, string[]>();
  for (const r of listMemoryItems(g.characterId))
    if (r.origin === "conversation") nowTags.set(rowKey(r), getTags("memory", r.id));

  for (const m of ex.memories) {
    if (!m.value?.trim() || !m.area || !m.subject) continue;
    if (keyProblem(m.area, m.subject)) {
      skipped.push(`${m.area}/${m.subject}`);
      continue;
    }
    const key = extractKey(m);
    const prev = snap.memories.get(key);
    const tags = nowTags.get(key) ?? [];
    const extra = [
      m.user_knows ? `유저가 아는가: ${m.user_knows}` : null,
      m.interest ? `관심 수준: ${INTEREST_NAME[m.interest]}` : null,
      m.end_condition ? `끝나는 조건: ${m.end_condition}` : null,
      m.relation ? `어떤 사이: ${m.relation}` : null,
      m.contact_mode ? `만나는 결: ${m.contact_mode}` : null,
      m.region ? `사는 곳: ${m.region}` : null,
    ].filter(Boolean) as string[];
    const tail = [
      `> ${esc(tagLine(tags, prev?.tags))}`,
      ...(extra.length ? [`> ${esc(extra.join(" · "))}`] : []),
    ];
    if (!prev) {
      fresh.push(
        [`＋ *${esc(memLabel(m))}*`, `> ${esc(clip(m.value, 400))}`, ...tail].join(
          "\n",
        ),
      );
    } else if (prev.value.trim() === m.value.trim()) {
      kept.push(memLabel(m));
    } else {
      changed.push(
        [
          `～ *${esc(memLabel(m))}*`,
          // 생성 행만 있던 키면 이번에 처음 대화 쪽 행이 생긴다 — 이전 값의 출처를 밝힌다.
          `> 이전: ${esc(clip(prev.value, 400))}${prev.origin === "creation" ? " (생성 때 값)" : ""}`,
          `> 새 값: ${esc(clip(m.value, 400))}`,
          ...tail,
        ].join("\n"),
      );
    }
  }

  const counts = [
    fresh.length ? `신규 ${fresh.length}건` : null,
    changed.length ? `덮어쓰기 ${changed.length}건` : null,
    kept.length ? `값 그대로 ${kept.length}건` : null,
    skipped.length ? `키 불가 ${skipped.length}건` : null,
  ].filter(Boolean);
  if (!counts.length) return;

  const body = [
    `*기억* ${counts.join(" · ")}`,
    ...fresh,
    ...changed,
    ...(kept.length ? [`= 값 그대로: ${esc(kept.join(", "))}`] : []),
    ...(skipped.length
      ? [`:warning: 키 규칙에 안 맞아 건너뜀: ${esc(skipped.join(", "))}`]
      : []),
  ].join("\n\n");
  pushChunks(g.characterId, parentKey, "nightly_memory", "기억", body);
};

const diaryChild = (g: NightlyGathered, parentKey: string): void => {
  const row = db
    .prepare(
      `SELECT entry_json FROM diary_entries WHERE character_id = ? AND date = ?`,
    )
    .get(g.characterId, g.diaryDate) as { entry_json: string } | undefined;
  if (!row) return;
  let e: DiaryOutput;
  try {
    e = JSON.parse(row.entry_json) as DiaryOutput;
  } catch {
    return;
  }
  const body = [
    `*${dateLabel(g.diaryDate)} 일기*`,
    quote(e.diary ?? ""),
    e.plan_vs_actual ? `*각본 대비*\n${quote(e.plan_vs_actual)}` : null,
    e.user_mood ? `*유저 기분*\n${quote(e.user_mood)}` : null,
    e.closeness ? `*가까움*\n${quote(e.closeness)}` : null,
    e.tomorrow?.length
      ? `*내일 챙길 것*\n${quote(e.tomorrow.map((t) => `- ${t}`).join("\n"))}`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");
  pushChunks(g.characterId, parentKey, "nightly_diary", "일기", body);
};

const SEND_KIND_NAME: Record<string, string> = {
  morning: "아침 선톡",
  checkin: "안부 선톡",
};

const sendChild = (g: NightlyGathered, parentKey: string): void => {
  const rows = db
    .prepare(
      `SELECT window_start, window_end, text, kind FROM scheduled_messages
        WHERE character_id = ? AND date = ? ORDER BY id`,
    )
    .all(g.characterId, g.today) as {
    window_start: string;
    window_end: string;
    text: string;
    kind: string;
  }[];
  if (!rows.length) return;
  const body = rows
    .map((r) =>
      [
        `*${dateLabel(g.today)} ${SEND_KIND_NAME[r.kind] ?? `${r.kind} 선톡`} 문안* · 발송 창 ${r.window_start}~${r.window_end}`,
        quote(r.text),
      ].join("\n"),
    )
    .join("\n\n");
  pushChunks(g.characterId, parentKey, "nightly_send", "선톡 문안", body);
};

interface NightlyCallRow {
  id: number;
  purpose: string;
  model: string;
  attempt: number;
  system_hashes: string | null;
  turns_hash: string | null;
  output_hash: string | null;
  input_tokens: number | null;
  cache_write_tokens: number | null;
  cache_read_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  error: string | null;
  created_at: string;
}

const tokenLine = (row: NightlyCallRow): string | null => {
  const bits: string[] = [];
  if (row.input_tokens) bits.push(`입력 ${row.input_tokens.toLocaleString()}`);
  if (row.cache_write_tokens)
    bits.push(`캐시 쓰기 ${row.cache_write_tokens.toLocaleString()}`);
  if (row.cache_read_tokens)
    bits.push(`캐시 읽기 ${row.cache_read_tokens.toLocaleString()}`);
  if (row.output_tokens) bits.push(`출력 ${row.output_tokens.toLocaleString()}`);
  return bits.length ? `*토큰* ${bits.join(" · ")}` : null;
};

const systemText = (raw: string | null): string => {
  if (!raw) return "";
  try {
    const blocks = JSON.parse(raw) as { h: string }[];
    return blocks
      .map((b) => getBlob(b.h) ?? "")
      .filter(Boolean)
      .join("\n\n");
  } catch {
    return "";
  }
};

/**
 * 새벽 정리가 부른 호출의 원문을 스레드에 붙인다.
 * 생성은 반영 직전에 끝나므로 아직 안 올린 호출 중 시간 창 안의 것을 가져와 표시까지 한다
 * (한 자리에서 가져오고 표시해야 다른 틱과 같은 호출을 두고 다투지 않는다).
 * 외부 스케줄러 경로는 모델을 부르지 않으므로 붙을 호출이 없다.
 */
const callChildren = (g: NightlyGathered, parentKey: string): void => {
  const list = NIGHTLY_PURPOSES.map((p) => `'${p}'`).join(", ");
  const rows = db
    .prepare(
      `SELECT id, purpose, model, attempt, system_hashes, turns_hash, output_hash,
              input_tokens, cache_write_tokens, cache_read_tokens, output_tokens,
              latency_ms, error, created_at
         FROM llm_calls
        WHERE traced = 0 AND character_id = ? AND purpose IN (${list})
          AND created_at >= ?
        ORDER BY id`,
    )
    .all(g.characterId, stampMinusMs(CALL_WINDOW_MS)) as NightlyCallRow[];
  for (const row of rows) {
    const bits = [
      `호출 #${row.id}`,
      row.created_at.slice(11, 19),
      shortModel(row.model),
    ];
    if (row.attempt > 1) bits.push(`${row.attempt}번째 시도`);
    if (row.latency_ms) bits.push(`${(row.latency_ms / 1000).toFixed(1)}초`);
    const head = [
      `:brain: *${purposeName(row.purpose)}* · ${bits.join(" · ")}`,
      tokenLine(row),
      row.error ? `:x: ${esc(clip(row.error, 300))}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    recordTraceEvent({
      characterId: g.characterId,
      kind: `nightly_call_${row.purpose}`,
      parentKey,
      text: head,
    });
    const prompt = [
      systemText(row.system_hashes),
      row.turns_hash ? getBlob(row.turns_hash) : null,
    ]
      .filter(Boolean)
      .join("\n\n───\n\n");
    if (prompt)
      pushChunks(
        g.characterId,
        parentKey,
        "nightly_call_prompt",
        `호출 #${row.id} 프롬프트`,
        esc(prompt),
        true,
      );
    const output = row.output_hash ? getBlob(row.output_hash) : null;
    if (output)
      pushChunks(
        g.characterId,
        parentKey,
        "nightly_call_output",
        `호출 #${row.id} 출력`,
        esc(output),
        true,
      );
    db.prepare(`UPDATE llm_calls SET traced = 1 WHERE id = ?`).run(row.id);
  }
};

// ── 반영 뒤 게시 ────────────────────────────────────────────────────────

/**
 * 반영이 끝난 뒤 게시함에 쌓는다. 트랜잭션 바깥에서 부른다 —
 * 여기서 무슨 일이 나도 그날 새벽 정리는 이미 저장되어 있다.
 */
export const afterNightlyTrace = (
  g: NightlyGathered,
  out: NightlyOutput,
  snap: NightlySnapshot | null,
  result: string,
): void => {
  // skip은 아무것도 반영되지 않은 실행이다(그 날짜 일기가 이미 있음).
  if (!snap || !traceEnabled() || result.startsWith("skip:")) return;
  try {
    const parentKey = `nightly:${g.characterId}:${g.diaryDate}`;
    const after = getRelationship(g.characterId);
    const afterProfile = getUserProfile(g.chatId);
    db.transaction(() => {
      recordTraceEvent({
        characterId: g.characterId,
        kind: "nightly",
        dedupeKey: parentKey,
        threadKey: parentKey,
        text: headText(g, out, snap, after, afterProfile, result),
      });
      memoryChild(g, out, snap, parentKey);
      diaryChild(g, parentKey);
      sendChild(g, parentKey);
      callChildren(g, parentKey);
    })();
  } catch (err) {
    console.error("[trace] 새벽 정리 게시 준비 실패:", err);
  }
};
