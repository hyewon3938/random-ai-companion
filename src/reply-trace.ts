// 답장 트레이스 — 답장 한 건이 무엇을 보고 나왔는지 슬랙 채널에 올린다.
//
// 게시 재료는 llm_calls·prompt_blobs를 읽어 만든다. 답장 경로에 게시 훅을 새로 달지 않는다 —
// 호출 원문이 이미 남으므로 읽는 쪽만 있으면 되고, 답장 파이프라인 안에 게시 코드가 끼면
// 게시 실패가 답장을 막을 자리가 생긴다.
//
// 한 건이 채널에 남기는 것:
//   본문   — 무슨 말에 답했는지, 텀이 어떻게 나왔는지, 무엇을 검색해 넣었는지,
//            모델이 뭐라고 썼고 다듬기가 뭘 고쳤는지
//   스레드 — 그 호출의 실시간 꼬리 전문(호출마다 달라지는 부분)
//   스레드 — 발송·폐기 결과(pending.ts가 그때 쌓는다)
// 하루 종일 같은 앞 두 층은 그날 첫 호출에서 한 번만 올리고, 일간층이 바뀌면 바뀐 줄만 올린다.
//
// 새벽 정리 쪽 호출(diary·extract·arc·day_plan·life_plan)은 여기서 건너뛴다 —
// 구간 3이 이전 값과 함께 올린다. 두 곳이 같은 호출을 올리면 채널이 두 벌로 찬다.

import { db, getBlob } from "./db.js";
import {
  chunked,
  dateLabel,
  esc,
  hasTraceEvent,
  recordTraceEvent,
  traceEnabled,
} from "./trace.js";
import {
  ACTIVITY_CATEGORY_NAME,
  CALL_PURPOSE_NAME,
  RESPONSIVENESS_NAME,
  toActivityCategory,
  toResponsiveness,
  type CallPurpose,
} from "./labels.js";
import { getKstNow, logicalDateOf } from "./kst.js";

// 한 틱에 준비하는 호출 수. 슬랙 발송은 게시함이 따로 조절하므로 여기서는 읽기 상한만 둔다.
const BATCH = 20;
// 판단 근거(context_json)가 붙기를 기다리는 시간. 답장은 행이 먼저 생기고 근거가 나중에 붙는다.
const CONTEXT_GRACE_MS = 5 * 60_000;
// 이보다 오래된 호출은 올리지 않고 표시만 한다 — 토큰을 뒤늦게 넣거나 오래 멈춰 있었을 때
// 지난 기록이 한꺼번에 채널로 쏟아지지 않게.
const MAX_AGE_MS = 3 * 3600_000;

/** 올리는 호출. 답장·붙잡기 판정·선톡 문안. */
const POST_PURPOSES = [
  "reply",
  "hold",
  "morning",
  "lunch",
  "reconnect",
  "catchup",
  "goodnight",
  "away",
  "comeback",
] as const;

// 3층 프롬프트를 타는 호출 — 하루 고정 두 덩이를 여기서만 견준다.
// 붙잡기 판정은 짧은 시스템 문장 한 덩이라 섞이면 매번 바뀐 것으로 보인다.
const LAYERED = new Set<string>(
  POST_PURPOSES.filter((p) => p !== "hold"),
);

const sqlList = (xs: readonly string[]): string =>
  xs.map((x) => `'${x}'`).join(", ");

interface CallRow {
  id: number;
  character_id: number | null;
  chat_id: string | null;
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
  context_json: string | null;
  created_at: string;
}

interface BlockHash {
  h: string;
  cache?: boolean;
}

