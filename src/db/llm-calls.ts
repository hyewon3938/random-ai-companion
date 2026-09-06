// 모델 호출 기록·사용량·본문 보관 표의 저장 함수와 보관 기간.
//
// 호출 하나가 행 하나다. 프롬프트·출력 본문은 내용 해시를 키로 prompt_blobs에 한 벌만 둔다.
// 사용량은 논리일×모델로 누적하고, 호출 행과 본문은 보관 기간이 지나면 지운다.

import { createHash } from "node:crypto";
import { db } from "./connection.js";
import { getKstNow, kstDateString, kstLogicalDate } from "../kst.js";

// LLM 사용량을 논리일×모델 단위로 누적한다 — 캐시 절감이 실제로 작동하는지 로그를 뒤지지 않고
// DB 질의 한 줄로 확인할 수 있게(cache_read가 input보다 훨씬 크게 유지되는 것이 정상 상태).
export const recordLlmUsage = (
  model: string,
  inputTokens: number,
  cacheWriteTokens: number,
  cacheReadTokens: number,
  outputTokens: number,
): void => {
  db.prepare(
    `INSERT INTO llm_usage (date, model, calls, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens)
     VALUES (?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(date, model) DO UPDATE SET
       calls = calls + 1,
       input_tokens = input_tokens + excluded.input_tokens,
       cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
       cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
       output_tokens = output_tokens + excluded.output_tokens`,
  ).run(
    kstLogicalDate(),
    model,
    inputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    outputTokens,
  );
};

// ── 모델 호출 원본 ─────────────────────────────────────────────────────────
// 호출 하나가 행 하나다. 프롬프트·출력 본문은 내용 해시를 키로 prompt_blobs에 한 벌만 둔다 —
// 앞 두 층은 하루 종일 같은 글자라, 호출마다 본문을 다시 담으면 DB가 호출 수만큼 커진다.

const stampNow = (): string =>
  `${kstDateString()} ${getKstNow().toISOString().slice(11, 19)}`;

