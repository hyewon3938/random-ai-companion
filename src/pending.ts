// 만들어 둔 답장과 구간 끝·약속 행을 정한 시각에 울리고, 결과를 행의 상태·사유로 닫는 자리.
//
// 답장·구간 끝·약속은 연락 예약 표(outbox)의 한 행이다(outgoing.md 「연락 예약 표」, 이슈 #476).
// 이 파일이 행을 넣고 타이머를 걸고, 시각이 되면 행을 다시 읽어 보내거나 핸들러에 넘긴 뒤 결과를
// 상태(보냄·부분 발송·건너뜀·폐기·실패)와 사유로 적는다. 발송이 실패하면 1·2·5·10분 간격으로
// 다시 보내 20분 가까이 버틴다(RETRY_MS). 부팅하면 resumePendingReplies가 이어받고, 유저가 말을
// 더 보내면 dropPendingReplies로 버린 뒤 텀부터 다시 계산한다.
//
// 울릴지 말지는 그 시각의 행 상태가 정한다 — 걸어 둔 타이머가 아니라 표를 다시 읽는다.
// 캐릭터를 끝내는 도구는 다른 프로세스에서 행을 거두므로 이 프로세스의 타이머가 남는다.
//
// 재시도를 다 쓰고 행을 닫을 때는 그 행이 지고 있던 답장 책임도 함께 놓는다
// (releaseRecoveryMark). 그래야 복구 틱이 이어받아 그 시점의 대화로 답장을 새로 만든다.
//
// 답장 불가 구간의 끝에 울릴 행은 kind='block_end'다. 자리 비움 틱이 구간에 들어가며 거는 행은
// 유저 첫 발화 시각이 비어 있고, 유저가 그 구간에 말을 걸면 그 시각이 적힌다(promoteWakeRow).
// 첫 발화 시각이 있는 행만 isWaiting에 들어가 선톡 틱이 물러난다. 이 행을 거는 armReturnRow도
// 여기 있다 — 자리 비움 틱과 구간 끝 핸들러가 같은 함수로 걸어야 조건(한 구간에 행 하나, 약속
// 행이 있으면 안 걺)이 두 곳에서 어긋나지 않는다(이슈 #341).
//
// 캐릭터가 답장에서 한 연락 약속은 kind='promise' 행이다(이슈 #308). 약속 시각에 울리면 그때
// 모델을 불러 말을 만든다. 유저가 말을 더 보내도 살아남고 선톡 틱을 막지 않으며, 지우는 것은
// dropPromiseRows다. 약속을 거두거나 포기할 때는 그 약속을 한 답장의 슬랙 스레드에 남기고
// (tracePromise, 이슈 #312), 구간 끝 행도 같은 모양으로 남긴다(traceWake, 이슈 #379).
//
// 핸들러는 행을 어떻게 닫을지를 돌려주고(HandlerOutcome), 던지면 재시도를 탄다. 선톡 잠금에
// 막힌 것은 시도로 세지 않고 같은 간격으로 다시 걸며, 30분 넘게 이어지면 양보로 닫는다.
//
// 발송 함수와 구간 끝·약속 핸들러는 bot.ts가 setPendingSender·setWakeHandler·setPromiseHandler로
// 넣어 준다 — 여기서 bot.ts를 부르면 순환 참조가 된다.

import {
  bumpOutboxAttempt,
  closeOutboxRow,
  closeWaitingRowsOf,
  getRecoveryMark,
  getWaitingOutboxRow,
  getWaitingOutboxRows,
  hasWaitingPromiseRow,
  hasWaitingReply,
  hasWaitingWakeRow,
  insertOutboxRow,
  insertOutboxRowByRowKey,
  markOutboxDelivered,
  markOutboxLocked,
  outboxKey,
  parsePayload,
  setRecoveryMark,
  type BlockEndPayload,
  type OutboxReason,
  type OutboxRow,
  type PromisePayload,
  type ReplyPayload,
} from "./db.js";
import { saveTodayNote } from "./memory.js";
import {
  tracePromise,
  traceReplyOutcome,
  traceWake,
} from "./reply-trace.js";
import { getKstNow, kstDateString, kstLogicalClock } from "./kst.js";
import { toMin } from "./context/day-progress.js";
import { BLOCK_END_JITTER_MS } from "./thresholds.js";
import type { PlanBlock } from "./day-plan.js";

