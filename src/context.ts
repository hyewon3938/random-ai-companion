// 프롬프트를 조립하는 자리 — 읽기와 조립을 잇는 앞문.
//
// buildSystemBlocks가 context/input.ts로 재료를 읽고 context/assemble.ts로 3층을 쌓는다.
//   불변층   — 정체성 기억(creation), 유저 프로필, 공통 규칙(태도·대화·표기·말의 결·note 신호)
//   일간층   — 관계 8컬럼 서술, 주변 인물, 진행 중인 일, 아크, 일정, 최근 일기
//   실시간   — 검색해 꺼낸 기억, 주제로 찾은 지난 일기와 일정, 오늘 각본, 오늘 메모,
//              직전 대화 시점, 오늘 안의 연락 텀, 지금 시각, 말투, 상황 문단, 답장 객체 설명
// 어느 값을 어디서 읽는지는 input.ts, 어떤 문안으로 어떤 순서로 쌓는지는 assemble.ts에 있다.
//
// 각본 위의 지금(지나온 블록·지금 블록·빈자리의 잠)은 context/day-progress.ts의 순수 계산이고,
// 여기서는 오늘 각본을 읽어 그 계산에 넘기는 currentBlock만 둔다 — 침묵 팔로업과 답장 텀
// 판정이 프롬프트 없이 그 블록만 쓴다.

import type { PlanBlock } from "./day-plan.js";
import type { SystemBlock } from "./llm.js";
import { kstLogicalClock } from "./kst.js";
import { assembleSystemBlocks } from "./context/assemble.js";
import { dayProgressOf, sleepGap, wokeNowLine } from "./context/day-progress.js";
import {
  readContextInput,
  readTodayPlan,
  type BuildOptions,
  type BuildTrace,
} from "./context/input.js";

export { sleepGap, wokeNowLine };
export type { BuildOptions, BuildTrace };

/** 지금 이 순간의 각본 블록. 침묵 팔로업과 답장 텀 판정이 쓴다. */
export const currentBlock = (characterId: number): PlanBlock | null => {
  const plan = readTodayPlan(characterId);
  return plan ? dayProgressOf(plan.blocks, kstLogicalClock()).cur : null;
};

export const buildSystemBlocks = (
  characterId: number,
  chatId: string,
  opts: BuildOptions = {},
): SystemBlock[] =>
  assembleSystemBlocks(readContextInput(characterId, chatId, opts), opts);
