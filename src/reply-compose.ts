// 답장 한 통을 만드는 순서 — 말투 굳히기, 검색 태그와 상대 상태 판정, 프롬프트 조립, 호출, 신호 반영, 폐기 판정.
//
// 즉답·틈틈이 답장(bot.ts의 respond), 불가 구간이 끝난 뒤의 몰아 답장(bot.ts의 깨우기
// 핸들러), 약속 시각의 답장(bot.ts의 약속 핸들러)이 같은 순서로 답장을 만든다. 서로 다른
// 것은 프롬프트 끝에 붙는 상황 문단, 대화 기록에서 시간 표시를 강제하는 기준 시각, 호출
// 기록에 붙이는 근거 세 가지뿐이라 그 셋만 입력으로 받는다. 붙잡기 판정이 일정을 취소하거나
// 미룬 뒤의 답장이면 그 결정을 상황 문단으로 함께 알려 준다 — 판정 결과를 모른 채 쓰면
// 취소한 일에 가겠다고 하거나 끝나고 연락하겠다는 약속이 나온다(이슈 #308). 만든 답장을
// 어떻게 보낼지(정한 시각에 보낼지, 바로 보낼지)는 호출부가 정한다 — 이 파일은 텔레그램을
// 모른다.
//
// 관계 신호(#353)도 여기서 적는다 — 답장 신호의 first는 firsts에 미확정 행으로, told_plan은
// 오늘 캐릭터 일정이 하나뿐일 때 그 일정의 상대가 안다는 표시로, 판정 호출이 돌려준 열림
// 4항목은 relationship_signals에 턴마다 1행으로. 만들어 둔 답장이 폐기되고 다시 만들어지면
// 마지막으로 나간 답장 뒤의 열림 행을 걷어 내고 적어 한 턴에 1행을 지킨다. 쓴 플러팅(move)과
// told_plan은 replyMeta로 돌려줘 호출부가 대화 기록의 답장 행 meta_json에 싣는다 — 다음 판정
// 호출과 [지금 관계] 절이 그 행을 읽는다.
//
// 만드는 동안 유저가 말을 더 보냈거나 답이 비어 있으면 null을 돌려준다. 그때도 호출 기록에는
// 버린 이유와 객체를 어느 길로 읽었는지가 남는다 — 형식이 깨진 날을 되짚는 자리다.
//
// 모델을 부르는 자리는 인자(ask·judge)로 바꿔 끼울 수 있다. 검사는 정해 둔 답을 돌려주는
// 함수를 넘겨 프롬프트에 무엇이 들어갔는지, 어느 답을 버렸는지를 본다(test/reply-compose.test.ts).

import { config } from "./config.js";
import { buildSystemBlocks, type BuildTrace } from "./context.js";
import {
  deleteRelationshipSignalsAfter,
  getActiveSchedulesOn,
  getRecentMessages,
  getStage,
  insertFirst,
  insertRelationshipSignal,
  lastAssistantMessage,
  markScheduleKnown,
  setCallContext,
  type MessageRow,
} from "./db.js";
import { kstLogicalDate, kstStamp } from "./kst.js";
import { stageDays } from "./context/relationship.js";
import {
  chat,
  type CallMeta,
  type ChatTurn,
  type SystemBlock,
} from "./llm.js";
import { askReply, type ReplyDraft } from "./reply-ask.js";
import {
  ALWAYS_KEYS,
  REPLY_MAX_TOKENS,
  type ReplySignals,
} from "./reply-signal.js";
import { recordHold } from "./reply-timing.js";
import {
  applyReplySignals,
  applyUserState,
  speechRatchet,
  type RelChange,
} from "./relationship-update.js";
import { todayNotesByMessage } from "./memory.js";
import { pickTags } from "./tag-pick.js";
import { judgeUserState, userStateLabel, type UserStateVerdict } from "./user-state.js";
import { getRelationship } from "./db.js";
import { logicalDateOf } from "./kst.js";
import { RECENT_MESSAGE_FETCH_MAX, RECENT_TURN_COUNT } from "./thresholds.js";
import { lastTurns, toTurns } from "./turns.js";