// 답장 호출에 붙는 판단 근거(bot.ts attach)의 모양. 없는 값이 많아 전부 옵셔널이다.
interface CallContext {
  timing?: {
    waitMs?: number;
    path?: string;
    block?: {
      start: string;
      end: string;
      activity: string;
      responsiveness: string;
      category: string;
    } | null;
    asked?: boolean;
    heldJudged?: boolean;
    held?: { outcome: string; activity: string } | null;
  };
  gathered?: { activity?: string; blockStart?: string | null };
  search?: {
    tags?: string[];
    memories?: string[];
    oldDiaries?: string[];
    dropped?: string[];
  };
  turns?: number;
  stay?: boolean;
  note?: string | null;
  bubbles?: number;
  bubbleLens?: number[];
  polished?: ({ before: string; after: string } | null)[];
  dropped?: string;
}

const PATH_NAME: Record<string, string> = {
  no_plan: "각본 없음",
  sleeping: "자다 깸",
  already_held: "이미 접어 둔 상태",
  table: "표",
  until_end: "구간 끝",
  held: "붙잡혀 접음",
  recover: "복구 발송",
};

const SEND_KIND_NAME: Record<string, string> = {
  morning: "아침 선톡",
  checkin: "안부 선톡",
  catchup: "근황 선톡",
  goodnight: "밤 인사 선톡",
  away: "자리비움 선톡",
};

const purposeName = (p: string): string =>
  p in CALL_PURPOSE_NAME ? CALL_PURPOSE_NAME[p as CallPurpose] : p;

const epochOf = (ts: string): number =>
  new Date(ts.replace(" ", "T") + "+09:00").getTime();

const clock = (): string => getKstNow().toISOString().slice(11, 19);

const callKey = (id: number): string => `call:${id}`;

const parseHashes = (raw: string | null): BlockHash[] => {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as BlockHash[]) : [];
  } catch {
    return [];
  }
};

const parseContext = (raw: string | null): CallContext | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CallContext;
  } catch {
    return null;
  }
};

const clip = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n)}… (${s.length}자)`;

const quote = (s: string): string =>
  s
    .split("\n")
    .map((l) => `> ${esc(l)}`)
    .join("\n");

const fmtWait = (ms: number): string => {
  if (ms < 1000) return "바로";
  if (ms < 60_000) return `${Math.round(ms / 1000)}초`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m}분 ${s}초` : `${m}분`;
};

const shortModel = (m: string): string => m.replace(/^claude-/, "");

// 대화 기록은 통째로 올리지 않는다 — 그날 나눈 말이 다 들어 있고, 이미 텔레그램에 있다.
// 이번에 답한 말 한 마디만 꺼낸다.
const lastUserTurn = (hash: string | null): string | null => {
  if (!hash) return null;
  const turns = getBlob(hash);
  if (!turns) return null;
  const at = turns.lastIndexOf("\n[user] ");
  const seg =
    at >= 0
      ? turns.slice(at + "\n[user] ".length)
      : turns.startsWith("[user] ")
        ? turns.slice("[user] ".length)
        : null;
  if (seg === null) return null;
  // 뒤에 다른 차례가 이어지면 거기서 끊는다(마지막 차례가 유저가 아닐 때).
  const next = seg.search(/\n\[(user|assistant)\] /);
  return (next >= 0 ? seg.slice(0, next) : seg).trim() || null;
};

const tokenLine = (row: CallRow): string | null => {
  const bits: string[] = [];
  if (row.input_tokens) bits.push(`입력 ${row.input_tokens.toLocaleString()}`);
  if (row.cache_write_tokens)
    bits.push(`캐시 쓰기 ${row.cache_write_tokens.toLocaleString()}`);
  if (row.cache_read_tokens)
    bits.push(`캐시 읽기 ${row.cache_read_tokens.toLocaleString()}`);
  if (row.output_tokens) bits.push(`출력 ${row.output_tokens.toLocaleString()}`);
  return bits.length ? `*토큰* ${bits.join(" · ")}` : null;
};

