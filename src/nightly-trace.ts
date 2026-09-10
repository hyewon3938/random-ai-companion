// 새벽 정리 트레이스 — 하루를 닫은 새벽 정리가 무엇을 바꿨는지 게시함에 쌓는다.
//
// 훅은 applyNightlyOutput 한 자리다. 봇 밖 스케줄러(tools/nightly-write)와 봇 안 폴백 크론이
// 둘 다 그 함수를 지나므로 한 곳이면 두 경로가 다 걸린다.
//
// 게시 기록은 반영 트랜잭션 바깥에서 남긴다 — 게시가 실패해도 새벽 정리는 되돌아가지 않는다.
// 바뀐 값은 이전 값 전문과 새 값 전문을 나란히 두지 않고, 전문 하나 안에서 빠진 말을 `[-…-]`,
// 더한 말을 `{+…+}`로 표시한다(trace/diff.ts, 이슈 #312). 그러려고 트랜잭션을 부르기 전에
// 출력이 쓸 키의 행을 미리 읽어 둔다.
//
//   본문   — 반영 요약, 그날 오늘 메모, 각본과 달라진 하루, 관계 갱신(바뀐 자리 표시),
//            관계 단계(문턱 조건별 값과 넘김 여부, 처음 확정과 취소, 오늘의 의도),
//            상대 프로필 갱신, 새 일정, 일정 시각 고침
//   스레드 — 기억 신규·덮어쓰기, 일기 전문, 오늘 선톡 문안과 발송 창, 새벽 정리가 부른 호출 원문
//   따로   — 단계가 오르면 stage_change, 처음이 확정·취소되거나 상대가 먼저 한 처음이 더해지면
//            first_event 게시가 스레드 밖에 한 건씩 나간다(relationship.md 「슬랙 게시」).
//
// 처음의 확정·취소는 트랜잭션이 돌려주지 않는다 — 수집이 넣어 둔 어제 후보(g.relation.firstsPending)와
// 반영 뒤 확정·미확정 행을 견줘 다시 센다. 단계도 반영 전 값을 스냅샷에 두고 뒤 값과 견준다.
//
// 게시를 위한 모델 호출은 없다. 전부 DB 값과 코드 계산이다.

import {
  db,
  getBlob,
  getConfirmedFirsts,
  getDiaryOn,
  getMemoryItemById,
  getRelationship,
  getScheduleById,
  getScheduledSendsOn,
  getStage,
  getTags,
  getUnconfirmedFirsts,
  getUserProfile,
  listMemoryItems,
  markLlmCallTraced,
  untracedCallsSince,
  type FirstRow,
  type MemoryRow,
  type RelationshipRow,
  type StageRow,
  type StoredUserProfile,
} from "./db.js";
import { recordTraceChunks, recordTraceEvent, traceEnabled } from "./trace.js";
import {
  clip,
  clock,
  dateLabel,
  esc,
  purposeName,
  quote,
  SEND_KIND_NAME,
  shortModel,
  tokenLine,
} from "./trace/format.js";
import {
  FIRST_BY_NAME,
  FIRST_KIND_NAME,
  INTEREST_NAME,
  MEMORY_ITEM_TYPE_NAME,
  MEMORY_OWNER_NAME,
  SPEECH_LEVEL_NAME,
  type FirstKind,
  type MemoryOrigin,
  type UserKnows,
} from "./labels.js";
import { intentSummary } from "./prompts/nightly.js";
import { wordDiff } from "./trace/diff.js";
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
  // 진행 반영 대상 행의 이전 값 — 반영 뒤에는 값이 바뀌고 끝난 것은 사실 행으로 옮겨져 번호가 바뀐다.
  progress: Map<number, { label: string; value: string }>;
  // 시각을 고칠 일정 줄의 이전 값 — 고친 뒤에는 앞의 시각이 남지 않는다.
  scheduleTimes: Map<
    number,
    { label: string; timeHint: string | null; userKnows: UserKnows }
  >;
  relationship: RelationshipRow | undefined;
  profile: StoredUserProfile;
  // 반영 전 단계 — 반영 뒤 값과 견줘 단계 전이 게시를 낸다.
  stage: StageRow | undefined;
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
    const progress = new Map<number, { label: string; value: string }>();
    for (const p of out.progress ?? []) {
      if (typeof p.id !== "number") continue;
      const r = getMemoryItemById(p.id);
      if (r)
        progress.set(p.id, {
          label: `${r.area}/${r.subject}`,
          value: r.value,
        });
    }
    const scheduleTimes = new Map<
      number,
      { label: string; timeHint: string | null; userKnows: UserKnows }
    >();
    for (const u of out.extract?.schedule_updates ?? []) {
      const id = Number(u?.id);
      if (!Number.isInteger(id) || id <= 0) continue;
      const r = getScheduleById(g.characterId, id);
      if (r)
        scheduleTimes.set(id, {
          label: `${r.date} ${r.content}`,
          timeHint: r.time_hint,
          userKnows: r.user_knows,
        });
    }
    return {
      memories,
      progress,
      scheduleTimes,
      relationship: getRelationship(g.characterId),
      profile: getUserProfile(g.chatId),
      stage: getStage(g.characterId),
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
  ["speech_note", "상대에게 쓰는 말투"],
  ["address_terms", "서로 부르는 말"],
  ["rapport", "잘 통하는 것"],
  ["cautions", "조심할 것"],
  ["history", "지나온 이야기"],
  ["feelings", "지금 마음"],
  ["user_state", "상대의 오늘 상태"],
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
    out.push([`*${name}*`, `> ${esc(wordDiff(b, a))}`].join("\n"));
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
    out.push([`*${name}*`, `> ${esc(wordDiff(b, a))}`].join("\n"));
  }
  return out;
};

