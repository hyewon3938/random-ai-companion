/**
 * 답장 한 통을 받아 오는 자리. 모델을 부르고, 형식이 깨졌으면 한 번 더 부르고, 둘 중
 * 어느 답을 쓸지 고른다.
 *
 * 모델을 부르는 일은 밖에서 넘겨받는다(AskOnce). 고르는 규칙만 남겨 두면 모델 없이도
 * 검사할 수 있어서다 — 답 두 개를 정해 놓고 어느 쪽을 골랐는지 보면 된다(test/reply-ask.test.ts).
 */
import {
  mergeSignals,
  parseReplyOutput,
  type ReplyParse,
  type ReplySignals,
} from "./reply-signal.js";

// 형식이 깨진 답은 한 번 다시 부른다. 대상은 셋이다 — 말풍선을 하나도 못 건진 답(empty),
// JSON을 아예 안 쓰고 본문만 보낸 답(plain), 토큰 상한에 걸려 잘린 답(salvage). 앞의 둘은
// note·호칭 같은 신호가 통째로 사라지고 잘린 답은 뒤 말풍선이 날아가는데, 답장 자체는
// 멀쩡히 나가서 유저 쪽에서도 트레이스에서도 표가 안 난다. 객체 밖으로 신호를 흘린
// 답(stray)은 그 줄을 주워 합치니 잃는 게 없어 그대로 쓴다.
export const RETRY_PARSE: readonly ReplyParse[] = ["empty", "plain", "salvage"];

// 다시 부른 답은 더 잘 읽혔을 때만 갈아 끼운다. 같은 등급이면 첫 답을 쓴다 — 둘 다 JSON을
// 안 썼는데 굳이 뒤엣것으로 바꿀 이유가 없다.
export const PARSE_RANK: Record<ReplyParse, number> = {
  json: 3,
  stray: 2,
  salvage: 1,
  plain: 1,
  empty: 0,
};

export interface ReplyDraft {
  bubbles: string[];
  signals: ReplySignals;
  parse: ReplyParse;
  /** 다시 부른 호출의 기록 id. 안 불렀으면 null이다. */
  retryCallId: number | null;
}

/**
 * 모델을 한 번 부르는 자리. attempt는 몇 번째 부름인지이고, 돌아오는 callId는 그 호출이
 * 기록에 남은 번호다(트레이스에서 재생성 호출을 찾아가는 데 쓴다).
 */
export type AskOnce = (
  attempt: number,
) => Promise<{ text: string; callId: number | null }>;

/** 답장 한 통을 받아 온다. 본문과 신호를 여기서 가른다 — 신호 칸은 유저에게 나가지 않는다. */
export const askReply = async (once: AskOnce): Promise<ReplyDraft> => {
  const firstCall = await once(1);
  const first = parseReplyOutput(firstCall.text);
  if (!RETRY_PARSE.includes(first.parse))
    return { ...first, retryCallId: null };
  const retryCall = await once(2);
  const retry = parseReplyOutput(retryCall.text);
  const take =
    PARSE_RANK[retry.parse] > PARSE_RANK[first.parse] ? retry : first;
  return {
    bubbles: take.bubbles,
    // 신호는 양쪽을 합친다 — 첫 답이 신호 칸만 뱉고 본문을 비운 경우가 실제로 있었고,
    // 두 답이 같은 말에 대한 답이라 어느 쪽에서 나온 신호든 이 대화의 것이다.
    signals: mergeSignals(first.signals, retry.signals),
    parse: take.parse,
    retryCallId: retryCall.callId,
  };
};