const headLine = (row: CallRow, icon: string, label: string): string => {
  const bits = [
    `호출 #${row.id}`,
    row.created_at.slice(11, 19),
    shortModel(row.model),
  ];
  if (row.attempt > 1) bits.push(`${row.attempt}번째 시도`);
  if (row.latency_ms) bits.push(`${(row.latency_ms / 1000).toFixed(1)}초`);
  return `${icon} *${label}* · ${bits.join(" · ")}`;
};

const timingLines = (ctx: CallContext): string[] => {
  const t = ctx.timing;
  if (!t) {
    if (!ctx.gathered) return [];
    const activity = ctx.gathered.activity ?? "하던 일";
    return [`*텀* 몰아 답장 — ${esc(activity)} 구간이 끝나 바로 보냈다`];
  }
  const bits = [`${fmtWait(t.waitMs ?? 0)} 뒤`];
  if (t.path) bits.push(PATH_NAME[t.path] ?? t.path);
  if (t.block) {
    const r = toResponsiveness(t.block.responsiveness);
    const c = toActivityCategory(t.block.category);
    const resp = r ? RESPONSIVENESS_NAME[r] : t.block.responsiveness;
    const cat = c ? ACTIVITY_CATEGORY_NAME[c] : t.block.category;
    bits.push(
      `${t.block.start}~${t.block.end} ${t.block.activity} [${resp}/${cat}]`,
    );
  }
  if (t.asked) bits.push(`붙잡기 판정 ${t.heldJudged ? "붙잡음" : "아님"}`);
  if (t.held) bits.push(`일정 ${t.held.outcome}`);
  return [`*텀* ${esc(bits.join(" · "))}`];
};

const searchLines = (ctx: CallContext): string[] => {
  const s = ctx.search;
  if (!s) return [];
  const bits = [s.tags?.length ? `태그 ${s.tags.join("·")}` : "태그 없음"];
  if (s.memories?.length)
    bits.push(`기억 ${s.memories.length}건 — ${s.memories.join(" / ")}`);
  if (s.oldDiaries?.length) bits.push(`옛 일기 ${s.oldDiaries.join("·")}`);
  if (s.dropped?.length)
    bits.push(`개수 상한에 걸려 빠짐 ${s.dropped.length}건 — ${s.dropped.join(" / ")}`);
  return [`*검색* ${esc(bits.join(" · "))}`];
};

const outcomeLines = (ctx: CallContext): string[] => {
  const out: string[] = [];
  if (ctx.polished?.length) {
    const fixed = ctx.polished.filter(
      (p): p is { before: string; after: string } => Boolean(p),
    );
    for (const p of fixed)
      out.push(`*다듬기* ${esc(clip(p.before, 120))} → ${esc(clip(p.after, 120))}`);
  }
  if (ctx.bubbles)
    out.push(
      `*보낸 말* 말풍선 ${ctx.bubbles}개${ctx.bubbleLens?.length ? ` (${ctx.bubbleLens.join("·")}자)` : ""}`,
    );
  if (ctx.stay) out.push("*[남음]* 일정을 접고 곁에 남기로 했다");
  if (ctx.note) out.push(`*[메모]* ${esc(clip(ctx.note, 200))}`);
  if (ctx.dropped) out.push(`:wastebasket: *폐기* ${esc(ctx.dropped)}`);
  return out;
};

const renderReply = (row: CallRow, ctx: CallContext | null): string => {
  const lines = [headLine(row, ":speech_balloon:", "답장")];
  const asked = lastUserTurn(row.turns_hash);
  if (asked) lines.push(quote(clip(asked, 300)));
  if (ctx) {
    lines.push(...timingLines(ctx), ...searchLines(ctx));
  } else {
    lines.push("_판단 근거가 붙지 않았다 — 생성 도중 끊겼을 수 있다._");
  }
  const output = row.output_hash ? getBlob(row.output_hash) : null;
  if (output) lines.push("*모델이 쓴 답*", quote(clip(output, 700)));
  if (row.error) lines.push(`:x: *호출 실패* ${esc(row.error)}`);
  if (ctx) lines.push(...outcomeLines(ctx));
  const tokens = tokenLine(row);
  if (tokens) lines.push(tokens);
  return lines.join("\n");
};

