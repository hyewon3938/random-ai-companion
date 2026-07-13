import { chatJson } from "./llm.js";
import { config } from "./config.js";
import { renderUserBlock } from "./user-profile.js";
import {
  db,
  getAttentionUntil,
  getMetAt,
  getDayPlan,
  lastMessage,
  currentSpeechLevel,
  type CharacterRow,
} from "./db.js";
import type { Bible } from "./character.js";
import type { DayPlan, PlanBlock } from "./day-plan.js";
import { blockCategory } from "./day-plan.js";
import { sendProactive } from "./bot.js";
import { kstClock, kstDateString } from "./kst.js";

// 자리 비움 예고(선-불가 선톡): 관계 초반, 곧 한동안 답장이 어려운 일(운동·샤워·외출·회의 등)로
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
  b.responsiveness === "불가" && !/잠|수면|숙면/.test(b.activity);

const relationshipDays = (characterId: number): number => {
  const met = getMetAt(characterId);
  if (!met) return 999;
  return ageMin(met) / 1440;
};

const lastCharTs = (chatId: string): string | undefined =>
  (
    db
      .prepare(
        `SELECT ts FROM messages WHERE chat_id = ? AND role = 'char' ORDER BY id DESC LIMIT 1`,
      )
      .get(chatId) as { ts: string } | undefined
  )?.ts;

