import { chatJson } from "./llm.js";
import { config } from "./config.js";
import { isHeldNow } from "./reply-timing.js";
import {
  awayNoticeCountToday,
  db,
  getDayPlan,
  lastMessage,
  lastUserTs,
  recordSendFailure,
  type CharacterRow,
} from "./db.js";
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
  AWAY_BEFORE_MIN,
  AWAY_AFTER_MIN,
  AWAY_SUDDEN_AFTER_MIN,
  AWAY_BACK_TO_BACK_BEFORE_MIN,
  AWAY_BACK_TO_BACK_AFTER_MIN,
  AWAY_DAILY_MAX,
  RECENT_USER_MS,
} from "./thresholds.js";
import { kstClock, kstDateString, logicalDayStartTs } from "./kst.js";

// 자리 비움 예고(선-불가 선톡): 곧 한동안 답장이 어려운 일(운동·샤워·외출·회의 등)이 있으면
// 조용히 사라지지 않고 "이제 ~하러 가요, 답 늦어요"를 먼저 남긴다. 미리 아는 일정은 시작 전에
// 예고하고, 닥친 일은 시작 시점에 알린 뒤 바로 조용해진다.
// 연속으로 바쁜 일 사이의 짧은 틈에는 그 경계에서 방금 한 일과 다음 일을 함께 알려 메운다.
// '찾을 때 있어주기'의 연장 — 막연한 침묵(이탈)을 '알고 하는 기다림'으로 바꾼다. 블록당 한 번.
// 다녀온 뒤는 이 파일 몫이 아니다 — 구간 끝의 깨우기 표시(bot.ts의 wake 핸들러)가 쌓인 메시지
// 몰아 답장과 복귀 인사를 한 자리에서 처리한다.
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