// 대기 중인 답장.
//
// 즉답·틈틈이 답장은 텀을 정한 뒤 바로 만들고, 정해진 시각이 되면 보낸다. 만들어 두고
// 기다리면 몇 분 뒤에 나가는 답장이 방금 본 것처럼 읽히지 않는다.
//
// 답장 불가 구간은 미리 만들지 않는다 — 몇 시간 뒤의 답장을 지금 만들면 그 사이 온 메시지를
// 못 담고, "방금 봤다"는 결도 거짓이 된다. 대신 구간 끝 행 하나만 남겨 구간이 끝나는 시각에
// 울리게 하고, 그때 쌓인 메시지를 읽어 한 번에 답장을 만든다(만드는 쪽은 pending-handlers.ts).
// 한 구간에 행은 하나이고, 울릴 때 무엇을 할지는 그 시점의 유저 첫 발화 시각과 대화 기록으로
// 갈린다. 행으로 남으므로 프로세스가 다시 떠도 이어간다.

// 실패한 발송을 다시 시도하는 간격. 몇 번째 실패인지로 골라 쓰고, 표가 끝나면 행을 닫는다.
//
// 60초 3회(≈2분)로 두었더니 텔레그램으로 가는 길이 몇 분 끊긴 날 만들어 둔 답장을 그대로
// 버렸다. 나쁜 구간은 수 분에서 수십 분씩 이어지므로 촘촘히 조르지 말고 1·2·5·10분으로
// 넓혀 18분을 덮는다. 그 사이 유저가 말을 더 보내면 dropPendingReplies가 폐기로
// 거두므로, 오래된 답장이 뒤늦게 나갈 걱정은 없다.
const RETRY_MS = [60_000, 120_000, 300_000, 600_000];

// 구간 끝 행과 약속 연락은 표의 앞 두 칸(1·2분)까지만 쓴다 — 지금까지와 같은 3회다.
//
// 이쪽은 만들어 둔 문안을 보내는 자리가 아니라 그 자리에서 모델을 불러 몰아 답장을 새로
// 만드는 길이라, 한 번 더 시도할 때마다 호출이 한 번 더 든다. 게다가 실패한 행이 닫히면
// 복구 표시가 풀려 2분 틱이 같은 일을 이어받으므로(releaseRecoveryMark), 여기서 오래
// 붙잡고 있을 이유가 없다.
const WAKE_RETRIES = 2;

// 선톡 잠금 충돌이 이만큼 이어지면 행을 양보로 닫는다(이슈 #476).
//
// 잠금은 다른 선톡이나 답장이 잠깐 잡는 것이라 시도로 세지 않고 같은 간격으로 다시 건다.
// 끝없이 기다리면 구간 끝 인사가 다음 구간까지 밀려 엉뚱한 때 나가므로 상한을 둔다. 30분은
// 선톡 틱 주기를 한 번 넘기는 길이로 고른 값이라 바꿔도 행 모양은 그대로다.
const LOCK_CAP_MS = 30 * 60_000;

/** 받은 행이 답장 책임을 진 유저 메시지 시각. 답장은 답하는 메시지, 구간 끝은 첫 발화다. */
const answeredAt = (row: OutboxRow): string | undefined => {
  if (row.kind === "reply") return parsePayload<ReplyPayload>(row).userMsgAt;
  if (row.kind === "block_end")
    return parsePayload<BlockEndPayload>(row).userFirstAt;
  return undefined;
};

/**
 * 이 행이 지고 있던 답장 책임을 놓는다 — 발송을 끝내 못 하고 행을 닫는 자리에서 부른다.
 *
 * 답장을 만들 때 bot.ts가 복구 표시(recovery_marks)를 유저 메시지 시각으로 찍는다. 저장된
 * 이 행이 발송을 보장하니 복구 틱이 같은 메시지에 다시 답하지 않아도 된다는 뜻이다. 행이
 * 실패로 닫히면 그 보장이 사라지므로 표시도 함께 거둔다. 그대로 두면 복구 틱이 이미 답한
 * 메시지로 읽고 건너뛰어, 유저가 보낸 말이 아무 답도 못 받은 채 남는다.
 *
 * 지금 표시가 이 행의 유저 메시지 시각과 같을 때만 지운다. 그 사이 다른 경로가 새로 찍은
 * 표시까지 지우면 그쪽이 책임진 답장이 두 번 나간다.
 *
 * 밖에서 부를 일은 없고, 지우는 조건을 테스트에서 재려고 열어 둔다.
 */
