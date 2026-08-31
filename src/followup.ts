import { chatJson } from "./llm.js";
import { config } from "./config.js";
import {
  db,
  getActiveCharacter,
  lastMessage,
  lastUserTs,
  proactiveCountToday,
  mendSentSinceLastUser,
  proactiveKindCountToday,
  proactiveSinceLastUser,
  recordSendFailure,
  upsetSinceLastUser,
  type CharacterRow,
} from "./db.js";
import {
  sendProactive,
  acquireProactive,
  releaseProactive,
  logErr,
} from "./bot.js";
import { buildSystemBlocks, currentBlock } from "./context.js";
import { proactiveAllowed } from "./proactive-policy.js";
import { kstClock, kstDateString, logicalDayStartTs } from "./kst.js";
import {
  GOODNIGHT_SILENCE_MS,
  GOODNIGHT_WINDOW,
  MEND_SILENCE_MS,
  PROACTIVE_DAILY_MAX,
  PROACTIVE_RECENT_LINES,
  RECENT_USER_MS,
} from "./thresholds.js";

// 침묵 팔로업: 대화 중 유저가 네 시간 답이 없으면 캐릭터가 지금 무엇을 하는지 한 마디 남긴다
// (근황 선톡). 재촉하지 않고 자기 근황만 전해 유저가 다시 말 걸 자리를 만들어 두는 것이라,
// 하루에 한 통만 보내고 그 뒤로도 답이 없으면 그날은 물러난다.
//
// 자정을 넘겨 대화하다 유저가 자겠다는 말 없이 한 시간 답이 없으면 잠든 것으로 보고 밤 인사
// 선톡을 한 통 남긴다. 두 종류 모두 그 순간의 각본을 봐야 하므로 문안은 모델이 쓴다.
//
// 유저가 캐릭터에게 서운해한 뒤 답을 멈추면 30분 뒤에 달래기를 한 통 보낸다. 서운함은 답장을
// 쓴 모델이 표시해 두고(reply-signal의 userUpset), 이 틱은 그 표시가 messages에 남았는지만
// 본다. 근황 선톡보다 앞에 두는 이유는 기다리는 시간이 다르기 때문이다 — 근황의 네 시간
// 검사에 걸리면 30분짜리 달래기가 영영 나가지 못한다.
//
// 문안은 대화와 같은 3층 프롬프트(buildSystemBlocks)에 상황 문단만 얹는다 — 앞 두 층이
// 대화와 같아야 캐시가 붙는다. 정체성·말투·표기 규칙·지금 시각은 3층이 들고 있으니 여기엔 상황만 적는다.

// '오늘'의 시작 = 논리일(새벽 5시 컷오프). 달력일 기준 "오늘 05:00"으로 만들면 자정~새벽엔
// 미래 시각이 되어 아래 가드들이 전부 죽는 버그가 있었다(밤 정리의 하루 정의와 통일).
const dayStart = (): string => logicalDayStartTs();
// 경과 분: 저장된 ts는 KST 벽시계(+09:00으로 파싱하면 실제 epoch)이므로 실제 현재(Date.now)와 뺀다.
// getKstNow()는 실제 시각+9시간이라 여기 쓰면 경과가 540분 부풀려져 침묵 조건을 늘 통과하는 버그가 났었다.
const minutesSince = (ts: string): number =>
  (Date.now() - new Date(ts.replace(" ", "T") + "+09:00").getTime()) / 60000;

const goodnightSituation = (): string =>
  [
    `[문안 — 지금 보낼 굿나잇 한 통]`,
    `자정을 넘겨 상대와 대화하다 상대가 잔다는 말 없이 답이 끊긴 지 한 시간쯤 됐다. 잠든 것 같다. 너도 자러 가며 다정하게 굿나잇 인사를 남긴다 — 상대가 아침에 보면 기분 좋을 결로.`,
    `- 매번 다르게, 자연스럽게. 재촉·서운함·매달림 없음.`,
    `- 1~2개 말풍선(줄바꿈 구분).`,
    ``,
    `JSON으로만 답한다: {"text":"..."}`,
  ].join("\n");

const mendSituation = (): string =>
  [
    `[문안 — 지금 보낼 달래기 한 통]`,
    `상대가 너에게 서운해하거나 화가 난 기색을 보인 뒤 답이 끊긴 지 30분쯤 됐다. 위 [방금까지 오간 말]을 읽고 무엇 때문인지 헤아려, 그 마음을 알아차렸다는 것만 짧게 전한다.`,
    `- 변명하지 않는다. 왜 그랬는지 설명하려 들면 달래기가 아니라 해명이 된다.`,
    `- 재촉하지 않는다. 답을 요구하거나 왜 말이 없냐고 묻지 않는다.`,
    `- 자러 간다는 말도, 어디 나간다는 말도 붙이지 않는다. 상대가 답할 자리를 여는 한 통인데 그런 말을 붙이면 그 자리를 네가 닫는다. 지금이 네 각본에서 자는 시간이어도 마찬가지다.`,
    `- 1~2개 말풍선(줄바꿈 구분).`,
    ``,
    `JSON으로만 답한다: {"text":"..."}`,
  ].join("\n");