/** 본문을 넣고 해시를 돌려준다. 같은 내용이면 새로 쌓지 않고 마지막으로 쓴 시각만 올린다. */
export const putBlob = (text: string): string => {
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const now = stampNow();
  db.prepare(
    `INSERT INTO prompt_blobs (hash, text, bytes, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(hash) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  ).run(hash, text, Buffer.byteLength(text, "utf8"), now, now);
  return hash;
};

/** 해시로 본문을 되찾는다. 보관 기간이 지나 지워졌으면 null. */
export const getBlob = (hash: string): string | null =>
  (
    db.prepare(`SELECT text FROM prompt_blobs WHERE hash = ?`).get(hash) as
      { text: string } | undefined
  )?.text ?? null;

export interface LlmCallInput {
  purpose: string;
  model: string;
  characterId?: number;
  chatId?: string;
  maxTokens?: number;
  /** JSON 재요청처럼 같은 자리에서 두 번 부른 경우의 차례. */
  attempt?: number;
  system: { text: string; cache?: boolean }[];
  /** 함께 보낸 대화 기록을 그대로 담은 글자. */
  turns: string;
  output?: string;
  usage?: {
    input: number;
    cacheWrite: number;
    cacheRead: number;
    output: number;
  };
  latencyMs: number;
  error?: string;
  codeVersion?: string;
  /** 응답이 왜 멈췄는지(end_turn·max_tokens 등). 호출이 실패한 행은 값이 없다. */
  stopReason?: string;
  /** 응답이 어떤 블록으로 왔는지 종류별 개수(예: `thinking:1,text:1`). */
  blockTypes?: string;
}

/** 호출 한 건을 남기고 행 번호를 돌려준다. 뒤에 판단 근거를 붙일 때 이 번호를 쓴다. */
export const recordLlmCall = (call: LlmCallInput): number => {
  const hashes = call.system.map((b) => ({
    h: putBlob(b.text),
    cache: b.cache === true,
  }));
  const info = db
    .prepare(
      `INSERT INTO llm_calls
         (character_id, chat_id, purpose, model, max_tokens, attempt,
          system_hashes, turns_hash, output_hash,
          input_tokens, cache_write_tokens, cache_read_tokens, output_tokens,
          latency_ms, stop_reason, block_types, error, code_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      call.characterId ?? null,
      call.chatId ?? null,
      call.purpose,
      call.model,
      call.maxTokens ?? null,
      call.attempt ?? 1,
      JSON.stringify(hashes),
      putBlob(call.turns),
      call.output === undefined ? null : putBlob(call.output),
      call.usage?.input ?? null,
      call.usage?.cacheWrite ?? null,
      call.usage?.cacheRead ?? null,
      call.usage?.output ?? null,
      call.latencyMs,
      call.stopReason ?? null,
      call.blockTypes ?? null,
      call.error ? call.error.slice(0, 500) : null,
      call.codeVersion ?? null,
      stampNow(),
    );
  return Number(info.lastInsertRowid);
};

/** 호출 행에 그때의 판단 근거를 붙인다 — 검색한 태그와 기억, 답장 텀, 말풍선 수. */
export const setCallContext = (callId: number, context: unknown): void => {
  db.prepare(`UPDATE llm_calls SET context_json = ? WHERE id = ?`).run(
    JSON.stringify(context),
    callId,
  );
};

// 본문 보관 기간. 지나면 본문을 가리키는 해시와 판단 근거를 지우고 메타(언제·무슨 호출·
// 토큰·지연)만 남긴다 — 본문에는 실제 대화가 통째로 들어 있어 오래 들고 있을 것이 아니고,
// 며칠 뒤에 다시 열어 보는 일도 없다. 메타는 가벼워서 계속 둔다.
// ── 게시가 읽는 호출 행 ──────────────────────────────────────────────────

export interface LlmCallRow {
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
  stop_reason: string | null;
  block_types: string | null;
  error: string | null;
  context_json: string | null;
  created_at: string;
}

/** 새벽 정리 게시가 읽는 열만 고른 행. */
export type LlmCallSummaryRow = Pick<
  LlmCallRow,
  | "id"
  | "purpose"
  | "model"
  | "attempt"
  | "system_hashes"
  | "turns_hash"
  | "output_hash"
  | "input_tokens"
  | "cache_write_tokens"
  | "cache_read_tokens"
  | "output_tokens"
  | "latency_ms"
  | "error"
  | "created_at"
>;

const sqlList = (xs: readonly string[]): string =>
  xs.map((x) => `'${x}'`).join(", ");

export const hasLlmCall = (id: number): boolean =>
  !!db.prepare(`SELECT 1 FROM llm_calls WHERE id = ?`).pluck().get(id);

export const getLlmCallBrief = (
  id: number,
): { id: number; model: string; created_at: string } | undefined =>
  db
    .prepare(`SELECT id, model, created_at FROM llm_calls WHERE id = ?`)
    .get(id) as { id: number; model: string; created_at: string } | undefined;

/** 같은 캐릭터의 바로 앞 호출 중 프롬프트 층 해시가 있고 목적이 목록에 든 것. */
export const prevLayeredCall = (
  beforeId: number,
  characterId: number | null,
  purposes: readonly string[],
): LlmCallRow | undefined =>
  db
    .prepare(
      `SELECT * FROM llm_calls
        WHERE id < ? AND character_id IS ? AND system_hashes IS NOT NULL
          AND purpose IN (${sqlList(purposes)})
        ORDER BY id DESC LIMIT 1`,
    )
    .get(beforeId, characterId) as LlmCallRow | undefined;

export const markLlmCallTraced = (id: number): void => {
  db.prepare(`UPDATE llm_calls SET traced = 1 WHERE id = ?`).run(id);
};

/** 아직 게시 안 한 호출을 번호 순서로. */
export const untracedLlmCalls = (
  purposes: readonly string[],
  limit: number,
): LlmCallRow[] =>
  db
    .prepare(
      `SELECT * FROM llm_calls
        WHERE traced = 0 AND purpose IN (${sqlList(purposes)})
        ORDER BY id LIMIT ?`,
    )
    .all(limit) as LlmCallRow[];

/** 한 캐릭터의 아직 게시 안 한 호출 중 시각 이후 것. 새벽 정리 게시가 시간 창으로 읽는다. */
export const untracedCallsSince = (
  characterId: number,
  purposes: readonly string[],
  since: string,
): LlmCallSummaryRow[] =>
  db
    .prepare(
      `SELECT id, purpose, model, attempt, system_hashes, turns_hash, output_hash,
              input_tokens, cache_write_tokens, cache_read_tokens, output_tokens,
              latency_ms, error, created_at
         FROM llm_calls
        WHERE traced = 0 AND character_id = ? AND purpose IN (${sqlList(purposes)})
          AND created_at >= ?
        ORDER BY id`,
    )
    .all(characterId, since) as LlmCallSummaryRow[];

// ── 보관 기간 ──────────────────────────────────────────────────────────

export const LLM_CALL_RETENTION_DAYS = 90;

// 슬랙 채널에서 표시를 받은 호출은 기간이 지나도 본문을 비우지 않는다. 답장이 왜 그렇게
// 나왔는지 사람이 판단한 기록이라, 프롬프트와 출력이 함께 있어야 나중에 채점표의 정답지로 쓸 수
// 있다. 표시를 뗀 것(removed_at)은 다시 정리 대상이 된다.
export const pruneLlmCalls = (
  days: number = LLM_CALL_RETENTION_DAYS,
): { calls: number; blobs: number } => {
  const cutoff = kstDateString(
    new Date(getKstNow().getTime() - days * 86400000),
  );
  const calls = db
    .prepare(
      `UPDATE llm_calls
          SET system_hashes = NULL, turns_hash = NULL, output_hash = NULL, context_json = NULL
        WHERE created_at < ?
          AND (system_hashes IS NOT NULL OR turns_hash IS NOT NULL
               OR output_hash IS NOT NULL OR context_json IS NOT NULL)
          AND id NOT IN (SELECT call_id FROM call_feedback
                          WHERE call_id IS NOT NULL AND removed_at IS NULL)`,
    )
    .run(cutoff).changes;
  // 아무 호출도 가리키지 않게 된 본문을 지운다. 같은 본문을 여러 호출이 가리키므로
  // 행을 지울 때가 아니라 여기서 한 번에 센다.
  const blobs = db
    .prepare(
      `DELETE FROM prompt_blobs
        WHERE hash NOT IN (
              SELECT turns_hash FROM llm_calls WHERE turns_hash IS NOT NULL
              UNION SELECT output_hash FROM llm_calls WHERE output_hash IS NOT NULL
              UNION SELECT json_extract(j.value, '$.h')
                      FROM (SELECT system_hashes FROM llm_calls
                             WHERE system_hashes IS NOT NULL) c,
                           json_each(c.system_hashes) j)`,
    )
    .run().changes;
  return { calls, blobs };
};
