// 답장 후기록 — 발송·폐기 결과, 선톡 발송, 접은 자리 비움 예고와 틈새 한 줄, 연락 약속의 단계를 게시함에 쌓는다.
//
// 답장 본문은 trace/reply-post.ts가 호출 행을 읽어 뒤늦게 올리지만, 여기 있는 것은 그 일이
// 일어나는 자리(pending·bot·proactive-send·presence)가 그때 바로 쌓는다. 답장 결과는 그 답장을
// 만든 호출 스레드에 달리고, 선톡은 나간 뒤 발송 행이 따로 붙는다. 재시도를 다 쓰고 끝내 못
// 나가면 그 문안 스레드에 발송 포기가 달린다 — 문안만 보고 나간 것으로 읽지 않게.
// 자리 비움 예고와 틈새 한 줄을 코드가 접은 자리도 사유와 함께 같은 게시함에 쌓는다(traceAwaySkip·
// traceGlanceSkip).
// 캐릭터가 한 연락 약속이 그 뒤 어떻게 됐는지(맡김·다시 걺·지킴·접음·거둠·포기)도 약속을 한
// 답장 스레드에 단다(tracePromise, 이슈 #312) — 약속은 답장 본문에 시각까지 적히는데 그
// 시각에 무슨 일이 있었는지는 콘솔에만 남아 슬랙에서는 지켰는지 알 수 없었다.

import { kstLogicalDate, clockLabel } from "./kst.js";
import { recordTraceEvent, traceEnabled } from "./trace.js";
import {
  callKey,
  clip,
  clock,
  esc,
  quote,
  SEND_KIND_NAME,
} from "./trace/format.js";

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
  const partial =
    p.delivered < p.total ? ` (${p.delivered}/${p.total}만 나감)` : "";
  recordTraceEvent({
    characterId: p.characterId,
    kind: "proactive_send",
    text: `:calling: *${name} 발송* · ${clock()}${partial}\n${quote(clip(p.text, 500))}`,
  });
};

/**
 * 선톡이 문안까지 만들어 놓고 끝내 못 나간 자리(presence·followup의 catch).
 * 실패는 send_failures 표에도 적지만 그것만으로는 채널에 아무 표시가 없어서, 문안만 남은
 * 채널을 보면 나간 것으로 읽힌다. 문안 호출 번호를 알면 그 문안 스레드에 달아 준다.
 */
export const traceProactiveFail = (p: {
  characterId: number;
  kind: string;
  error: string;
  callId?: number;
}): void => {
  if (!traceEnabled()) return;
  const name = SEND_KIND_NAME[p.kind] ?? `${p.kind} 선톡`;
  recordTraceEvent({
    characterId: p.characterId,
    kind: "proactive_fail",
    parentKey: p.callId ? callKey(p.callId) : undefined,
    text: `:x: *${name} 발송 포기* · ${clock()} — ${esc(clip(p.error, 300))}`,
  });
};

/** 자리 비움 예고를 접은 사유. 값은 kind에 그대로 실어 나중에 사유별로 셀 수 있게 한다. */
export type AwaySkipReason = "just_spoke" | "no_away" | "conversation_moved";

const AWAY_SKIP_NAME: Record<AwaySkipReason, string> = {
  just_spoke: "캐릭터가 방금 말했다",
  no_away: "문안에 자리를 비우는 일이 없다",
  conversation_moved: "문안을 만드는 사이 마지막 메시지가 바뀌었다",
};

/**
 * 자리 비움 예고를 접은 자리(presence.ts). 예고가 안 나가는 것 자체는 정상이지만 왜 안
 * 나갔는지가 어디에도 없으면, 문안까지 만들어 놓고 접은 날 채널에는 문안만 남아 나간 것으로
 * 읽힌다. 문안 호출 번호를 알면 그 문안 스레드에 달고, 부르기 전에 접은 자리는 독립 행이다.
 *
 * 같은 블록에 같은 사유는 하루 한 번만 쌓는다 — 10분 틱이 같은 창을 두 번 지나기 때문이다.
 */
export const traceAwaySkip = (p: {
  characterId: number;
  reason: AwaySkipReason;
  activity: string;
  /** 예고하려던 블록의 시작 시각. 하루 안에서 이 예고를 가리키는 이름이다. */
  block: string;
  detail?: string;
  /** 문안을 만든 호출 번호. 부르기 전에 접었으면 없다. */
  callId?: number;
}): void => {
  if (!traceEnabled()) return;
  recordTraceEvent({
    characterId: p.characterId,
    kind: `away_skip_${p.reason}`,
    dedupeKey: `away_skip:${p.characterId}:${kstLogicalDate()}:${p.block}:${p.reason}`,
    parentKey: p.callId ? callKey(p.callId) : undefined,
    text:
      `:mute: *자리비움 예고 접음* · ${clock()} — ${clockLabel(p.block)} ${esc(p.activity)}` +
      `\n${AWAY_SKIP_NAME[p.reason]}${p.detail ? ` (${esc(p.detail)})` : ""}`,
  });
};

/** 틈새 한 줄을 접은 사유. 값은 kind에 그대로 실어 나중에 사유별로 셀 수 있게 한다. */
export type GlanceSkipReason = "not_check" | "conversation_moved";

