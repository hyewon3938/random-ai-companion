// 슬랙 트레이스 게시함 — 보여줄 내용을 trace_events 행으로 쌓고 1분 틱이 슬랙으로 내보낸다.
//
// 원칙 셋.
// - 게시를 위한 모델 호출은 없다. DB에 이미 있는 값과 코드 계산만으로 만든다.
// - 보여줄 내용은 trace_events 행으로 먼저 쌓고(게시함), 1분 틱이 슬랙으로 내보낸다.
//   재시작·슬랙 장애에도 보낼 것이 남고, 봇 밖에서 도는 배치가 남긴 행도 같은 길로 나간다.
// - SLACK_BOT_TOKEN·SLACK_TRACE_CHANNEL 둘 중 하나라도 없으면 전체가 no-op —
//   토큰 없이 먼저 배포해도 안전하다.
//
// 무엇을 쌓을지는 각 자리가 정한다 — 아침 각본은 trace/morning-plan.ts, 답장 호출은
// trace/reply-post.ts, 발송 결과와 선톡은 reply-trace.ts, 새벽 정리는 nightly-trace.ts.
// 문안 표기 도우미는 trace/format.ts에 있다.
//
// 쌓을 때 본문은 한 번 redactToken을 거친다 — 예외를 그대로 싣는 자리(traceReplyFault)가
// 있어서, 라이브러리가 에러에 담은 요청 주소로 봇 토큰이 슬랙까지 나갈 수 있다. 부르는 쪽마다
// 가리게 하면 새 자리가 늘 때 빠지므로, 밖으로 나가는 길목인 여기서 한 번에 가린다.

import { config, redactToken } from "./config.js";
import {
  insertTraceEvent,
  markTraceEventSent,
  pendingTraceEvents,
  setTraceEventFailure,
  skipTraceEvent,
  traceParentOf,
  type PendingTraceRow,
} from "./db.js";
import { kstStamp } from "./kst.js";
import { chunked } from "./trace/format.js";

export const traceEnabled = (): boolean =>
  Boolean(config.slackBotToken && config.slackTraceChannel);

// 관계를 쌓으면서 올리는 게시 종류 넷. 여기에는 이름만 두고 게시 본문은 쌓는 자리가 만든다 —
// 캐릭터를 시작하고 끝내는 도구가 앞의 둘을, 새벽 정리가 단계 변화와 처음을 쌓는다. 넷 다 그때
// 한 번 쌓고 마는 기록이라 호출 기록에서 다시 만들 수 없어, 되돌리기 도구(tools/retrace.ts)가
// 다시 보낼 것을 고를 때 이 목록을 읽는다.
export const RELATIONSHIP_TRACE_KINDS = [
  "character_start",
  "character_end",
  "stage_change",
  "first_event",
] as const;

// ── 게시함에 쌓기 ───────────────────────────────────────────────────────

export interface TraceEventInput {
  characterId?: number;
  kind: string;
  text: string;
  /** 같은 키가 이미 쌓였으면 다시 쌓지 않는다(재게시 방지). */
  dedupeKey?: string;
  /** 이 행이 스레드의 부모가 될 때, 자식들이 가리킬 키. */
  threadKey?: string;
  /** 이 행이 스레드에 달릴 때, 부모 행의 threadKey. */
  parentKey?: string;
}

export const recordTraceEvent = (e: TraceEventInput): void => {
  if (!traceEnabled()) return;
  try {
    insertTraceEvent({
      characterId: e.characterId ?? null,
      kind: e.kind,
      dedupeKey: e.dedupeKey ?? null,
      threadKey: e.threadKey ?? null,
      parentKey: e.parentKey ?? null,
      text: redactToken(e.text),
      createdAt: kstStamp(),
    });
  } catch (err) {
    // 트레이스 기록 실패가 본 기능(답장·선톡)을 멈추면 안 된다 — 적고 넘어간다.
    console.error("[trace] 기록 실패:", err);
  }
};

// 긴 본문은 한 덩이 크기로 잘라 스레드 자식 여러 행으로 쌓는다. 이스케이프는 부르는 쪽이 끝내고
// 넘긴다. code=true면 자른 뒤에 각 덩이를 코드 울타리로 감싼다 — 울타리째 자르면 표시가 깨진다.
export const recordTraceChunks = (
  characterId: number | undefined,
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

// ── 슬랙 발송 ───────────────────────────────────────────────────────────

interface SlackResult {
  ok: boolean;
  ts?: string;
  error?: string;
}

const postToSlack = async (
  text: string,
  threadTs?: string,
): Promise<SlackResult> => {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${config.slackBotToken}`,
    },
    body: JSON.stringify({
      channel: config.slackTraceChannel,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      unfurl_links: false,
      unfurl_media: false,
    }),
  });
  return (await res.json()) as SlackResult;
};

// 다시 보내도 같은 이유로 실패하는 응답 — 재시도 없이 바로 접는다.
// not_in_channel은 앱을 채널에 초대해야 풀린다(로그로 안내).
const PERMANENT_ERRORS = new Set([
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "msg_too_long",
]);

const MAX_ATTEMPTS = 3;
const BATCH = 20;

// 부모를 이만큼 기다려도 안 생기면 접는다. 자식이 부모보다 먼저 쌓이는 자리가 있어서
// (발송 결과가 답장 게시 준비보다 빠를 수 있다) 잠깐은 기다리되, 영영 기다리지는 않는다.
const ORPHAN_WAIT_MS = 30 * 60_000;

const markFailure = (
  row: PendingTraceRow,
  error: string,
  permanent: boolean,
): void => {
  const attempts = row.attempts + 1;
  const giveUp = permanent || attempts >= MAX_ATTEMPTS;
  setTraceEventFailure(row.id, giveUp ? "failed" : "pending", attempts, error);
  if (giveUp)
    console.error(
      `[trace] 게시 포기 (${row.kind}): ${error}${error === "not_in_channel" ? " — 슬랙 앱을 채널에 초대해야 한다" : ""}`,
    );
};

/** 1분 틱. pending 행을 슬랙으로 내보낸다. 쌓는 쪽은 index.ts가 이 틱 앞에서 부른다. */
export const runTraceTick = async (): Promise<void> => {
  if (!traceEnabled()) return;
  const rows = pendingTraceEvents(BATCH);
  for (const row of rows) {
    let threadTs: string | undefined;
    if (row.parent_key) {
      const parent = traceParentOf(row.parent_key);
      // 부모가 아직 안 나갔으면 다음 틱에 — 스레드 순서를 지킨다.
      if (!parent || parent.status === "pending") {
        const waited =
          Date.now() -
          new Date(row.created_at.replace(" ", "T") + "+09:00").getTime();
        if (!parent && waited > ORPHAN_WAIT_MS)
          skipTraceEvent(row.id, "부모 행이 없다");
        continue;
      }
      if (parent.status !== "sent" || !parent.slack_ts) {
        skipTraceEvent(row.id, "부모 게시 실패");
        continue;
      }
      threadTs = parent.slack_ts;
    }
    try {
      const res = await postToSlack(row.text, threadTs);
      if (res.ok && res.ts) markTraceEventSent(row.id, res.ts);
      else {
        const error = res.error ?? "unknown_error";
        markFailure(row, error, PERMANENT_ERRORS.has(error));
      }
    } catch (err) {
      markFailure(row, String(err), false);
    }
  }
};
