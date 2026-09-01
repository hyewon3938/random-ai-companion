// 슬랙 트레이스 채널에 사람이 남긴 표시를 모은다.
//
// 채널에 올라온 답장을 읽다가 이상한 것을 보면 리액션 하나로 분류를 고르고(❌ 사실 오류 ·
// 💬 말투 · ⏰ 타이밍 · 👍 좋음), 그렇게 본 이유는 스레드 답글로 적는다. 10분 간격 틱이
// 채널을 다시 읽어 그 표시를 call_feedback에 쌓는다. 분류 넷 중 맞는 것이 없으면 리액션
// 없이 스레드에만 적어도 같이 쌓인다.
//
// 원칙 셋.
// - 답장 파이프라인에는 손대지 않는다. 이미 남아 있는 게시 기록(trace_events)의 slack_ts로
//   어느 모델 호출의 글이었는지 되짚는다 — reply-trace.ts와 같은 구조다.
// - 모아 두기만 한다. 요약도 자동 분류도 하지 않고, 캐릭터 프롬프트나 기억으로도 가지 않는다.
//   무엇을 고쳐야 하는지 사람이 찾는 데 쓰는 데이터다.
// - 상시 연결(Socket Mode) 대신 폴링이다. 리액션은 conversations.history 응답에 메시지마다
//   딸려 오므로 채널을 다시 읽는 것만으로 지금 붙어 있는 표시를 전부 알 수 있고, 뗀 것도
//   같은 방법으로 드러난다. 프로세스가 죽어 있던 동안의 표시도 다음 회차에 그대로 들어온다.
//
// SLACK_BOT_TOKEN·SLACK_TRACE_CHANNEL 둘 중 하나라도 없으면 전체가 no-op이다.

import { config } from "./config.js";
import { db } from "./db.js";
import { getKstNow } from "./kst.js";
import { toFeedbackKind, type FeedbackKind } from "./labels.js";

// 슬랙에는 "최근에 리액션이 달린 글"을 묻는 방법이 없어서, 최근 며칠치를 다시 읽어 지금 붙어
// 있는 표시와 우리가 아는 것을 맞춘다. 며칠 지난 답장에 표시를 남길 수도 있어 사흘을 되읽는다.
const LOOKBACK_MS = 3 * 86400_000;
const PAGE_LIMIT = 200;
// 사흘치가 한 회차 안에 들어오게 하는 상한. 하루 게시량이 100행 안팎이라 보통 두 페이지면 끝난다.
const MAX_PAGES = 5;
// 이유는 한두 줄로 적는 자리라 길이 상한은 사고 방지용이다.
const REPLY_TEXT_MAX = 2000;

const nowIso = (): string =>
  getKstNow().toISOString().replace("T", " ").slice(0, 19);