// ── 관계 단계 ────────────────────────────────────────────────────────────

interface FirstChanges {
  confirmed: FirstRow[];
  cancelled: FirstKind[];
  userAdded: FirstRow[];
}

/** 반영 뒤 확정·미확정 행을 어제 후보와 견줘 무엇이 확정되고 취소됐는지 센다. 상대가 먼저 한
 * 처음은 후보에도 이미 한 처음에도 없던 종류가 유저 쪽으로 확정된 것이다. */
const firstChangesOf = (g: NightlyGathered): FirstChanges => {
  const confirmedRows = getConfirmedFirsts(g.characterId);
  const unconfirmedIds = new Set(
    getUnconfirmedFirsts(g.characterId).map((r) => r.id),
  );
  const confirmed: FirstRow[] = [];
  const cancelled: FirstKind[] = [];
  for (const p of g.relation.firstsPending) {
    const row = confirmedRows.find((r) => r.id === p.id);
    if (row) confirmed.push(row);
    else if (!unconfirmedIds.has(p.id)) cancelled.push(p.kind);
  }
  const before = new Set<FirstKind>([
    ...g.relation.firstsDone.map((f) => f.kind),
    ...g.relation.firstsPending.map((f) => f.kind),
  ]);
  const userAdded = confirmedRows.filter(
    (r) => r.by === "user" && !before.has(r.kind),
  );
  return { confirmed, cancelled, userAdded };
};