export const releaseRecoveryMark = (row: OutboxRow): void => {
  const at = answeredAt(row);
  if (!at || getRecoveryMark(row.chat_id) !== at) return;
  setRecoveryMark(row.chat_id, "");
  console.log(
    `[pending] 복구 표시 거둠 #${row.id} — 다음 복구 틱이 이어받는다`,
  );
};

/** 발송 결과. 기록 행 번호는 오늘 메모를 그 답장에 붙이는 데 쓴다(이슈 #346). */
export interface SenderResult {
  /** 발송을 적은 대화 기록 행의 번호. 기록을 안 적었으면 null. */
  messageId: number | null;
  /** 실제로 나간 말풍선 수. 받은 수보다 적으면 부분 발송으로 닫는다. */
  delivered: number;
}

/** 발송은 bot.ts가 한다 — 여기서 부르면 순환 참조가 되므로 등록받아 쓴다. */
export type PendingSender = (
  row: OutboxRow,
  bubbles: string[],
) => Promise<SenderResult>;

let sender: PendingSender | null = null;
export const setPendingSender = (fn: PendingSender): void => {
  sender = fn;
};

/**
 * 핸들러가 돌려주는 결과 — 행을 어떻게 닫을지. 던지면 재시도를 타고, busy는 선톡 잠금에
 * 막힌 것이라 시도로 세지 않고 다시 건다.
 */
export type HandlerOutcome =
  | {
      status: "sent" | "partial";
      detail?: string;
      /** 문안을 만든 호출 번호. 약속 행의 종류별 값에 옮겨 적는다. */
      draftCallId?: number | null;
    }
  | {
      status: "skipped" | "dropped";
      reason: OutboxReason;
      detail?: string;
      draftCallId?: number | null;
    }
  | { status: "busy"; detail: string };

/** 구간 끝 행이 울리면 할 일도 bot.ts가 정한다 — 같은 이유로 등록받아 쓴다. */
export type WakeHandler = (row: OutboxRow) => Promise<HandlerOutcome>;

let wakeHandler: WakeHandler | null = null;
export const setWakeHandler = (fn: WakeHandler): void => {
  wakeHandler = fn;
};

/** 약속 시각이 되면 할 일도 bot.ts가 정한다. */
export type PromiseHandler = (row: OutboxRow) => Promise<HandlerOutcome>;

let promiseHandler: PromiseHandler | null = null;
export const setPromiseHandler = (fn: PromiseHandler): void => {
  promiseHandler = fn;
};

const timers = new Map<number, ReturnType<typeof setTimeout>>();

const epochOf = (ts: string): number =>
  new Date(ts.replace(" ", "T") + "+09:00").getTime();

const stampAfter = (ms: number): string => {
  const t = new Date(getKstNow().getTime() + ms);
  return `${kstDateString(t)} ${t.toISOString().slice(11, 19)}`;
};

const stamp = (): string => stampAfter(0);

const stringsOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** 문안 없이 울리는 행 — 구간 끝과 약속 연락. 등록된 핸들러가 그 자리에서 할 일을 정한다. */
const isHandlerKind = (kind: string): boolean =>
  kind === "block_end" || kind === "promise";

/** 이 파일이 타이머를 거는 종류. 아침·안부는 디스패처가 크론으로 집는다. */
const ARMED_KINDS: OutboxRow["kind"][] = ["reply", "block_end", "promise"];

const retryTable = (kind: string): number[] =>
  isHandlerKind(kind) ? RETRY_MS.slice(0, WAKE_RETRIES) : RETRY_MS;

