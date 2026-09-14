// 깨우기·약속 표시가 울릴 때 실제로 답장을 만들고 선톡을 거는 자리.
//
// bot.ts의 setWakeHandler·setPromiseHandler 콜백을 동작 변경 없이 옮겼다(이슈 #449,
// outgoing.md 적용 순서 3단계 — 답장과 선톡 문안을 하나의 경로로 합치는 다음 단계들이
// 전부 이 콜백이 있던 자리를 다시 열게 되므로 먼저 떼어냈다).
//
// createWakeHandler·createPromiseHandler는 말풍선 발송·선톡 발송·약속 재예약·선톡 상호
// 배제·상황 문단 빌더를 인자(deps)로 받는 팩토리 함수다. bot.ts가 이미 내보낸 함수라도
// 여기서 직접 가져오지 않는다 — bot.ts가 이 파일의 createWakeHandler·createPromiseHandler를
// 부르는 것과 맞물려 순환 참조가 생기기 때문이다. 그 밖의 의존성(행을 읽고 쓰는 함수,
// 상황 판정, 발송 기록)은 각자의 원본 모듈에서 직접 가져온다.

import { config } from "./config.js";
import { isAwayUnavail, type PlanBlock } from "./day-plan.js";
import { buildSystemBlocks, currentBlock } from "./context.js";
import { composeReply, pendingUserTurn } from "./reply-compose.js";
import {
  armReturnRow,
  dropPendingReplies,
  parseWakeMeta,
  type WakeHandler,
  type PromiseHandler,
} from "./pending.js";
import {
  tracePromise,
  traceWake,
  type PromiseStage,
  type WakeStage,
} from "./reply-trace.js";
import { chatJson, type CallMeta } from "./llm.js";
import { saveTodayNote } from "./memory.js";
import {
  PROACTIVE_RECENT_LINES,
  PROACTIVE_USER_MEMORY_LINES,
} from "./thresholds.js";
import {
  hasWaitingWakeRow,
  lastMessage,
  logMessage,
  setCallContext,
  setRecoveryMark,
  type PendingReplyRow,
} from "./db.js";
import { kstStamp } from "./kst.js";
import type { ReturnAction, SendOutcome, SendKind } from "./bot.js";

// 두 핸들러가 함께 필요로 하는 의존성.
interface SharedHandlerDeps {
  sendBubbleList: (
    chatId: string,
    bubbles: string[],
    characterId?: number,
  ) => Promise<{ sent: string[]; error?: unknown }>;
  sendProactive: (
    chatId: string,
    characterId: number,
    text: string,
    kind?: Exclude<SendKind, "reply" | "recover">,
    extraMeta?: Record<string, unknown>,
  ) => Promise<SendOutcome>;
  keepPromise: (
    chatId: string,
    characterId: number,
    userMsgAt: string,
    promise: string,
    callId: number | null,
    exceptRowId?: number,
  ) => {
    sendAt: string;
    block: string;
    activity: string;
    replaced: number;
  } | null;
  acquireProactive: (chatId: string) => boolean;
  releaseProactive: (chatId: string) => void;
  // 답장을 만드는 중이면 그쪽이 답한다 — bot.ts의 pending·responding을 감춘 자리.
  isBusy: (chatId: string) => boolean;
}

export interface WakeHandlerDeps extends SharedHandlerDeps {
  gatherSituation: (activity: string) => string;
  betweenSituation: (prevActivity: string, next: PlanBlock) => string;
  returnSituation: (activity: string) => string;
  pickReturnAction: (
    lastMetaJson: string | null,
    cur: PlanBlock | null,
  ) => ReturnAction;
}

export interface PromiseHandlerDeps extends SharedHandlerDeps {
  promiseSituation: (
    promise: string,
    activity: string,
    replying: boolean,
  ) => string;
}

