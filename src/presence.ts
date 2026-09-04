// 자리 비움 예고 — 오래 답을 못 하게 되기 전에 미리 알린다(10분 틱).
//
// 유저 발화가 4시간 이내일 때만 본다. 자기 발화로 창이 열리면 캐릭터끼리 말을 이어 가는
// 체인이 된다.
//
// 30분 넘는 답장 불가 구간을 PlanBlock.advance_known으로 갈라 알리는 시점을 나눈다 —
// 미리 아는 일정은 시작 10분 전~3분 후, 닥친 일은 시작 시점~12분 후에 알리고 바로 조용해진다.
// 연속된 불가 사이의 경계는 2분 전~12분 후다. 블록당 1회, 하루 3회까지(복귀 인사는 안 센다).
// 선톡 하루 총량에는 넣지 않는다. 공적 불가는 끝나고 연락한다는 톤으로 쓴다.
//
// 무슨 일로 자리를 비우는지는 마지막 말이 누구 것이든 이 문안에서 반드시 말한다 — 상대 말에만
// 답하고 끝나면 예고가 사라진다. 유저가 남긴 말이 아직 답을 못 받은 채면 짧게 아는 척하고 답은
// 미루고, 마지막 말이 캐릭터 것이면 이미 답한 말에 다시 답하지 않고 그 말에 이어 나간다고 한다.
// 문안 JSON에는 자리를 비우는 일을 한 구절로 적는 away 칸을 두고, 그 칸이 비면 보내지 않는다.
//
// 만든 문안이 한 통도 못 나갔으면 버리지 않고 들고 있다가(proactive-policy의 보관 자리),
// 다음 틱이 같은 블록에 다시 오면 모델을 부르지 않고 그 문안부터 보낸다.
//
// 캐릭터가 방금 말했으면 예고하지 않는다. 기준은 최소 AWAY_QUIET_MIN분이되, 알릴 일정이
// 이미 시작했으면 그 시작 시각까지 넓힌다 — 구간 끝 몰아 답장이 이미 같은 전환을 알린
// 뒤라서, 그 답장 자리에서 다음 일정까지 함께 말하고 예고는 나가지 않는다.
//
// 이렇게 접은 자리는 사유와 함께 트레이스 게시함에 남긴다(traceAwaySkip). 예고가 안 나가는
// 것 자체는 정상이지만 사유가 로그에만 있으면 배포 한 번에 지워지고, 문안까지 만들어 놓고
// 접은 날은 채널에 문안만 남아 나간 것으로 읽힌다(#218).
//
// 다녀온 뒤는 이 모듈 몫이 아니다. 구간 끝의 깨우기 처리(bot.ts)가 몰아 답장과 복귀 인사를
// 한 자리에서 한다.

import { chatJson, type CallMeta } from "./llm.js";
import { config } from "./config.js";
import { isHeldNow } from "./reply-timing.js";
import {
  awayNoticeCountToday,
  awayNoticeSent,
  db,
  getDayPlan,
  hasWaitingWakeRow,
  lastMessage,
  lastUserTs,
  recordSendFailure,
  type CharacterRow,
} from "./db.js";
import { scheduleWakeRow } from "./pending.js";
import {
  holdFailedDraft,
  takeHeldDraft,
  type HeldDraft,
} from "./proactive-policy.js";
import { traceAwaySkip, traceProactiveFail } from "./reply-trace.js";
import { buildSystemBlocks } from "./context.js";
import type { DayPlan, PlanBlock } from "./day-plan.js";
import { blockCategory, isAwayUnavail } from "./day-plan.js";
import {
  sendProactive,
  acquireProactive,
  releaseProactive,
  logErr,
} from "./bot.js";
import {
  AWAY_MIN_BLOCK_MIN,
  BLOCK_END_JITTER_MS,
  AWAY_QUIET_MIN,
  PROACTIVE_RECENT_LINES,
  AWAY_BEFORE_MIN,
  AWAY_AFTER_MIN,
  AWAY_SUDDEN_AFTER_MIN,
  AWAY_BACK_TO_BACK_BEFORE_MIN,
  AWAY_BACK_TO_BACK_AFTER_MIN,
  AWAY_DAILY_MAX,
  RECENT_USER_MS,
} from "./thresholds.js";
import {
  clockLabel,
  kstLogicalClock,
  kstLogicalDate,
  logicalDayStartTs,
} from "./kst.js";

