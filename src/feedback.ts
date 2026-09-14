// 슬랙 트레이스 채널에 사람이 남긴 표시를 모은다.
//
// 채널에 올라온 게시글을 읽다가 눈에 걸리는 것이 있으면 리액션을 달거나 스레드에 답글을 적는다.
// 10분 간격 틱이 채널을 다시 읽어 그 표시를 call_feedback에 쌓는다. 게시글 본문과 스레드 안
// 글(프롬프트 덩이·발송 결과 같은) 어느 쪽에 달아도, 이모지가 무엇이든 모은다. 분류 이모지
// 넷(❌ 사실 오류 · 💬 말투 · ⏰ 타이밍 · 👍 좋음)은 분류로 적고 그 밖의 이모지는 이름만 적는다.
// 처리했다는 체크는 tools/feedback.ts가 단 것이라 뺀다.
//
// 원칙 셋.
// - 답장 파이프라인에는 손대지 않는다. 이미 남아 있는 게시 기록(trace_events)의 slack_ts로
//   어느 게시였고 어느 모델 호출이었는지 되짚고, 그 게시 키를 행에 옮겨 적는다.
// - 모아 두기만 한다. 요약도 자동 분류도 하지 않고, 캐릭터 프롬프트나 기억으로도 가지 않는다.
//   무엇을 고쳐야 하는지 사람이 찾는 데 쓰는 데이터다.
// - 상시 연결(Socket Mode) 대신 폴링이다. 본문에 단 리액션은 conversations.history 응답에
//   딸려 오지만, 스레드 안 글의 리액션은 conversations.replies로 스레드를 열어야 보이고 부모
//   글의 답글 수도 바꾸지 않는다. 사흘치 스레드를 매 회차 전부 열면 분당 한도에 걸려서, 여는
//   때를 shouldOpenThread가 정한다. 프로세스가 죽어 있던 동안의 표시도 다음 회차에 들어온다.
//
// SLACK_BOT_TOKEN·SLACK_TRACE_CHANNEL 둘 중 하나라도 없으면 전체가 no-op이다.

import { config } from "./config.js";
import {
  activeReactionFeedback,
  countReplyFeedback,
  countSentChildren,
  getFeedbackByDedupeKey,
  hasLlmCall,
  insertFeedback,
  removeFeedback,
  restoreFeedback,
  traceEventBySlackTs,
  traceParentOf,
} from "./db.js";
import { kstStamp } from "./kst.js";
import {
  baseEmojiName,
  FEEDBACK_DONE_EMOJI,
  toFeedbackKind,
  type FeedbackKind,
} from "./labels.js";

// 슬랙에는 "최근에 리액션이 달린 글"을 묻는 방법이 없어서, 최근 며칠치를 다시 읽어 지금 붙어
// 있는 표시와 우리가 아는 것을 맞춘다. 며칠 지난 답장에 표시를 남길 수도 있어 사흘을 되읽는다.
const LOOKBACK_MS = 3 * 86400_000;
const PAGE_LIMIT = 200;
// 사흘치가 한 회차 안에 들어오게 하는 상한. 하루 게시량이 100행 안팎이라 보통 두 페이지면 끝난다.
const MAX_PAGES = 5;
// 이유는 한두 줄로 적는 자리라 길이 상한은 사고 방지용이다.
const REPLY_TEXT_MAX = 2000;
// 올린 지 이 시간 안인 스레드는 매 회차 연다. 표시는 대개 올라온 날 채널을 읽으면서 단다.
const RECENT_THREAD_MS = 6 * 3600_000;
// 그보다 오래된 스레드는 여섯 묶음으로 나눠 회차(10분)마다 한 묶음씩 연다 — 한 시간에 한 번이다.
const TICK_MS = 10 * 60_000;
const ROTATION = 6;
// conversations.replies는 분당 50회 안팎에서 막힌다. 그 밑으로 천천히 연다.
const THREAD_GAP_MS = 1_500;

