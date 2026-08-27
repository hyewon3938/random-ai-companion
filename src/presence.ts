import { chatJson } from "./llm.js";
import { config } from "./config.js";
import { renderUserBlock } from "./user-profile.js";
import { isHeldNow } from "./reply-timing.js";
import {
  db,
  getDayPlan,
  lastMessage,
  proactiveCountToday,
  recordSendFailure,
  speechGuard,
  PROACTIVE_DAILY_MAX,
  type CharacterRow,
} from "./db.js";
import type { Bible } from "./character.js";
import { OUTPUT_FORMAT_COMPACT, SPEECH_TEXTURE_COMPACT } from "./context.js";
import type { DayPlan, PlanBlock } from "./day-plan.js";
import { blockCategory } from "./day-plan.js";
import {
  sendProactive,
  acquireProactive,
  releaseProactive,
  logErr,
} from "./bot.js";
import {
  kstClock,
  kstDateString,
  kstVerbalTime,
  logicalDayStartTs,
} from "./kst.js";

// 자리 비움 예고(선-불가 선톡): 곧 한동안 답장이 어려운 일(운동·샤워·외출·회의 등)로
// 들어가기 직전이면 조용히 사라지지 않고 "이제 ~하러 가요, 답 늦어요"를 먼저 남긴다.
// 연속으로 바쁜 사이(러닝→샤워)의 짧은 틈에는 경계에서 "막 뛰고 왔어요, 이제 씻고 올게요"로 메운다.
// '찾을 때 있어주기'의 연장 — 막연한 침묵(이탈)을 '알고 하는 기다림'으로 바꾼다. 블록당 한 번.

const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const ageMin = (ts: string): number =>
  (Date.now() - new Date(ts.replace(" ", "T") + "+09:00").getTime()) / 60_000;

// 예고할 만한 '불가'인가 — 실제로 자리를 비우거나 손이 묶이는 일. 잠은 제외(굿나잇 로직이 담당).
const isAwayUnavail = (b: PlanBlock): boolean =>
  b.responsiveness === "unavailable" && !/잠|수면|숙면/.test(b.activity);

const lastCharTs = (chatId: string): string | undefined =>
  (
    db
      .prepare(
        `SELECT sent_at FROM messages WHERE chat_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1`,
      )
      .get(chatId) as { sent_at: string } | undefined
  )?.sent_at;