const firstLabel = (r: FirstRow): string =>
  `${FIRST_KIND_NAME[r.kind]} · ${FIRST_BY_NAME[r.by]} · ${r.happened_at.slice(5, 16)}${
    r.message_id ? ` · 메시지 #${r.message_id}` : ""
  }`;

const conditionLines = (g: NightlyGathered): string[] =>
  g.relation.threshold.conditions.map((c) => {
    const v =
      c.value === null
        ? "표본 없음"
        : typeof c.value === "boolean"
          ? c.value
            ? "있음"
            : "없음"
          : String(c.value);
    const need = typeof c.need === "boolean" ? "있음" : String(c.need);
    return `${c.name} ${v}/${need} ${c.met ? "찼음" : "안 찼음"}`;
  });

/** 본문의 관계 단계 절. 단계와 문턱은 늘 적고, 넘김·처음·의도는 그 회차에 있을 때만 적는다. */
const relationStageBlock = (
  g: NightlyGathered,
  out: NightlyOutput,
  snap: NightlySnapshot,
  afterStage: StageRow | undefined,
  firsts: FirstChanges,
): string => {
  const r = g.relation;
  const t = r.threshold;
  const lines: string[] = [
    `> ${r.stageNo}단계 ${r.stageSince}부터 ${r.stayDays}일 · 다음 문턱 ${
      t.to === null ? "없음(마지막 단계)" : `${t.from}→${t.to} ${t.met ? "찼음" : "안 찼음"}`
    }`,
  ];
  const conds = conditionLines(g);
  if (conds.length) lines.push(`> 조건: ${esc(conds.join(" · "))}`);
  const adv = out.extract?.relation?.advance;
  if (adv)
    lines.push(
      `> 넘김 판단: ${adv.go === true ? "넘긴다" : "아직"}${adv.basis ? ` — ${esc(adv.basis)}` : ""}`,
    );
  if (snap.stage && afterStage && afterStage.stage_no > snap.stage.stage_no)
    lines.push(`> *단계 전이* ${snap.stage.stage_no}단계 → ${afterStage.stage_no}단계`);
  else if (adv?.go === true)
    lines.push(`> 단계는 그대로 — 반영 자리가 건너뜀`);
  if (firsts.confirmed.length)
    lines.push(`> 처음 확정: ${esc(firsts.confirmed.map(firstLabel).join(" / "))}`);
  if (firsts.cancelled.length)
    lines.push(`> 처음 취소: ${esc(firsts.cancelled.map((k) => FIRST_KIND_NAME[k]).join(" / "))}`);
  if (firsts.userAdded.length)
    lines.push(`> 상대가 먼저 한 처음: ${esc(firsts.userAdded.map(firstLabel).join(" / "))}`);
  if (r.confessionDue) lines.push(`> 고백 차례 — 오늘 의도에 마음 확인을 넣는 날`);
  const intent = out.extract?.relation?.intent;
  const summary = intentSummary(intent);
  if (summary) {
    lines.push(`> 오늘 의도: ${esc(summary)}`);
    if (intent?.basis && typeof intent.basis === "object") {
      const basis = Object.entries(intent.basis)
        .filter(([, v]) => typeof v === "string" && v)
        .map(([k, v]) => `${k}=${v}`)
        .join(" · ");
      if (basis) lines.push(`> 의도 근거: ${esc(basis)}`);
    }
  }
  return [`*관계 단계*`, ...lines].join("\n");
};

/** 단계가 올랐으면 스레드 밖에 게시 한 건. 같은 단계로 두 번 나가지 않는다. */
const stageChangeEvent = (
  g: NightlyGathered,
  out: NightlyOutput,
  snap: NightlySnapshot,
  afterStage: StageRow | undefined,
): void => {
  if (!snap.stage || !afterStage || afterStage.stage_no <= snap.stage.stage_no)
    return;
  const basis = out.extract?.relation?.advance?.basis;
  recordTraceEvent({
    characterId: g.characterId,
    kind: "stage_change",
    dedupeKey: `stage:${g.characterId}:${afterStage.stage_no}`,
    text: [
      `:arrow_up: *단계 전이* ${snap.stage.stage_no}단계 → ${afterStage.stage_no}단계 · ${clock()}`,
      `> ${snap.stage.stage_no}단계에 ${g.relation.stageSince}부터 ${g.relation.stayDays}일 머묾`,
      `> 조건: ${esc(conditionLines(g).join(" · ") || "없음")}`,
      basis ? `> 근거: ${esc(basis)}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  });
};

