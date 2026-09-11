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
// 불가 구간의 몰아 답장 표시도 걸고 거두고 울리는 자리마다 쌓고(traceWake), 답장 경로가
// 답장 없이 예외로 끝난 자리도 단계와 사유를 남긴다(traceReplyFault, 이슈 #379) — 이 둘이
// 없으면 답장이 안 나간 날과 아직 기다리는 날이 밖에서 똑같이 조용해 보인다.

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
 * 발송 직전에 깨진 글자(U+FFFD·짝 없는 서러게이트)를 걸러낸 자리(bot.ts sendBubbleList,
 * 이슈 #395). 원인이 모델 응답 쪽이라 코드로 막을 수 없어, 실제로 얼마나 자주 나는지는 여기
 * 쌓이는 줄 수로 센다 — DB에는 거른 뒤 글자만 남으므로 원문은 이 게시함에만 남는다.
 */
export const traceGarbledFilter = (p: {
  characterId?: number;
  raw: string;
  filtered: string;
}): void => {
  if (!traceEnabled()) return;
  recordTraceEvent({
    characterId: p.characterId,
    kind: "garbled_filtered",
    text:
      `:warning: *깨진 글자 걸러냄* · ${clock()}\n` +
      `원문 ${quote(clip(esc(p.raw), 200))}\n` +
      `거른 뒤 ${quote(clip(esc(p.filtered), 200))}`,
  });
};

/**
 * 선톡이 실제로 나간 자리(bot.ts sendProactive).
 * 아침·안부는 전날 밤에 만든 문안이라 문안 호출과 발송이 몇 시간 떨어져 있다 —
 * 스레드로 잇지 않고 독립 행으로 둔다.
 * 근거 줄은 부르는 쪽이 발송 기록의 meta_json으로 만들어 넘긴다(proactive-policy의
 * basisLineFromMeta) — 선톡은 근거 종류 넷 가운데 하나를 반드시 갖는다(설계 원본 §9).
 */
export const traceProactiveSend = (p: {
  characterId: number;
  kind: string;
  text: string;
  delivered: number;
  total: number;
  /** 무슨 근거로 나간 한 통인지 — 의도(이어갈 자리)·일정(12:00 블록)·달래기·약속(행 12). */
  basis?: string | null;
}): void => {
  if (!traceEnabled()) return;
  const name = SEND_KIND_NAME[p.kind] ?? `${p.kind} 선톡`;
  const partial =
    p.delivered < p.total ? ` (${p.delivered}/${p.total}만 나감)` : "";
  const basis = p.basis ? `*근거* ${esc(p.basis)}\n` : "";
  recordTraceEvent({
    characterId: p.characterId,
    kind: "proactive_send",
    text: `:calling: *${name} 발송* · ${clock()}${partial}\n${basis}${quote(clip(p.text, 500))}`,
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
  const parents = [
    ...new Set([p.callId, p.draftCallId].filter((id): id is number => !!id)),
  ];
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

// ── 몰아 답장을 걸어 두는 표시가 그 뒤 어떻게 됐는지 ──────────────────

/** 깨우기 표시가 지나는 자리. 값은 kind에 그대로 실어 나중에 자리별로 셀 수 있게 한다. */
export type WakeStage =
  | "armed" // 답장 불가 구간이라 구간 끝에 울릴 표시를 걸었다
  | "merged" // 표시가 이미 걸려 있어 메시지만 쌓는다
  | "promoted" // 자리 비움 틱이 걸어 둔 표시를 몰아 답장으로 올렸다
  | "dropped" // 불가 구간이 아닌 길로 답장이 나가게 돼 거뒀다
  | "yielded" // 울릴 때 다른 경로가 답하는 중이라 양보했다
  | "no_turn" // 울렸는데 몰아 답할 메시지를 찾지 못했다
  | "no_reply" // 울려서 답장을 만들었는데 그 답장을 버렸다
  | "no_last" // 울렸는데 직전 발화가 없거나 캐릭터 것이 아니다
  | "busy" // 복귀 인사 자리가 차 있어 인사를 접었다
  | "gave_up"; // 재시도를 다 쓰고 발송을 포기했다

const WAKE_STAGE_NAME: Record<WakeStage, string> = {
  armed: "구간 끝에 울릴 표시를 걺",
  merged: "표시가 이미 걸려 있어 메시지만 쌓음",
  promoted: "구간 끝 표시를 몰아 답장으로 올림",
  dropped: "표시 거둠",
  yielded: "다른 경로가 답하는 중이라 양보",
  no_turn: "몰아 답할 메시지를 찾지 못함",
  no_reply: "만든 답장을 버림",
  no_last: "직전 발화가 없거나 캐릭터 것이 아님",
  busy: "복귀 인사 자리가 차 있어 접음",
  gave_up: "발송 포기",
};

const WAKE_STAGE_ICON: Record<WakeStage, string> = {
  armed: ":alarm_clock:",
  merged: ":inbox_tray:",
  promoted: ":arrow_up:",
  dropped: ":wastebasket:",
  yielded: ":mute:",
  no_turn: ":warning:",
  no_reply: ":warning:",
  no_last: ":warning:",
  busy: ":mute:",
  gave_up: ":x:",
};

/**
 * 몰아 답장 표시가 그 뒤 어떻게 됐는지(bot.ts 답장·깨우기 처리, pending.ts).
 *
 * 불가 구간에 온 메시지는 답장을 만들지 않고 구간 끝에 울릴 표시만 걸어 두는데, 이 자리가
 * 콘솔에만 남아 있어서 밖에서는 구간이 끝날 때까지 아무 일도 없는 것처럼 보였다(이슈 #379).
 * 표시가 울린 뒤 답장 없이 끝나는 갈래는 더 무겁다 — pending.ts가 그 행을 보낸 것으로
 * 확정해 재시도도 걸리지 않으므로, 여기 적히지 않으면 답장이 사라진 사실 자체가 남지 않는다.
 *
 * 같은 행의 같은 자리는 한 번만 쌓는다. 행 번호를 모르는 자리는 블록 단위로 하루 한 번 쌓는다.
 */
export const traceWake = (p: {
  characterId: number;
  /** pending_replies의 깨우기 행 번호. 걸기 전이거나 알 수 없으면 없다. */
  rowId?: number | null;
  stage: WakeStage;
  activity: string;
  /** 그 불가 블록의 시작·끝 시각. */
  block?: { start?: string | null; end?: string | null };
  detail?: string;
}): void => {
  if (!traceEnabled()) return;
  const start = p.block?.start;
  const end = p.block?.end;
  const span = start
    ? `${clockLabel(start)}${end ? `~${clockLabel(end)}` : ""} `
    : "";
  const name = `wake:${p.characterId}:${p.rowId ?? `${kstLogicalDate()}:${start ?? "?"}`}`;
  recordTraceEvent({
    characterId: p.characterId,
    kind: `wake_${p.stage}`,
    dedupeKey: `${name}:${p.stage}`,
    text:
      `${WAKE_STAGE_ICON[p.stage]} *몰아 답장* ${WAKE_STAGE_NAME[p.stage]} · ${clock()}` +
      `${p.detail ? ` — ${esc(p.detail)}` : ""}` +
      `\n${span}${esc(clip(p.activity, 120))}`,
  });
};

// ── 답장 경로가 예외로 끝난 자리 ──────────────────────────────────────

/** 답장이 멈춘 단계. 값은 kind에 그대로 실어 나중에 단계별로 셀 수 있게 한다. */
export type ReplyFaultStage =
  | "no_turn" // 답할 유저 메시지를 찾지 못했다
  | "respond" // 텀 계산·조립·저장 어딘가에서 예외로 끝났다
  | "recover" // 놓친 답장 복구가 예외로 끝났다
  | "bot"; // 봇 핸들러 어딘가에서 예외로 끝났다

const REPLY_FAULT_NAME: Record<ReplyFaultStage, string> = {
  no_turn: "답할 유저 메시지를 찾지 못함",
  respond: "답장을 만들다 멈춤",
  recover: "놓친 답장 복구가 멈춤",
  bot: "메시지 처리가 멈춤",
};

/**
 * 답장 경로가 답장 없이 끝난 자리(bot.ts). 텀 계산·조립·저장 어디서 터지든 콘솔 한 줄만
 * 남아서, 유저는 답장을 못 받는데 채널은 조용했다(이슈 #379). 어느 단계에서 멈췄는지와
 * 사유를 남겨 정상 대기와 구분되게 한다.
 *
 * 같은 대화의 같은 단계는 분 단위로 한 번만 쌓는다 — 같은 예외가 틱마다 되풀이될 때
 * 채널이 같은 줄로 덮이지 않게.
 */
export const traceReplyFault = (p: {
  characterId?: number | null;
  chatId?: string;
  stage: ReplyFaultStage;
  detail: string;
}): void => {
  if (!traceEnabled()) return;
  const minute = clock().slice(0, 5);
  recordTraceEvent({
    characterId: p.characterId ?? undefined,
    kind: `reply_fault_${p.stage}`,
    dedupeKey: `reply_fault:${p.chatId ?? "?"}:${p.stage}:${kstLogicalDate()}:${minute}`,
    text:
      `:rotating_light: *답장 멈춤* ${REPLY_FAULT_NAME[p.stage]} · ${clock()}` +
      `\n${esc(clip(p.detail, 400))}`,
  });
};
