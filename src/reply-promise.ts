// 답장에서 한 연락 약속을 코드가 지킬 시각으로 바꾼다.
//
// 캐릭터가 답장에서 "통화 끝나고 연락할게"라고 하면 그 말은 이제 코드의 책임이다(이슈 #308).
// 모델은 시각을 정하지 않는다 — 시각은 각본 블록의 경계에서 코드가 고른다. 지금 블록이 즉답
// 구간이 아니면 그 블록이 끝나는 시각이고, 즉답 구간이면 다음 블록이 끝나는 시각이다. 즉답
// 구간에서 한 약속은 지금 하는 일이 아니라 곧 시작할 일을 마치고 연락하겠다는 뜻이기 때문이다.
// 그 시각에 pending 행(kind='promise')이 울려 모델을 다시 부르고, 모델은 그때의 대화 기록을
// 보고 보낼 말을 만든다(bot.ts의 약속 처리). 여기는 시각을 고르는 계산만 있다.
import { dayProgressOf, toMin } from "./context/day-progress.js";
import { readTodayPlan } from "./context/input.js";
import type { PlanBlock } from "./day-plan.js";
import { kstLogicalClock } from "./kst.js";
import { BLOCK_END_JITTER_MS } from "./thresholds.js";

export interface PromiseSlot {
  /** 약속을 지키는 시각이 되는 블록 — 이 블록이 끝날 때 연락한다. */
  block: PlanBlock;
  /** 지금부터 그 시각까지. 블록 끝에 초 단위로 맞추지 않도록 1분 안에서 흩뜨린 값이 더해진다. */
  waitMs: number;
}

/**
 * 약속을 지킬 블록. 지금 블록이 즉답 구간이 아니면 그 블록, 즉답 구간이면 다음 블록이다.
 * 각본에 다음 블록이 없으면 null — 그 약속은 코드가 시각을 정할 수 없어 걸지 않는다.
 * 자정 뒤 빈자리를 잠으로 메운 가짜 블록(fallback)은 각본에 없는 블록이라 쓰지 않는다.
 * now는 각본 표기("HH:MM", 자정 뒤는 24를 넘는다).
 */
export const promiseBlock = (
  blocks: PlanBlock[],
  now: string,
): PlanBlock | null => {
  const { cur: progress } = dayProgressOf(blocks, now);
  const cur = progress && !progress.fallback ? progress : null;
  if (cur && cur.responsiveness !== "instant") return cur;
  const from = cur ? cur.end : now;
  return (
    [...blocks]
      .filter((b) => b.start >= from && b.end > now)
      .sort((a, b) => a.start.localeCompare(b.start))[0] ?? null
  );
};

/** 그 블록이 끝날 때까지 기다릴 시간. 이미 지났으면 0에 흩뜨린 값만 더한다. */
export const promiseWaitMs = (block: PlanBlock, now: string): number =>
  Math.max(0, toMin(block.end) - toMin(now)) * 60_000 +
  Math.floor(Math.random() * BLOCK_END_JITTER_MS);

/** 오늘 각본과 지금 시각으로 약속 시각을 고른다. 각본이 없거나 남은 블록이 없으면 null. */
export const promiseSlotFor = (characterId: number): PromiseSlot | null => {
  const plan = readTodayPlan(characterId);
  if (!plan) return null;
  const now = kstLogicalClock();
  const block = promiseBlock(plan.blocks, now);
  return block ? { block, waitMs: promiseWaitMs(block, now) } : null;
};