/** 처음의 확정·취소·상대가 먼저 한 처음마다 스레드 밖에 게시 한 건. */
const firstEvents = (g: NightlyGathered, firsts: FirstChanges): void => {
  const key = (kind: FirstKind, what: string): string =>
    `first:${g.characterId}:${kind}:${g.diaryDate}:${what}`;
  for (const r of firsts.confirmed)
    recordTraceEvent({
      characterId: g.characterId,
      kind: "first_event",
      dedupeKey: key(r.kind, "confirm"),
      text: `:sparkles: *처음 확정* ${esc(firstLabel(r))} · 확정됨`,
    });
  for (const k of firsts.cancelled)
    recordTraceEvent({
      characterId: g.characterId,
      kind: "first_event",
      dedupeKey: key(k, "cancel"),
      text: `:leftwards_arrow_with_hook: *처음 취소* ${FIRST_KIND_NAME[k]} · 답장이 표시했지만 대화를 읽어 보니 그 처음이 아니었다`,
    });
  for (const r of firsts.userAdded)
    recordTraceEvent({
      characterId: g.characterId,
      kind: "first_event",
      dedupeKey: key(r.kind, "user"),
      text: `:sparkles: *처음 확정* ${esc(firstLabel(r))} · 상대가 먼저 한 것을 새벽 정리가 더함`,
    });
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
  afterStage: StageRow | undefined,
  firsts: FirstChanges,
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
  parts.push(relationStageBlock(g, out, snap, afterStage, firsts));
  const prof = profileBlocks(snap.profile, afterProfile);
  if (prof.length)
    parts.push([`*상대 프로필 갱신* ${prof.length}항목`, ...prof].join("\n"));
  const schedules = (out.extract?.schedules ?? [])
    .filter((s) => s.date && s.content)
    .map(
      (s) =>
        // 태그는 붙지 않은 날도 적는다 — 나중에 이 일정을 주제로 꺼낼 수 있는지가 화면에 그대로 보인다.
        `${s.date}${s.time_hint ? ` ${s.time_hint}` : ""} · ${s.content} (${s.who === "user" ? "유저" : "캐릭터"} 쪽) · 태그 ${
          (Array.isArray(s.tags) ? s.tags : []).filter(Boolean).join("·") ||
          "없음"
        }`,
    );
  const sched = listSection("새 일정", schedules);
  if (sched) parts.push(sched);
  // 이전 값이 없는 번호는 반영 자리에서 걸러진 것이다(남의 캐릭터·없는 줄·접힌 일정).
  const timeFixes = (out.extract?.schedule_updates ?? [])
    .filter((u) => Number.isInteger(Number(u?.id)) && u?.time_hint?.trim())
    .map((u) => {
      const before = snap.scheduleTimes.get(Number(u.id));
      if (!before) return `[${u.id}] 반영 대상이 아니라 건너뜀`;
      return `${before.label} · ${before.timeHint ?? "시각 없음"} → ${u.time_hint?.trim()}`;
    });
  const times = listSection("일정 시각 고침", timeFixes);
  if (times) parts.push(times);
  // 이미 [상대가 앎]이던 줄은 바뀐 것이 없어 반영 자리가 건너뛴다. 게시도 같게 적는다.
  const knownFixes = (out.extract?.schedule_updates ?? [])
    .filter((u) => Number.isInteger(Number(u?.id)) && u?.user_knows === "known")
    .map((u) => {
      const before = snap.scheduleTimes.get(Number(u.id));
      if (!before) return `[${u.id}] 반영 대상이 아니라 건너뜀`;
      return before.userKnows === "known"
        ? `${before.label} · 이미 상대가 아는 일정`
        : `${before.label} · 상대는 모름 → 상대가 앎`;
    });
  const knowns = listSection("상대에게 말한 일정", knownFixes);
  if (knowns) parts.push(knowns);
  return parts.join("\n\n");
};

// ── 스레드 ──────────────────────────────────────────────────────────────

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
          // 생성 행만 있던 키면 이번에 처음 대화 쪽 행이 생긴다 — 이전 값의 출처를 밝힌다.
          `～ *${esc(memLabel(m))}*${prev.origin === "creation" ? " (생성 때 값을 덮음)" : ""}`,
          `> ${esc(wordDiff(clip(prev.value, 400), clip(m.value, 400)))}`,
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
  recordTraceChunks(g.characterId, parentKey, "nightly_memory", "기억", body);
};

