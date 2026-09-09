// 틈새 한 줄 — 불가 구간에 온 확인 말에 지금 하는 일과 끝나는 시각을 짧게 알린다(5분 틱).
//
// 불가 구간에서는 답장을 만들지 않고 구간 끝에 몰아 답하는데, 그 사이 유저가 있는지·뭐 하는지
// 묻는 한 통을 남기면 붙잡기 판정은 아님으로 답하고 유저는 구간이 끝날 때까지 아무 말도 못
// 받는다. 그 자리에 무엇을 하는 중이고 몇 시에 끝나는지만 알리는 한 마디가 이것이다. 일정은
// 바꾸지 않는다 — 유저가 그 뒤에 그만하고 놀자고 하면 그건 붙잡기 판정이 받는다(이슈 #339).
//
// 조건은 glanceBlock이 정한다. 지금이 불가 블록 안이고, 마지막 말이 유저 것이며 그 말이 이
// 블록 안에서 GLANCE_AFTER_USER_MIN분 이상 지났고, 블록 끝까지 GLANCE_MIN_LEFT_MIN분 넘게
// 남았을 때만이다. 잠·공적 블록은 뺀다. 확인 말인지는 모델이 정한다 — 전하는 말이나 나중에
// 답해도 되는 물음이면 send=false로 답하고, 그 유저 말 시각을 프로세스 안에서 기억해 같은
// 말에 다시 묻지 않는다. 블록마다 한 번이고, 하루 선톡 합계에는 넣지 않는다(proactive-policy).
//
// 선톡 경로(sendProactiveDraft)를 타므로 답장 텀도, 구간 끝의 몰아 답장 시각도 그대로다.
// 몰아 답장은 이 한 마디 뒤에 온 말까지 한 번에 읽는다.

import { isHeldNow } from "./reply-timing.js";
import { glanceSentForBlock } from "./proactive-policy.js";
import { getActiveCharacters, getDayPlan, lastMessage } from "./db.js";
import { noOverlap, sendProactiveDraft } from "./proactive-send.js";
import { traceGlanceSkip } from "./reply-trace.js";
import { type DayPlan, type PlanBlock, blockCategory, isAwayUnavail } from "./day-plan.js";
import { toMin } from "./context/day-progress.js";
import { GLANCE_AFTER_USER_MIN, GLANCE_MIN_LEFT_MIN } from "./thresholds.js";
import { clockLabel, kstLogicalClock, kstLogicalDate, logicalDayStartTs } from "./kst.js";

const ageMin = (ts: string): number =>
  (Date.now() - new Date(ts.replace(" ", "T") + "+09:00").getTime()) / 60_000;

/**
 * 지금 틈새 한 줄을 보낼 자리인지. 맞으면 그 불가 블록을, 아니면 null을 돌려준다.
 * userAgeMin은 마지막 메시지가 온 뒤 지난 분 수다 — 블록 시작 전에 온 말은 이 블록의 확인
 * 말이 아니라서 (블록 시작부터 지금까지의 분 수)보다 오래된 말은 뺀다.
 */
export const glanceBlock = (
  blocks: PlanBlock[],
  nowMin: number,
  lastRole: string,
  userAgeMin: number,
): PlanBlock | null => {
  if (lastRole !== "user") return null;
  const cur = blocks.find((b) => toMin(b.start) <= nowMin && nowMin < toMin(b.end));
  if (!cur || !isAwayUnavail(cur)) return null;
  if (blockCategory(cur) === "official") return null;
  if (userAgeMin > nowMin - toMin(cur.start)) return null;
  if (userAgeMin < GLANCE_AFTER_USER_MIN) return null;
  if (toMin(cur.end) - nowMin <= GLANCE_MIN_LEFT_MIN) return null;
  return cur;
};