/** 답장 대상이 되는 유저 발화 — 마지막 캐릭터 말 뒤에 온 유저 메시지를 한 덩어리로 묶은 것. */
export interface UserTurn {
  /** 덩어리의 마지막 메시지 시각. 생성이 끝났을 때 이보다 새 메시지가 있으면 답장을 버린다. */
  at: string;
  /** 덩어리의 첫 메시지 시각. 붙잡기 판정이 상대가 내 답 없이 기다린 시간을 여기서 잰다. */
  firstAt: string;
  /** 메시지들을 줄바꿈으로 이은 글. 붙잡기 판정과 검색 태그가 이 글을 읽는다. */
  text: string;
  /** 메시지 수. */
  n: number;
}

// 나눠 보낸 여러 줄이 한 덩어리로 붙잡기 판정에 들어간다.
export const pendingUserTurn = (
  chatId: string,
  characterId: number,
): UserTurn | null => {
  const rows = getRecentMessages(chatId, characterId, 12);
  const mine: MessageRow[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (!r || r.role !== "user") break;
    mine.unshift(r);
  }
  const first = mine[0];
  const last = mine[mine.length - 1];
  if (!first || !last) return null;
  return {
    at: last.sent_at,
    firstAt: first.sent_at,
    text: mine.map((m) => m.text).join("\n"),
    n: mine.length,
  };
};

// 연달아 보낸 말은 몇 통이든 한 턴이라, 유저가 끊어 보내도 남는 대화 길이가 같다.
// markFrom을 주면 그 시각 이후 첫 메시지에 시간 표시를 강제한다(몰아 답장 자리, 이슈 #238).
// 오늘 적은 메모를 함께 넘겨 기록 속 답장 객체의 메모 칸을 실제 값으로 채운다(이슈 #346).
export const replyHistory = (
  chatId: string,
  characterId: number,
  markFrom?: string,
): ChatTurn[] =>
  toTurns(
    lastTurns(
      getRecentMessages(chatId, characterId, RECENT_MESSAGE_FETCH_MAX),
      RECENT_TURN_COUNT,
    ),
    {
      notes: todayNotesByMessage(characterId),
      ...(markFrom ? { markFrom } : {}),
    },
  );

/** 모델을 불러 답장 한 통을 받아 오는 자리. 검사에서 정해 둔 답을 돌려주는 함수로 바꿔 끼운다. */
export type ReplyAsker = (
  system: SystemBlock[],
  turns: ChatTurn[],
  meta: CallMeta,
) => Promise<ReplyDraft>;

// 답장 한 통을 받아 온다. 무엇을 고르고 무엇을 합치는지는 reply-ask.ts에 있다.
export const askReplyWith: ReplyAsker = (system, turns, meta) =>
  askReply(async (attempt) => {
    const callMeta: CallMeta = attempt === 1 ? meta : { ...meta, attempt };
    const text = await chat(
      system,
      turns,
      REPLY_MAX_TOKENS,
      config.model,
      callMeta,
    );
    return { text, callId: callMeta.callId ?? null };
  });

/** 붙잡기 판정이 이미 내린 결정을 답장에 알리는 상황 문단. 답장이 그 결정과 어긋나지 않게. */
export const heldSituation = (held: {
  activity: string;
  outcome: string;
}): string =>
  [
    `[붙잡기 판정 — 이미 정해진 것]`,
    `상대가 붙잡아서 너는 "${held.activity}"을(를) ${
      held.outcome === "취소"
        ? "취소하고 남기로 했다"
        : "미루고 지금은 상대 곁에 남기로 했다"
    }. 이 답장은 그 결정 뒤의 말이다.`,
    `- 취소했으면 그 일에 가겠다거나 끝나고 연락하겠다고 하지 않는다. 미뤘으면 나중에 한다는 결로만 말하고 지금 가겠다고 하지 않는다.`,
    `- 남기로 한 것을 무겁게 생색내지 않는다. 한 마디면 된다.`,
  ].join("\n");