const catchupSituation = (): string =>
  [
    `[문안 — 지금 보낼 근황 한 통]`,
    `상대가 네 시간 넘게 조용하다. 재촉하지 않고 위 [지금]에서 네가 하는 일만 가볍게 한 마디 전한다 — 상대가 다시 말 걸 자리를 만들어 두는 것.`,
    `- 막 시작하는 참이면 이제 그걸 하러 간다고 가볍게 흘리는 결.`,
    `- 자기 삶 공유가 핵심. 가볍게 질문 하나 얹어도 좋다.`,
    `- 매달리거나 서운함을 내비치지 않는다. 재촉 금지.`,
    `- 지금 상황에서 이 말이 억지스러우면 send=false.`,
    `- 1~2개 말풍선(줄바꿈 구분).`,
    ``,
    `JSON으로만 답한다: {"send":true,"text":"..."} 또는 {"send":false}`,
  ].join("\n");

// 틱 재진입 방지 — LLM 호출·발송으로 한 틱이 길어져 다음 크론과 겹치면 이중 발송이 된다.
let running = false;

export const runFollowupTick = async (): Promise<void> => {
  if (running) return;
  running = true;
  try {
    await followupTickBody();
  } finally {
    running = false;
  }
};

const followupTickBody = async (): Promise<void> => {
  const rows = db
    .prepare(`SELECT * FROM characters WHERE status = 'active'`)
    .all() as CharacterRow[];

  for (const c of rows) {
    const active = getActiveCharacter(c.chat_id);
    if (!active) continue;

    const last = lastMessage(c.chat_id);
    // 조건: 대화가 있었고 + 마지막이 '캐릭터' 차례(유저가 답 안 한 상태)
    if (!last || last.role !== "assistant") continue;

    // 침묵 백오프(관제탑): 무응답이 길어진 유저에겐 팔로업도 접는다
    if (!proactiveAllowed(c.chat_id, c.id)) continue;

    const lu = lastUserTs(c.chat_id);
    if (!lu) continue;

    // 밤 인사 선톡: 자정을 넘겨 대화하다 유저가 '잔다'는 말 없이 한 시간 답이 없으면, 잠든 것으로
    // 보고 다정한 인사를 한 번 남긴다(아침에 보면 설렘). 이미 굿나잇을 주고받았으면 보내지 않는다.
    // 자정 전을 경계로 삼으면 그 시간에 자는 사람이 잠깐 딴 일을 한 것뿐인데 잘 자라는 인사를 받아
    // 그날 대화가 그대로 닫힌다. 자정을 넘겨 조용해진 것은 잠든 쪽에 가깝다.
    const now = kstClock();
    const isNight = now >= GOODNIGHT_WINDOW.start && now < GOODNIGHT_WINDOW.end;
    // 자정 이후에 오간 대화여야 한다 — 어제 저녁에 끊긴 대화는 밤 인사를 붙일 자리가 아니다.
    const afterMidnight = lu >= `${kstDateString()} 00:00:00`;
    const lastText =
      (
        db
          .prepare(
            `SELECT text FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1`,
          )
          .get(c.chat_id) as { text: string } | undefined
      )?.text ?? "";
    const alreadyGoodnight = /잘\s*자|굿나잇|주무|좋은\s*꿈|good ?night/i.test(
      lastText,
    );
    if (
      isNight &&
      afterMidnight &&
      !alreadyGoodnight &&
      minutesSince(lu) >= GOODNIGHT_SILENCE_MS / 60_000 &&
      proactiveSinceLastUser(c.chat_id) < 1
    ) {
      // 다른 선톡 틱·답장이 이 chat에 진행 중이면 이번 틱은 접는다
      if (!acquireProactive(c.chat_id)) continue;
      try {
        const g = await chatJson<{ text: string }>(
          buildSystemBlocks(c.id, c.chat_id, {
            recent: PROACTIVE_RECENT_LINES,
            situation: goodnightSituation(),
          }),
          "위 상황 문단대로 문안을 만들어.",
          300,
          config.model,
          { purpose: "goodnight", characterId: c.id, chatId: c.chat_id },
        );
        // 발송 직전 재확인 — LLM을 기다리는 사이 유저가 답했거나(그럼 굿나잇은 필요 없다)
        // 다른 경로가 뭔가 보냈으면(마지막 메시지가 바뀜) 접는다.
        if (g.text && lastMessage(c.chat_id)?.sent_at === last.sent_at) {
          await sendProactive(c.chat_id, c.id, g.text, "goodnight");
          console.log(`[followup] goodnight to ${c.chat_id}`);
        }
      } catch (e) {
        logErr("[followup] 굿나잇 전송 실패:", e);
        recordSendFailure(
          c.chat_id,
          c.id,
          "goodnight",
          e instanceof Error ? e.message : String(e),
        );
      } finally {
        releaseProactive(c.chat_id);
      }
      continue;
    }

    // 달래기 선톡: 유저가 캐릭터에게 서운해한 뒤 답을 멈추면 30분 뒤에 한 통.
    //
    // 마지막 유저 발화 이후 구간을 통째로 본다 — 표시가 붙은 답장 뒤에 자리 비움 예고가 끼면
    // 마지막 메시지만 봐서는 표시가 가려진다. 한 발현에 한 통이라, 같은 구간에 달래기가 이미
    // 나갔으면 접는다(유저가 답한 뒤 다시 서운해하면 새 표시가 붙어 한 통 더 나간다).
    //
    // 각본이 잠 블록이어도 보낸다. 근황 선톡에 있는 답장 가능 구간 검사를 여기엔 걸지 않는데,
    // 밤 인사가 이미 같은 대우를 받고 있어 새 동작이 아니고 서운하게 해 놓고 답도 못 받은 채
    // 그냥 자는 쪽이 오히려 사람과 멀다.
    if (
      minutesSince(lu) >= MEND_SILENCE_MS / 60_000 &&
      upsetSinceLastUser(c.chat_id) &&
      !mendSentSinceLastUser(c.chat_id) &&
      proactiveCountToday(c.chat_id, dayStart()) < PROACTIVE_DAILY_MAX
    ) {
      if (!acquireProactive(c.chat_id)) continue;
      try {
        const m = await chatJson<{ text: string }>(
          buildSystemBlocks(c.id, c.chat_id, {
            recent: PROACTIVE_RECENT_LINES,
            situation: mendSituation(),
          }),
          "위 상황 문단대로 문안을 만들어.",
          300,
          config.model,
          { purpose: "mend", characterId: c.id, chatId: c.chat_id },
        );
        // 발송 직전 재확인 — LLM을 기다리는 사이 유저가 답했거나(그럼 달래기는 필요 없다)
        // 다른 경로가 뭔가 보냈으면 접는다.
        if (m.text && lastMessage(c.chat_id)?.sent_at === last.sent_at) {
          await sendProactive(c.chat_id, c.id, m.text, "mend");
          console.log(`[followup] mend to ${c.chat_id}`);
        }
      } catch (e) {
        logErr("[followup] 달래기 전송 실패:", e);
        recordSendFailure(
          c.chat_id,
          c.id,
          "mend",
          e instanceof Error ? e.message : String(e),
        );
      } finally {
        releaseProactive(c.chat_id);
      }
      continue;
    }

    // (이하 근황 선톡)
    // 유저가 네 시간 답이 없을 때 한 통. 조건을 이 하나로 두는 건, 각본 전환점까지 겹쳐 보면
    // 언제 오는 말인지 설명할 수 없고 두 시간은 낮에 흔한 간격이라 답이 늦은 것과 대화가 끝난
    // 것을 가르지 못해서다.
    if (minutesSince(lu) < RECENT_USER_MS / 60_000) continue;
    // 오늘 시작 이후에 유저가 말한 적이 있어야 (어제 끊긴 건 아침 선톡이 담당)
    if (lu < dayStart()) continue;
    // 근황은 하루 한 통. 보낸 뒤에도 답이 없으면 그날은 더 보내지 않고 다음 날 아침으로 넘긴다.
    if (proactiveKindCountToday(c.chat_id, dayStart(), "catchup") >= 1) continue;
    // 하루 절대 상한(안전장치, 자리비움을 뺀 선톡 합산)
    if (proactiveCountToday(c.chat_id, dayStart()) >= PROACTIVE_DAILY_MAX)
      continue;

    const block = currentBlock(c.id);
    if (!block || block.responsiveness === "unavailable") continue; // 운전·잠 등엔 못 보냄

    // 다른 선톡 틱·답장이 이 chat에 진행 중이면 이번 틱은 접는다
    if (!acquireProactive(c.chat_id)) continue;
    try {
      const draft = await chatJson<{ send: boolean; text?: string }>(
        buildSystemBlocks(c.id, c.chat_id, {
          recent: PROACTIVE_RECENT_LINES,
          situation: catchupSituation(),
        }),
        "위 상황 문단대로 문안을 만들어.",
        500,
        config.model, // 실시간성이라 대화 모델(sonnet)
        { purpose: "catchup", characterId: c.id, chatId: c.chat_id },
      );
      // 발송 직전 재확인 — LLM을 기다리는 사이 유저가 말을 걸었으면(답장이 담당) 근황톡을 접고,
      // 다른 경로가 이미 보냈으면(마지막 메시지가 바뀜) 겹쳐 보내지 않는다.
      if (
        draft.send &&
        draft.text &&
        lastMessage(c.chat_id)?.sent_at === last.sent_at
      ) {
        await sendProactive(c.chat_id, c.id, draft.text, "catchup");
        console.log(`[followup] sent to ${c.chat_id} @ ${block.activity}`);
      }
    } catch (e) {
      logErr("[followup] 전송 실패:", e);
      recordSendFailure(
        c.chat_id,
        c.id,
        "catchup",
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      releaseProactive(c.chat_id);
    }
  }
};
