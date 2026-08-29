// 관계 항목을 답장 자리에서 갱신하는 한 자리.
//
// 관계 일곱 항목 중 다섯(상대에게 쓰는 말투·잘 통하는 것·조심할 것·지나온 이야기·지금 마음)은
// 하루를 통째로 돌아보고 쓰는 값이라 새벽 정리가 갖는다. 나머지 셋 — 말투·지금 어떤 사이·서로
// 부르는 말 — 은 대화 도중에 바뀌고 바뀐 티가 그 자리에서 나야 하는 값이라 답장 자리에서
// 갱신한다. 낮에 반말이 됐는데 다음 날 새벽까지 프롬프트가 존댓말 관계를 읽으면 그 사이 답장이
// 전부 옛 사이를 전제로 나간다(이슈 #144).
//
// 세 항목이 한 파일에 있지만 부르는 시점은 둘이다. 갱신한 값이 프롬프트에 실리려면 조립 전에
// 저장돼 있어야 하는데, 단계·호칭은 모델이 답과 함께 넘겨야 알 수 있어 답을 읽은 뒤에야 손에
// 들어오기 때문이다:
//   speechRatchet     — 프롬프트를 조립하기 전. 최근 발화로 반말 전환을 가려 그 자리에서 저장한다.
//   applyReplySignals — 답을 읽은 뒤. 신호로 온 단계·호칭을 지금 값과 견줘 달라진 것만 저장한다.
//
// 세 항목 모두 하루 동안 같은 데이터층(context.ts)에 실리므로 갱신하면 그 층의 프롬프트 캐시를
// 새로 쓴다. 자주 바뀌는 값이 아니라 그 비용은 받아들인다.

import {
  currentSpeechLevel,
  getRelationship,
  setSpeechLevel,
  updateRelationshipNotes,
  type RelationshipNotes,
} from "./db.js";
import type { ReplySignals } from "./reply-signal.js";

/** 관계 한 항목이 실제로 바뀐 기록. 트레이스의 *관계 갱신* 줄이 이 모양을 읽는다. */
export interface RelChange {
  /** 사람이 읽는 항목 이름. context.ts·nightly-trace.ts와 같은 말을 쓴다. */
  field: string;
  from: string | null;
  to: string;
}

/**
 * 말투 전환 — 존댓말에서 반말로 한 방향으로만 간다.
 *
 * 되돌리지 않는 이유는 판정이 최근 발화 표본에 기대기 때문이다. 반말 사이에 존댓말 한 줄이
 * 섞였다고 관계가 존댓말로 돌아간 것은 아닌데, 되돌리게 두면 그 한 줄이 관계를 뒤집는다.
 * 프롬프트를 조립하기 전에 불러야 이번 답장이 바뀐 말투를 읽는다.
 */
export const speechRatchet = (
  characterId: number,
  chatId: string,
  now: string,
): RelChange[] => {
  const prev = getRelationship(characterId)?.speech_level ?? null;
  if (prev === "casual") return [];
  if (currentSpeechLevel(chatId) !== "반말") return [];
  setSpeechLevel(characterId, "casual", now);
  return [{ field: "말투", from: prev, to: "casual" }];
};

/**
 * 답장 신호로 온 단계·호칭을 반영한다.
 *
 * 값이 없거나 공백뿐이면 건드리지 않고(신호를 안 넣은 것과 빈 값이 같은 뜻이다), 지금 값과
 * 같으면 저장도 기록도 하지 않는다 — 같은 값을 다시 써 봐야 updated_at만 움직이고 그 층의
 * 프롬프트 캐시가 헛되이 끊긴다. 달라진 항목만 골라 updateRelationshipNotes를 한 번 부르므로
 * 나머지 항목은 그대로 남는다.
 */
export const applyReplySignals = (
  characterId: number,
  signals: ReplySignals,
  now: string,
): RelChange[] => {
  const rel = getRelationship(characterId);
  const notes: RelationshipNotes = {};
  const changes: RelChange[] = [];

  const put = (
    key: "stage" | "addressTerms",
    field: string,
    current: string | null | undefined,
    raw: string | null,
  ): void => {
    const next = raw?.trim();
    if (!next) return;
    const from = current ?? null;
    if (from === next) return;
    notes[key] = next;
    changes.push({ field, from, to: next });
  };

  put("stage", "지금 어떤 사이", rel?.stage, signals.stage);
  put(
    "addressTerms",
    "서로 부르는 말",
    rel?.address_terms,
    signals.addressTerms,
  );

  if (changes.length) updateRelationshipNotes(characterId, notes, now);
  return changes;
};
