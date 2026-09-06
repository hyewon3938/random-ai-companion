// 침묵 팔로업 — 답이 끊긴 자리에 한 통 보낸다(15분 틱).
//
// 관제탑을 통과할 때만 보낸다. 셋이다.
//   낮 근황   — 유저의 마지막 말도 캐릭터의 마지막 말도 4시간 넘게 지났으면 하루 1통. 보낸 뒤에도
//               답이 없으면 그날은 물러난다.
//   밤 인사   — 자정~새벽 5시에 유저가 잔다는 말 없이 1시간 넘게 조용하면 1회.
//   달래기    — 관계 행의 상대 상태(user-state가 답장마다 판정)가 나 때문에 안 좋은데 그 뒤로
//               답이 끊기면 30분 뒤 1통. 한 발현에 한 통이고 잠 블록에도 나간다.
//
// 문안은 대화와 같은 3층(buildSystemBlocks)에 상황 문단을 더해 만든다 — 앞 두 층 캐시를
// 대화와 함께 쓴다. 경과 시간은 Date.now()로 잰다(getKstNow().getTime()은 9시간 어긋난다).
//
// 셋 다 문안을 만들어 보내는 일은 proactive-send의 sendProactiveDraft에 맡긴다 — 다른 틱과의
// 잠금, 발송이 실패한 문안을 다음 틱까지 들고 있는 것, 발송 직전 재확인이 거기 있다. 이 파일은
// 어느 종류를 언제 보낼지만 정한다.

import {
  getActiveCharacter,
  getActiveCharacters,
  getRelationship,
  lastMessage,
  lastUserTs,
} from "./db.js";
import { currentBlock } from "./context.js";
import {
  mendSentSince,
  proactiveAllowed,
  proactiveCountToday,
  proactiveKindCountToday,
  proactiveSinceLastUser,
} from "./proactive-policy.js";
import {
  noOverlap,
  readSendText,
  readText,
  sendProactiveDraft,
} from "./proactive-send.js";
import { kstClock, kstDateString, logicalDayStartTs } from "./kst.js";
import {
  GOODNIGHT_SILENCE_MS,
  GOODNIGHT_WINDOW,
  MEND_SILENCE_MS,
  PROACTIVE_DAILY_MAX,
  RECENT_USER_MS,
} from "./thresholds.js";

// 침묵 팔로업: 대화 중 유저가 네 시간 답이 없으면 캐릭터가 지금 무엇을 하는지 한 마디 남긴다
// (근황 선톡). 재촉하지 않고 자기 근황만 전해 유저가 다시 말 걸 자리를 만들어 두는 것이라,
// 하루에 한 통만 보내고 그 뒤로도 답이 없으면 그날은 물러난다.
//
// 자정을 넘겨 대화하다 유저가 자겠다는 말 없이 한 시간 답이 없으면 잠든 것으로 보고 밤 인사
// 선톡을 한 통 남긴다. 두 종류 모두 그 순간의 각본을 봐야 하므로 문안은 모델이 쓴다.
//
// 유저가 캐릭터 때문에 안 좋은 상태로 답을 멈추면 30분 뒤에 달래기를 한 통 보낸다. 상태는
// 답장마다 판정 호출(user-state)이 정해 관계 행에 적어 두고, 이 틱은 그 값의 원인과 결만
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
const minutesBetween = (ts: string, nowMs: number): number =>
  (nowMs - new Date(ts.replace(" ", "T") + "+09:00").getTime()) / 60000;
const minutesSince = (ts: string): number => minutesBetween(ts, Date.now());

// 근황 선톡의 침묵 조건 — 유저의 마지막 말도, 캐릭터의 마지막 말도 네 시간은 지났어야 한다.
//
// 유저 발화만 재면 자리 비움 예고와 복귀 인사가 방금 나간 위에 근황이 겹쳐, 답 없는 말이 한
// 시간 안에 셋 쌓였다(이슈 #274). 캐릭터가 무슨 말이든 했으면 상대가 그 말에 답할 네 시간을
// 먼저 준다. 조건은 여전히 하나(네 시간 침묵)이고, 재는 자리가 누구 말이든 마지막 말로 바뀐 것뿐이다.
export const catchupSilenceOk = (
  lastUserTs: string,
  lastAssistantTs: string,
  nowMs = Date.now(),
): boolean => {
  const need = RECENT_USER_MS / 60_000;
  return (
    minutesBetween(lastUserTs, nowMs) >= need &&
    minutesBetween(lastAssistantTs, nowMs) >= need
  );
};

const goodnightSituation = (): string =>
  [
    `[문안 — 지금 보낼 굿나잇 한 통]`,
    `자정을 넘겨 상대와 대화하다 상대가 잔다는 말 없이 답이 끊긴 지 한 시간쯤 됐다. 잠든 것 같다. 너도 자러 가며 다정하게 굿나잇 인사를 남긴다 — 상대가 아침에 보면 기분 좋을 결로.`,
    `- 매번 다르게, 자연스럽게. 재촉하거나 매달리지 않는다.`,
    `- 1~2개 말풍선(줄바꿈 구분).`,
    ``,
    `JSON으로만 답한다: {"text":"..."}`,
  ].join("\n");

