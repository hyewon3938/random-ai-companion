// 각본 위의 지금 — 지금 시각이 각본의 어느 블록인지, 지나온 블록, 빈자리를 메우는 잠.
//
// 각본 표기(05:00~28:59)의 시각 문자열만 받는 순수 계산이다. 각본을 읽어 오는 일은 context.ts가
// 하고, 여기 결과는 프롬프트의 지금 절(context/assemble.ts)과 침묵 팔로업·답장 텀 판정이
// 같이 쓴다. 각본에 지금 시각을 덮는 블록이 없으면 sleepGap이 잠 블록으로 메운다(자정 이후만).
// 오늘 실제 기록이 지금 블록을 각본과 다르게 만든 경우(자다 깸, 붙잡혀 취소하거나 미룸)의
// 지금 문장도 여기서 만든다.

import type { PlanBlock } from "../day-plan.js";
import { clockLabel, logicalClockOf } from "../kst.js";
import { HOLD_OUTCOME, RESPONSIVENESS_NAME } from "../labels.js";

// 하루의 자정과 끝 — 각본 표기(05:00~28:59) 기준이다.
const MIDNIGHT = "24:00";
const DAY_END = "29:00";

/**
 * 각본에 지금 시각을 덮는 블록이 없을 때 그 빈자리를 잠으로 메운다.
 *
 * 하루를 23:59까지만 잡던 옛 각본이나 만들다 만 각본이 있어서, 자정을 넘긴 시각에는 덮는
 * 블록이 없는 일이 생긴다. 그때 지금 하는 일을 모르는 채로 답하는 것보다 자다 깬 사람으로
 * 답하는 편이 실제에 가깝다. 낮의 빈자리는 그대로 둔다 — 한낮에 자고 있다고 말하는 쪽이
 * 더 큰 거짓말이다.
 */
export const sleepGap = (
  blocks: PlanBlock[],
  now: string,
): PlanBlock | null => {
  if (now < MIDNIGHT) return null;
  return {
    start: blocks
      .filter((b) => b.end <= now)
      .reduce((latest, b) => (b.end > latest ? b.end : latest), MIDNIGHT),
    end: blocks
      .filter((b) => b.start > now)
      .reduce(
        (earliest, b) => (b.start < earliest ? b.start : earliest),
        DAY_END,
      ),
    activity: "잠",
    responsiveness: "unavailable",
    advance_known: true,
    category: "personal",
    fallback: true,
  };
};

/** 지나온 블록과 지금 블록. 지금 시각을 덮는 블록이 없으면 잠으로 메운 블록이거나 null이다. */
export interface DayProgress {
  past: PlanBlock[];
  cur: PlanBlock | null;
}

export const dayProgressOf = (
  blocks: PlanBlock[],
  now: string,
): DayProgress => ({
  past: blocks.filter((b) => b.end <= now),
  cur:
    blocks.find((b) => b.start <= now && now < b.end) ??
    sleepGap(blocks, now),
});

export const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

// 자는 시간에 상대 연락으로 깬 뒤의 '지금' 문장. 각본은 아직 잠으로 되어 있지만 오늘 실제
// 기록에 깸 행이 있으면 그 행의 시각이 깬 시각이다 — 모델이 몇 시에 깼는지 어림해 지어내지 않게
// 코드가 세어 준다(이슈 #288). wokeAt은 기록의 recorded_at("YYYY-MM-DD HH:MM:SS"), now는 각본 표기.
export const wokeNowLine = (
  cur: PlanBlock,
  wokeAt: string,
  now: string,
): string => {
  const clock = wokeAt.slice(11, 16);
  const awake = Math.max(0, toMin(now) - toMin(logicalClockOf(wokeAt)));
  return `너는 각본상 ${clockLabel(cur.start)}~${clockLabel(cur.end)} 자는 시간이지만 ${clock}에 상대 연락에 깼고, 지금 ${awake}분째 깨어 있다. 깬 시각은 이 값 그대로다 — 몇 시에 깼는지 다른 시각을 어림해 말하지 않는다. 자다 깬 채로 답하는 자리라 답장 여건은 ${RESPONSIVENESS_NAME.instant}이고, 도로 잘지는 대화가 정한다.`;
};

// 상대가 붙잡아 지금 블록의 일을 취소하거나 미룬 뒤의 '지금' 문장. 각본은 아직 그 일로 되어
// 있지만 오늘 실제 기록에 취소·미룸 행이 있으면 그 일을 하지 않고 상대와 이야기하는 중이다.
// 결정을 답장 한 번에만 알리면 같은 블록의 다음 답장과 다시 만든 답장에서 빠지므로, 기록에서
// 읽어 매번 넣는다(이슈 #430). heldAt은 기록의 recorded_at("YYYY-MM-DD HH:MM:SS").
export const heldNowLine = (
  cur: PlanBlock,
  outcome: string,
  heldAt: string,
): string => {
  const clock = heldAt.slice(11, 16);
  const cancelled = outcome.trim() === HOLD_OUTCOME.cancelled;
  return `너는 각본상 ${clockLabel(cur.start)}~${clockLabel(cur.end)} "${cur.activity}" 시간이지만 ${clock}에 상대가 붙잡아서 이 일을 ${cancelled ? "취소했다" : "미뤘다"}. 지금은 그 일을 하지 않고 상대와 이야기하는 중이라 답장 여건은 ${RESPONSIVENESS_NAME.instant}이다. ${cancelled ? "취소한 일을 지금 하거나 곧 하러 가는 것처럼 말하지 않고, 그 일이 끝나면 연락하겠다고 하지 않는다." : "미룬 일은 나중에 한다는 결로만 말하고 지금 하러 가겠다고 하지 않는다."}`;
};