const renderHold = (row: CallRow): string => {
  const lines = [headLine(row, ":mag:", "붙잡기 판정")];
  const prompt = row.turns_hash ? getBlob(row.turns_hash) : null;
  if (prompt)
    lines.push(
      quote(clip(prompt.replaceAll("[user] ", ""), 400)),
    );
  const out = row.output_hash ? getBlob(row.output_hash) : null;
  lines.push(`*판정* ${out ? esc(out.trim()) : "(없음)"}`);
  if (row.error) lines.push(`:x: *호출 실패* ${esc(row.error)} — 일정을 그대로 둔다`);
  return lines.join("\n");
};

const renderDraft = (row: CallRow): string => {
  const name = purposeName(row.purpose);
  const lines = [headLine(row, ":memo:", `${name} 문안`)];
  const raw = row.output_hash ? getBlob(row.output_hash) : null;
  if (raw) {
    let shown = false;
    try {
      const v = JSON.parse(raw) as { send?: boolean; text?: string };
      if (typeof v.send === "boolean") {
        lines.push(`*보낼까* ${v.send ? "보낸다" : "접는다"}`);
        if (v.text) lines.push(quote(clip(v.text, 500)));
        shown = true;
      }
    } catch {
      /* JSON이 아니면 원문 그대로 */
    }
    if (!shown) lines.push(quote(clip(raw, 500)));
  }
  if (row.error) lines.push(`:x: *호출 실패* ${esc(row.error)}`);
  const tokens = tokenLine(row);
  if (tokens) lines.push(tokens);
  return lines.join("\n");
};

// ── 하루 고정 두 덩이 ───────────────────────────────────────────────────

const LAYER_NAME = ["불변층", "일간층"] as const;
const LAYER_KEY = ["fixed", "daily"] as const;

const prevLayeredCall = (row: CallRow): CallRow | undefined =>
  db
    .prepare(
      `SELECT * FROM llm_calls
        WHERE id < ? AND character_id IS ? AND system_hashes IS NOT NULL
          AND purpose IN (${sqlList([...LAYERED])})
        ORDER BY id DESC LIMIT 1`,
    )
    .get(row.id, row.character_id) as CallRow | undefined;

const postFullLayers = (
  row: CallRow,
  hashes: BlockHash[],
  date: string,
): void => {
  const key = `prompt_full:${row.character_id ?? 0}:${date}`;
  if (hasTraceEvent(key)) return;
  const bodies = [getBlob(hashes[0].h), getBlob(hashes[1].h)];
  const sizes = bodies.map((b, i) =>
    b ? `${LAYER_NAME[i]} ${b.length.toLocaleString()}자` : `${LAYER_NAME[i]} 본문 없음`,
  );
  db.transaction(() => {
    recordTraceEvent({
      characterId: row.character_id ?? undefined,
      kind: "prompt_day",
      dedupeKey: key,
      threadKey: key,
      text: [
        `:page_facing_up: *${dateLabel(date)} 프롬프트 고정 두 덩이* — 호출 #${row.id}부터 이 내용으로 답한다`,
        `${sizes.join(" · ")} · 캐시 경계 뒤로 하루 종일 재사용된다`,
      ].join("\n"),
    });
    bodies.forEach((body, i) => {
      if (!body) return;
      const parts = chunked(esc(body));
      parts.forEach((p, j) => {
        const label =
          parts.length > 1
            ? `${LAYER_NAME[i]} (${j + 1}/${parts.length})`
            : LAYER_NAME[i];
        recordTraceEvent({
          characterId: row.character_id ?? undefined,
          kind: "prompt_day_body",
          parentKey: key,
          text: `${label}\n\`\`\`\n${p}\n\`\`\``,
        });
      });
    });
  })();
};