// 자리 비움 예고(선-불가 선톡): 곧 한동안 답장이 어려운 일(운동·샤워·외출·회의 등)이 있으면
// 조용히 사라지지 않고 "이제 ~하러 가요, 답 늦어요"를 먼저 남긴다. 미리 아는 일정은 시작 전에
// 예고하고, 닥친 일은 시작 시점에 알린 뒤 바로 조용해진다.
// 연속으로 바쁜 일 사이의 짧은 틈에는 그 경계에서 방금 한 일과 다음 일을 함께 알려 메운다.
// '찾을 때 있어주기'의 연장 — 막연한 침묵(이탈)을 '알고 하는 기다림'으로 바꾼다. 블록당 한 번.
// 다녀온 뒤 무엇을 보낼지는 이 파일이 정하지 않는다 — 구간 끝에 울리는 표시(bot.ts의 wake
// 핸들러)가 쌓인 메시지 몰아 답장과 복귀 인사를 한 자리에서 처리한다. 다만 그 표시를 거는
// 것은 이 틱의 몫이다(armReturnRow): 예전에는 유저가 그 구간에 말을 걸어야만 표시가 생겨서,
// 나가기 전 대화를 나누고 유저가 답하지 않은 채 구간이 지나가면 캐릭터가 다음 날 아침까지
// 아무 말도 하지 않았다. 유저는 이따 보자는 말을 듣고 기다리는 중인데도.
//
// 문안은 대화와 같은 3층 프롬프트(buildSystemBlocks)에 상황 문단만 얹는다 — 앞 두 층이
// 대화와 같아야 캐시가 붙는다. 정체성·말투·표기 규칙·지금 시각은 3층이 들고 있으니 여기엔 상황만 적는다.

const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const ageMin = (ts: string): number =>
  (Date.now() - new Date(ts.replace(" ", "T") + "+09:00").getTime()) / 60_000;

const lastCharTs = (chatId: string): string | undefined =>
  (
    db
      .prepare(
        `SELECT sent_at FROM messages WHERE chat_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1`,
      )
      .get(chatId) as { sent_at: string } | undefined
  )?.sent_at;

// 문안에 필요한 값(활동 이름·활동 성격·닥친 일인지·언제 끝나는지)이 전부 블록에 들어 있어,
// 부르는 쪽이 하나씩 뽑아 넘기지 않고 블록 자체를 넘긴다.
// pending은 마지막 메시지가 유저 것인지다 — 답을 못 받은 말이 있으면 아는 척하고 미루고,
// 마지막 말이 캐릭터 것이면 이미 답한 말에 다시 답하지 않게 갈라 적는다(이슈 #265).
export const presenceSituation = (
  block: PlanBlock,
  between: boolean,
  prevAct: string,
  pending: boolean,
): string => {
  const activity = block.activity;
  // 연속 불가 사이의 경계(between)는 앞 일이 끝난 자리라, 미리 알던 일정이 아니어도 닥친 일로 치지 않는다.
  const sudden = !between && !block.advance_known;
  const fixed = blockCategory(block) === "official";
  const mins = toMin(block.end) - toMin(block.start);
  return [
    `[문안 — 지금 보낼 자리 비움 예고 한 통]`,
    between
      ? `너는 방금 "${prevAct}"을(를) 막 끝냈고, 이제 곧 "${activity}"을(를) 하러 간다. 그 동안은 답장이 어렵다.`
      : sudden
        ? `너는 지금 막 "${activity}"을(를) 시작해야 한다. 갑자기 생긴 일이라 미리 말을 못 했고, 지금부터는 답장이 어렵다.`
        : `너는 이제 곧 "${activity}"을(를) 하러 간다. 그 동안은 답장이 어렵거나 느려진다.`,
    fixed
      ? `이건 미룰 수 없는 공적 의무(회의·시험·발표 등)라 폰을 못 본다. 끝나고 연락하겠다는 결로 알린다.`
      : `이건 급하면 미루거나 조정할 수도 있는 일이다. 가볍게 잠깐 다녀오겠다, 급하면 말하라는 결로.`,
    `이 일은 ${clockLabel(block.end)}에 끝난다(${mins}분짜리). 얼마나 걸리는지 말할지는 네가 정하되, 말한다면 이 시각 그대로 쓴다 — 어림해서 다른 시각을 지어내지 않는다.`,
    pending
      ? `상대가 방금 남긴 말이 있다(위 [방금까지 오간 말]의 마지막 줄). 지금 제대로 답하긴 어려우니 짧게 아는 척만 하고, 다녀와서/이따 얘기하자는 정도로 미뤄도 된다.`
      : `위 [방금까지 오간 말]은 네 말로 끝났다. 상대 말에는 그때 이미 답했으니 다시 답하지 않고, 네가 마지막으로 한 말에 이어서 이제 자리를 비운다는 말을 꺼낸다.`,
    `답을 미루든 앞말에 이어 말하든, 무슨 일로 자리를 비우는지는 반드시 남긴다. 상대 말에만 답하고 끝내면 이 문안은 제 몫을 못 한다.`,
    ``,
    `조용히 사라지지 말고, 상대가 '네가 뭘 하는지 알고 기다리게' 지금 상황을 가볍게 한 마디 남긴다. 매달림이 아니라 배려다.`,
    `- 나가는 경우: 이제 그 일을 하러 가고 그동안 답이 늦어질 거라고 가볍게 알리는 결.`,
    `- 방금 뭔가 하고 와서 또 나가는 경우: 방금 한 걸 자연스럽게 언급하며 이제 다음 걸 하러 간다고 말한다.`,
    `- 짧게 1~2개 말풍선(줄바꿈 구분). 재촉·서운함·매달림 없음.`,
    `- 억지스러우면(딱히 알릴 만한 상황이 아니면) send=false.`,
    `- away 칸에는 무슨 일로 자리를 비우는지 한 구절로 먼저 적고, text는 그 일이 들어가게 쓴다.`,
    ``,
    `JSON으로만 답한다: {"send":true,"away":"무슨 일로 자리를 비우는지 한 구절","text":"..."} 또는 {"send":false}`,
  ].join("\n");
};