const mendSituation = (): string =>
  [
    `[문안 — 지금 보낼 달래기 한 통]`,
    `위 [상대의 지금 상태]대로 상대가 너 때문에 안 좋은 상태인 채 답이 끊긴 지 30분쯤 됐다. 그 상태와 [방금까지 오간 말]을 읽고 무엇 때문인지 헤아려, 그 마음을 알아차렸다는 것만 짧게 전한다.`,
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
    `- 재촉하지 않는다. 왜 답이 없냐고 묻거나 답을 요구하지 않는다. 기다리고 있다는 티는 네 성격대로 한 마디까지다.`,
    `- 지금 상황에서 이 말이 억지스러우면 send=false.`,
    `- 1~2개 말풍선(줄바꿈 구분).`,
    ``,
    `JSON으로만 답한다: {"send":true,"text":"..."} 또는 {"send":false}`,
  ].join("\n");

// 틱 재진입 방지 — LLM 호출·발송으로 한 틱이 길어져 다음 크론과 겹치면 이중 발송이 된다.
const followupTickBody = async (): Promise<void> => {
  for (const c of getActiveCharacters()) {
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
    const alreadyGoodnight = /잘\s*자|굿나잇|주무|좋은\s*꿈|good ?night/i.test(
      last.text,
    );
    if (
      isNight &&
      afterMidnight &&
      !alreadyGoodnight &&
      minutesSince(lu) >= GOODNIGHT_SILENCE_MS / 60_000 &&
      proactiveSinceLastUser(c.chat_id) < 1
    ) {
      await sendProactiveDraft({
        characterId: c.id,
        chatId: c.chat_id,
        kind: "goodnight",
        lastSentAt: last.sent_at,
        situation: goodnightSituation(),
        maxTokens: 300,
        read: readText,
        label: "[followup] 굿나잇",
        sentLog: `[followup] goodnight to ${c.chat_id}`,
      });
      continue;
    }

    // 달래기 선톡: 상대의 지금 상태가 나 때문에 안 좋은데 답을 멈추면 30분 뒤에 한 통.
    //
    // 상태는 관계 행에 있다(답장마다 판정). 한 발현에 한 통이라, 그 상태가 시작된 시각 뒤로
    // 달래기가 이미 나갔으면 접는다 — 상태가 바뀌어 시작 시각이 새로 찍히면 한 통 더 나간다.
    //
    // 각본이 잠 블록이어도 보낸다. 근황 선톡에 있는 답장 가능 구간 검사를 여기엔 걸지 않는데,
    // 밤 인사가 이미 같은 대우를 받고 있어 새 동작이 아니고 서운하게 해 놓고 답도 못 받은 채
    // 그냥 자는 쪽이 오히려 사람과 멀다.
    const rel = getRelationship(c.id);
    if (
      minutesSince(lu) >= MEND_SILENCE_MS / 60_000 &&
      rel?.user_state_tone === "bad" &&
      rel.user_state_cause === "char" &&
      !mendSentSince(c.chat_id, rel.user_state_since ?? lu) &&
      proactiveCountToday(c.chat_id, dayStart()) < PROACTIVE_DAILY_MAX
    ) {
      await sendProactiveDraft({
        characterId: c.id,
        chatId: c.chat_id,
        kind: "mend",
        lastSentAt: last.sent_at,
        situation: mendSituation(),
        maxTokens: 300,
        read: readText,
        label: "[followup] 달래기",
        sentLog: `[followup] mend to ${c.chat_id}`,
      });
      continue;
    }

    // (이하 근황 선톡)
    // 네 시간 조용할 때 한 통. 조건을 이 하나로 두는 건, 각본 전환점까지 겹쳐 보면 언제 오는
    // 말인지 설명할 수 없고 두 시간은 낮에 흔한 간격이라 답이 늦은 것과 대화가 끝난 것을 가르지
    // 못해서다. 네 시간은 유저의 마지막 말과 캐릭터의 마지막 말 둘 다에서 잰다 — 예고·복귀 인사가
    // 방금 나갔으면 그 말에 답할 시간을 먼저 준다(이슈 #274). last는 위에서 캐릭터 차례로 확인했다.
    if (!catchupSilenceOk(lu, last.sent_at)) continue;
    // 오늘 시작 이후에 유저가 말한 적이 있어야 (어제 끊긴 건 아침 선톡이 담당)
    if (lu < dayStart()) continue;
    // 근황은 하루 한 통. 보낸 뒤에도 답이 없으면 그날은 더 보내지 않고 다음 날 아침으로 넘긴다.
    if (proactiveKindCountToday(c.chat_id, dayStart(), "catchup") >= 1) continue;
    // 하루 절대 상한(안전장치, 자리비움을 뺀 선톡 합산)
    if (proactiveCountToday(c.chat_id, dayStart()) >= PROACTIVE_DAILY_MAX)
      continue;

    const block = currentBlock(c.id);
    if (!block || block.responsiveness === "unavailable") continue; // 운전·잠 등엔 못 보냄

    await sendProactiveDraft({
      characterId: c.id,
      chatId: c.chat_id,
      kind: "catchup",
      lastSentAt: last.sent_at,
      situation: catchupSituation(),
      maxTokens: 500,
      read: readSendText,
      label: "[followup]",
      sentLog: `[followup] sent to ${c.chat_id} @ ${block.activity}`,
    });
  }
};

export const runFollowupTick = noOverlap(followupTickBody);
