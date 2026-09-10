// 만들어 둔 답장을 정한 시각에 내보내는 자리.
//
// 답장을 pending_replies에 적어 두고 정해진 시각에 발송한다. 발송이 실패하면 1·2·5·10분
// 간격으로 다시 보내 20분 가까이 버틴다(RETRY_MS). 부팅하면 resumePendingReplies가
// 이어받고, 유저가 말을 더 보내면 dropPendingReplies로 버린 뒤 텀부터 다시 계산한다.
//
// 울릴지 말지는 그 시각의 행 상태가 정한다 — 걸어 둔 타이머가 아니라 표를 다시 읽는다.
// 캐릭터를 끝내는 도구는 다른 프로세스에서 행을 거두므로 이 프로세스의 타이머가 남는다.
//
// 재시도를 다 쓰고 행을 닫을 때는 그 행이 지고 있던 답장 책임도 함께 놓는다
// (releaseRecoveryMark). 그래야 복구 틱이 이어받아 그 시점의 대화로 답장을 새로 만든다.
//
// 약속 행(kind='promise')을 거두거나 포기할 때는 그 약속을 한 답장의 슬랙 스레드에 남긴다
// (tracePromise, 이슈 #312) — 행의 meta에 실린 답장 호출 번호가 그 스레드를 가리킨다.
// 깨우기·복귀 인사 행을 거두거나 포기할 때도 같은 모양으로 남긴다(traceWake, 이슈 #379).
//
// 답장 불가 구간의 깨우기 표시도 같은 표를 쓴다 — 문안 없이 kind='wake' 행으로 구간 끝
// 시각에 걸어 둔다. 유저가 말을 더 보내도 이 행은 살아남고(구간 끝 시각은 그대로다),
// 지우는 것은 dropWakeRows다. 기다리는 동안 isWaiting이 참이라 선톡 틱이 물러난다.
//
// 아직 답할 말이 없는 구간 끝 표시(kind='return')를 거는 armReturnRow도 여기 있다 — 자리 비움
// 틱과 구간 끝 핸들러가 같은 함수로 걸어야 조건(한 구간에 행 하나, 약속 행이 있으면 안 걺)이
// 두 곳에서 어긋나지 않는다(이슈 #341).
//
// 캐릭터가 답장에서 한 연락 약속도 같은 표를 쓴다(이슈 #308) — 문안 없이 kind='promise'
// 행으로 약속 시각에 걸어 두고, 울리면 그때 모델을 불러 말을 만든다. 유저가 말을 더 보내도
// 살아남고 선톡 틱을 막지 않으며, 지우는 것은 dropPromiseRows다.
//
// 발송 함수와 깨우기·약속 함수는 bot.ts가 setPendingSender·setWakeHandler·setPromiseHandler로
// 넣어 준다 — 여기서 bot.ts를 부르면 순환 참조가 된다.