// 틱 재진입 방지 — LLM 호출·발송으로 한 틱이 길어져 다음 크론과 겹치면 이중 발송이 된다.
let running = false;

export const runPresenceTick = async (): Promise<void> => {
  if (running) return;
  running = true;
  try {
    await presenceTickBody();
  } finally {
    running = false;
  }
};

/**
 * 지금 들어가 있는 불가 구간이 끝나는 시각에 울릴 표시를 걸어 둔다.
 *
 * 예고를 보냈는지와 무관하게 건다 — 예고가 막혀 조용히 사라진 날이야말로 돌아와서 말을
 * 거는 게 필요한 날이다. 유저가 그 구간에 말을 걸면 이 행이 'wake'로 바뀌어(promoteWakeRow)
 * 몰아 답장 쪽으로 간다. 걸어 둔 것이 이미 있으면 두지 않는다 — 한 구간에 행은 하나다.
 */
const armReturnRow = (
  characterId: number,
  chatId: string,
  blocks: PlanBlock[],
  nowMin: number,
  userMsgAt: string,
): void => {
  if (hasWaitingWakeRow(chatId)) return;
  const cur = blocks.find(
    (b) => toMin(b.start) <= nowMin && nowMin < toMin(b.end),
  );
  if (!cur || !isAwayUnavail(cur)) return;
  // 알리지 않고 다녀오는 짧은 구간은 돌아와서 인사도 하지 않는다 — 나갈 때 말이 없었는데
  // 들어와서만 말하면 유저 쪽에서는 앞뒤가 맞지 않는다.
  if (toMin(cur.end) - toMin(cur.start) < AWAY_MIN_BLOCK_MIN) return;
  const waitMs =
    (toMin(cur.end) - nowMin) * 60_000 +
    Math.floor(Math.random() * BLOCK_END_JITTER_MS);
  scheduleWakeRow({
    chatId,
    characterId,
    userMsgAt,
    waitMs,
    meta: {
      activity: cur.activity,
      blockStart: cur.start,
      blockEnd: cur.end,
    },
    kind: "return",
  });
};