// 슬랙 ts(에포크 초)를 KST 벽시계 문자열로 — 답글은 적힌 시각을 그대로 쓴다.
const kstStampOf = (slackTs: string): string => {
  const sec = Number(slackTs.split(".")[0]);
  if (!Number.isFinite(sec)) return nowIso();
  return new Date(sec * 1000 + 9 * 3600_000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
};

// ── 표시가 달린 글 되짚기 ───────────────────────────────────────────────

// 답장 게시의 dedupe_key는 부모가 `call:12`, 스레드 자식이 `call:12:sent` 꼴이다.
// 자식에 달린 표시도 같은 호출에 대한 것이라 둘 다 받는다.
const CALL_KEY = /^call:(\d+)(?::|$)/;

interface Target {
  characterId: number | null;
  callId: number | null;
  traceKind: string | null;
}

const resolveTarget = (slackTs: string): Target | null => {
  const row = db
    .prepare(
      `SELECT character_id, kind, dedupe_key FROM trace_events
        WHERE slack_ts = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(slackTs) as
    | { character_id: number | null; kind: string; dedupe_key: string | null }
    | undefined;
  // 우리가 올린 글이 아니면(사람이 채널에 직접 쓴 말) 표시를 붙일 자리가 없다.
  if (!row) return null;

  const matched = row.dedupe_key ? CALL_KEY.exec(row.dedupe_key) : null;
  let callId = matched ? Number(matched[1]) : null;
  // 게시함은 30일, 호출 기록은 그보다 오래 남지만 순서가 뒤집힐 여지를 남기지 않는다 —
  // 없는 호출을 가리키면 외래키에 걸려 그 회차 전체가 멈춘다.
  if (callId !== null) {
    const exists = db
      .prepare(`SELECT 1 FROM llm_calls WHERE id = ?`)
      .pluck()
      .get(callId);
    if (!exists) callId = null;
  }
  return { characterId: row.character_id, callId, traceKind: row.kind };
};

// ── 쌓기 ────────────────────────────────────────────────────────────────

type SaveResult = "new" | "restored" | "known";

interface SaveInput {
  dedupeKey: string;
  slackTs: string;
  source: "reaction" | "reply";
  kind: FeedbackKind | null;
  slackUser: string | null;
  text: string | null;
  replyTs: string | null;
  createdAt: string;
  target: Target;
}

const save = (f: SaveInput): SaveResult => {
  const existing = db
    .prepare(`SELECT id, removed_at FROM call_feedback WHERE dedupe_key = ?`)
    .get(f.dedupeKey) as { id: number; removed_at: string | null } | undefined;
  if (existing) {
    // 같은 표시를 다시 읽은 것뿐이면 그대로 둔다.
    if (!existing.removed_at) return "known";
    // 뗐다가 다시 붙인 표시는 되살린다.
    db.prepare(`UPDATE call_feedback SET removed_at = NULL WHERE id = ?`).run(
      existing.id,
    );
    return "restored";
  }
  db.prepare(
    `INSERT INTO call_feedback
       (character_id, call_id, slack_ts, trace_kind, source, kind,
        slack_user, text, reply_ts, dedupe_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    f.target.characterId,
    f.target.callId,
    f.slackTs,
    f.target.traceKind,
    f.source,
    f.kind,
    f.slackUser,
    f.text,
    f.replyTs,
    f.dedupeKey,
    f.createdAt,
  );
  return "new";
};

/** 지금 그 글에 붙어 있는 표시 하나 — 같은 사람이 두 분류를 고르면 두 건이 된다. */
export interface LiveReaction {
  kind: FeedbackKind;
  user: string | null;
}

export interface ReactionSync {
  added: number;
  restored: number;
  removed: number;
}

const reactionKey = (slackTs: string, r: LiveReaction): string =>
  `react:${slackTs}:${r.kind}:${r.user ?? "?"}`;

/**
 * 글 하나에 붙어 있는 표시를 우리가 아는 것과 맞춘다.
 * 새로 붙은 것은 넣고, 없어진 것은 지우지 않고 removed_at으로 표시한다.
 */
export const syncReactions = (
  slackTs: string,
  live: LiveReaction[],
): ReactionSync => {
  const stored = db
    .prepare(
      `SELECT id, dedupe_key FROM call_feedback
        WHERE slack_ts = ? AND source = 'reaction' AND removed_at IS NULL`,
    )
    .all(slackTs) as { id: number; dedupe_key: string }[];
  if (!live.length && !stored.length)
    return { added: 0, restored: 0, removed: 0 };

  let added = 0;
  let restored = 0;
  const seen = new Set<string>();
  if (live.length) {
    const target = resolveTarget(slackTs);
    if (!target) return { added: 0, restored: 0, removed: 0 };
    const stamp = nowIso();
    for (const r of live) {
      const dedupeKey = reactionKey(slackTs, r);
      seen.add(dedupeKey);
      const result = save({
        dedupeKey,
        slackTs,
        source: "reaction",
        kind: r.kind,
        slackUser: r.user,
        text: null,
        replyTs: null,
        // 슬랙은 리액션을 누른 시각을 주지 않는다. 처음 본 시각을 적는다.
        createdAt: stamp,
        target,
      });
      if (result === "new") added += 1;
      else if (result === "restored") restored += 1;
    }
  }

  let removed = 0;
  const stamp = nowIso();
  for (const row of stored) {
    if (seen.has(row.dedupe_key)) continue;
    db.prepare(`UPDATE call_feedback SET removed_at = ? WHERE id = ?`).run(
      stamp,
      row.id,
    );
    removed += 1;
  }
  return { added, restored, removed };
};

/** 표시를 남긴 이유로 적은 스레드 답글 하나. */
export interface ThreadReply {
  ts: string;
  user: string | null;
  text: string;
}

/**
 * 스레드에 적힌 이유를 쌓는다. 답글은 지우고 고치는 자리가 아니라, 새 것만 넣는다.
 */
export const recordThreadReplies = (
  slackTs: string,
  replies: ThreadReply[],
): number => {
  if (!replies.length) return 0;
  const target = resolveTarget(slackTs);
  if (!target) return 0;
  let added = 0;
  for (const r of replies) {
    const text = r.text.trim();
    if (!text) continue;
    const result = save({
      dedupeKey: `reply:${r.ts}`,
      slackTs,
      source: "reply",
      kind: null,
      slackUser: r.user,
      text: text.slice(0, REPLY_TEXT_MAX),
      replyTs: r.ts,
      createdAt: kstStampOf(r.ts),
      target,
    });
    if (result === "new") added += 1;
  }
  return added;
};

// ── 슬랙 읽기 ───────────────────────────────────────────────────────────

interface SlackReaction {
  name: string;
  users?: string[];
}

interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  reply_count?: number;
  reactions?: SlackReaction[];
}

interface SlackListResult {
  ok: boolean;
  error?: string;
  messages?: SlackMessage[];
  response_metadata?: { next_cursor?: string };
}

const slackGet = async (
  method: string,
  params: Record<string, string>,
): Promise<SlackListResult> => {
  const url = `https://slack.com/api/${method}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.slackBotToken}` },
  });
  return (await res.json()) as SlackListResult;
};