/** 줄 단위 차이. 같은 줄은 빼고 사라진 줄·생긴 줄만 남긴다. */
export const lineDiff = (
  before: string,
  after: string,
  maxLines = 60,
): string => {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 250_000)
    return `(줄 수 ${a.length} → ${b.length} — 너무 커서 줄 단위 비교는 생략)`;
  const w = b.length + 1;
  const dp = new Int32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  if (!out.length) return "(줄 단위로는 같다 — 공백만 바뀌었다)";
  return out.length > maxLines
    ? [...out.slice(0, maxLines), `… ${out.length - maxLines}줄 더`].join("\n")
    : out.join("\n");
};

const postLayerChange = (
  row: CallRow,
  layer: 0 | 1,
  oldHash: string,
  newHash: string,
): void => {
  const key = `prompt_change:${row.character_id ?? 0}:${LAYER_KEY[layer]}:${newHash}`;
  if (hasTraceEvent(key)) return;
  const before = getBlob(oldHash);
  const after = getBlob(newHash);
  const body = after
    ? before
      ? lineDiff(before, after)
      : `(이전 본문이 보관 기간이 지나 없다 — 지금 내용 ${after.length.toLocaleString()}자)`
    : "(본문 없음)";
  db.transaction(() => {
    recordTraceEvent({
      characterId: row.character_id ?? undefined,
      kind: "prompt_change",
      dedupeKey: key,
      threadKey: key,
      text: `:pencil2: *${LAYER_NAME[layer]}이 바뀌었다* — ${row.created_at.slice(11, 16)} 호출 #${row.id}부터`,
    });
    for (const part of chunked(esc(body)))
      recordTraceEvent({
        characterId: row.character_id ?? undefined,
        kind: "prompt_change_body",
        parentKey: key,
        text: `\`\`\`\n${part}\n\`\`\``,
      });
  })();
};

// 그날 첫 호출이면 두 덩이를 통째로, 그 뒤에 달라지면 바뀐 줄만 올린다.
// 어디까지 올렸는지는 따로 표시하지 않고 앞 호출의 해시와 견준다 — 게시함의 dedupe_key가
// 두 번 올리는 것을 막아 준다.
const ensureDayPrompt = (row: CallRow, hashes: BlockHash[]): void => {
  const date = logicalDateOf(row.created_at);
  const prev = prevLayeredCall(row);
  const prevHashes = prev ? parseHashes(prev.system_hashes) : [];
  const sameDay =
    prev && prevHashes.length >= 3 && logicalDateOf(prev.created_at) === date;
  if (!sameDay) {
    postFullLayers(row, hashes, date);
    return;
  }
  for (const layer of [0, 1] as const)
    if (hashes[layer].h !== prevHashes[layer].h)
      postLayerChange(row, layer, prevHashes[layer].h, hashes[layer].h);
};

// ── 게시함에 쌓기 ───────────────────────────────────────────────────────

const postCall = (row: CallRow): void => {
  const hashes = parseHashes(row.system_hashes);
  if (LAYERED.has(row.purpose) && hashes.length >= 3) {
    try {
      ensureDayPrompt(row, hashes);
    } catch (err) {
      console.error("[trace] 고정 두 덩이 게시 준비 실패:", err);
    }
  }
  const ctx = parseContext(row.context_json);
  const body =
    row.purpose === "reply"
      ? renderReply(row, ctx)
      : row.purpose === "hold"
        ? renderHold(row)
        : renderDraft(row);
  const key = callKey(row.id);
  db.transaction(() => {
    recordTraceEvent({
      characterId: row.character_id ?? undefined,
      kind: `call_${row.purpose}`,
      dedupeKey: key,
      threadKey: key,
      text: body,
    });
    // 실시간 꼬리 — 호출마다 달라지는 부분이라 전문을 스레드에 붙인다.
    // 앞 두 층은 하루 한 번만 올리므로 여기서 되풀이하지 않는다.
    const tail = hashes.length >= 3 ? getBlob(hashes[hashes.length - 1].h) : null;
    if (!tail) return;
    const parts = chunked(esc(tail));
    parts.forEach((p, i) => {
      const label =
        parts.length > 1 ? `실시간 꼬리 (${i + 1}/${parts.length})` : "실시간 꼬리";
      recordTraceEvent({
        characterId: row.character_id ?? undefined,
        kind: "call_tail",
        parentKey: key,
        text: `${label}\n\`\`\`\n${p}\n\`\`\``,
      });
    });
  })();
};