export interface ComposeInput {
  characterId: number;
  chatId: string;
  /** 지금 답장하는 유저 발화. */
  turn: UserTurn;
  /** 프롬프트 맨 끝에 붙는 상황 문단 — 배웅 답과 몰아 답장이 준다. */
  situation?: string;
  /** 대화 기록에서 이 시각 이후 첫 메시지에 시간 표시를 강제한다(몰아 답장, 이슈 #238). */
  markFrom?: string;
  /**
   * 호출 기록에 항상 앞세워 붙는 근거 — 텀 계산의 입력과 결과·도착 대기, 또는 어느 구간이
   * 끝나 답하는지. 검색한 태그·기억, 대화 길이, 관계 갱신은 이 파일이 뒤에 붙인다.
   */
  context: Record<string, unknown>;
  /**
   * 붙잡기 판정이 이미 일정을 취소하거나 미뤘으면 그 기록. stay 신호로 남긴 기록보다 앞선다 —
   * 판정이 접은 자리는 recordHold가 알아서 넘어가므로 둘이 같은 블록을 두 번 적지 않는다.
   */
  heldActual?: { blockStart: string | null; activity: string; outcome: string };
  /** 로그 머리말 — "[send]"·"[wake]"처럼 어느 길에서 만들었는지. */
  logTag: string;
  ask?: ReplyAsker;
  /** 상대 상태 판정 자리 — 검사가 정해 둔 판정을 넘긴다. 없으면 모델을 부른다. */
  judge?: (characterId: number, chatId: string) => Promise<UserStateVerdict>;
}

export interface ComposedReply {
  bubbles: string[];
  signals: ReplySignals;
  /** 이 답장을 만든 모델 호출 번호. 발송·폐기 결과를 이 호출의 트레이스에 잇는다. */
  callId: number | null;
  /** 호출 기록에 근거를 덧붙인다 — 발송 예정 시각이나 발송 결과를 호출부가 붙인다. */
  attach: (extra: Record<string, unknown>) => void;
  /** 대화 기록의 답장 행 meta_json에 실을 관계 값(move·told_plan). 둘 다 없으면 null. */
  replyMeta: Record<string, unknown> | null;
}

/**
 * 답장 한 통을 만든다. 보내지 않으며, 버린 답장은 null이다.
 *
 * 순서: 말투 래칫 → 검색 태그·상대 상태 판정 → 3층 프롬프트 조립 → 대화 기록 → 호출 → 관계 신호 저장 →
 * stay 신호로 일정 기록 → 빈 답·새 메시지 폐기 판정. 호출 기록(llm_calls)에는 검색한
 * 태그·기억, 대화 길이, 관계 갱신, 객체를 읽은 길, 말풍선 수가 붙고, 기록이 실패해도 답장은
 * 그대로 나간다.
 */