const GLANCE_SKIP_NAME: Record<GlanceSkipReason, string> = {
  not_check: "있는지·뭐 하는지 묻는 확인 말이 아니라 모델이 보내지 않았다",
  conversation_moved: "문안을 만드는 사이 마지막 메시지가 바뀌었다",
};

/**
 * 틈새 한 줄을 접은 자리(glance.ts). 모델이 확인 말이 아니라고 답해 접은 것은 그 판정
 * 호출 스레드에 달린다 — 문안만 남아 나간 것으로 읽히지 않게. 같은 블록에 같은 사유는
 * 하루 한 번만 쌓는다(이슈 #339).
 */
export const traceGlanceSkip = (p: {
  characterId: number;
  reason: GlanceSkipReason;
  activity: string;
  /** 그 불가 블록의 시작 시각. 하루 안에서 이 틈새 한 줄을 가리키는 이름이다. */
  block: string;
  /** 판정 호출 번호. 부르기 전에 접었으면 없다. */
  callId?: number;
}): void => {
  if (!traceEnabled()) return;
  recordTraceEvent({
    characterId: p.characterId,
    kind: `glance_skip_${p.reason}`,
    dedupeKey: `glance_skip:${p.characterId}:${kstLogicalDate()}:${p.block}:${p.reason}`,
    parentKey: p.callId ? callKey(p.callId) : undefined,
    text:
      `:mute: *틈새 한 줄 접음* · ${clock()} — ${clockLabel(p.block)} ${esc(p.activity)}` +
      `\n${GLANCE_SKIP_NAME[p.reason]}`,
  });
};

// ── 연락 약속이 그 뒤 어떻게 됐는지 ──────────────────────────────────

/** 약속 행이 울린 뒤 갈 수 있는 길. 값은 kind에 그대로 실어 나중에 길별로 셀 수 있게 한다. */
export type PromiseStage =
  | "deferred" // 깨우기 표시가 걸려 있어 몰아 답장에 맡겼다
  | "rescheduled" // 답장 불가 구간이라 다음 블록 끝으로 다시 걸었다
  | "no_slot" // 답장 불가 구간인데 다시 걸 블록이 없어 접었다
  | "replied" // 그 사이 온 말이 있어 답장으로 지켰다
  | "sent" // 온 말이 없어 약속대로 먼저 연락했다
  | "skipped" // 문안까지 만들고 접었다
  | "dropped" // 울리기 전에 거뒀다(새 약속으로 갈아 끼움 등)
  | "gave_up"; // 재시도를 다 쓰고 포기했다

const PROMISE_STAGE_NAME: Record<PromiseStage, string> = {
  deferred: "깨우기 표시가 걸려 있어 몰아 답장에 맡김",
  rescheduled: "답장 불가 구간이라 다시 걺",
  no_slot: "답장 불가 구간인데 다시 걸 블록이 없어 접음",
  replied: "그 사이 온 말이 있어 답장으로 지킴",
  sent: "약속대로 먼저 연락함",
  skipped: "약속 연락 접음",
  dropped: "약속 거둠",
  gave_up: "약속 연락 포기",
};

const PROMISE_STAGE_ICON: Record<PromiseStage, string> = {
  deferred: ":hourglass_flowing_sand:",
  rescheduled: ":hourglass_flowing_sand:",
  no_slot: ":mute:",
  replied: ":white_check_mark:",
  sent: ":white_check_mark:",
  skipped: ":mute:",
  dropped: ":wastebasket:",
  gave_up: ":x:",
};

/**
 * 연락 약속이 그 뒤 어떻게 됐는지(bot.ts 약속 처리·keepPromise, pending.ts). 약속을 한 답장의
 * 호출 번호를 알면 그 스레드에 달아 답장 본문의 *약속* 줄 아래에서 이어 읽게 하고, 문안을
 * 만든 호출도 있으면 그 스레드에도 단다 — 문안만 보면 나갔는지 접었는지 알 수 없어서다.
 * 둘 다 모르면 독립 행이다. 같은 행의 같은 길은 한 번만 쌓는다(재시도가 같은 자리를 두 번 지난다).
 */
export const tracePromise = (p: {
  characterId: number;
  /** pending_replies의 약속 행 번호. */
  rowId: number;
  stage: PromiseStage;
  promise: string;
  /** 약속을 한 답장의 호출 번호. */
  callId?: number | null;
  /** 약속 시각에 문안을 만든 호출 번호(먼저 연락하는 길). */
  draftCallId?: number | null;
  detail?: string;
}): void => {
  if (!traceEnabled()) return;
  const head =
    `${PROMISE_STAGE_ICON[p.stage]} *약속* ${PROMISE_STAGE_NAME[p.stage]} · ${clock()}` +
    `${p.detail ? ` — ${esc(p.detail)}` : ""}\n${quote(clip(p.promise, 300))}`;
  const parents = [...new Set([p.callId, p.draftCallId].filter((id): id is number => !!id))];
  if (!parents.length) {
    recordTraceEvent({
      characterId: p.characterId,
      kind: `promise_${p.stage}`,
      dedupeKey: `promise:${p.rowId}:${p.stage}`,
      text: head,
    });
    return;
  }
  for (const parent of parents)
    recordTraceEvent({
      characterId: p.characterId,
      kind: `promise_${p.stage}`,
      dedupeKey: `promise:${p.rowId}:${p.stage}:${parent}`,
      parentKey: callKey(parent),
      text: head,
    });
};