// 슬랙 ts(에포크 초)를 KST 벽시계 문자열로 — 답글은 적힌 시각을 그대로 쓴다.
const kstStampOf = (slackTs: string): string => {
  const sec = Number(slackTs.split(".")[0]);
  if (!Number.isFinite(sec)) return kstStamp();
  return new Date(sec * 1000 + 9 * 3600_000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
};

// ── 표시가 달린 글 되짚기 ───────────────────────────────────────────────

// 답장 게시의 dedupe_key는 부모가 `call:12`, 스레드 자식이 `call:12:sent` 꼴이다.
// 자식에 달린 표시도 같은 호출에 대한 것이라 둘 다 받는다.
const CALL_KEY = /^call:(\d+)(?::|$)/;

const callIdOf = (key: string | null): number | null => {
  const matched = key ? CALL_KEY.exec(key) : null;
  return matched ? Number(matched[1]) : null;
};

interface Target {
  characterId: number | null;
  callId: number | null;
  traceKind: string | null;
  /** 그 글의 게시 키. 제 키가 없는 스레드 자식이면 부모 키. */
  traceKey: string | null;
  /** 스레드 안 글이면 부모 글의 ts. */
  threadTs: string | null;
}

const resolveTarget = (slackTs: string): Target | null => {
  const row = traceEventBySlackTs(slackTs);
  // 우리가 올린 글이 아니면(사람이 채널에 직접 쓴 말) 표시를 붙일 자리가 없다.
  if (!row) return null;

  // 실시간 꼬리·프롬프트 덩이처럼 제 키 없이 부모 키만 가진 자식은 부모 키로 호출을 찾는다.
  let callId = callIdOf(row.dedupe_key) ?? callIdOf(row.parent_key);
  // 트레이스 표는 30일, 호출 기록은 그보다 오래 남지만 순서가 뒤집힐 여지를 남기지 않는다 —
  // 없는 호출을 가리키면 외래키에 걸려 그 회차 전체가 멈춘다.
  if (callId !== null && !hasLlmCall(callId)) callId = null;
  return {
    characterId: row.character_id,
    callId,
    traceKind: row.kind,
    traceKey: row.dedupe_key ?? row.parent_key,
    threadTs: row.parent_key
      ? (traceParentOf(row.parent_key)?.slack_ts ?? null)
      : null,
  };
};

// ── 쌓기 ────────────────────────────────────────────────────────────────

type SaveResult = "new" | "restored" | "known";

interface SaveInput {
  dedupeKey: string;
  slackTs: string;
  source: "reaction" | "reply";
  kind: FeedbackKind | null;
  emoji: string | null;
  slackUser: string | null;
  text: string | null;
  replyTs: string | null;
  createdAt: string;
  target: Target;
}

const save = (f: SaveInput): SaveResult => {
  const existing = getFeedbackByDedupeKey(f.dedupeKey);
  if (existing) {
    // 같은 표시를 다시 읽은 것뿐이면 그대로 둔다.
    if (!existing.removed_at) return "known";
    // 뗐다가 다시 붙인 표시는 되살린다.
    restoreFeedback(existing.id);
    return "restored";
  }
  insertFeedback({
    characterId: f.target.characterId,
    callId: f.target.callId,
    slackTs: f.slackTs,
    traceKind: f.target.traceKind,
    source: f.source,
    kind: f.kind,
    slackUser: f.slackUser,
    text: f.text,
    replyTs: f.replyTs,
    dedupeKey: f.dedupeKey,
    createdAt: f.createdAt,
    emoji: f.emoji,
    traceKey: f.target.traceKey,
    threadTs: f.target.threadTs,
  });
  return "new";
};

/** 지금 그 글에 붙어 있는 리액션 하나 — 같은 사람이 두 이모지를 달면 두 건이 된다. */
export interface LiveReaction {
  /** 분류 이모지 넷 중 하나면 그 분류, 그 밖의 이모지면 null. */
  kind: FeedbackKind | null;
  /** 살색 변형을 뗀 이모지 이름. */
  emoji: string;
  user: string | null;
}

export interface ReactionSync {
  added: number;
  restored: number;
  removed: number;
}

// 분류 이모지는 이모지 이름 대신 분류로 키를 만든다. 👍를 +1로 달든 thumbsup으로 달든 한 건이고,
// 분류 밖 이모지를 모으기 전에 쌓인 행과도 키가 그대로 이어진다.
const reactionKey = (slackTs: string, r: LiveReaction): string =>
  r.kind
    ? `react:${slackTs}:${r.kind}:${r.user ?? "?"}`
    : `react:${slackTs}:emoji:${r.emoji}:${r.user ?? "?"}`;

/**
 * 글 하나에 붙어 있는 표시를 우리가 아는 것과 맞춘다.
 * 새로 붙은 것은 넣고, 없어진 것은 지우지 않고 removed_at으로 표시한다.
 */
export const syncReactions = (
  slackTs: string,
  live: LiveReaction[],
): ReactionSync => {
  const stored = activeReactionFeedback(slackTs);
  if (!live.length && !stored.length)
    return { added: 0, restored: 0, removed: 0 };

  let added = 0;
  let restored = 0;
  const seen = new Set<string>();
  if (live.length) {
    const target = resolveTarget(slackTs);
    if (!target) return { added: 0, restored: 0, removed: 0 };
    const stamp = kstStamp();
    for (const r of live) {
      const dedupeKey = reactionKey(slackTs, r);
      seen.add(dedupeKey);
      const result = save({
        dedupeKey,
        slackTs,
        source: "reaction",
        kind: r.kind,
        emoji: r.emoji,
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
  const stamp = kstStamp();
  for (const row of stored) {
    if (seen.has(row.dedupe_key)) continue;
    removeFeedback(row.id, stamp);
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
 *
 * 슬랙 스레드는 한 줄로 이어져서 답글이 스레드 안 어느 글을 두고 한 말인지 알 수 없다. 그래서
 * 답글은 전부 부모 글(slackTs)에 붙이고, 어느 자식 가까이에 적혔는지로 짐작해 붙이지 않는다.
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
      emoji: null,
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

export interface SlackReaction {
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

/** 슬랙 글에 달린 리액션을 사람마다 한 건으로 편다. 처리 체크는 도구가 단 것이라 뺀다. */
export const liveReactionsOf = (m: {
  reactions?: SlackReaction[];
}): LiveReaction[] => {
  const out: LiveReaction[] = [];
  for (const r of m.reactions ?? []) {
    const emoji = baseEmojiName(r.name);
    if (emoji === FEEDBACK_DONE_EMOJI) continue;
    const kind = toFeedbackKind(emoji);
    const users = r.users?.length ? r.users : [null];
    for (const user of users) out.push({ kind, emoji, user });
  }
  return out;
};

// 게시글에는 우리가 올린 판단 근거가 스레드 자식으로 함께 달려서, 사람이 아무 말도 적지
// 않은 글에서도 reply_count가 0보다 크다. 우리가 올린 자식 수와 이미 수집한 답글 수를 세어
// 두고 그보다 많으면 사람이 새로 적은 답글이 있는 것이다(이슈 #236).
const hasUnreadReply = (m: SlackMessage, threadKey: string | null): boolean => {
  const total = m.reply_count ?? 0;
  // 부모 키를 모르면 0으로 둔다. 스레드를 한 번 헛읽는 비용이 사람이 적은 이유를
  // 놓치는 것보다 싸서, 모를 때는 읽는 쪽으로 기운다.
  const ours = threadKey ? countSentChildren(threadKey) : 0;
  return total > 0 && total > ours + countReplyFeedback(m.ts);
};

/**
 * 이번 회차에 그 스레드를 열지 정한다.
 *
 * 스레드 안 글에 단 리액션은 부모 글의 reply_count를 바꾸지 않아서 채널 목록만 읽어서는 달렸는지
 * 알 수 없다. 그렇다고 사흘치 스레드를 매 회차 전부 열면 분당 한도에 걸려서 셋으로 나눈다.
 * 사람이 새로 답글을 적은 스레드와 올린 지 6시간 안인 스레드는 바로 열고, 그보다 오래된 스레드는
 * ts로 여섯 묶음에 나눠 회차마다 한 묶음씩 연다.
 */
export const shouldOpenThread = (p: {
  ts: string;
  replyCount: number;
  unread: boolean;
  nowMs: number;
}): boolean => {
  if (p.replyCount <= 0) return false;
  if (p.unread) return true;
  const [sec, frac] = p.ts.split(".");
  if (p.nowMs - Number(sec) * 1000 < RECENT_THREAD_MS) return true;
  const turn = Math.floor(p.nowMs / TICK_MS) % ROTATION;
  return (Number(sec) + Number(frac ?? 0)) % ROTATION === turn;
};

interface ThreadRead extends ReactionSync {
  reasons: number;
  /** 분당 한도에 걸려 끝까지 못 읽었다. */
  limited: boolean;
}

const collectThread = async (
  channel: string,
  m: SlackMessage,
): Promise<ThreadRead> => {
  const out: ThreadRead = {
    added: 0,
    restored: 0,
    removed: 0,
    reasons: 0,
    limited: false,
  };
  const human: ThreadReply[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (page > 0) await pause();
    const res = await slackGet("conversations.replies", {
      channel,
      ts: m.ts,
      limit: String(PAGE_LIMIT),
      ...(cursor ? { cursor } : {}),
    });
    if (!res.ok) {
      if (res.error === "ratelimited") out.limited = true;
      else
        console.error(
          `[feedback] ${explain("conversations.replies", res.error ?? "unknown")}`,
        );
      break;
    }
    for (const r of res.messages ?? []) {
      // 부모 글의 리액션은 채널 목록에서 이미 맞췄다.
      if (r.ts === m.ts) continue;
      // 스레드 안 글마다 리액션을 맞춘다. 사람이 쓴 답글에 단 리액션은 붙일 게시가 없어 건너뛴다.
      const sync = syncReactions(r.ts, liveReactionsOf(r));
      out.added += sync.added;
      out.restored += sync.restored;
      out.removed += sync.removed;
      // 스레드에는 우리가 올린 판단 근거가 이미 들어 있다. 사람이 적은 것만 이유로 고른다.
      if (!r.bot_id && r.user && (r.text ?? "").trim())
        human.push({ ts: r.ts, user: r.user, text: r.text ?? "" });
    }
    cursor = res.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  out.reasons = recordThreadReplies(m.ts, human);
  return out;
};

const pause = (): Promise<void> =>
  new Promise((r) => setTimeout(r, THREAD_GAP_MS));

// 스레드를 천천히 열어서 한 회차가 길어질 수 있다. 앞 회차가 안 끝났으면 이번 회차는 건너뛴다.
let running = false;

export const runFeedbackTick = async (): Promise<void> => {
  const channel = config.slackTraceChannel;
  // 게시가 꺼져 있으면 읽을 글도 없다(trace.ts와 같은 조건).
  if (!config.slackBotToken || !channel) return;
  if (running) return;
  running = true;
  try {
    await tick(channel);
  } finally {
    running = false;
  }
};

const tick = async (channel: string): Promise<void> => {
  const nowMs = Date.now();
  const oldest = ((nowMs - LOOKBACK_MS) / 1000).toFixed(6);
  let cursor: string | undefined;
  let added = 0;
  let restored = 0;
  let removed = 0;
  let reasons = 0;
  let opened = 0;
  let limited = false;

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
      const sync = syncReactions(m.ts, liveReactionsOf(m));
      added += sync.added;
      restored += sync.restored;
      removed += sync.removed;
      // 한도에 걸린 뒤로는 스레드를 열지 않고 본문 리액션만 맞춘다. 나머지는 다음 회차에 연다.
      if (limited || !m.reply_count) continue;
      // 우리가 올린 글의 스레드만 연다. 사람이 채널에 직접 쓴 글에는 표시를 붙일 자리가 없다.
      const ours = traceEventBySlackTs(m.ts);
      if (!ours) continue;
      const open = shouldOpenThread({
        ts: m.ts,
        replyCount: m.reply_count,
        unread: hasUnreadReply(m, ours.thread_key),
        nowMs,
      });
      if (!open) continue;
      if (opened > 0) await pause();
      opened += 1;
      try {
        const thread = await collectThread(channel, m);
        added += thread.added;
        restored += thread.restored;
        removed += thread.removed;
        reasons += thread.reasons;
        limited = thread.limited;
      } catch (e) {
        console.error("[feedback] 스레드 읽기 실패:", e);
      }
    }
    cursor = res.response_metadata?.next_cursor;
    if (!cursor) break;
  }

  if (limited)
    console.warn(
      `[feedback] 스레드 ${opened}개째에서 읽기 한도에 걸렸다 — 나머지는 다음 회차에 연다`,
    );
  if (added || restored || removed || reasons)
    console.log(
      `[feedback] 새 표시 ${added}건, 되살림 ${restored}건, 뗀 것 ${removed}건, 이유 ${reasons}건`,
    );
};