import {
  insertPendingReply,
  getWaitingPendingReplies,
  getPendingReply,
  hasWaitingPendingReply,
  hasWaitingPromiseRow,
  hasWaitingWakeRow,
  supersedePendingReplies,
  supersedeWakeRows,
  supersedePromiseRows,
  markPendingReply,
  bumpPendingAttempt,
  getRecoveryMark,
  setRecoveryMark,
  type PendingReplyRow,
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
// 못 담고, "방금 봤다"는 결도 거짓이 된다. 대신 행 하나만 남겨 구간이 끝나는 시각에 울리게
// 하고, 그때 쌓인 메시지를 읽어 한 번에 답장을 만든다(만드는 쪽은 bot.ts).
//
// 그 행은 두 종류다. 자리 비움 틱이 구간에 들어갈 때 거는 kind='return'은 아직 답할 말이 없고,
// 유저가 그 구간에 말을 걸면 kind='wake'로 바뀐다(promoteWakeRow). 한 구간에 행은 하나이고,
// 울릴 때 무엇을 할지는 그 시점의 종류로 갈린다. 어느 쪽이든 행으로 남으므로 프로세스가
// 다시 떠도 이어간다.

// 실패한 발송을 다시 시도하는 간격. 몇 번째 실패인지로 골라 쓰고, 표가 끝나면 행을 닫는다.
//
// 60초 3회(≈2분)로 두었더니 텔레그램으로 가는 길이 몇 분 끊긴 날 만들어 둔 답장을 그대로
// 버렸다. 나쁜 구간은 수 분에서 수십 분씩 이어지므로 촘촘히 조르지 말고 1·2·5·10분으로
// 넓혀 18분을 덮는다. 그 사이 유저가 말을 더 보내면 dropPendingReplies가 superseded로
// 거두므로, 오래된 답장이 뒤늦게 나갈 걱정은 없다.
const RETRY_MS = [60_000, 120_000, 300_000, 600_000];

// 깨우기·구간 끝 표시·약속 연락은 표의 앞 두 칸(1·2분)까지만 쓴다 — 지금까지와 같은 3회다.
//
// 이쪽은 만들어 둔 문안을 보내는 자리가 아니라 그 자리에서 모델을 불러 몰아 답장을 새로
// 만드는 길이라, 한 번 더 시도할 때마다 호출이 한 번 더 든다. 게다가 실패한 행이 닫히면
// 복구 표시가 풀려 2분 틱이 같은 일을 이어받으므로(releaseRecoveryMark), 여기서 오래
// 붙잡고 있을 이유가 없다.
const WAKE_RETRIES = 2;

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
export const releaseRecoveryMark = (row: PendingReplyRow): void => {
  if (getRecoveryMark(row.chat_id) !== row.user_msg_at) return;
  setRecoveryMark(row.chat_id, "");
  console.log(
    `[pending] 복구 표시 거둠 #${row.id} — 다음 복구 틱이 이어받는다`,
  );
};

/**
 * 발송은 bot.ts가 한다 — 여기서 부르면 순환 참조가 되므로 등록받아 쓴다.
 *
 * 돌려주는 값은 발송을 적은 대화 기록 행의 번호다. 오늘 메모를 그 답장에 붙이는 데 쓴다
 * (이슈 #346). 기록을 안 적었으면 null.
 */
export type PendingSender = (
  row: PendingReplyRow,
  bubbles: string[],
) => Promise<number | null>;

let sender: PendingSender | null = null;
export const setPendingSender = (fn: PendingSender): void => {
  sender = fn;
};

/** 깨우기 표시가 울리면 할 일도 bot.ts가 정한다 — 같은 이유로 등록받아 쓴다. */
export type WakeHandler = (row: PendingReplyRow) => Promise<void>;

let wakeHandler: WakeHandler | null = null;
export const setWakeHandler = (fn: WakeHandler): void => {
  wakeHandler = fn;
};

/** 약속 시각이 되면 할 일도 bot.ts가 정한다. 약속을 못 지킬 자리면 던져서 재시도를 탄다. */
export type PromiseHandler = (row: PendingReplyRow) => Promise<void>;

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

const parseBubbles = (row: PendingReplyRow): string[] => {
  try {
    const v = JSON.parse(row.bubbles_json) as unknown;
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
};

const isWakeKind = (kind: string): boolean =>
  kind === "wake" || kind === "return";

/** 문안 없이 울리는 행 — 깨우기 표시와 약속 연락. 등록된 핸들러가 그 자리에서 할 일을 정한다. */
const isHandlerKind = (kind: string): boolean =>
  isWakeKind(kind) || kind === "promise";

/**
 * 이번 실패 뒤 얼마를 기다렸다 다시 보낼지. 표를 다 썼으면 null — 그 자리에서 행을 닫는다.
 *
 * row.attempts는 이번 것을 빼고 지금까지 쌓인 실패 횟수라 그대로 표의 자리가 된다. 그 값은
 * bumpPendingAttempt가 행에 적어 두므로, 프로세스가 다시 떠서 arm이 행을 이어받아도 남은
 * 재시도가 처음부터 다시 시작되지 않는다.
 *
 * 밖에서 부를 일은 없고, 간격 표를 테스트에서 재려고 열어 둔다.
 */
export const retryDelayMs = (row: PendingReplyRow): number | null => {
  const table = isHandlerKind(row.kind)
    ? RETRY_MS.slice(0, WAKE_RETRIES)
    : RETRY_MS;
  return row.attempts < table.length ? table[row.attempts] : null;
};

const fire = async (id: number): Promise<void> => {
  timers.delete(id);
  // 울리기 직전에 행을 다시 읽는다. 두 가지가 걸어 둔 뒤에 바뀌어 있을 수 있다.
  //
  // 하나는 종류다 — 구간에 들어갈 때 건 'return' 행은 그 사이 유저가 말을 걸면 'wake'가 된다.
  // 다른 하나는 상태다 — getPendingReply는 waiting 행만 주므로, 거둔 행은 여기서 값이 없어
  // 울리지 않는다. 같은 프로세스에서 거두는 길(dropPendingReplies 셋)은 타이머까지 지우지만
  // 캐릭터를 끝내는 도구는 다른 프로세스라 이 프로세스의 타이머가 그대로 남는다. 상태를 다시
  // 읽어야 끝난 캐릭터의 답장이 나가지 않는다.
  const row = getPendingReply(id);
  if (!row) return;
  // 깨우기 표시·약속 연락 — 보낼 말풍선이 없고, 등록된 핸들러가 그 자리에서 할 일을 정한다.
  if (isHandlerKind(row.kind)) {
    const handler = row.kind === "promise" ? promiseHandler : wakeHandler;
    const label = row.kind === "promise" ? "약속 연락" : "깨우기";
    if (!handler) return;
    try {
      await handler(row);
      markPendingReply(row.id, "sent", stamp());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      bumpPendingAttempt(row.id, msg);
      const delay = retryDelayMs(row);
      if (delay === null) {
        markPendingReply(row.id, "failed", null, msg);
        if (row.kind !== "promise") releaseRecoveryMark(row);
        console.error(`[pending] ${label} 포기 #${row.id}: ${msg}`);
        const meta = parseWakeMeta(row);
        if (row.kind === "promise")
          tracePromise({
            characterId: row.character_id,
            rowId: row.id,
            stage: "gave_up",
            promise: meta.promise ?? "",
            callId: meta.callId,
            detail: msg,
          });
        else
          traceWake({
            characterId: row.character_id,
            rowId: row.id,
            stage: "gave_up",
            activity: meta.activity ?? "하던 일",
            block: { start: meta.blockStart, end: meta.blockEnd },
            detail: msg,
          });
        return;
      }
      console.warn(
        `[pending] ${label} 실패 #${row.id} (${row.attempts + 1}번째), ${delay / 1000}초 뒤 재시도: ${msg}`,
      );
      timers.set(
        row.id,
        setTimeout(() => {
          void fire(row.id);
        }, delay),
      );
    }
    return;
  }
  if (!sender) return;
  const bubbles = parseBubbles(row);
  if (!bubbles.length) {
    markPendingReply(row.id, "failed", null, "만들어 둔 답장을 읽지 못함");
    releaseRecoveryMark(row);
    traceReplyOutcome({
      callId: row.call_id,
      outcome: "failed",
      detail: "만들어 둔 답장을 읽지 못함",
    });
    return;
  }
  try {
    const messageId = await sender(row, bubbles);
    markPendingReply(row.id, "sent", stamp());
    traceReplyOutcome({
      callId: row.call_id,
      outcome: "sent",
      detail: `말풍선 ${bubbles.length}개`,
    });
    // 남길 내용은 답장을 만들 때 같이 나온다. 보낸 뒤에 오늘 메모로 옮긴다 —
    // 못 보낸 답장의 내용이 오늘 있었던 일로 남지 않게. 어느 답장에 적은 메모인지도 함께
    // 남긴다: 대화 기록을 모델에 넘길 때 그 턴의 메모 칸을 이 번호로 찾는다(이슈 #346).
    if (row.note_to_save)
      saveTodayNote(row.character_id, row.note_to_save, messageId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    bumpPendingAttempt(row.id, msg);
    const delay = retryDelayMs(row);
    if (delay === null) {
      markPendingReply(row.id, "failed", null, msg);
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
    timers.set(
      row.id,
      setTimeout(() => {
        void fire(row.id);
      }, delay),
    );
  }
};

const arm = (row: PendingReplyRow): void => {
  const prev = timers.get(row.id);
  if (prev) clearTimeout(prev);
  // epochOf는 진짜 UTC epoch를 주므로 비교도 Date.now()로 — getKstNow().getTime()은
  // +9h 시프트된 값이라 대기가 9시간 짧아져 전부 즉시 발송된다(스모크에서 확인된 버그).
  const delay = Math.max(0, epochOf(row.send_at) - Date.now());
  timers.set(
    row.id,
    setTimeout(() => {
      void fire(row.id);
    }, delay),
  );
};

/** 만들어 둔 답장을 정한 시각에 보내도록 걸어 둔다. */
export const schedulePendingReply = (p: {
  chatId: string;
  characterId: number;
  userMsgAt: string;
  bubbles: string[];
  noteToSave: string | null;
  waitMs: number;
  kind: string;
  /** 이 답장을 만든 모델 호출 번호. 발송·폐기 결과를 그 호출의 트레이스에 잇는다. */
  callId?: number | null;
  /** 답장 신호에서 나온 관계 값(move·told_plan). 발송할 때 대화 기록 행의 meta_json에 옮겨 적는다. */
  replyMeta?: Record<string, unknown> | null;
}): { id: number; sendAt: string } => {
  const sendAt = stampAfter(p.waitMs);
  const createdAt = stamp();
  // 답장 행의 meta_json은 관계 값(move·told_plan)만 싣는다 — 깨우기·약속 행처럼 자기 근거를
  // 싣는 자리가 아니라, 발송 뒤 대화 기록 행으로 옮겨 적을 값을 잠시 들고 가는 자리다.
  const metaJson =
    p.replyMeta && Object.keys(p.replyMeta).length
      ? JSON.stringify(p.replyMeta)
      : null;
  const id = insertPendingReply({
    chatId: p.chatId,
    characterId: p.characterId,
    userMsgAt: p.userMsgAt,
    bubbles: p.bubbles,
    noteToSave: p.noteToSave,
    sendAt,
    kind: p.kind,
    metaJson,
    callId: p.callId ?? null,
    createdAt,
  });
  arm({
    id,
    chat_id: p.chatId,
    character_id: p.characterId,
    user_msg_at: p.userMsgAt,
    bubbles_json: JSON.stringify(p.bubbles),
    note_to_save: p.noteToSave,
    send_at: sendAt,
    kind: p.kind,
    meta_json: metaJson,
    call_id: p.callId ?? null,
    attempts: 0,
    created_at: createdAt,
  });
  console.log(
    `[pending] #${id} ${p.chatId} → ${sendAt} (${Math.round(p.waitMs / 1000)}초 뒤)`,
  );
  return { id, sendAt };
};

/** 문안 없이 울리는 행이 들고 있는 값. 약속 연락은 약속 문장을 함께 둔다. */
export interface WakeMeta {
  activity: string;
  blockStart: string;
  blockEnd: string;
  /** kind='promise'일 때, 캐릭터가 답장에서 한 약속 한 문장. */
  promise?: string;
  /** kind='promise'일 때, 그 약속을 한 답장의 호출 번호 — 트레이스가 그 스레드에 단다. */
  callId?: number | null;
}

/** 약속 행의 meta를 읽는다. 깨져 있어도 약속 자체는 유효하므로 빈 값으로 돌려준다. */
export const parseWakeMeta = (row: PendingReplyRow): Partial<WakeMeta> => {
  try {
    return JSON.parse(row.meta_json ?? "{}") as Partial<WakeMeta>;
  } catch {
    return {};
  }
};

const WAKE_LABEL: Record<"wake" | "return" | "promise", string> = {
  wake: "깨우기",
  return: "구간 끝 표시",
  promise: "약속 연락",
};

/**
 * 구간이 끝나는 시각에 울릴 표시를 건다. 무엇을 보낼지는 그때 정한다.
 *
 * kind='wake'는 그 구간에 온 유저 메시지에 답해야 해서 거는 행이고, 'return'은 자리 비움 틱이
 * 구간에 들어가며 거는 행이라 아직 답할 말이 없다. 'promise'는 캐릭터가 답장에서 한 연락
 * 약속이다. 'return'과 'promise' 행은 선톡을 막지 않는다.
 */
export const scheduleWakeRow = (p: {
  chatId: string;
  characterId: number;
  userMsgAt: string;
  waitMs: number;
  meta: WakeMeta;
  kind?: "wake" | "return" | "promise";
}): { id: number; sendAt: string } => {
  const kind = p.kind ?? "wake";
  const sendAt = stampAfter(p.waitMs);
  const createdAt = stamp();
  const metaJson = JSON.stringify(p.meta);
  const id = insertPendingReply({
    chatId: p.chatId,
    characterId: p.characterId,
    userMsgAt: p.userMsgAt,
    bubbles: [],
    noteToSave: null,
    sendAt,
    kind,
    metaJson,
    createdAt,
  });
  arm({
    id,
    chat_id: p.chatId,
    character_id: p.characterId,
    user_msg_at: p.userMsgAt,
    bubbles_json: "[]",
    note_to_save: null,
    send_at: sendAt,
    kind,
    meta_json: metaJson,
    call_id: null,
    attempts: 0,
    created_at: createdAt,
  });
  console.log(
    `[pending] ${WAKE_LABEL[kind]} #${id} ${p.chatId} ${p.meta.activity} → ${sendAt} (${Math.round(p.waitMs / 1000)}초 뒤)`,
  );
  return { id, sendAt };
};

/**
 * 지금 들어가 있는 자리 비움 불가 구간이 끝나는 시각에 'return' 표시를 건다. 자리 비움 틱과
 * 구간 끝 핸들러가 같이 쓴다(이슈 #341).
 *
 * 예고를 보냈는지와 무관하게 건다 — 예고가 막혀 조용히 사라진 날이야말로 돌아와서 말을
 * 거는 게 필요한 날이다. 유저가 그 구간에 말을 걸면 이 행이 'wake'로 바뀌어(promoteWakeRow)
 * 몰아 답장 쪽으로 간다. 걸지 않고 null인 경우는 셋 — 울릴 행이 이미 있을 때(한 구간에 행은
 * 하나), 연락 약속이 걸려 있을 때(그 시각엔 약속 핸들러가 말을 건다), 구간이 이미 끝났을 때.
 * exceptRowId는 지금 울리고 있는 행이다 — 그 핸들러 안에서 다음 구간의 표시를 걸 때 그 행은
 * 아직 waiting이라 빼고 센다.
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
  return scheduleWakeRow({
    chatId: p.chatId,
    characterId: p.characterId,
    userMsgAt: p.userMsgAt,
    waitMs,
    meta: {
      activity: p.block.activity,
      blockStart: p.block.start,
      blockEnd: p.block.end,
    },
    kind: "return",
  });
};

/**
 * 기다리던 답장을 버린다.
 * 유저가 말을 더 보내면 답장의 내용도 텀도 다시 정해야 하므로, 만들어 둔 것은 쓰지 않는다.
 * 깨우기 표시와 약속 연락은 남는다 — 메시지가 더 쌓여도 그 시각에 한 번 깨서 읽는 건 같다.
 * detail은 트레이스에 적는 버린 사유. 약속 시각에 다시 만들 때는 그 사유로 적는다.
 */
export const dropPendingReplies = (
  chatId: string,
  detail = "유저가 말을 더 보내 다시 만든다",
): number => {
  const rows = supersedePendingReplies(chatId);
  for (const r of rows) {
    const t = timers.get(r.id);
    if (t) clearTimeout(t);
    timers.delete(r.id);
    traceReplyOutcome({
      callId: r.call_id,
      outcome: "superseded",
      detail,
    });
  }
  return rows.length;
};

/**
 * 걸어 둔 연락 약속을 거둔다 — 새 약속으로 갈아 끼우거나 몰아 답장이 그 자리를 덮을 때.
 * detail은 트레이스에 적는 거둔 사유.
 */
export const dropPromiseRows = (
  chatId: string,
  detail = "새 약속으로 갈아 끼운다",
  exceptRowId?: number,
): number => {
  const rows = supersedePromiseRows(chatId, exceptRowId);
  for (const r of rows) {
    const t = timers.get(r.id);
    if (t) clearTimeout(t);
    timers.delete(r.id);
    let meta: Partial<WakeMeta> = {};
    try {
      meta = JSON.parse(r.meta_json ?? "{}") as Partial<WakeMeta>;
    } catch {
      /* 약속 문장 없이 적는다 */
    }
    tracePromise({
      characterId: r.character_id,
      rowId: r.id,
      stage: "dropped",
      promise: meta.promise ?? "",
      callId: meta.callId,
      detail,
    });
  }
  return rows.length;
};

/** 구간 끝에 울릴 표시를 거둔다(두 종류 다) — 불가 구간이 아닌 길로 답장이 나가게 됐을 때. */
export const dropWakeRows = (chatId: string, detail?: string): number => {
  const rows = supersedeWakeRows(chatId);
  for (const r of rows) {
    const t = timers.get(r.id);
    if (t) clearTimeout(t);
    timers.delete(r.id);
    let meta: Partial<WakeMeta> = {};
    try {
      meta = JSON.parse(r.meta_json ?? "{}") as Partial<WakeMeta>;
    } catch {
      /* 활동 이름 없이 적는다 */
    }
    traceWake({
      characterId: r.character_id,
      rowId: r.id,
      stage: "dropped",
      activity: meta.activity ?? "하던 일",
      block: { start: meta.blockStart, end: meta.blockEnd },
      detail,
    });
  }
  return rows.length;
};

export const isWaiting = (chatId: string): boolean =>
  hasWaitingPendingReply(chatId);

/**
 * 프로세스가 다시 떴을 때 남아 있는 대기 답장을 이어서 건다.
 *
 * 재시도 중에 프로세스가 죽은 행은 보낼 시각이 이미 지나 있어 바로 울린다. 몇 번째 실패였는지는
 * 행의 attempts에 적혀 있어서(bumpPendingAttempt), 남은 간격도 그 자리에서 이어진다.
 */
export const resumePendingReplies = (): void => {
  const rows = getWaitingPendingReplies();
  for (const r of rows) arm(r);
  if (rows.length) console.log(`[pending] 대기 답장 ${rows.length}건 이어받음`);
};