export const composeReply = async (
  input: ComposeInput,
): Promise<ComposedReply | null> => {
  const { characterId, chatId, turn, logTag } = input;
  const ask = input.ask ?? askReplyWith;
  const judge = input.judge ?? judgeUserState;

  // 말투 래칫 — 프롬프트를 조립하기 전에 부른다. 저장해 두면 이번 답장은 물론 최근 대화를
  // 안 보는 경로(선톡 문안)도 같은 값을 읽는다. 단계·호칭은 답을 읽은 뒤에 같은 목록에 쌓인다.
  const relUpdates: RelChange[] = speechRatchet(characterId, chatId, kstStamp());

  // 3층(불변/일간/실시간) 블록 — 앞 두 층은 프롬프트 캐시 경계가 걸려 재사용된다.
  // 검색 태그는 답장을 만들기 전에 짧은 호출로 먼저 고른다 — 이번 답장에 바로 쓰기 때문에
  // 여기서 돌아야 한다. 무엇을 찾아 넣었는지(검색 태그·기억)를 받아 둬서 호출 기록에 남긴다.
  const built: BuildTrace = {
    tags: [],
    tagPool: 0,
    memories: [],
    oldDiaries: [],
    schedules: [],
    dropped: [],
  };
  // 상대 상태 판정은 검색 태그와 나란히 돈다 — 둘 다 짧은 호출이고 서로 모른다. 바뀐 값은
  // 조립 전에 저장해야 이번 답장이 읽는다(관계 갱신 목록에 같이 쌓인다).
  const [pick, verdict] = await Promise.all([
    pickTags(characterId, turn.text),
    judge(characterId, chatId),
  ]);
  relUpdates.push(...applyUserState(characterId, verdict, kstStamp()));
  // 상황 문단은 호출부가 준 것 뒤에 붙잡기 판정의 결정을 잇는다 — 둘 다 있을 수 있다.
  const situation = [
    input.situation ?? "",
    input.heldActual ? heldSituation(input.heldActual) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const system = buildSystemBlocks(characterId, chatId, {
    pick,
    trace: built,
    // 답장만 객체(JSON)로 받는다 — 본문과 신호가 한 덩이로 온다.
    signals: true,
    ...(situation ? { situation } : {}),
  });
  const turns = replyHistory(chatId, characterId, input.markFrom);
  const meta: CallMeta = { purpose: "reply", characterId, chatId };
  // 빈 답장은 reply-ask.ts가 한 번 다시 부른다. 그래도 비면 아래에서 버린다 — 빈 텍스트를
  // 그대로 보내면 텔레그램이 400으로 거부해 대화가 막혔었다.
  const { bubbles, signals, parse, slots, retryCallId } = await ask(
    system,
    turns,
    meta,
  );

  // 이 답장이 어떤 근거로 나왔는지를 호출 기록에 붙인다. 여러 번 나눠 부르므로 덮어쓰지 않고
  // 쌓는다 — 뒤에 붙는 발송 예정 시각이 앞의 검색 기록을 지우면 안 된다.
  const facts: Record<string, unknown> = {};
  const attach = (extra: Record<string, unknown>): void => {
    Object.assign(facts, extra);
    if (!meta.callId) return;
    try {
      setCallContext(meta.callId, {
        ...input.context,
        search: built,
        turns: turns.length,
        userMsgs: turn.n,
        ...(relUpdates.length ? { relUpdate: relUpdates } : {}),
        ...(retryCallId ? { retryCallId } : {}),
        ...facts,
      });
    } catch (e) {
      console.error("[llm] 판단 근거 기록 실패:", e);
    }
  };
  // 재생성 호출은 답장 스레드에 딸린 것으로 표시한다 — 그냥 두면 판단 근거 없는 낱개 행으로
  // 올라가 어느 답장의 두 번째 시도인지 알 수 없다.
  if (retryCallId && meta.callId)
    try {
      setCallContext(retryCallId, { partOf: meta.callId });
    } catch (e) {
      console.error("[llm] 재생성 호출 표시 실패:", e);
    }

  // 관계 신호 — 이번 대화로 사이나 부르는 말이 달라졌으면 그 자리에서 저장한다.
  // 조립 전에 굳힌 말투와 한 목록에 모아 트레이스가 *관계 갱신* 한 자리에서 읽는다.
  relUpdates.push(...applyReplySignals(characterId, signals, kstStamp()));
  // 객체를 어느 길로 읽었는지는 답장을 버리는 경우에도 남긴다. 늘 넣기로 한 칸이 빠졌으면
  // 그 이름도 같이 남긴다 — 플러팅·처음이 안 남을 때 모델이 안 쓴 것인지 칸을 뺀 것인지를
  // 이 줄로만 가른다(이슈 #385). 객체로 못 읽은 답은 실을 칸 자체가 없어 세지 않는다.
  const missingSlots =
    parse === "plain" || parse === "empty"
      ? []
      : ALWAYS_KEYS.filter((k) => !slots.includes(k));
  attach({
    outputParse: parse,
    ...(missingSlots.length ? { missingSlots } : {}),
  });
  // 조정 가능한(개인·사회) 자기 일정을 취소하거나 미루고 남기로 한 stay 신호.
  const staged = signals.stay ? recordHold(characterId) : null;
  if (input.heldActual) attach({ dayActual: { ...input.heldActual, by: "judge" } });
  else if (staged) attach({ dayActual: { ...staged, by: "stay" } });

  if (!bubbles.length) {
    attach({ dropped: "빈 답장" });
    console.warn(`${logTag} empty reply — skip (chat=${chatId})`);
    return null;
  }
  // 만드는 동안 유저가 말을 더 보냈으면 이 답장은 버린다 — 디바운스 타이머가 합쳐서 다시 만든다.
  const now = pendingUserTurn(chatId, characterId);
  if (now && now.at !== turn.at) {
    attach({ dropped: "생성 중 새 메시지 도착" });
    console.log(`${logTag} 생성 중 새 메시지 도착 — 폐기 (chat=${chatId})`);
    return null;
  }
  // 관계 값 — 처음은 미확정 행으로 적고(새벽 정리가 확정한다), 오늘 일정을 먼저 말했으면
  // 상대가 안다고 표시하며, 판정 호출이 돌려준 열림 4항목은 턴마다 1행이다(관계 설계 §6·§7).
  const stampNow = kstStamp();
  if (signals.first)
    try {
      insertFirst({
        characterId,
        chatId,
        kind: signals.first.kind,
        by: signals.first.by,
        happenedAt: stampNow,
        ...(meta.callId ? { callId: meta.callId } : {}),
      });
    } catch (e) {
      console.error(`${logTag} 처음 기록 실패:`, e);
    }
  // 오늘 일정을 말했다는 신호는 어느 일정인지를 안 가리킨다 — 오늘 캐릭터 일정이 하나뿐일 때만
  // 그 일정을 표시하고, 둘 이상이면 새벽 정리가 대화를 보고 고른다(#345의 schedule_updates).
  // 표시는 한 방향이라 안 말한 일정까지 안다고 적으면 되돌릴 길이 없다.
  if (signals.toldPlan)
    try {
      const todays = getActiveSchedulesOn(characterId, "char", kstLogicalDate());
      if (todays.length === 1) markScheduleKnown(characterId, todays[0]!.id);
    } catch (e) {
      console.error(`${logTag} 일정 말함 표시 실패:`, e);
    }
  if (verdict.signals)
    try {
      const o = verdict.signals;
      // 한 유저 턴에 1행 — 만들어 둔 답장이 폐기되고 다시 만들어지면 앞선 답장의 행이 남아
      // 있다. 마지막으로 나간 답장 뒤에 적힌 행이 그것이라 걷어 내고 적는다.
      const replaced = deleteRelationshipSignalsAfter(
        characterId,
        chatId,
        lastAssistantMessage(chatId, characterId)?.sent_at ?? null,
      );
      if (replaced)
        console.log(`${logTag} 열림 신호 ${replaced}행을 이번 답장 것으로 바꾼다 (chat=${chatId})`);
      insertRelationshipSignal({
        characterId,
        chatId,
        at: stampNow,
        openedSelf: o.openedSelf,
        askedAboutChar: o.askedAboutChar,
        saidAffection: o.saidAffection,
        ...(o.prevMove ? { prevMove: o.prevMove } : {}),
        moveReaction: o.moveReaction,
        ...(verdict.callId ? { callId: verdict.callId } : {}),
      });
    } catch (e) {
      console.error(`${logTag} 열림 신호 기록 실패:`, e);
    }
  const stage = getStage(characterId);
  const replyMeta: Record<string, unknown> = {
    ...(signals.move ? { move: signals.move } : {}),
    ...(signals.toldPlan ? { told_plan: true } : {}),
  };
  const rel = getRelationship(characterId);
  attach({
    stay: signals.stay,
    note: signals.note,
    // 관계 — 지금 단계와 며칠째인지, 이 답장이 쓴 플러팅, 처음으로 적은 일. 슬랙 답장 게시의 관계 줄.
    relationship: {
      stage: stage?.stage_no ?? 1,
      days: stageDays(stage?.stage_since ?? kstLogicalDate(), kstLogicalDate()),
      move: signals.move,
      first: signals.first
        ? { kind: signals.first.kind, by: signals.first.by, confirmed: false }
        : null,
    },
    // 열림 — 판정 호출이 돌려준 4항목. 답에 칸이 없으면 줄도 없다.
    ...(verdict.signals
      ? {
          opened: {
            openedSelf: verdict.signals.openedSelf,
            askedAboutChar: verdict.signals.askedAboutChar,
            saidAffection: verdict.signals.saidAffection,
            moveReaction: verdict.signals.moveReaction,
          },
        }
      : {}),
    // 상대 상태 — 이번 판정이 바꿨는지와 지금 값. 바뀌었으면 직전 값도 같이 남겨 슬랙이
    // 이전 → 지금으로 적는다. 판정 호출 번호는 트레이스가 답장 옆에 적는다.
    userState: {
      changed: verdict.changed,
      failed: verdict.failed,
      callId: verdict.callId,
      label: rel ? userStateLabel(rel, logicalDateOf(kstStamp())) : null,
      prev: verdict.prev,
    },
    bubbles: bubbles.length,
    // 말풍선 사이 간격은 발송할 때 글자 수에서 나온다(1초 안쪽 흔들림) — 길이를 남겨 둔다.
    bubbleLens: bubbles.map((b) => b.length),
  });
  return {
    bubbles,
    signals,
    callId: meta.callId ?? null,
    attach,
    replyMeta: Object.keys(replyMeta).length ? replyMeta : null,
  };
};