const markTraced = (id: number): void => {
  db.prepare(`UPDATE llm_calls SET traced = 1 WHERE id = ?`).run(id);
};

/** 1분 틱. 아직 안 올린 호출을 번호 순서대로 게시함에 쌓는다. */
export const enqueueReplyTraces = (): void => {
  if (!traceEnabled()) return;
  const rows = db
    .prepare(
      `SELECT * FROM llm_calls
        WHERE traced = 0 AND purpose IN (${sqlList(POST_PURPOSES)})
        ORDER BY id LIMIT ?`,
    )
    .all(BATCH) as CallRow[];
  for (const row of rows) {
    const age = Date.now() - epochOf(row.created_at);
    // 판단 근거는 호출 행이 만들어진 뒤에 붙는다. 아직이면 다음 틱에 —
    // 건너뛰지 않고 멈춘다. 뒤 호출을 먼저 올리면 채널 순서가 호출 순서와 어긋난다.
    if (row.purpose === "reply" && !row.context_json && age < CONTEXT_GRACE_MS)
      break;
    if (age > MAX_AGE_MS) {
      markTraced(row.id);
      continue;
    }
    try {
      postCall(row);
    } catch (err) {
      console.error(`[trace] 호출 #${row.id} 게시 준비 실패:`, err);
    }
    markTraced(row.id);
  }
};

// ── 답장이 어떻게 끝났는지 ──────────────────────────────────────────────

/**
 * 만들어 둔 답장의 발송·폐기 결과를 그 답장 스레드에 단다(pending.ts가 부른다).
 * 답장을 만든 호출 번호를 모르면(복구 발송·깨우기 표시) 올리지 않는다.
 */
export const traceReplyOutcome = (p: {
  callId: number | null;
  outcome: "sent" | "failed" | "superseded";
  detail?: string;
}): void => {
  if (!traceEnabled() || !p.callId) return;
  const parentKey = callKey(p.callId);
  const head =
    p.outcome === "sent"
      ? `:outbox_tray: 발송 ${clock()}`
      : p.outcome === "failed"
        ? `:x: 발송 포기 ${clock()}`
        : `:wastebasket: 폐기 ${clock()}`;
  recordTraceEvent({
    kind: `reply_${p.outcome}`,
    dedupeKey: `${parentKey}:${p.outcome}`,
    parentKey,
    text: p.detail ? `${head} — ${esc(p.detail)}` : head,
  });
};

/**
 * 선톡이 실제로 나간 자리(bot.ts sendProactive).
 * 아침·안부는 전날 밤에 만든 문안이라 문안 호출과 발송이 몇 시간 떨어져 있다 —
 * 스레드로 잇지 않고 독립 행으로 둔다.
 */
export const traceProactiveSend = (p: {
  characterId: number;
  kind: string;
  text: string;
  delivered: number;
  total: number;
}): void => {
  if (!traceEnabled()) return;
  const name = SEND_KIND_NAME[p.kind] ?? `${p.kind} 선톡`;
  const partial = p.delivered < p.total ? ` (${p.delivered}/${p.total}만 나감)` : "";
  recordTraceEvent({
    characterId: p.characterId,
    kind: "proactive_send",
    text: `:calling: *${name} 발송* · ${clock()}${partial}\n${quote(clip(p.text, 500))}`,
  });
};