/** 상황 문단. 확인 말인지 가르는 것도, 보낼지 정하는 것도 모델이라 판단 기준을 여기 적는다. */
export const glanceSituation = (block: PlanBlock): string =>
  [
    `[문안 — 지금 보낼 틈새 한 줄]`,
    `너는 지금 "${block.activity}"을(를) 하는 중이라 제대로 답하기 어렵다. 이 일은 ${clockLabel(block.end)}에 끝난다.`,
    `상대가 그 사이에 말을 남겼다(위 [방금까지 오간 말]의 마지막 줄). 그 말이 어떤 말인지 보고 보낼지 정한다.`,
    `- 네가 있는지, 지금 뭐 하는지, 아직 그 일을 하는 중인지 묻는 확인 말이면 보낸다. 지금 무엇을 하는 중인지와 몇 시에 끝나는지를 위 값 그대로 짧게 알리고, 무슨 일인지 되묻는 한 마디를 붙여도 된다.`,
    `- 그냥 전하는 말(오늘 있었던 일, 감상, 사진 설명)이나 나중에 답해도 되는 물음이면 send=false. 그 말에는 이 일이 끝난 뒤에 제대로 답한다.`,
    `- 끝나는 시각은 ${clockLabel(block.end)} 그대로 쓴다 — 어림해서 다른 시각을 지어내지 않는다. 일정을 바꾸거나 미루겠다고 말하지 않는다.`,
    `- 짧은 문장 2~3개, 말풍선 1~2개(줄바꿈 구분). 상대 말에 본격적으로 답하지 않는다 — 그건 끝나고 한다.`,
    ``,
    `JSON으로만 답한다: {"send":true,"text":"..."} 또는 {"send":false}`,
  ].join("\n");

/** 확인 말이 아니라고 판정한 마지막 메시지 시각(chatId별). 같은 말에 5분마다 다시 묻지 않게. */
const judged = new Map<string, string>();

const glanceTickBody = async (): Promise<void> => {
  for (const c of getActiveCharacters()) {
    const raw = getDayPlan(c.id, kstLogicalDate());
    if (!raw) continue;
    let blocks: PlanBlock[];
    try {
      blocks = (JSON.parse(raw) as DayPlan).blocks;
    } catch {
      continue;
    }
    const last = lastMessage(c.chat_id, c.id);
    if (!last) continue;
    const target = glanceBlock(blocks, toMin(kstLogicalClock()), last.role, ageMin(last.sent_at));
    if (!target) continue;
    if (judged.get(c.chat_id) === last.sent_at) continue;
    // 붙잡기 판정이 요청으로 나온 블록은 이미 몰아 답장이 당겨져 있어 이 한 마디가 끼어들 자리가 아니다.
    if (isHeldNow(c.id)) continue;
    const block = target.start;
    if (glanceSentForBlock(c.chat_id, c.id, logicalDayStartTs(), block)) continue;

    const activity = target.activity;
    const askedAt = last.sent_at;
    await sendProactiveDraft<{ send: boolean; text?: string }>({
      characterId: c.id,
      chatId: c.chat_id,
      kind: "glance",
      block,
      lastSentAt: askedAt,
      situation: glanceSituation(target),
      maxTokens: 300,
      read: (draft, meta) => {
        if (draft.send && draft.text) return draft.text;
        judged.set(c.chat_id, askedAt);
        console.log(`[glance] ${c.chat_id} @ ${activity} 접음 — 확인 말이 아니다`);
        traceGlanceSkip({
          characterId: c.id,
          reason: "not_check",
          activity,
          block,
          callId: meta.callId,
        });
        return null;
      },
      label: "[glance]",
      sentLog: `[glance] ${c.chat_id} @ ${activity} 끝 ${clockLabel(target.end)}`,
      onMoved: (meta) => {
        console.log(
          `[glance] ${c.chat_id} @ ${activity} 접음 — 문안을 만드는 사이 마지막 메시지가 바뀌었다`,
        );
        traceGlanceSkip({
          characterId: c.id,
          reason: "conversation_moved",
          activity,
          block,
          callId: meta.callId,
        });
      },
    });
  }
};

/** 5분 틱. 앞 틱이 아직 도는 중이면 겹치지 않고 건너뛴다. */
export const runGlanceTick = noOverlap(glanceTickBody);
