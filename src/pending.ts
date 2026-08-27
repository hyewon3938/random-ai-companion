import {
  insertPendingReply,
  getWaitingPendingReplies,
  hasWaitingPendingReply,
  supersedePendingReplies,
  markPendingReply,
  bumpPendingAttempt,
  type PendingReplyRow,
} from "./db.js";
import { saveTodayNote } from "./memory.js";
import { getKstNow, kstDateString } from "./kst.js";

// 대기 중인 답장.
//
// 답장은 텀을 정한 뒤 바로 만들고, 정해진 시각이 되면 보낸다. 만들어 두고 기다리면 그 사이에
// 무슨 일이 있는지를 각본에서 읽어 담을 수 있고, 몇 시간 뒤에 나가는 답장이 방금 본 것처럼
// 읽히지 않는다. 회의가 세 시간이면 세 시간 뒤에 나가므로 대기가 길어질 수 있어, 만든 답장을
// 행으로 남겨 프로세스가 다시 떠도 이어간다.

const RETRY_MS = 60_000;
const MAX_ATTEMPTS = 3;

/** 발송은 bot.ts가 한다 — 여기서 부르면 순환 참조가 되므로 등록받아 쓴다. */
export type PendingSender = (row: PendingReplyRow, bubbles: string[]) => Promise<void>;

let sender: PendingSender | null = null;
export const setPendingSender = (fn: PendingSender): void => {
  sender = fn;
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
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const fire = async (row: PendingReplyRow): Promise<void> => {
  timers.delete(row.id);
  if (!sender) return;
  const bubbles = parseBubbles(row);
  if (!bubbles.length) {
    markPendingReply(row.id, "failed", null, "만들어 둔 답장을 읽지 못함");
    return;
  }
  try {
    await sender(row, bubbles);
    markPendingReply(row.id, "sent", stamp());
    // 남길 내용은 답장을 만들 때 같이 나온다. 보낸 뒤에 오늘 메모로 옮긴다 —
    // 못 보낸 답장의 내용이 오늘 있었던 일로 남지 않게.
    if (row.note_to_save) saveTodayNote(row.character_id, row.note_to_save);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    bumpPendingAttempt(row.id, msg);
    if (row.attempts + 1 >= MAX_ATTEMPTS) {
      markPendingReply(row.id, "failed", null, msg);
      console.error(`[pending] 발송 포기 #${row.id}: ${msg}`);
      return;
    }
    console.warn(`[pending] 발송 실패 #${row.id}, ${RETRY_MS / 1000}초 뒤 재시도: ${msg}`);
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
  const delay = Math.max(0, epochOf(row.send_at) - getKstNow().getTime());
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
}): number => {
  const sendAt = stampAfter(p.waitMs);
  const createdAt = stamp();
  const id = insertPendingReply({
    chatId: p.chatId,
    characterId: p.characterId,
    userMsgAt: p.userMsgAt,
    bubbles: p.bubbles,
    noteToSave: p.noteToSave,
    sendAt,
    kind: p.kind,
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
    attempts: 0,
    created_at: createdAt,
  });
  console.log(
    `[pending] #${id} ${p.chatId} → ${sendAt} (${Math.round(p.waitMs / 1000)}초 뒤)`,
  );
  return id;
};

/**
 * 기다리던 답장을 버린다.
 * 유저가 말을 더 보내면 답장의 내용도 텀도 다시 정해야 하므로, 만들어 둔 것은 쓰지 않는다.
 */
export const dropPendingReplies = (chatId: string): number => {
  const ids = supersedePendingReplies(chatId);
  for (const id of ids) {
    const t = timers.get(id);
    if (t) clearTimeout(t);
    timers.delete(id);
  }
  return ids.length;
};

export const isWaiting = (chatId: string): boolean => hasWaitingPendingReply(chatId);

/** 프로세스가 다시 떴을 때 남아 있는 대기 답장을 이어서 건다. */
export const resumePendingReplies = (): void => {
  const rows = getWaitingPendingReplies();
  for (const r of rows) arm(r);
  if (rows.length) console.log(`[pending] 대기 답장 ${rows.length}건 이어받음`);
};