export const createWakeHandler = (deps: WakeHandlerDeps): WakeHandler => {
  return async (row: PendingReplyRow) => {
    const chatId = row.chat_id;
    const meta = parseWakeMeta(row);
    const activity = meta.activity ?? "하던 일";
    // 이 행이 답장 없이 끝나는 갈래는 전부 여기로 적는다 — pending.ts가 행을 보낸 것으로
    // 확정해 재시도가 걸리지 않으므로, 안 적으면 사라진 사실 자체가 남지 않는다(이슈 #379).
    const wake = (stage: WakeStage, detail?: string): void =>
      traceWake({
        characterId: row.character_id,
        rowId: row.id,
        stage,
        activity,
        block: { start: meta.blockStart, end: meta.blockEnd },
        detail,
      });
    // 디바운스·답장 생성이 진행 중이면 그쪽이 답한다(불가 구간은 이미 끝났으니 평범한 길로 나간다).
    if (deps.isBusy(chatId)) {
      wake("yielded", "답장을 만드는 중이라 그쪽이 답한다");
      return;
    }
    // 이 구간에 처음 온 메시지가 얼마나 기다렸는지 — 깨우기 표시를 건 그 메시지 시각 기준.
    const firstAt = Date.parse(row.user_msg_at.replace(" ", "T") + "+09:00");
    const waitedMs = Number.isFinite(firstAt)
      ? Math.max(0, Date.now() - firstAt)
      : null;
    const last = lastMessage(chatId, row.character_id);

    // ① 몰아 답장 — 마지막 말이 유저 차례로 남아 있으면 그 사이 온 메시지가 있다는 뜻.
    if (last?.role === "user") {
      const turn = pendingUserTurn(chatId, row.character_id);
      if (!turn) {
        wake("no_turn", "직전 발화는 유저인데 답할 차례가 잡히지 않는다");
        return;
      }
      // 순서는 답장과 같다(reply-compose.ts). 다른 것은 셋 — 방금 돌아왔다는 상황 문단, 구간에
      // 처음 온 메시지에 강제하는 시간 표시(자리를 비운 사이가 한 시간이 안 되면 마커가 안 붙어
      // 나가기 직전 발화와 그 뒤에 온 말이 기록에서 맞붙는다), 텀 대신 어느 구간이 끝나 답하는지를
      // 남기는 근거. 이 길은 텀 표를 타지 않는다.
      const reply = await composeReply({
        characterId: row.character_id,
        chatId,
        turn,
        situation: deps.gatherSituation(activity),
        markFrom: row.user_msg_at,
        context: {
          gathered: { activity, blockStart: meta.blockStart ?? null, waitedMs },
        },
        logTag: "[wake]",
      });
      if (!reply) {
        wake("no_reply", "빈 답장이거나 만드는 사이 유저가 말을 더 보냈다");
        return;
      }
      const { bubbles, signals } = reply;
      // 바로 보낸다 — 구간이 끝나는 시각이 이미 이 답장의 텀이다.
      const { sent, error } = await deps.sendBubbleList(
        chatId,
        bubbles,
        row.character_id,
      );
      if (sent.length === 0 && error) throw error; // pending의 재시도에 맡긴다
      // 이 길은 pending을 타지 않아 발송 결과가 따로 붙지 않는다 — 여기서 남긴다.
      reply.attach({ sent: `${sent.length}/${bubbles.length}` });
      if (error)
        console.warn(`[wake] 부분 발송 ${sent.length}/${bubbles.length}`);
      const messageId = logMessage(
        chatId,
        row.character_id,
        "assistant",
        sent.join("\n"),
        kstStamp(),
        {
          kind: "reply",
          gathered: meta.blockStart ?? true,
          ...(reply.replyMeta ?? {}),
          ...(sent.length < bubbles.length
            ? { partial: `${sent.length}/${bubbles.length}` }
            : {}),
        },
      );
      saveTodayNote(row.character_id, signals.note, messageId);
      setRecoveryMark(chatId, turn.at);
      if (signals.promise) {
        const kept = deps.keepPromise(
          chatId,
          row.character_id,
          turn.at,
          signals.promise,
          reply.callId,
        );
        reply.attach({
          promise: kept
            ? { text: signals.promise, ...kept }
            : { text: signals.promise, dropped: "각본에 남은 블록이 없음" },
        });
      }
      // 지금 블록이 자리 비움 불가면 그 끝에 표시를 건다 — 이 답장에서 그리로 간다고 말했으니
      // 돌아와서 말할 자리가 있어야 한다. 자리 비움 틱은 알리지 않은 짧은 구간을 거르지만 여기서는
      // 방금 알렸으므로 길이를 보지 않는다. 약속을 걸었으면 그 약속이 그 자리라 armReturnRow가
      // 약속 행을 보고 걸지 않는다. 울리고 있는 이 행은 아직 waiting이라 빼고 센다.
      const next = currentBlock(row.character_id);
      if (next && isAwayUnavail(next)) {
        const armed = armReturnRow({
          chatId,
          characterId: row.character_id,
          block: next,
          userMsgAt: turn.at,
          exceptRowId: row.id,
        });
        if (armed)
          reply.attach({
            returnRow: { sendAt: armed.sendAt, activity: next.activity },
          });
      }
      console.log(
        `[wake] 몰아 답장 chat=${chatId} @ ${activity} bubbles=${bubbles.length}`,
      );
      return;
    }

    // ② 복귀 인사 — 자리를 비운 사이 상대에게서 온 말이 없었던 경우.
    //
    // 예전에는 자리 비움 예고를 보낸 자리에서만 인사했는데, 그 예고는 하루 상한·중복 검사·침묵
    // 검사에 자주 막힌다. 그래서 나갈 때 답장으로 이따 보자고 해 놓고 예고만 막힌 날에는 상대가
    // 그 말을 믿고 기다리는데도 캐릭터가 다음 날 아침까지 아무 말도 하지 않았다.
    if (!last || last.role !== "assistant") {
      wake("no_last", "복귀 인사를 이어 붙일 직전 발화가 없다");
      return;
    }
    // 지금 블록을 보고 갈래를 고른다. 방금 보낸 것이 복귀 인사면 또 하지 않는다 — 불가 구간이
    // 이어지는 날 유저가 답하지 않는 동안 인사가 구간마다 쌓인다. 유저가 한 번 답하면 last.role이
    // 유저가 되어 다시 열린다. 지금 블록도 자리 비움 불가면 돌아왔다고 말하지 않는다 — 그 문안은
    // 다음 일을 모르니 집에 왔다고 하거나 각본에 없는 일을 하러 간다고 지어냈다(이슈 #341).
    const cur = currentBlock(row.character_id);
    const action = deps.pickReturnAction(last.meta_json, cur);
    if (action === "skip") {
      console.log(
        `[wake] 복귀 인사 접음 — ${last.meta_json?.includes('"return"') ? "직전에 이미 했다" : "잠"} (chat=${chatId})`,
      );
      return;
    }
    // 사이 예고와 표시 다시 걸기는 문안이 나가든 접히든 먼저 건다 — 그 끝에 울릴 행이 있어야
    // 마지막 불가 구간 뒤에 복귀 인사가 나간다. 울리고 있는 이 행은 아직 waiting이라 빼고 센다.
    const between = action === "between" || action === "rearm" ? cur : null;
    if (between) {
      const armed = armReturnRow({
        chatId,
        characterId: row.character_id,
        block: between,
        userMsgAt: row.user_msg_at,
        exceptRowId: row.id,
      });
      console.log(
        `[wake] 다음 블록도 자리 비움(${between.activity}) — ${armed ? `${armed.sendAt}에 표시 다시 걺` : "표시 안 걺(이미 있음)"} (chat=${chatId})`,
      );
      if (action === "rearm") return;
    }
    // 이 인사는 선톡과 같은 자리를 쓴다. 답할 말이 있는 'wake' 행과 달리 이 행은 선톡 틱을
    // 막지 않으므로(그래야 구간 안에서 다음 예고와 아침·점심 선톡이 창을 지킨다), 보내는 동안만
    // 자리를 잡아 같은 순간에 도는 자리 비움 예고와 겹치지 않게 한다.
    if (!deps.acquireProactive(chatId)) {
      wake("busy", "같은 순간에 다른 선톡이 나가는 중이다");
      return;
    }
    try {
      const draft = await chatJson<{ send: boolean; text?: string }>(
        buildSystemBlocks(row.character_id, chatId, {
          recent: PROACTIVE_RECENT_LINES,
          userMemories: PROACTIVE_USER_MEMORY_LINES,
          situation: between
            ? deps.betweenSituation(activity, between)
            : deps.returnSituation(activity),
        }),
        "위 상황 문단대로 문안을 만들어.",
        400,
        config.model,
        {
          purpose: between ? "away" : "comeback",
          characterId: row.character_id,
          chatId,
        },
      );
      // 발송 직전 재확인 — LLM을 기다리는 사이 유저가 답했거나 다른 경로가 보냈으면 접는다.
      if (
        draft.send &&
        draft.text &&
        lastMessage(chatId, row.character_id)?.sent_at === last.sent_at
      ) {
        // 사이 예고의 block은 자리 비움 틱의 예고와 같은 칸이다 — 틱이 같은 블록에 예고를 또
        // 보내지 않게(awayNoticeSent) 하고, between은 하루 상한에서 빼는 표시다.
        await deps.sendProactive(
          chatId,
          row.character_id,
          draft.text,
          "away",
          between
            ? { between: between.start, block: between.start }
            : { return: meta.blockStart ?? true },
        );
        console.log(
          `[wake] ${between ? "between" : "return"} @ ${activity} → ${chatId}`,
        );
      }
    } finally {
      deps.releaseProactive(chatId);
    }
  };
};

