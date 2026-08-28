import { chatJson } from "./llm.js";
import { config } from "./config.js";
import {
  db,
  getActiveCharacter,
  lastMessage,
  proactiveCountToday,
  proactiveSinceLastUser,
  recordSendFailure,
  PROACTIVE_DAILY_MAX,
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
import { kstClock, logicalDayStartTs } from "./kst.js";

// 침묵 팔로업: 대화 중 유저가 한동안 조용하고, 지금 캐릭터의 각본이 '자기 삶을 한 마디 흘릴 만한
// 전환점'이면(밥 먹으러 가기·일 마치기·운동 등), 캐릭터가 먼저 근황을 남긴다. 밤에 계획된 아침 안부와 다른 채널.
// 그 순간의 각본을 봐야 하므로 판단·문안을 LLM이 한다. 매달리지 않도록 총량·간격을 강하게 제한.
//
// 문안은 대화와 같은 3층 프롬프트(buildSystemBlocks)에 상황 문단만 얹는다 — 앞 두 층이
// 대화와 같아야 캐시가 붙는다. 정체성·말투·표기 규칙·지금 시각은 3층이 들고 있으니 여기엔 상황만 적는다.

// 기계처럼 똑같이 반복되지 않게 — 하루 상한도, 침묵 임계도 그때그때 다르게(단 안정적으로).
// 같은 날/같은 침묵 구간에서는 값이 흔들리지 않도록 문자열 해시로 결정론적 난수를 만든다.
const hashInt = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

// '오늘'의 시작 = 논리일(새벽 5시 컷오프). 달력일 기준 "오늘 05:00"으로 만들면 자정~새벽엔
// 미래 시각이 되어 아래 가드들이 전부 죽는 버그가 있었다(밤 정리의 하루 정의와 통일).
const dayStart = (): string => logicalDayStartTs();
// 하루 절대 상한(안전장치, 전 채널 합산 — presence와 공유). 실제 조절은 '연속 무응답 taper'가 한다.
const DAILY_MAX = PROACTIVE_DAILY_MAX;
// 연속 무응답이 이 수에 닿으면 그날은 물러난다 — 침묵에 대고 계속 보내면 매달림이 되므로.
const TAPER = 2;
// 이 침묵 구간의 임계: 약 2시간(100~139분, 마지막 메시지 시각마다 조금씩 다르게).
const silenceThreshold = (lastTs: string): number =>
  100 + (hashInt(lastTs) % 40);
// 경과 분: 저장된 ts는 KST 벽시계(+09:00으로 파싱하면 실제 epoch)이므로 실제 현재(Date.now)와 뺀다.
// getKstNow()는 실제 시각+9시간이라 여기 쓰면 경과가 540분 부풀려져 침묵 조건을 늘 통과하는 버그가 났었다.
const minutesSince = (ts: string): number =>
  (Date.now() - new Date(ts.replace(" ", "T") + "+09:00").getTime()) / 60000;

const goodnightSituation = (): string =>
  [
    `[문안 — 지금 보낼 굿나잇 한 통]`,
    `새벽에 상대와 대화하다 상대가 잔다는 말 없이 답이 끊긴 지 한 시간쯤 됐다. 잠든 것 같다. 너도 자러 가며 다정하게 굿나잇 인사를 남긴다 — 상대가 아침에 보면 기분 좋을 결로.`,
    `- 매번 다르게, 자연스럽게. 재촉·서운함·매달림 없음.`,
    `- 1~2개 말풍선(줄바꿈 구분).`,
    ``,
    `JSON으로만 답한다: {"text":"..."}`,
  ].join("\n");

const catchupSituation = (lastLine: string): string =>
  [
    `[문안 — 지금 보낼 근황 한 통]`,
    `상대가 한참 조용하다. 재촉하지 않고, 위 [지금]의 전환점(지금 하는/막 시작하는 일)에서 네 근황만 가볍게 한 마디 흘긴다 — 상대가 다시 말 걸 자리를 만들어 두는 것.`,
    `마지막으로 오간 말: ${lastLine || "(없음)"}`,
    `- 지금 하는 일을 막 시작하는 참이면 이제 그걸 하러 간다고 가볍게 흘리는 결.`,
    `- 자기 삶 공유가 핵심. 가볍게 질문 하나 얹어도 좋다.`,
    `- 매달리거나 서운함을 내비치지 않는다. 재촉 금지.`,
    `- 지금 각본이 흘릴 만한 전환점이 아니거나(자는 중이거나 손·정신이 묶인 일 중), 억지스러우면 send=false.`,
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

    // 밤 굿나잇: 새벽(2~5시)에 대화하다 유저가 '잔다'는 말 없이 1시간+ 잠수하면, 잠든 듯 여겨 다정한
    // 굿나잇을 한 번 남긴다(아침에 보면 설렘). 이미 굿나잇을 주고받았으면 보내지 않는다.
    // 새벽 이 시간대의 1시간 무응답은 '잠들었다'로 봐도 자연스럽다(낮·초저녁엔 그냥 바쁜 것일 수 있어 제외).
    const hour = Number(kstClock().slice(0, 2));
    const isNight = hour >= 2 && hour < 5;
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
      !alreadyGoodnight &&
      minutesSince(last.sent_at) >= 60 &&
      proactiveSinceLastUser(c.chat_id) < 1
    ) {
      // 다른 선톡 틱·답장이 이 chat에 진행 중이면 이번 틱은 접는다
      if (!acquireProactive(c.chat_id)) continue;
      try {
        const g = await chatJson<{ text: string }>(
          buildSystemBlocks(c.id, c.chat_id, {
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

    // (이하 낮의 전환점 팔로업)
    // 침묵 임계는 이 구간마다 약 2시간(100~139분)으로 조금씩 달라진다
    if (minutesSince(last.sent_at) < silenceThreshold(last.sent_at)) continue;
    // 오늘 시작 이후에 오간 대화여야 (어제 끊긴 건 아침 안부가 담당)
    if (last.sent_at < dayStart()) continue;
    // 하루 절대 상한(안전장치)
    if (proactiveCountToday(c.chat_id, dayStart()) >= DAILY_MAX) continue;
    // taper: 마지막 유저 메시지 이후 이미 TAPER회 먼저 보냈는데도 답이 없으면 그날은 물러난다
    if (proactiveSinceLastUser(c.chat_id) >= TAPER) continue;

    const block = currentBlock(c.id);
    if (!block || block.responsiveness === "unavailable") continue; // 운전·잠 등엔 못 보냄

    const lastLine = (
      db
        .prepare(
          `SELECT text FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(c.chat_id) as { text: string } | undefined
    )?.text;

    // 다른 선톡 틱·답장이 이 chat에 진행 중이면 이번 틱은 접는다
    if (!acquireProactive(c.chat_id)) continue;
    try {
      const draft = await chatJson<{ send: boolean; text?: string }>(
        buildSystemBlocks(c.id, c.chat_id, {
          situation: catchupSituation((lastLine ?? "").replace(/\n/g, " ")),
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