/**
 * 이번 실패 뒤 얼마를 기다렸다 다시 보낼지. 표를 다 썼으면 null — 그 자리에서 행을 닫는다.
 *
 * row.attempts는 이번 것을 빼고 지금까지 쌓인 실패 횟수라 그대로 표의 자리가 된다. 그 값은
 * bumpOutboxAttempt가 행에 적어 두므로, 프로세스가 다시 떠서 arm이 행을 이어받아도 남은
 * 재시도가 처음부터 다시 시작되지 않는다.
 *
 * 밖에서 부를 일은 없고, 간격 표를 테스트에서 재려고 열어 둔다.
 */
export const retryDelayMs = (
  row: Pick<OutboxRow, "kind" | "attempts">,
): number | null => {
  const table = retryTable(row.kind);
  return row.attempts < table.length ? (table[row.attempts] ?? null) : null;
};

/** 잠금에 막혔을 때 다시 걸 간격. 시도로 세지 않으므로 지금 자리의 간격을 그대로 쓴다. */
const lockRetryMs = (row: Pick<OutboxRow, "kind" | "attempts">): number => {
  const table = retryTable(row.kind);
  return table[Math.min(row.attempts, table.length - 1)] ?? RETRY_MS[0]!;
};

const rearmAfter = (id: number, delay: number): void => {
  timers.set(
    id,
    setTimeout(() => {
      void fire(id);
    }, delay),
  );
};

/** 핸들러 행을 포기하거나 잠금 충돌로 접을 때 그 약속·구간을 트레이스에 남긴다. */
const traceHandlerRow = (
  row: OutboxRow,
  end: "gave_up" | "lock_cap",
  detail: string,
): void => {
  if (row.kind === "promise") {
    const p = parsePayload<PromisePayload>(row);
    tracePromise({
      characterId: row.character_id,
      rowId: row.id,
      stage: end === "gave_up" ? "gave_up" : "dropped",
      promise: p.promise ?? "",
      callId: row.call_id,
      detail,
    });
    return;
  }
  const p = parsePayload<BlockEndPayload>(row);
  traceWake({
    characterId: row.character_id,
    rowId: row.id,
    stage: end === "gave_up" ? "gave_up" : "busy",
    activity: p.activity ?? "하던 일",
    block: { start: p.blockStart, end: p.blockEnd },
    detail,
  });
};

const fireHandler = async (row: OutboxRow): Promise<void> => {
  const handler = row.kind === "promise" ? promiseHandler : wakeHandler;
  const label = row.kind === "promise" ? "약속 연락" : "구간 끝";
  if (!handler) return;
  let outcome: HandlerOutcome;
  try {
    outcome = await handler(row);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    bumpOutboxAttempt(row.id, msg);
    const delay = retryDelayMs(row);
    if (delay === null) {
      closeOutboxRow(row.id, "failed", "retries_exhausted", msg, null);
      if (row.kind === "block_end") releaseRecoveryMark(row);
      console.error(`[pending] ${label} 포기 #${row.id}: ${msg}`);
      traceHandlerRow(row, "gave_up", msg);
      return;
    }
    console.warn(
      `[pending] ${label} 실패 #${row.id} (${row.attempts + 1}번째), ${delay / 1000}초 뒤 재시도: ${msg}`,
    );
    rearmAfter(row.id, delay);
    return;
  }
  if (outcome.status === "busy") {
    // 잠금 충돌은 시도로 세지 않는다. 처음 막힌 시각부터 LOCK_CAP_MS가 지나면 양보로 닫는다.
    // 복구 표시는 건드리지 않는다 — 잠금에 막히는 행은 첫 발화 시각이 없는 구간 끝 행과 약속
    // 행이라 답장 책임을 지고 있지 않다. 책임을 진 구간 끝 행은 핸들러가 잠금을 보기 전에 닫는다.
    const since = markOutboxLocked(row.id, stamp(), outcome.detail);
    if (Date.now() - epochOf(since) >= LOCK_CAP_MS) {
      const detail = `잠금 충돌 — ${outcome.detail}`;
      closeOutboxRow(row.id, "dropped", "yielded", detail, null);
      console.warn(`[pending] ${label} 접음 #${row.id}: ${detail}`);
      traceHandlerRow(
        row,
        "lock_cap",
        `${since.slice(11, 16)}부터 ${detail}`,
      );
      return;
    }
    const delay = lockRetryMs(row);
    console.log(
      `[pending] ${label} 잠금 대기 #${row.id}, ${delay / 1000}초 뒤 다시: ${outcome.detail}`,
    );
    rearmAfter(row.id, delay);
    return;
  }
  const patch =
    outcome.draftCallId != null
      ? { draftCallId: outcome.draftCallId }
      : undefined;
  if ("reason" in outcome)
    closeOutboxRow(
      row.id,
      outcome.status,
      outcome.reason,
      outcome.detail ?? null,
      null,
      patch,
    );
  else
    markOutboxDelivered(
      row.id,
      outcome.status,
      outcome.detail ?? null,
      stamp(),
      patch,
    );
};