const lastLineOf = (chatId: string): string =>
  (
    db
      .prepare(
        `SELECT text FROM messages WHERE chat_id = ? AND role IN ('user','char') ORDER BY id DESC LIMIT 1`,
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
): string => `너는 이 인물이다: ${JSON.stringify(bible.identity)} / 말투 습관: ${bible.voice.ending}${currentSpeechLevel(chatId) === "반말" ? " (지금 서로 반말 — 존댓말로 되돌아가지 말고, '야'·'덥냐'·'했냐'처럼 문장 끝을 '냐'로 맺는 거친 반말도 쓰지 마라)" : ""}
${renderUserBlock(chatId)}
지금 시각 ${kstClock()}.
${
  between
    ? `너는 방금 "${prevAct}"을(를) 막 끝냈고, 이제 곧 "${activity}"을(를) 하러 간다. 그 동안은 답장이 어렵다.`
    : `너는 이제 곧 "${activity}"을(를) 하러 간다. 그 동안은 답장이 어렵거나 느려진다.`
}
${
  fixed
    ? `이건 미룰 수 없는 공적 의무(회의·시험·발표 등)라 폰을 못 본다. "끝나고 연락할게요" 결로 알린다.`
    : `이건 급하면 미루거나 조정할 수도 있는 일이다. 가볍게 "갔다 올게요, 급하면 말해요" 결로.`
}
${pending ? `상대가 방금 남긴 말이 있다: "${lastLine.replace(/\n/g, " ")}". 지금 제대로 답하긴 어려우니 짧게 아는 척만 하고 "갔다 와서/이따 얘기해요" 정도로 미뤄도 된다.` : ""}

조용히 사라지지 말고, 상대가 '네가 뭘 하는지 알고 기다리게' 지금 상황을 가볍게 한 마디 남긴다.
- 나가는 경우: "이제 러닝 좀 갔다 올게요 답 좀 늦어요", "잠깐 나갔다 올게요 이따 봐요" 같은 결.
- 방금 뭔가 하고 와서 또 나가는 경우: "막 뛰고 왔어요 이제 씻고 올게요"처럼 방금 걸 자연스럽게 언급.
- 짧게 1~2개 말풍선(줄바꿈으로 구분). 이모지 없음. 재촉·서운함·매달림 없음. 지금 관계 말투(존댓말이면 존댓말) 유지.
- 억지스러우면(딱히 알릴 만한 상황이 아니면) send=false.
JSON: {"send":true,"text":"..."} 또는 {"send":false}`;

const RETURN_SYSTEM = `너는 주어진 인물이다. 아까 곧 자리를 비운다고 알리고 다녀왔다. 방금 그 일이 끝나서 돌아왔음을 상대에게 가볍게 한 마디 알린다. 매달림이 아니라 자연스러운 복귀 인사다.`;

const returnPrompt = (
  bible: Bible,
  activity: string,
  chatId: string,
): string => `너는 이 인물이다: ${JSON.stringify(bible.identity)} / 말투 습관: ${bible.voice.ending}${currentSpeechLevel(chatId) === "반말" ? " (지금 서로 반말 — 존댓말로 되돌아가지 말고, '야'·'덥냐'·'했냐'처럼 문장 끝을 '냐'로 맺는 거친 반말도 쓰지 마라)" : ""}
${renderUserBlock(chatId)}
지금 시각 ${kstClock()}. 너는 방금 ${activity} 을(를) 끝내고 돌아왔다. 그 사이 상대에게선 답이 없었다.
- 돌아왔음을 가볍게 알린다(이제 끝났어요 / 다녀왔어요 같은 결). 아까 하려던 안부를 자연스럽게 이어도 좋다.
- 짧게 1~2개 말풍선(줄바꿈). 이모지 없음. 재촉·서운함 없음. 지금 관계 말투(존댓말이면 존댓말) 유지.
JSON: {"send":true,"text":"..."} 또는 {"send":false}`;

export const runPresenceTick = async (): Promise<void> => {
  const rows = db
    .prepare(`SELECT * FROM characters WHERE status = 'active'`)
    .all() as CharacterRow[];

  for (const c of rows) {
    // 관계 초반에만 — 무르익으면 자기 시간을 갖고, 매 자리 비움을 알리지 않는다.
    if (relationshipDays(c.id) >= config.earlyDays) continue;

    const raw = getDayPlan(c.id, kstDateString());
    if (!raw) continue;
    let blocks: PlanBlock[];
    try {
      blocks = (JSON.parse(raw) as DayPlan).blocks;
    } catch {
      continue;
    }
    const nowMin = toMin(kstClock());

    // 대화가 최근(≤4h) 오갔을 때만 — 하루 종일 조용한 상대에게 뜬금없이 알리지 않는다.
    const last = lastMessage(c.chat_id);
    if (!last || ageMin(last.ts) > 240) continue;
    // 유저가 붙잡아 곁에 있는 중(주의집중)이면 자리 비움 예고를 하지 않는다.
    const ov = getAttentionUntil(c.chat_id);
    if (ov && ageMin(ov) < 0) continue;
    // 방금(≤5분) 캐릭터가 발화했으면 스킵 — 답장/예고가 겹쳐 쌓이지 않게.
    const lc = lastCharTs(c.chat_id);
    if (lc && ageMin(lc) < 5) continue;

    // 하루 예고 상한(안전장치) — 자리 비움이 많은 날도 과하지 않게.
    const dayStart = `${kstDateString()} 05:00:00`;
    const cnt = (
      db
        .prepare(
          `SELECT count(*) c FROM messages WHERE chat_id = ? AND ts >= ? AND meta_json LIKE ?`,
        )
        .get(c.chat_id, dayStart, '%"kind":"presence"%') as { c: number }
    ).c;
    if (cnt >= 4) continue;

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
          `SELECT 1 FROM messages WHERE chat_id = ? AND ts >= ? AND meta_json LIKE ? AND meta_json LIKE ? LIMIT 1`,
        )
        .get(
          c.chat_id,
          dayStart,
          '%"kind":"presence"%',
          `%"block":"${ended.start}"%`,
        );
      const returned = db
        .prepare(
          `SELECT 1 FROM messages WHERE chat_id = ? AND ts >= ? AND meta_json LIKE ? LIMIT 1`,
        )
        .get(c.chat_id, dayStart, `%"return":"${ended.start}"%`);
      if (announced && !returned && last.role === "char") {
        try {
          const bible = JSON.parse(c.bible_json) as Bible;
          const draft = await chatJson<{ send: boolean; text?: string }>(
            RETURN_SYSTEM,
            returnPrompt(bible, ended.activity, c.chat_id),
            400,
            config.model,
          );
          if (draft.send && draft.text) {
            await sendProactive(c.chat_id, c.id, draft.text, "presence", {
              return: ended.start,
            });
            console.log(`[presence] return @ ${ended.activity} → ${c.chat_id}`);
          }
        } catch (e) {
          console.error("[presence] return error:", e);
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
      if (dur < 10) continue; // 아주 짧은 건 예고 불필요
      if (dur < 20) {
        // 20분 미만은 대개 그냥 사라지되, 가끔(블록·날짜별 결정론적으로 ~1/4)은 미리 알린다
        const seed = [...(c.chat_id + kstDateString() + b.start)].reduce(
          (a, ch) => a + ch.charCodeAt(0),
          0,
        );
        if (seed % 4 !== 0) continue;
      }
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
          `SELECT 1 FROM messages WHERE chat_id = ? AND ts >= ? AND meta_json LIKE ? AND meta_json LIKE ? LIMIT 1`,
        )
        .get(
          c.chat_id,
          dayStart,
          '%"kind":"presence"%',
          `%"block":"${b.start}"%`,
        );
      if (dup) continue;
      target = b;
      between = prevAway;
      prevAct = prev?.activity ?? "";
      break;
    }
    if (!target) continue;

    try {
      const bible = JSON.parse(c.bible_json) as Bible;
      const draft = await chatJson<{ send: boolean; text?: string }>(
        PRESENCE_SYSTEM,
        presencePrompt(
          bible,
          target.activity,
          between,
          prevAct,
          last.role === "user",
          lastLineOf(c.chat_id),
          blockCategory(target) === "공적",
          c.chat_id,
        ),
        400,
        config.model, // 실시간성이라 대화 모델(sonnet)
      );
      if (draft.send && draft.text) {
        await sendProactive(c.chat_id, c.id, draft.text, "presence", {
          block: target.start,
        });
        console.log(
          `[presence] ${c.chat_id} @ ${target.activity} (between=${between})`,
        );
      }
    } catch (e) {
      console.error("[presence] error:", e);
    }
  }
};
