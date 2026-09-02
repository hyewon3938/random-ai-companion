// 만들어 둔 답장을 정한 시각에 내보내는 자리.
//
// 답장을 pending_replies에 적어 두고 정해진 시각에 발송한다(재시도 3회). 부팅하면
// resumePendingReplies가 이어받고, 유저가 말을 더 보내면 dropPendingReplies로 버린 뒤
// 텀부터 다시 계산한다.
//
// 재시도를 다 쓰고 행을 닫을 때는 그 행이 지고 있던 답장 책임도 함께 놓는다
// (releaseRecoveryMark). 그래야 복구 틱이 이어받아 그 시점의 대화로 답장을 새로 만든다.
//
// 답장 불가 구간의 깨우기 표시도 같은 표를 쓴다 — 문안 없이 kind='wake' 행으로 구간 끝
// 시각에 걸어 둔다. 유저가 말을 더 보내도 이 행은 살아남고(구간 끝 시각은 그대로다),
// 지우는 것은 dropWakeRows다. 기다리는 동안 isWaiting이 참이라 선톡 틱이 물러난다.
//
// 발송 함수와 깨우기 함수는 bot.ts가 setPendingSender·setWakeHandler로 넣어 준다 —
// 여기서 bot.ts를 부르면 순환 참조가 된다.

import {
  insertPendingReply,
  getWaitingPendingReplies,
  getPendingReply,
  hasWaitingPendingReply,
  supersedePendingReplies,
  supersedeWakeRows,
  markPendingReply,
  bumpPendingAttempt,
  getRecoveryMark,
  setRecoveryMark,
  type PendingReplyRow,
} from "./db.js";
import { saveTodayNote } from "./memory.js";
import { traceReplyOutcome } from "./reply-trace.js";
import { getKstNow, kstDateString } from "./kst.js";

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

const RETRY_MS = 60_000;
const MAX_ATTEMPTS = 3;

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

/** 발송은 bot.ts가 한다 — 여기서 부르면 순환 참조가 되므로 등록받아 쓴다. */
export type PendingSender = (
  row: PendingReplyRow,
  bubbles: string[],
) => Promise<void>;

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