const lastLineOf = (chatId: string): string =>
  (
    db
      .prepare(
        `SELECT text FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(chatId) as { text: string } | undefined
  )?.text ?? "";

const presenceSituation = (
  activity: string,
  between: boolean,
  prevAct: string,
  sudden: boolean,
  pending: boolean,
  lastLine: string,
  fixed: boolean,
): string =>
  [
    `[문안 — 지금 보낼 자리 비움 예고 한 통]`,
    between
      ? `너는 방금 "${prevAct}"을(를) 막 끝냈고, 이제 곧 "${activity}"을(를) 하러 간다. 그 동안은 답장이 어렵다.`
      : sudden
        ? `너는 지금 막 "${activity}"을(를) 시작해야 한다. 갑자기 생긴 일이라 미리 말을 못 했고, 지금부터는 답장이 어렵다.`
        : `너는 이제 곧 "${activity}"을(를) 하러 간다. 그 동안은 답장이 어렵거나 느려진다.`,
    fixed
      ? `이건 미룰 수 없는 공적 의무(회의·시험·발표 등)라 폰을 못 본다. 끝나고 연락하겠다는 결로 알린다.`
      : `이건 급하면 미루거나 조정할 수도 있는 일이다. 가볍게 잠깐 다녀오겠다, 급하면 말하라는 결로.`,
    ...(pending
      ? [
          `상대가 방금 남긴 말이 있다: "${lastLine.replace(/\n/g, " ")}". 지금 제대로 답하긴 어려우니 짧게 아는 척만 하고, 다녀와서/이따 얘기하자는 정도로 미뤄도 된다.`,
        ]
      : []),
    ``,
    `조용히 사라지지 말고, 상대가 '네가 뭘 하는지 알고 기다리게' 지금 상황을 가볍게 한 마디 남긴다. 매달림이 아니라 배려다.`,
    `- 나가는 경우: 이제 그 일을 하러 가고 그동안 답이 늦어질 거라고 가볍게 알리는 결.`,
    `- 방금 뭔가 하고 와서 또 나가는 경우: 방금 한 걸 자연스럽게 언급하며 이제 다음 걸 하러 간다고 말한다.`,
    `- 짧게 1~2개 말풍선(줄바꿈 구분). 재촉·서운함·매달림 없음.`,
    `- 억지스러우면(딱히 알릴 만한 상황이 아니면) send=false.`,
    ``,
    `JSON으로만 답한다: {"send":true,"text":"..."} 또는 {"send":false}`,
  ].join("\n");

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

const presenceTickBody = async (): Promise<void> => {
  const rows = db
    .prepare(`SELECT * FROM characters WHERE status = 'active'`)
    .all() as CharacterRow[];

  for (const c of rows) {
    const raw = getDayPlan(c.id, kstDateString());
    if (!raw) continue;
    let blocks: PlanBlock[];
    try {
      blocks = (JSON.parse(raw) as DayPlan).blocks;
    } catch {
      continue;
    }
    const nowMin = toMin(kstClock());

    // 유저가 방금까지 대화 중이었을 때만 — 하루 종일 조용한 상대에게 뜬금없이 알리지 않는다.
    // 캐릭터 자기 발화까지 세면 아침 선톡이 '최근 대화'가 되어 예고가 예고를 부르는 체인이 생겼다
    // (실측: 침묵일에도 하루 최대 5통). 유저 기준 네 시간은 침묵 백오프(3일)를 자연히 포함한다.
    const lu = lastUserTs(c.chat_id);
    if (!lu || ageMin(lu) > RECENT_USER_MS / 60_000) continue;
    const last = lastMessage(c.chat_id);
    if (!last) continue;
    // 유저가 붙잡아 지금 일정을 접고 곁에 있는 중이면 자리 비움 예고를 하지 않는다.
    if (isHeldNow(c.id)) continue;
    // 방금(≤5분) 캐릭터가 발화했으면 스킵 — 답장/예고가 겹쳐 쌓이지 않게.
    const lc = lastCharTs(c.chat_id);
    if (lc && ageMin(lc) < 5) continue;

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
      const dup = db
        .prepare(
          `SELECT 1 FROM messages WHERE chat_id = ? AND sent_at >= ? AND meta_json LIKE ? AND meta_json LIKE ? LIMIT 1`,
        )
        .get(c.chat_id, dayStart, '%"kind":"away"%', `%"block":"${b.start}"%`);
      if (dup) continue;
      target = b;
      between = prevAway;
      prevAct = prev?.activity ?? "";
      break;
    }
    if (!target) continue;

    // 다른 선톡 틱·답장이 이 chat에 진행 중이면 이번 틱은 접는다
    if (!acquireProactive(c.chat_id)) continue;
    try {
      const draft = await chatJson<{ send: boolean; text?: string }>(
        buildSystemBlocks(c.id, c.chat_id, {
          situation: presenceSituation(
            target.activity,
            between,
            prevAct,
            !between && !target.advance_known,
            last.role === "user",
            lastLineOf(c.chat_id),
            blockCategory(target) === "official",
          ),
        }),
        "위 상황 문단대로 문안을 만들어.",
        400,
        config.model, // 실시간성이라 대화 모델(sonnet)
        { purpose: "away", characterId: c.id, chatId: c.chat_id },
      );
      // 발송 직전 재확인 — LLM을 기다리는 사이 대화 상태가 바뀌었으면(유저 추가 발화·다른 발송) 접는다
      if (
        draft.send &&
        draft.text &&
        lastMessage(c.chat_id)?.sent_at === last.sent_at
      ) {
        await sendProactive(c.chat_id, c.id, draft.text, "away", {
          block: target.start,
        });
        console.log(
          `[presence] ${c.chat_id} @ ${target.activity} (between=${between})`,
        );
      }
    } catch (e) {
      logErr("[presence] 전송 실패:", e);
      recordSendFailure(
        c.chat_id,
        c.id,
        "away",
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      releaseProactive(c.chat_id);
    }
  }
};