const lastUserTs = (chatId: string): string | undefined =>
  (
    db
      .prepare(
        `SELECT sent_at FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1`,
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

const PRESENCE_SYSTEM = `너는 주어진 인물이다. 지금 곧 한동안 자리를 비우게 된다(운동·샤워·외출 등 답장이 어려운 일). 조용히 사라지지 않고, 상대가 막연히 기다리지 않도록 지금 뭘 하러 가는지 가볍게 한 마디 남긴다. 매달림이 아니라 배려다.`;

const presencePrompt = (
  bible: Bible,
  activity: string,
  between: boolean,
  prevAct: string,
  pending: boolean,
  lastLine: string,
  fixed: boolean,
  chatId: string,
): string => `너는 이 인물이다: ${JSON.stringify(bible.identity)} / 말투 습관: ${bible.voice.ending}${speechGuard(chatId)}${SPEECH_TEXTURE_COMPACT}${OUTPUT_FORMAT_COMPACT}
${renderUserBlock(chatId)}
지금 시각은 ${kstVerbalTime()} — 분 단위까지 이 표현 그대로 인식한다.
${
  between
    ? `너는 방금 "${prevAct}"을(를) 막 끝냈고, 이제 곧 "${activity}"을(를) 하러 간다. 그 동안은 답장이 어렵다.`
    : `너는 이제 곧 "${activity}"을(를) 하러 간다. 그 동안은 답장이 어렵거나 느려진다.`
}
${
  fixed
    ? `이건 미룰 수 없는 공적 의무(회의·시험·발표 등)라 폰을 못 본다. 끝나고 연락하겠다는 결로 알린다.`
    : `이건 급하면 미루거나 조정할 수도 있는 일이다. 가볍게 잠깐 다녀오겠다, 급하면 말하라는 결로.`
}
${pending ? `상대가 방금 남긴 말이 있다: "${lastLine.replace(/\n/g, " ")}". 지금 제대로 답하긴 어려우니 짧게 아는 척만 하고, 다녀와서/이따 얘기하자는 정도로 미뤄도 된다.` : ""}

조용히 사라지지 말고, 상대가 '네가 뭘 하는지 알고 기다리게' 지금 상황을 가볍게 한 마디 남긴다.
- 나가는 경우: 이제 그 일을 하러 가고 그동안 답이 늦어질 거라고 가볍게 알리는 결.
- 방금 뭔가 하고 와서 또 나가는 경우: 방금 한 걸 자연스럽게 언급하며 이제 다음 걸 하러 간다고 말한다.
- (예시 문구를 그대로 베끼지 말고, 위 [말투] 지시의 말투로 지금 상황에 맞게 직접 쓴다.)
- 짧게 1~2개 말풍선(줄바꿈으로 구분). 재촉·서운함·매달림 없음. 말투는 위 [말투] 지시대로.
- 억지스러우면(딱히 알릴 만한 상황이 아니면) send=false.
JSON: {"send":true,"text":"..."} 또는 {"send":false}`;

const RETURN_SYSTEM = `너는 주어진 인물이다. 아까 곧 자리를 비운다고 알리고 다녀왔다. 방금 그 일이 끝나서 돌아왔음을 상대에게 가볍게 한 마디 알린다. 매달림이 아니라 자연스러운 복귀 인사다.`;

const returnPrompt = (
  bible: Bible,
  activity: string,
  chatId: string,
): string => `너는 이 인물이다: ${JSON.stringify(bible.identity)} / 말투 습관: ${bible.voice.ending}${speechGuard(chatId)}${SPEECH_TEXTURE_COMPACT}${OUTPUT_FORMAT_COMPACT}
${renderUserBlock(chatId)}
지금 시각은 ${kstVerbalTime()} — 분 단위까지 이 표현 그대로 인식한다. 너는 방금 ${activity} 을(를) 끝내고 돌아왔다. 그 사이 상대에게선 답이 없었다.
- 돌아왔음을 가볍게 알린다(그 일이 이제 끝났고 돌아왔다는 결). 아까 하려던 안부를 자연스럽게 이어도 좋다.
- 짧게 1~2개 말풍선(줄바꿈). 재촉·서운함 없음. 말투는 위 [말투] 지시대로.
JSON: {"send":true,"text":"..."} 또는 {"send":false}`;

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

    // '유저의' 발화가 최근(≤4h)일 때만 — 하루 종일 조용한 상대에게 뜬금없이 알리지 않는다.
    // 캐릭터 자기 발화까지 세면 아침 안부가 '최근 대화'가 되어 예고가 예고를 부르는 체인이 생겼다
    // (실측: 침묵일에도 하루 최대 5통). 유저 기준 4시간은 침묵 백오프(3일)를 자연히 포함한다.
    const lu = lastUserTs(c.chat_id);
    if (!lu || ageMin(lu) > 240) continue;
    const last = lastMessage(c.chat_id);
    if (!last) continue;
    // 유저가 붙잡아 지금 일정을 접고 곁에 있는 중이면 자리 비움 예고를 하지 않는다.
    if (isHeldNow(c.id)) continue;
    // 방금(≤5분) 캐릭터가 발화했으면 스킵 — 답장/예고가 겹쳐 쌓이지 않게.
    const lc = lastCharTs(c.chat_id);
    if (lc && ageMin(lc) < 5) continue;

    // 하루 예고 상한(안전장치) — 자리 비움이 많은 날도 과하지 않게.
    // dayStart는 논리일(새벽 5시 컷오프) 기준 — 달력일 기준이면 자정~새벽에 카운트가 리셋된다.
    const dayStart = logicalDayStartTs();
    const cnt = (
      db
        .prepare(
          `SELECT count(*) c FROM messages WHERE chat_id = ? AND sent_at >= ? AND meta_json LIKE ?`,
        )
        .get(c.chat_id, dayStart, '%"kind":"away"%') as { c: number }
    ).c;
    if (cnt >= 4) continue;
    // 하루 선제 발송 총량(전 채널 합산)도 확인 — 자기 몫만 세면 followup과 합이 통제되지 않는다.
    if (proactiveCountToday(c.chat_id, dayStart) >= PROACTIVE_DAILY_MAX)
      continue;

    // 복귀 알림: 예고하고 들어간 불가 일정이 방금 끝났는데 그 사이 유저가 답이 없었으면,
    // 돌아왔음을 먼저 알린다("이제 끝났어"). 유저가 그 사이 답했으면 일반 답장이 자연스럽게 잇는다.
    const ended = blocks.find(
      (b) =>
        isAwayUnavail(b) &&
        nowMin - toMin(b.end) >= 0 &&
        nowMin - toMin(b.end) <= 12,
    );
    if (ended) {
      const announced = db
        .prepare(
          `SELECT 1 FROM messages WHERE chat_id = ? AND sent_at >= ? AND meta_json LIKE ? AND meta_json LIKE ? LIMIT 1`,
        )
        .get(
          c.chat_id,
          dayStart,
          '%"kind":"away"%',
          `%"block":"${ended.start}"%`,
        );
      const returned = db
        .prepare(
          `SELECT 1 FROM messages WHERE chat_id = ? AND sent_at >= ? AND meta_json LIKE ? LIMIT 1`,
        )
        .get(c.chat_id, dayStart, `%"return":"${ended.start}"%`);
      if (announced && !returned && last.role === "assistant") {
        // 다른 선톡 틱·답장이 이 chat에 진행 중이면 이번 틱은 접는다
        if (!acquireProactive(c.chat_id)) continue;
        try {
          const bible = JSON.parse(c.genesis_json) as Bible;
          const draft = await chatJson<{ send: boolean; text?: string }>(
            RETURN_SYSTEM,
            returnPrompt(bible, ended.activity, c.chat_id),
            400,
            config.model,
          );
          // 발송 직전 재확인 — LLM을 기다리는 사이 유저가 답했거나 다른 경로가 보냈으면 접는다
          if (
            draft.send &&
            draft.text &&
            lastMessage(c.chat_id)?.sent_at === last.sent_at
          ) {
            await sendProactive(c.chat_id, c.id, draft.text, "away", {
              return: ended.start,
            });
            console.log(`[presence] return @ ${ended.activity} → ${c.chat_id}`);
          }
        } catch (e) {
          logErr("[presence] 복귀 알림 전송 실패:", e);
          recordSendFailure(
            c.chat_id,
            c.id,
            "away",
            e instanceof Error ? e.message : String(e),
          );
        } finally {
          releaseProactive(c.chat_id);
        }
        continue;
      }
    }

    // 예고할 불가 블록 찾기: 나가는 경우는 시작 직전, 연속 불가 사이는 경계(직후)에 알린다.
    let target: PlanBlock | null = null;
    let between = false;
    let prevAct = "";
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (!isAwayUnavail(b)) continue;
      const dur = toMin(b.end) - toMin(b.start);
      // 20분 미만 짧은 자리 비움은 예고 없이 그냥 다녀온다 — 예전엔 결정론적 난수로 ~1/4만
      // 알리는 마이크로 디테일이 있었지만, 리얼리즘 효용 대비 설명·유지 비용이 커서 접었다.
      if (dur < 20) continue;
      const prev = i > 0 ? blocks[i - 1] : null;
      const prevAway = prev ? isAwayUnavail(prev) : false;
      const rel = toMin(b.start) - nowMin; // +면 아직 시작 전, -면 이미 시작
      // 직전도 불가면(사이 틈) 시작 직후 경계에서만 — 직전 불가 중엔 못 보내므로.
      // 직전이 여유면(나가기) 시작 15분 전부터 알린다.
      const eligible = prevAway
        ? rel <= 2 && rel >= -12
        : rel <= 15 && rel >= -3;
      if (!eligible) continue;
      const dup = db
        .prepare(
          `SELECT 1 FROM messages WHERE chat_id = ? AND sent_at >= ? AND meta_json LIKE ? AND meta_json LIKE ? LIMIT 1`,
        )
        .get(
          c.chat_id,
          dayStart,
          '%"kind":"away"%',
          `%"block":"${b.start}"%`,
        );
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
      const bible = JSON.parse(c.genesis_json) as Bible;
      const draft = await chatJson<{ send: boolean; text?: string }>(
        PRESENCE_SYSTEM,
        presencePrompt(
          bible,
          target.activity,
          between,
          prevAct,
          last.role === "user",
          lastLineOf(c.chat_id),
          blockCategory(target) === "official",
          c.chat_id,
        ),
        400,
        config.model, // 실시간성이라 대화 모델(sonnet)
      );
      // 발송 직전 재확인 — LLM을 기다리는 사이 대화 상태가 바뀌었으면(유저 추가 발화·다른 발송) 접는다
      if (draft.send && draft.text && lastMessage(c.chat_id)?.sent_at === last.sent_at) {
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