const fire = async (fired: PendingReplyRow): Promise<void> => {
  timers.delete(fired.id);
  // 걸어 둔 뒤에 종류가 바뀌었을 수 있다 — 구간에 들어갈 때 건 'return' 행은 그 사이 유저가
  // 말을 걸면 'wake'가 된다. 타이머는 걸 때의 값을 들고 있으므로 여기서 지금 값을 다시 읽는다.
  const row = isWakeKind(fired.kind)
    ? (getPendingReply(fired.id) ?? fired)
    : fired;
  // 깨우기 표시 — 보낼 말풍선이 없고, 등록된 핸들러가 그 자리에서 할 일을 정한다.
  if (isWakeKind(row.kind)) {
    if (!wakeHandler) return;
    try {
      await wakeHandler(row);
      markPendingReply(row.id, "sent", stamp());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      bumpPendingAttempt(row.id, msg);
      if (row.attempts + 1 >= MAX_ATTEMPTS) {
        markPendingReply(row.id, "failed", null, msg);
        releaseRecoveryMark(row);
        console.error(`[pending] 깨우기 포기 #${row.id}: ${msg}`);
        return;
      }
      console.warn(
        `[pending] 깨우기 실패 #${row.id}, ${RETRY_MS / 1000}초 뒤 재시도: ${msg}`,
      );
      timers.set(
        row.id,
        setTimeout(() => {
          void fire({ ...row, attempts: row.attempts + 1 });
        }, RETRY_MS),
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
    await sender(row, bubbles);
    markPendingReply(row.id, "sent", stamp());
    traceReplyOutcome({
      callId: row.call_id,
      outcome: "sent",
      detail: `말풍선 ${bubbles.length}개`,
    });
    // 남길 내용은 답장을 만들 때 같이 나온다. 보낸 뒤에 오늘 메모로 옮긴다 —
    // 못 보낸 답장의 내용이 오늘 있었던 일로 남지 않게.
    if (row.note_to_save) saveTodayNote(row.character_id, row.note_to_save);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    bumpPendingAttempt(row.id, msg);
    if (row.attempts + 1 >= MAX_ATTEMPTS) {
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
      `[pending] 발송 실패 #${row.id}, ${RETRY_MS / 1000}초 뒤 재시도: ${msg}`,
    );
    timers.set(
      row.id,
      setTimeout(() => {
        void fire({ ...row, attempts: row.attempts + 1 });
      }, RETRY_MS),
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
      void fire(row);
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
  /** 상대가 서운해하는 기색을 답장이 읽었다(reply-signal의 userUpset). */
  userUpset?: boolean;
}): { id: number; sendAt: string } => {
  const sendAt = stampAfter(p.waitMs);
  const createdAt = stamp();
  // 표시는 행에 실어 두고 발송할 때 messages.meta_json으로 옮긴다 — 달래기 선톡을 보낼지는
  // 나중에 침묵 팔로업 틱이 messages만 읽고 정하므로, 답장이 나가는 자리에서 넘겨줘야 한다.
  const metaJson = p.userUpset ? JSON.stringify({ userUpset: true }) : null;
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

/**
 * 불가 구간이 끝나는 시각에 울릴 표시를 건다. 무엇을 보낼지는 그때 정한다.
 *
 * kind='wake'는 그 구간에 온 유저 메시지에 답해야 해서 거는 행이고, 'return'은 자리 비움 틱이
 * 구간에 들어가며 거는 행이라 아직 답할 말이 없다. 'return' 행은 선톡을 막지 않는다.
 */
export const scheduleWakeRow = (p: {
  chatId: string;
  characterId: number;
  userMsgAt: string;
  waitMs: number;
  meta: { activity: string; blockStart: string; blockEnd: string };
  kind?: "wake" | "return";
}): number => {
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
    `[pending] ${kind === "wake" ? "깨우기" : "구간 끝 표시"} #${id} ${p.chatId} ${p.meta.activity} → ${sendAt} (${Math.round(p.waitMs / 1000)}초 뒤)`,
  );
  return id;
};

/**
 * 기다리던 답장을 버린다.
 * 유저가 말을 더 보내면 답장의 내용도 텀도 다시 정해야 하므로, 만들어 둔 것은 쓰지 않는다.
 * 깨우기 표시는 남는다 — 메시지가 더 쌓여도 구간 끝에 한 번 깨서 몰아 읽는 건 같다.
 */
export const dropPendingReplies = (chatId: string): number => {
  const rows = supersedePendingReplies(chatId);
  for (const r of rows) {
    const t = timers.get(r.id);
    if (t) clearTimeout(t);
    timers.delete(r.id);
    traceReplyOutcome({
      callId: r.call_id,
      outcome: "superseded",
      detail: "유저가 말을 더 보내 다시 만든다",
    });
  }
  return rows.length;
};

/** 구간 끝에 울릴 표시를 거둔다(두 종류 다) — 불가 구간이 아닌 길로 답장이 나가게 됐을 때. */
export const dropWakeRows = (chatId: string): number => {
  const rows = supersedeWakeRows(chatId);
  for (const r of rows) {
    const t = timers.get(r.id);
    if (t) clearTimeout(t);
    timers.delete(r.id);
  }
  return rows.length;
};

export const isWaiting = (chatId: string): boolean =>
  hasWaitingPendingReply(chatId);

/** 프로세스가 다시 떴을 때 남아 있는 대기 답장을 이어서 건다. */
export const resumePendingReplies = (): void => {
  const rows = getWaitingPendingReplies();
  for (const r of rows) arm(r);
  if (rows.length) console.log(`[pending] 대기 답장 ${rows.length}건 이어받음`);
};