// 진행 중인 일의 어제 몫 — 이전 값과 새 값을 나란히, 끝난 것은 사실로 옮겼다고 적는다.
// 이전 값이 없는 번호는 반영 자리에서 걸러진 것이라(남의 행·사실 행) 그대로 표시한다.
const progressChild = (
  g: NightlyGathered,
  out: NightlyOutput,
  snap: NightlySnapshot,
  parentKey: string,
): void => {
  const items = (out.progress ?? []).filter(
    (p) => typeof p.id === "number" && p.value?.trim(),
  );
  if (!items.length) return;
  const lines = items.map((p) => {
    const before = snap.progress.get(p.id);
    if (!before) return `:warning: [${p.id}] 반영 대상이 아니라 건너뜀`;
    return [
      `*${esc(before.label)}*${p.done ? " · 끝나서 사실로 옮김" : ""}`,
      esc(wordDiff(before.value, p.value.trim())),
    ].join("\n");
  });
  recordTraceChunks(
    g.characterId,
    parentKey,
    "nightly_progress",
    "진행 중인 일",
    lines.join("\n\n"),
  );
};

const diaryChild = (g: NightlyGathered, parentKey: string): void => {
  const row = getDiaryOn(g.characterId, g.diaryDate);
  if (!row) return;
  let e: DiaryOutput;
  try {
    e = JSON.parse(row.entry_json) as DiaryOutput;
  } catch {
    return;
  }
  const tags = getTags("diary", row.id);
  const diaryTagLine = tags.length ? esc(tags.join(", ")) : "없음";
  const body = [
    `*${dateLabel(g.diaryDate)} 일기*`,
    quote(e.diary ?? ""),
    e.plan_vs_actual ? `*각본 대비*\n${quote(e.plan_vs_actual)}` : null,
    e.user_mood ? `*유저 기분*\n${quote(e.user_mood)}` : null,
    e.closeness ? `*가까움*\n${quote(e.closeness)}` : null,
    e.tomorrow?.length
      ? `*내일 챙길 것*\n${quote(e.tomorrow.map((t) => `- ${t}`).join("\n"))}`
      : null,
    // 붙지 않은 날도 적는다 — 나중에 이 일기를 태그로 꺼낼 수 있는지가 이 줄에 달렸다.
    `*태그* ${diaryTagLine}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  recordTraceChunks(g.characterId, parentKey, "nightly_diary", "일기", body);
};

const sendChild = (g: NightlyGathered, parentKey: string): void => {
  const rows = getScheduledSendsOn(g.characterId, g.today);
  if (!rows.length) return;
  const body = rows
    .map((r) =>
      [
        `*${dateLabel(g.today)} ${SEND_KIND_NAME[r.kind] ?? `${r.kind} 선톡`} 문안* · 발송 창 ${r.window_start}~${r.window_end}`,
        quote(r.text),
      ].join("\n"),
    )
    .join("\n\n");
  recordTraceChunks(g.characterId, parentKey, "nightly_send", "선톡 문안", body);
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
  const rows = untracedCallsSince(
    g.characterId,
    NIGHTLY_PURPOSES,
    stampMinusMs(CALL_WINDOW_MS),
  );
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
      recordTraceChunks(
        g.characterId,
        parentKey,
        "nightly_call_prompt",
        `호출 #${row.id} 프롬프트`,
        esc(prompt),
        true,
      );
    const output = row.output_hash ? getBlob(row.output_hash) : null;
    if (output)
      recordTraceChunks(
        g.characterId,
        parentKey,
        "nightly_call_output",
        `호출 #${row.id} 출력`,
        esc(output),
        true,
      );
    markLlmCallTraced(row.id);
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
    const afterStage = getStage(g.characterId);
    const firsts = firstChangesOf(g);
    db.transaction(() => {
      recordTraceEvent({
        characterId: g.characterId,
        kind: "nightly",
        dedupeKey: parentKey,
        threadKey: parentKey,
        text: headText(g, out, snap, after, afterProfile, result, afterStage, firsts),
      });
      memoryChild(g, out, snap, parentKey);
      progressChild(g, out, snap, parentKey);
      diaryChild(g, parentKey);
      sendChild(g, parentKey);
      callChildren(g, parentKey);
      stageChangeEvent(g, out, snap, afterStage);
      firstEvents(g, firsts);
    })();
  } catch (err) {
    console.error("[trace] 새벽 정리 게시 준비 실패:", err);
  }
};
