// 답장 게시 준비 — 아직 안 올린 모델 호출을 번호 순서대로 게시함(trace_events)에 쌓는다.
//
// 1분 틱이 부른다. 호출 한 건이 채널에 남기는 것:
//   본문   — trace/reply-render.ts가 그린 한 장
//   스레드 — 그 호출의 실시간 꼬리 전문(호출마다 달라지는 부분)
//   스레드 — 발송·폐기 결과(reply-trace.ts의 후기록이 그때 쌓는다)
// 하루 종일 같은 앞 두 덩이는 그날 첫 호출에서 한 번만 올리고, 하루 중에 바뀌면 바뀐 줄만 올린다.
//
// 선톡도 문안 호출이 같은 길로 올라간다. 새벽 정리 쪽 호출(diary·extract·arc·day_plan·
// life_plan)은 여기서 건너뛴다 — nightly-trace.ts가 이전 값과 함께 올린다. 두 곳이 같은
// 호출을 올리면 채널이 두 벌로 찬다.

import {
  db,
  getBlob,
  hasTraceEvent,
  markLlmCallTraced,
  prevLayeredCall as prevLayeredCallRow,
  untracedLlmCalls,
} from "../db.js";
import { logicalDateOf } from "../kst.js";
import { recordTraceChunks, recordTraceEvent, traceEnabled } from "../trace.js";
import { callKey, chunked, dateLabel, esc } from "./format.js";
import {
  changedSections,
  changeLabel,
  LAYER_NAME,
  lineDiff,
  parseContext,
  parseHashes,
  renderDraft,
  renderHold,
  renderReply,
  renderRetry,
  type BlockHash,
  type CallRow,
} from "./reply-render.js";

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
  "mend",
  "away",
  "comeback",
  "promise",
] as const;

// 3층 프롬프트를 타는 호출 — 하루 고정 두 덩이를 여기서만 견준다.
// 붙잡기 판정은 짧은 시스템 문장 한 덩이라 섞이면 매번 바뀐 것으로 보인다.
const LAYERED = new Set<string>(POST_PURPOSES.filter((p) => p !== "hold"));

const epochOf = (ts: string): number =>
  new Date(ts.replace(" ", "T") + "+09:00").getTime();

// ── 하루 고정 두 덩이 ───────────────────────────────────────────────────

const LAYER_KEY = ["fixed", "daily"] as const;

const prevLayeredCall = (row: CallRow): CallRow | undefined =>
  prevLayeredCallRow(row.id, row.character_id, [...LAYERED]);

const postFullLayers = (
  row: CallRow,
  hashes: BlockHash[],
  date: string,
): void => {
  const key = `prompt_full:${row.character_id ?? 0}:${date}`;
  if (hasTraceEvent(key)) return;
  const bodies = [getBlob(hashes[0].h), getBlob(hashes[1].h)];
  const sizes = bodies.map((b, i) =>
    b
      ? `${LAYER_NAME[i]} ${b.length.toLocaleString()}자`
      : `${LAYER_NAME[i]} 본문 없음`,
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
      recordTraceChunks(
        row.character_id ?? undefined,
        key,
        "prompt_day_body",
        LAYER_NAME[i],
        esc(body),
        true,
      );
    });
  })();
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
      text: `:pencil2: *바뀐 부분 — ${changeLabel(
        before && after ? changedSections(before, after) : [],
        layer,
      )}* · ${row.created_at.slice(11, 16)} 호출 #${row.id}부터`,
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
  const ctx = parseContext(row.context_json);
  // 첫 답이 비어 다시 부른 호출은 제 몫의 글이 없다 — 원래 답장 스레드에 붙인다.
  // 앞 두 층은 원래 답장과 같은 글자라 여기서는 견주지 않는다.
  if (ctx?.partOf) {
    recordTraceEvent({
      characterId: row.character_id ?? undefined,
      kind: "call_retry",
      dedupeKey: callKey(row.id),
      parentKey: callKey(ctx.partOf),
      text: renderRetry(row, ctx.partOf),
    });
    return;
  }
  const hashes = parseHashes(row.system_hashes);
  if (LAYERED.has(row.purpose) && hashes.length >= 3) {
    try {
      ensureDayPrompt(row, hashes);
    } catch (err) {
      console.error("[trace] 고정 두 덩이 게시 준비 실패:", err);
    }
  }
  const body =
    row.purpose === "reply"
      ? renderReply(row, ctx)
      : row.purpose === "hold"
        ? renderHold(row, ctx)
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
    const tail =
      hashes.length >= 3 ? getBlob(hashes[hashes.length - 1].h) : null;
    if (!tail) return;
    recordTraceChunks(
      row.character_id ?? undefined,
      key,
      "call_tail",
      "실시간 꼬리",
      esc(tail),
      true,
    );
  })();
};

const markTraced = markLlmCallTraced;

/** 1분 틱. 아직 안 올린 호출을 번호 순서대로 게시함에 쌓는다. */
export const enqueueReplyTraces = (): void => {
  if (!traceEnabled()) return;
  const rows = untracedLlmCalls(POST_PURPOSES, BATCH);
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
