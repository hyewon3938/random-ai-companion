// 선톡 한 통을 만들어 보내는 공통 자리 — 잠금·보관 문안·발송 직전 재확인·실패 보관을 한 벌로 둔다.
//
// followup의 밤 인사·달래기·근황과 presence의 자리 비움 예고가 같은 뼈대를 네 번 반복하던 것을
// sendProactiveDraft 하나로 모았다(#300). 순서는 이렇다.
//   1. 이 chat에 다른 선톡 틱이나 답장이 진행 중이면 접는다(acquireProactive).
//   2. 앞 틱에서 못 나간 같은 종류의 문안이 있으면 모델을 부르지 않고 그것부터 쓴다.
//   3. 없으면 대화와 같은 3층 프롬프트에 상황 문단을 얹어 모델을 부르고, 부른 쪽이 준 read로
//      응답을 문안으로 읽는다. read가 null을 주면 보내지 않는다(접은 사유는 read 안에서 남긴다).
//   4. 모델을 기다리는 사이 마지막 메시지가 바뀌었으면 접는다 — 유저가 답했거나 다른 경로가
//      뭔가 보낸 것이다.
//   5. 보낸다. 한 통도 못 나갔으면 문안을 보관함에 넣어 다음 틱이 다시 보내게 한다.
// 종류별로 다른 것(상황 문단·응답 모양·접을 때 남길 기록·로그 문구)만 spec으로 받는다.
//
// noOverlap은 틱 재진입 방지다 — 모델 호출·발송으로 한 틱이 길어져 다음 크론과 겹치면 같은
// 자리를 두 틱이 집어 이중 발송이 된다. dispatch·followup·presence 세 틱이 같은 것을 쓴다.

import { chatJson, type CallMeta } from "./llm.js";
import { config } from "./config.js";
import { lastMessage, recordSendFailure } from "./db.js";
import {
  acquireProactive,
  releaseProactive,
  sendProactive,
  logErr,
} from "./bot.js";
import { buildSystemBlocks } from "./context.js";
import {
  holdFailedDraft,
  takeHeldDraft,
  type HeldDraft,
  type HeldDraftKind,
} from "./proactive-policy.js";
import { traceProactiveFail } from "./reply-trace.js";
import { PROACTIVE_RECENT_LINES } from "./thresholds.js";

export interface ProactiveDraftSpec<T> {
  characterId: number;
  chatId: string;
  /** 문안 종류. 호출 목적·보관함·발송 기록·실패 기록에 같은 이름을 쓴다. */
  kind: HeldDraftKind;
  /** 자리 비움 예고만 채운다 — 보관 문안은 같은 블록(시작 시각)에서만 다시 쓴다. */
  block?: string;
  /** 발송 직전에 대조할 마지막 메시지 시각. 문안을 만드는 사이 바뀌었으면 접는다. */
  lastSentAt: string;
  /** 3층 프롬프트에 얹을 상황 문단. */
  situation: string;
  maxTokens: number;
  /** 모델 응답을 문안으로 읽는다. null이면 보내지 않는다 — 접은 사유는 여기서 남긴다. */
  read: (draft: T, meta: CallMeta) => string | null;
  /** 로그 접두어. 실패 로그는 이 뒤에 "전송 실패:"가 붙는다. */
  label: string;
  /** 나간 뒤 남길 로그 한 줄. */
  sentLog: string;
  /** 문안을 만드는 사이 마지막 메시지가 바뀌어 접었을 때 남길 기록. */
  onMoved?: (meta: CallMeta) => void;
}

export type ProactiveDraftResult =
  | "busy" // 다른 틱·답장이 진행 중
  | "sent"
  | "skipped" // read가 문안을 안 줬다
  | "moved" // 만드는 사이 대화가 움직였다
  | "held"; // 발송에 실패해 문안을 보관했다

/** 모델 호출과 발송. 검사에서 바꿔 끼우는 자리라 기본값은 실제 함수다. */
export interface ProactiveDraftDeps {
  ask: typeof chatJson;
  send: typeof sendProactive;
}

const realDeps: ProactiveDraftDeps = { ask: chatJson, send: sendProactive };

export const sendProactiveDraft = async <T>(
  spec: ProactiveDraftSpec<T>,
  deps: ProactiveDraftDeps = realDeps,
): Promise<ProactiveDraftResult> => {
  const { characterId, chatId, kind } = spec;
  if (!acquireProactive(chatId)) return "busy";
  // 호출 번호를 catch에서도 봐야 한다 — 발송에 실패하면 이 문안 스레드에 실패를 단다.
  const meta: CallMeta = { purpose: kind, characterId, chatId };
  // 앞 틱에서 못 나간 문안이 있으면 모델을 다시 부르지 않고 그것부터 보낸다 — 여기까지 온
  // 것이 곧 그 종류의 창·침묵 조건이 아직 맞다는 뜻이다(이슈 #269).
  let outgoing: HeldDraft | null = takeHeldDraft(chatId, kind, spec.block);
  try {
    if (!outgoing) {
      const draft = await deps.ask<T>(
        buildSystemBlocks(characterId, chatId, {
          recent: PROACTIVE_RECENT_LINES,
          situation: spec.situation,
        }),
        "위 상황 문단대로 문안을 만들어.",
        spec.maxTokens,
        config.model, // 실시간성이라 대화 모델(sonnet)
        meta,
      );
      const text = spec.read(draft, meta);
      if (!text) return "skipped";
      outgoing = {
        kind,
        text,
        ...(spec.block !== undefined ? { block: spec.block } : {}),
        madeAt: Date.now(),
      };
    }
    // 발송 직전 재확인 — 모델을 기다리는 사이 유저가 답했거나 다른 경로가 뭔가 보냈으면
    // (마지막 메시지가 바뀜) 접는다.
    if (lastMessage(chatId)?.sent_at !== spec.lastSentAt) {
      spec.onMoved?.(meta);
      return "moved";
    }
    await deps.send(
      chatId,
      characterId,
      outgoing.text,
      kind,
      spec.block !== undefined ? { block: spec.block } : undefined,
    );
    outgoing = null; // 나갔으니 들고 있지 않는다
    console.log(spec.sentLog);
    return "sent";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logErr(`${spec.label} 전송 실패:`, e);
    recordSendFailure(chatId, characterId, kind, msg);
    traceProactiveFail({ characterId, kind, error: msg, callId: meta.callId });
    // 한 통도 못 나갔으면 문안을 들고 있는다 — 다음 틱이 같은 자리면 그대로 다시 보낸다.
    // (일부라도 나가면 sendProactive가 던지지 않으므로 여기 오지 않는다.)
    if (outgoing) holdFailedDraft(chatId, outgoing);
    return "held";
  } finally {
    releaseProactive(chatId);
  }
};

/** 응답이 `{ text }` 모양인 문안(밤 인사·달래기). */
export const readText = (d: { text?: string }): string | null => d.text || null;

/** 응답이 `{ send, text }` 모양인 문안(근황). send가 false면 보내지 않는다. */
export const readSendText = (d: { send: boolean; text?: string }): string | null =>
  d.send && d.text ? d.text : null;

/**
 * 틱 재진입 방지 — 앞 틱이 아직 도는 중이면 이번 호출은 아무것도 하지 않고 돌아온다.
 * 크론이 부르는 틱 함수를 이걸로 감싼다.
 */
export const noOverlap = (body: () => Promise<void>): (() => Promise<void>) => {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await body();
    } finally {
      running = false;
    }
  };
};