export const createPromiseHandler = (
  deps: PromiseHandlerDeps,
): PromiseHandler => {
  return async (row: PendingReplyRow) => {
    const chatId = row.chat_id;
    const meta = parseWakeMeta(row);
    const activity = meta.activity ?? "하던 일";
    const promise = meta.promise ?? "끝나고 다시 연락";
    // 약속이 그 뒤 어떻게 됐는지는 약속을 한 답장 스레드에 단다(이슈 #312).
    const trace = (
      stage: PromiseStage,
      detail?: string,
      draftCallId?: number | null,
    ): void =>
      tracePromise({
        characterId: row.character_id,
        rowId: row.id,
        stage,
        promise,
        callId: meta.callId,
        draftCallId,
        detail,
      });
    if (hasWaitingWakeRow(chatId)) {
      console.log(
        `[promise] 깨우기 표시가 걸려 있어 그쪽에 맡김 (chat=${chatId}): ${promise}`,
      );
      trace("deferred");
      return;
    }
    if (deps.isBusy(chatId)) throw new Error("답장을 만드는 중 — 잠시 뒤 다시");
    const cur = currentBlock(row.character_id);
    if (cur && cur.responsiveness === "unavailable") {
      // 다시 거는 행은 같은 답장의 약속이라 원래 호출 번호를 그대로 잇는다.
      const kept = deps.keepPromise(
        chatId,
        row.character_id,
        row.user_msg_at,
        promise,
        meta.callId ?? null,
        row.id,
      );
      console.log(
        `[promise] 지금은 답장 불가 구간(${cur.activity}) — ${kept ? `${kept.sendAt}로 다시 검` : "다시 걸 블록 없음"} (chat=${chatId})`,
      );
      if (kept)
        trace(
          "rescheduled",
          `${cur.activity} 중 → ${kept.sendAt.slice(11, 16)} (${kept.activity} 끝)`,
        );
      else trace("no_slot", `${cur.activity} 중`);
      return;
    }
    const last = lastMessage(chatId, row.character_id);

    // ③ 그 사이 온 말이 있다 — 약속을 지키는 답장.
    if (last?.role === "user") {
      // 만들어 둔 답장이 있으면 버린다 — 약속 시각의 답장이 그 말까지 함께 받는다.
      const droppedReply = dropPendingReplies(
        chatId,
        "약속 시각이 되어 다시 만든다",
      );
      if (droppedReply)
        console.log(
          `[promise] 만들어 둔 답장 ${droppedReply}건 거둠 (chat=${chatId})`,
        );
      const turn = pendingUserTurn(chatId, row.character_id);
      if (!turn) {
        trace("skipped", "직전 발화는 유저인데 답할 차례가 잡히지 않는다");
        return;
      }
      const reply = await composeReply({
        characterId: row.character_id,
        chatId,
        turn,
        situation: deps.promiseSituation(promise, activity, true),
        context: {
          promised: { promise, activity, blockStart: meta.blockStart ?? null },
        },
        logTag: "[promise]",
      });
      if (!reply) {
        trace("skipped", "빈 답장이거나 만드는 사이 유저가 말을 더 보냈다");
        return;
      }
      const { bubbles, signals } = reply;
      const { sent, error } = await deps.sendBubbleList(
        chatId,
        bubbles,
        row.character_id,
      );
      if (sent.length === 0 && error) throw error; // pending의 재시도에 맡긴다
      reply.attach({ sent: `${sent.length}/${bubbles.length}` });
      if (error)
        console.warn(`[promise] 부분 발송 ${sent.length}/${bubbles.length}`);
      const messageId = logMessage(
        chatId,
        row.character_id,
        "assistant",
        sent.join("\n"),
        kstStamp(),
        {
          kind: "reply",
          promised: true,
          ...(reply.replyMeta ?? {}),
          ...(sent.length < bubbles.length
            ? { partial: `${sent.length}/${bubbles.length}` }
            : {}),
        },
      );
      saveTodayNote(row.character_id, signals.note, messageId);
      setRecoveryMark(chatId, turn.at);
      trace("replied", reply.callId ? `답장 #${reply.callId}` : undefined);
      if (signals.promise) {
        const kept = deps.keepPromise(
          chatId,
          row.character_id,
          turn.at,
          signals.promise,
          reply.callId,
          row.id,
        );
        reply.attach({
          promise: kept
            ? { text: signals.promise, ...kept }
            : { text: signals.promise, dropped: "각본에 남은 블록이 없음" },
        });
      }
      console.log(
        `[promise] 약속 답장 chat=${chatId} @ ${activity} bubbles=${bubbles.length}`,
      );
      return;
    }

    // ④ 온 말이 없다 — 약속대로 먼저 연락한다.
    if (!last || last.role !== "assistant") {
      trace("skipped", "약속 연락을 이어 붙일 직전 발화가 없다");
      return;
    }
    if (!deps.acquireProactive(chatId))
      throw new Error("선톡 자리가 차 있음 — 잠시 뒤 다시");
    try {
      const draftMeta: CallMeta = {
        purpose: "promise",
        characterId: row.character_id,
        chatId,
      };
      const draft = await chatJson<{ send: boolean; text?: string }>(
        buildSystemBlocks(row.character_id, chatId, {
          recent: PROACTIVE_RECENT_LINES,
          userMemories: PROACTIVE_USER_MEMORY_LINES,
          situation: deps.promiseSituation(promise, activity, false),
        }),
        "위 상황 문단대로 문안을 만들어.",
        400,
        config.model,
        draftMeta,
      );
      // 문안 호출 행에 어느 약속을 지키는 자리였는지 남긴다 — 문안 게시가 머리에 적는다.
      if (draftMeta.callId)
        setCallContext(draftMeta.callId, {
          promised: { promise, activity, blockStart: meta.blockStart ?? null },
        });
      const draftLabel = draftMeta.callId
        ? `문안 #${draftMeta.callId}`
        : undefined;
      // 발송 직전 재확인 — 모델을 기다리는 사이 유저가 답했거나 다른 경로가 보냈으면 접는다.
      if (!draft.send || !draft.text) {
        console.log(`[promise] 약속 연락 접음 (chat=${chatId}): ${promise}`);
        trace(
          "skipped",
          `모델이 보내지 않기로 했다${draftLabel ? ` (${draftLabel})` : ""}`,
          draftMeta.callId,
        );
      } else if (
        lastMessage(chatId, row.character_id)?.sent_at !== last.sent_at
      ) {
        console.log(
          `[promise] 약속 연락 접음 — 문안을 만드는 사이 마지막 메시지가 바뀌었다 (chat=${chatId})`,
        );
        trace(
          "skipped",
          `문안을 만드는 사이 마지막 메시지가 바뀌었다${draftLabel ? ` (${draftLabel})` : ""}`,
          draftMeta.callId,
        );
      } else {
        // 근거 줄이 어느 약속인지 적을 수 있게 기록 행 번호를 함께 남긴다(설계 원본 §9).
        await deps.sendProactive(
          chatId,
          row.character_id,
          draft.text,
          "promise",
          {
            promise,
            promise_row: row.id,
          },
        );
        console.log(`[promise] 약속 연락 @ ${activity} → ${chatId}`);
        trace("sent", draftLabel, draftMeta.callId);
      }
    } finally {
      deps.releaseProactive(chatId);
    }
  };
};