const presenceTickBody = async (): Promise<void> => {
  const rows = db
    .prepare(`SELECT * FROM characters WHERE status = 'active'`)
    .all() as CharacterRow[];

  for (const c of rows) {
    const raw = getDayPlan(c.id, kstLogicalDate());
    if (!raw) continue;
    let blocks: PlanBlock[];
    try {
      blocks = (JSON.parse(raw) as DayPlan).blocks;
    } catch {
      continue;
    }
    const nowMin = toMin(kstLogicalClock());

    // 유저가 방금까지 대화 중이었을 때만 — 하루 종일 조용한 상대에게 뜬금없이 알리지 않는다.
    // 캐릭터 자기 발화까지 세면 아침 선톡이 '최근 대화'가 되어 예고가 예고를 부르는 체인이 생겼다
    // (실측: 침묵일에도 하루 최대 5통). 유저 기준 네 시간은 침묵 백오프(3일)를 자연히 포함한다.
    const lu = lastUserTs(c.chat_id);
    if (!lu || ageMin(lu) > RECENT_USER_MS / 60_000) continue;
    const last = lastMessage(c.chat_id);
    if (!last) continue;
    // 유저가 붙잡아 지금 일정을 접고 곁에 있는 중이면 자리 비움 예고를 하지 않는다.
    if (isHeldNow(c.id)) continue;

    // 구간 끝에 울릴 표시부터 걸어 둔다. 아래 예고가 상한·중복·침묵으로 접히더라도
    // 돌아와서 말을 걸 자리는 남는다.
    armReturnRow(c.id, c.chat_id, blocks, nowMin, lu);

    // 하루 예고 상한 — 나갔다 오는 일정이 많은 날도 알리는 말이 과해지지 않게 막는다.
    // 하루 각본을 만들 때부터 같은 상한을 지키므로 여기서 걸리는 날은 드물다.
    // dayStart는 논리일(새벽 5시 컷오프) 기준 — 달력일 기준이면 자정~새벽에 카운트가 리셋된다.
    const dayStart = logicalDayStartTs();
    if (awayNoticeCountToday(c.chat_id, dayStart) >= AWAY_DAILY_MAX) continue;

    // 예고할 불가 블록 찾기: 미리 아는 일정은 시작 직전, 닥친 일은 시작 시점,
    // 연속 불가 사이는 경계(직후)에 알린다.
    let target: PlanBlock | null = null;
    let between = false;
    let prevAct = "";
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (!isAwayUnavail(b)) continue;
      const dur = toMin(b.end) - toMin(b.start);
      // 짧은 자리 비움은 예고 없이 그냥 다녀온다 — 예전엔 결정론적 난수로 ~1/4만
      // 알리는 마이크로 디테일이 있었지만, 리얼리즘 효용 대비 설명·유지 비용이 커서 접었다.
      if (dur < AWAY_MIN_BLOCK_MIN) continue;
      const prev = i > 0 ? blocks[i - 1] : null;
      const prevAway = prev ? isAwayUnavail(prev) : false;
      const rel = toMin(b.start) - nowMin; // +면 아직 시작 전, -면 이미 시작
      // 직전도 불가면(사이 틈) 시작 직후 경계에서만 — 직전 불가 중엔 못 보내므로.
      // 직전이 여유면: 미리 아는 일정은 시작 전에 예고하고, 닥친 일은 시작 시점에 알린다.
      const eligible = prevAway
        ? rel <= AWAY_BACK_TO_BACK_BEFORE_MIN &&
          rel >= -AWAY_BACK_TO_BACK_AFTER_MIN
        : b.advance_known
          ? rel <= AWAY_BEFORE_MIN && rel >= -AWAY_AFTER_MIN
          : rel <= 0 && rel >= -AWAY_SUDDEN_AFTER_MIN;
      if (!eligible) continue;
      if (awayNoticeSent(c.chat_id, dayStart, b.start)) continue;
      target = b;
      between = prevAway;
      prevAct = prev?.activity ?? "";
      break;
    }
    if (!target) continue;

    // 캐릭터가 방금 말했으면 예고를 접는다 — 답장과 예고가 겹쳐 쌓이지 않게.
    // 기준은 최소 AWAY_QUIET_MIN분이되, 알릴 일정이 이미 시작했으면 그 시작 시각까지 넓힌다.
    // 불가 구간이 끝나는 자리에서 몰아 답장이 나가고 그 시각이 곧 다음 일정의 시작이라,
    // 시간만 재면 그 답장이 이미 말한 전환("방금 끝났고 이제 ~하러 간다")을 또 말하게 된다.
    const lc = lastCharTs(c.chat_id);
    const quietMin = Math.max(AWAY_QUIET_MIN, nowMin - toMin(target.start));
    if (lc && ageMin(lc) < quietMin) {
      const detail = `${Math.round(ageMin(lc))}분 전에 이미 말했다, 기준 ${Math.round(quietMin)}분`;
      console.log(
        `[presence] ${c.chat_id} @ ${target.activity} 접음 — ${detail}`,
      );
      traceAwaySkip({
        characterId: c.id,
        reason: "just_spoke",
        activity: target.activity,
        block: target.start,
        detail,
      });
      continue;
    }

    // 다른 선톡 틱·답장이 이 chat에 진행 중이면 이번 틱은 접는다
    if (!acquireProactive(c.chat_id)) continue;
    // 호출 번호를 catch에서도 봐야 한다 — 발송에 실패하면 이 문안 스레드에 실패를 단다.
    const meta: CallMeta = {
      purpose: "away",
      characterId: c.id,
      chatId: c.chat_id,
    };
    // 앞 틱에서 못 나간 문안이 같은 블록의 것이면 모델을 다시 부르지 않고 그것부터 보낸다 —
    // 길이 몇 분 끊긴 사이 같은 예고를 매 틱 새로 만들어 또 실패하는 것을 막는다(이슈 #269).
    let outgoing: HeldDraft | null = takeHeldDraft(
      c.chat_id,
      "away",
      target.start,
    );
    try {
      if (!outgoing) {
        const draft = await chatJson<{
          send: boolean;
          away?: string;
          text?: string;
        }>(
          buildSystemBlocks(c.id, c.chat_id, {
            recent: PROACTIVE_RECENT_LINES,
            situation: presenceSituation(
              target,
              between,
              prevAct,
              last.role === "user",
            ),
          }),
          "위 상황 문단대로 문안을 만들어.",
          400,
          config.model, // 실시간성이라 대화 모델(sonnet)
          meta,
        );
        // 자리를 비우는 일을 적는 칸이 비었으면 보내지 않는다 — 상대 말에 답만 하고 나간 문안이
        // 이 모양이다(이슈 #265). 다음 틱에 아직 알릴 창 안이면 다시 만든다.
        const away = typeof draft.away === "string" ? draft.away.trim() : "";
        if (draft.send && draft.text && !away) {
          console.log(
            `[presence] ${c.chat_id} @ ${target.activity} 접음 — 문안에 자리를 비우는 일이 없다`,
          );
          traceAwaySkip({
            characterId: c.id,
            reason: "no_away",
            activity: target.activity,
            block: target.start,
            callId: meta.callId,
          });
        } else if (draft.send && draft.text) {
          outgoing = {
            kind: "away",
            text: draft.text,
            block: target.start,
            madeAt: Date.now(),
          };
        }
      }
      // 발송 직전 재확인 — LLM을 기다리는 사이 대화 상태가 바뀌었으면(유저 추가 발화·다른 발송) 접는다
      if (outgoing && lastMessage(c.chat_id)?.sent_at !== last.sent_at) {
        console.log(
          `[presence] ${c.chat_id} @ ${target.activity} 접음 — 문안을 만드는 사이 마지막 메시지가 바뀌었다`,
        );
        traceAwaySkip({
          characterId: c.id,
          reason: "conversation_moved",
          activity: target.activity,
          block: target.start,
          callId: meta.callId,
        });
      } else if (outgoing) {
        await sendProactive(c.chat_id, c.id, outgoing.text, "away", {
          block: target.start,
        });
        outgoing = null; // 나갔으니 들고 있지 않는다
        console.log(
          `[presence] ${c.chat_id} @ ${target.activity} (between=${between})`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logErr("[presence] 전송 실패:", e);
      recordSendFailure(c.chat_id, c.id, "away", msg);
      traceProactiveFail({
        characterId: c.id,
        kind: "away",
        error: msg,
        callId: meta.callId,
      });
      // 만들어 둔 문안이 한 통도 못 나갔으면 들고 있는다(일부라도 나가면 sendProactive가
      // 던지지 않으므로 여기 오지 않는다 — 같은 말이 두 번 나갈 일은 없다).
      if (outgoing) holdFailedDraft(c.chat_id, outgoing);
    } finally {
      releaseProactive(c.chat_id);
    }
  }
};