const fireReply = async (row: OutboxRow): Promise<void> => {
  if (!sender) return;
  const payload = parsePayload<ReplyPayload>(row);
  const bubbles = stringsOf(payload.bubbles);
  if (!bubbles.length) {
    closeOutboxRow(
      row.id,
      "failed",
      "broken_payload",
      "만들어 둔 답장을 읽지 못함",
      null,
    );
    releaseRecoveryMark(row);
    traceReplyOutcome({
      callId: row.call_id,
      outcome: "failed",
      detail: "만들어 둔 답장을 읽지 못함",
    });
    return;
  }
  try {
    const { messageId, delivered } = await sender(row, bubbles);
    const partial = delivered < bubbles.length;
    const counted = partial
      ? `말풍선 ${delivered}/${bubbles.length}`
      : `말풍선 ${bubbles.length}개`;
    markOutboxDelivered(
      row.id,
      partial ? "partial" : "sent",
      partial ? counted : null,
      stamp(),
    );
    traceReplyOutcome({ callId: row.call_id, outcome: "sent", detail: counted });
    // 남길 내용은 답장을 만들 때 같이 나온다. 보낸 뒤에 오늘 메모로 옮긴다 —
    // 못 보낸 답장의 내용이 오늘 있었던 일로 남지 않게. 어느 답장에 적은 메모인지도 함께
    // 남긴다: 대화 기록을 모델에 넘길 때 그 턴의 메모 칸을 이 번호로 찾는다(이슈 #346).
    saveTodayNote(
      row.character_id,
      stringsOf(payload.notes).filter((x) => x.trim()),
      messageId,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    bumpOutboxAttempt(row.id, msg);
    const delay = retryDelayMs(row);
    if (delay === null) {
      closeOutboxRow(row.id, "failed", "retries_exhausted", msg, null);
      releaseRecoveryMark(row);
      traceReplyOutcome({
        callId: row.call_id,
        outcome: "failed",
        detail: msg,
      });
      console.error(`[pending] 발송 포기 #${row.id}: ${msg}`);
      return;
    }
    console.warn(
      `[pending] 발송 실패 #${row.id} (${row.attempts + 1}번째), ${delay / 1000}초 뒤 재시도: ${msg}`,
    );
    rearmAfter(row.id, delay);
  }
};

const fire = async (id: number): Promise<void> => {
  timers.delete(id);
  // 울리기 직전에 행을 다시 읽는다. 걸어 둔 뒤에 두 가지가 바뀌어 있을 수 있다.
  //
  // 하나는 종류별 값이다 — 자리 비움 틱이 건 구간 끝 행에는 그 사이 유저 첫 발화 시각이 적힐 수
  // 있다. 다른 하나는 상태다 — getWaitingOutboxRow는 대기 행만 주므로, 거둔 행은 여기서 값이
  // 없어 울리지 않는다. 같은 프로세스에서 거두는 길(drop 함수 셋)은 타이머까지 지우지만 캐릭터를
  // 끝내는 도구는 다른 프로세스라 이 프로세스의 타이머가 그대로 남는다. 상태를 다시 읽어야 끝난
  // 캐릭터의 답장이 나가지 않는다.
  const row = getWaitingOutboxRow(id);
  if (!row) return;
  if (isHandlerKind(row.kind)) return fireHandler(row);
  if (row.kind === "reply") return fireReply(row);
};

const arm = (row: Pick<OutboxRow, "id" | "send_at">): void => {
  const prev = timers.get(row.id);
  if (prev) clearTimeout(prev);
  // epochOf는 진짜 UTC epoch를 주므로 비교도 Date.now()로 — getKstNow().getTime()은
  // +9h 시프트된 값이라 대기가 9시간 짧아져 전부 즉시 발송된다(스모크에서 확인된 버그).
  rearmAfter(row.id, Math.max(0, epochOf(row.send_at) - Date.now()));
};

/**
 * 만들어 둔 답장을 정한 시각에 보내도록 걸어 둔다. 같은 유저 메시지에 답하는 대기 답장이 이미
 * 있으면 넣지 않고 null을 준다(중복 방지 키 `답장:<유저 메시지 시각>`).
 */
export const schedulePendingReply = (p: {
  chatId: string;
  characterId: number;
  userMsgAt: string;
  bubbles: string[];
  notesToSave: string[];
  waitMs: number;
  /** 복구 답장이면 recover — 같은 종류(reply)로 넣고 종류별 값에 표시만 남긴다. */
  kind: "reply" | "recover";
  /** 이 답장을 만든 모델 호출 번호. 발송·폐기 결과를 그 호출의 트레이스에 잇는다. */
  callId?: number | null;
  /** 답장 신호에서 나온 관계 값(move·told_plan). 발송할 때 대화 기록 행의 meta_json에 옮겨 적는다. */
  replyMeta?: Record<string, unknown> | null;
}): { id: number; sendAt: string } | null => {
  const sendAt = stampAfter(p.waitMs);
  const payload: ReplyPayload = {
    userMsgAt: p.userMsgAt,
    bubbles: p.bubbles,
    ...(p.notesToSave.length ? { notes: p.notesToSave } : {}),
    ...(p.kind === "recover" ? { recover: true as const } : {}),
    ...(p.replyMeta && Object.keys(p.replyMeta).length
      ? { replyMeta: p.replyMeta }
      : {}),
  };
  const id = insertOutboxRow({
    kind: "reply",
    chatId: p.chatId,
    characterId: p.characterId,
    dedupeKey: outboxKey.reply(p.userMsgAt),
    sendAt,
    payload,
    callId: p.callId ?? null,
    createdAt: stamp(),
  });
  if (id === null) {
    console.warn(
      `[pending] 같은 메시지에 답하는 대기 답장이 이미 있어 넣지 않음 (chat=${p.chatId}, ${p.userMsgAt})`,
    );
    return null;
  }
  arm({ id, send_at: sendAt });
  console.log(
    `[pending] #${id} ${p.chatId} → ${sendAt} (${Math.round(p.waitMs / 1000)}초 뒤)`,
  );
  return { id, sendAt };
};

/** 구간 끝·약속 행이 기대는 불가 블록. */
export interface BlockRef {
  activity: string;
  blockStart: string;
  blockEnd: string;
}

/**
 * 구간이 끝나는 시각에 울릴 행을 건다. 무엇을 보낼지는 그때 정한다.
 *
 * userFirstAt은 그 구간에 유저가 처음 말한 시각이다. 답장 경로가 구간 안에서 온 말을 받아 걸 때
 * 채우고, 자리 비움 틱과 핸들러가 구간에 들어가며 걸 때는 비운다. 같은 구간의 대기 행이 이미
 * 있으면 넣지 않고 null을 준다(중복 방지 키 `구간끝:<블록 시작>`).
 */
export const scheduleBlockEndRow = (p: {
  chatId: string;
  characterId: number;
  block: BlockRef;
  userFirstAt?: string | null;
  waitMs: number;
}): { id: number; sendAt: string } | null => {
  const sendAt = stampAfter(p.waitMs);
  const payload: BlockEndPayload = {
    activity: p.block.activity,
    blockStart: p.block.blockStart,
    blockEnd: p.block.blockEnd,
    ...(p.userFirstAt ? { userFirstAt: p.userFirstAt } : {}),
  };
  const id = insertOutboxRow({
    kind: "block_end",
    chatId: p.chatId,
    characterId: p.characterId,
    dedupeKey: outboxKey.blockEnd(p.block.blockStart),
    sendAt,
    payload,
    createdAt: stamp(),
  });
  if (id === null) return null;
  arm({ id, send_at: sendAt });
  console.log(
    `[pending] 구간 끝 #${id} ${p.chatId} ${p.block.activity}${p.userFirstAt ? " (답할 말 있음)" : ""} → ${sendAt} (${Math.round(p.waitMs / 1000)}초 뒤)`,
  );
  return { id, sendAt };
};

/**
 * 캐릭터가 답장에서 한 연락 약속을 약속 시각에 건다. callId는 약속을 말한 답장의 호출 번호로,
 * 중복 방지 키(`약속:<호출 번호>`)와 모델 호출 번호 컬럼에 함께 들어간다. 호출 번호가 없으면
 * 키를 행 번호로 짓는다. 같은 약속의 대기 행이 이미 있으면 null.
 */
export const schedulePromiseRow = (p: {
  chatId: string;
  characterId: number;
  userMsgAt: string;
  waitMs: number;
  block: BlockRef;
  promise: string;
  callId: number | null;
}): { id: number; sendAt: string } | null => {
  const sendAt = stampAfter(p.waitMs);
  const payload: PromisePayload = {
    activity: p.block.activity,
    blockStart: p.block.blockStart,
    blockEnd: p.block.blockEnd,
    promise: p.promise,
    userMsgAt: p.userMsgAt,
  };
  const row = {
    kind: "promise" as const,
    chatId: p.chatId,
    characterId: p.characterId,
    sendAt,
    payload,
    callId: p.callId,
    createdAt: stamp(),
  };
  const id =
    p.callId != null
      ? insertOutboxRow({ ...row, dedupeKey: outboxKey.promise(p.callId) })
      : insertOutboxRowByRowKey(row);
  if (id === null) return null;
  arm({ id, send_at: sendAt });
  console.log(
    `[pending] 약속 연락 #${id} ${p.chatId} ${p.block.activity} → ${sendAt} (${Math.round(p.waitMs / 1000)}초 뒤)`,
  );
  return { id, sendAt };
};

/**
 * 지금 들어가 있는 자리 비움 불가 구간이 끝나는 시각에 구간 끝 행을 건다. 자리 비움 틱과
 * 구간 끝 핸들러가 같이 쓴다(이슈 #341).
 *
 * 예고를 보냈는지와 무관하게 건다 — 예고가 막혀 조용히 사라진 날이야말로 돌아와서 말을
 * 거는 게 필요한 날이다. 유저가 그 구간에 말을 걸면 이 행에 첫 발화 시각이 적혀
 * (promoteWakeRow) 몰아 답장 쪽으로 간다. 걸지 않고 null인 경우는 넷 — 울릴 행이 이미 있을 때
 * (한 구간에 행은 하나), 연락 약속이 걸려 있을 때(그 시각엔 약속 핸들러가 말을 건다), 구간이
 * 이미 끝났을 때, 같은 구간 키의 대기 행이 있을 때. exceptRowId는 지금 울리고 있는 행이다 —
 * 그 핸들러 안에서 다음 구간의 행을 걸 때 그 행은 아직 대기라 빼고 센다.
 *
 * userMsgAt은 부르는 쪽과의 모양을 지키려고 받기만 한다. 이 행은 유저 첫 발화 시각을 비운 채
 * 걸리고, 그 값은 유저가 구간 안에서 말을 걸 때 적힌다(outgoing.md 「구간 끝 행의 종류별 값」).
 */
export const armReturnRow = (p: {
  chatId: string;
  characterId: number;
  block: Pick<PlanBlock, "activity" | "start" | "end">;
  userMsgAt: string;
  exceptRowId?: number;
}): { id: number; sendAt: string } | null => {
  if (hasWaitingWakeRow(p.chatId, p.exceptRowId)) return null;
  if (hasWaitingPromiseRow(p.chatId)) return null;
  const remainMin = toMin(p.block.end) - toMin(kstLogicalClock());
  if (remainMin <= 0) return null;
  const waitMs =
    remainMin * 60_000 + Math.floor(Math.random() * BLOCK_END_JITTER_MS);
  return scheduleBlockEndRow({
    chatId: p.chatId,
    characterId: p.characterId,
    block: {
      activity: p.block.activity,
      blockStart: p.block.start,
      blockEnd: p.block.end,
    },
    waitMs,
  });
};

const clearTimers = (rows: OutboxRow[]): void => {
  for (const r of rows) {
    const t = timers.get(r.id);
    if (t) clearTimeout(t);
    timers.delete(r.id);
  }
};

/**
 * 기다리던 답장을 버린다.
 * 유저가 말을 더 보내면 답장의 내용도 텀도 다시 정해야 하므로, 만들어 둔 것은 쓰지 않는다.
 * 구간 끝 행과 약속 연락은 남는다 — 메시지가 더 쌓여도 그 시각에 한 번 깨서 읽는 건 같다.
 * detail은 행의 상세와 트레이스에 적는 버린 사유다. 약속 시각에 다시 만들 때는 사유를
 * 양보(yielded)로 적는다 — 유저가 말을 더 보낸 것이 아니라 약속 답장이 그 자리를 대신한다.
 */
export const dropPendingReplies = (
  chatId: string,
  detail = "유저가 말을 더 보내 다시 만든다",
  reason: "user_followup" | "yielded" = "user_followup",
): number => {
  const rows = closeWaitingRowsOf(chatId, "reply", "dropped", reason, detail);
  clearTimers(rows);
  for (const r of rows)
    traceReplyOutcome({
      callId: r.call_id,
      outcome: "superseded",
      detail,
    });
  return rows.length;
};

/**
 * 걸어 둔 연락 약속을 거둔다 — 같은 대화에 새 약속이 걸릴 때. detail은 행의 상세와 트레이스에
 * 적는 거둔 사유다.
 */
export const dropPromiseRows = (
  chatId: string,
  detail = "새 약속으로 갈아 끼운다",
  exceptRowId?: number,
): number => {
  const rows = closeWaitingRowsOf(
    chatId,
    "promise",
    "dropped",
    "replaced_promise",
    detail,
    exceptRowId,
  );
  clearTimers(rows);
  for (const r of rows)
    tracePromise({
      characterId: r.character_id,
      rowId: r.id,
      stage: "dropped",
      promise: parsePayload<PromisePayload>(r).promise ?? "",
      callId: r.call_id,
      detail,
    });
  return rows.length;
};

/** 구간 끝에 울릴 행을 거둔다 — 불가 구간이 아닌 길로 답장이 나가게 됐을 때. */
export const dropWakeRows = (chatId: string, detail?: string): number => {
  const rows = closeWaitingRowsOf(
    chatId,
    "block_end",
    "dropped",
    "yielded",
    detail ?? null,
  );
  clearTimers(rows);
  for (const r of rows) {
    const p = parsePayload<BlockEndPayload>(r);
    traceWake({
      characterId: r.character_id,
      rowId: r.id,
      stage: "dropped",
      activity: p.activity ?? "하던 일",
      block: { start: p.blockStart, end: p.blockEnd },
      detail,
    });
  }
  return rows.length;
};

/**
 * 유저가 답을 기다리는 중인가 — 선톡 틱과 선톡 잠금이 이 값을 보고 물러난다. 대기 답장과,
 * 유저 첫 발화 시각이 있는 구간 끝 행만 센다(db/sends.ts의 hasWaitingReply).
 */
export const isWaiting = (chatId: string): boolean => hasWaitingReply(chatId);

/**
 * 프로세스가 다시 떴을 때 남아 있는 대기 행을 이어서 건다. 답장·구간 끝·약속만 건다 —
 * 아침·안부는 디스패처가 크론으로 집는다.
 *
 * 재시도 중에 프로세스가 죽은 행은 보낼 시각이 이미 지나 있어 바로 울린다. 몇 번째 실패였는지는
 * 행의 attempts에 적혀 있어서(bumpOutboxAttempt), 남은 간격도 그 자리에서 이어진다.
 */
export const resumePendingReplies = (): void => {
  const rows = getWaitingOutboxRows(ARMED_KINDS);
  for (const r of rows) arm(r);
  if (rows.length) console.log(`[pending] 대기 행 ${rows.length}건 이어받음`);
};