// 설정이 잘못돼 조용히 아무것도 못 읽는 상태가 오래가지 않게, 무엇을 고쳐야 하는지까지 적는다.
const explain = (method: string, error: string): string => {
  if (error === "missing_scope")
    return `${method} 권한이 없다 — 슬랙 앱에 channels:history(비공개 채널이면 groups:history)와 reactions:read를 넣고 다시 설치해야 한다`;
  if (error === "channel_not_found")
    return `${method} 채널을 못 찾았다 — 채널을 읽으려면 SLACK_TRACE_CHANNEL이 이름(#…)이 아니라 채널 ID(C…)여야 한다(게시는 이름으로도 된다)`;
  if (error === "not_in_channel")
    return `${method} 앱이 채널 밖이다 — 채널에 초대해야 읽는다`;
  return `${method} 실패: ${error}`;
};

const liveReactionsOf = (m: SlackMessage): LiveReaction[] => {
  const out: LiveReaction[] = [];
  for (const r of m.reactions ?? []) {
    const kind = toFeedbackKind(r.name);
    // 분류 네 가지 밖의 이모지는 표시가 아니라 잡담이다.
    if (!kind) continue;
    const users = r.users?.length ? r.users : [null];
    for (const user of users) out.push({ kind, user });
  }
  return out;
};

// 게시글에는 우리가 올린 판단 근거가 스레드 자식으로 함께 달려서, 사람이 아무 말도 적지
// 않은 글에서도 reply_count가 0보다 크다. 우리가 올린 자식 수와 이미 수집한 답글 수를 세어
// 두고 그보다 많을 때만 스레드를 연다 — 리액션을 조건으로 걸면 분류 네 가지 중 맞는 것이
// 없어 이유만 적은 글을 통째로 놓친다(이슈 #236).
const knownReplyCount = (slackTs: string): number => {
  const threadKey = db
    .prepare(
      `SELECT thread_key FROM trace_events
        WHERE slack_ts = ? ORDER BY id DESC LIMIT 1`,
    )
    .pluck()
    .get(slackTs) as string | null | undefined;
  // 부모 행을 못 찾으면 0으로 둔다. 스레드를 한 번 헛읽는 비용이 사람이 적은 이유를
  // 놓치는 것보다 싸서, 모를 때는 읽는 쪽으로 기운다.
  const ours = threadKey
    ? (db
        .prepare(
          `SELECT COUNT(*) FROM trace_events
            WHERE parent_key = ? AND status = 'sent'`,
        )
        .pluck()
        .get(threadKey) as number)
    : 0;
  const collected = db
    .prepare(
      `SELECT COUNT(*) FROM call_feedback
        WHERE slack_ts = ? AND source = 'reply'`,
    )
    .pluck()
    .get(slackTs) as number;
  return ours + collected;
};

const hasUnreadReply = (m: SlackMessage): boolean => {
  const total = m.reply_count ?? 0;
  return total > 0 && total > knownReplyCount(m.ts);
};

const collectThread = async (
  channel: string,
  m: SlackMessage,
): Promise<number> => {
  if (!m.reply_count) return 0;
  const res = await slackGet("conversations.replies", {
    channel,
    ts: m.ts,
    limit: String(PAGE_LIMIT),
  });
  if (!res.ok) {
    console.error(
      `[feedback] ${explain("conversations.replies", res.error ?? "unknown")}`,
    );
    return 0;
  }
  // 스레드에는 우리가 올린 판단 근거가 이미 들어 있다. 사람이 적은 것만 고른다.
  const human = (res.messages ?? []).filter(
    (r) => r.ts !== m.ts && !r.bot_id && r.user && (r.text ?? "").trim(),
  );
  return recordThreadReplies(
    m.ts,
    human.map((r) => ({ ts: r.ts, user: r.user ?? null, text: r.text ?? "" })),
  );
};

export const runFeedbackTick = async (): Promise<void> => {
  const channel = config.slackTraceChannel;
  // 게시가 꺼져 있으면 읽을 글도 없다(trace.ts와 같은 조건).
  if (!config.slackBotToken || !channel) return;

  const oldest = ((Date.now() - LOOKBACK_MS) / 1000).toFixed(6);
  let cursor: string | undefined;
  let added = 0;
  let restored = 0;
  let removed = 0;
  let reasons = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await slackGet("conversations.history", {
      channel,
      oldest,
      limit: String(PAGE_LIMIT),
      ...(cursor ? { cursor } : {}),
    });
    if (!res.ok) {
      console.error(
        `[feedback] ${explain("conversations.history", res.error ?? "unknown")}`,
      );
      return;
    }
    for (const m of res.messages ?? []) {
      const live = liveReactionsOf(m);
      const sync = syncReactions(m.ts, live);
      added += sync.added;
      restored += sync.restored;
      removed += sync.removed;
      // 이유는 아직 안 읽은 사람 글이 있는 글에서만 찾는다.
      if (!hasUnreadReply(m)) continue;
      try {
        reasons += await collectThread(channel, m);
      } catch (e) {
        console.error("[feedback] 스레드 읽기 실패:", e);
      }
    }
    cursor = res.response_metadata?.next_cursor;
    if (!cursor) break;
  }

  if (added || restored || removed || reasons)
    console.log(
      `[feedback] 새 표시 ${added}건, 되살림 ${restored}건, 뗀 것 ${removed}건, 이유 ${reasons}건`,
    );
};
