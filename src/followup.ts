// 침묵 팔로업 — 답이 끊긴 자리에 한 통 보낸다(15분 틱).
//
// 관제탑을 통과할 때만 보낸다. 여섯이다.
//   낮 근황   — 유저의 마지막 말도 캐릭터의 마지막 말도 4시간 넘게 지났으면 하루 1통. 보낸 뒤에도
//               답이 없으면 그날은 물러난다. 그날 미리 만들어 둔 선톡이 아직 안 나갔으면 그것을
//               먼저 내보내고 기다린다.
//   점심      — 무응답 이틀째 12:05~12:50에 1통. 그날은 아침 선톡과 이 한 통이 나가고 낮 근황은
//               겹치지 않는다(이슈 #314).
//   의도      — 오늘의 관계 의도 네 줄 가운데 아직 안 쓴 줄 하나로 먼저 거는 한 통. 각본이 답할
//               수 있는 블록이고 양쪽 마지막 말이 2시간 넘게 지난 09~23시에 나간다. 하루 몇 통까지
//               쓸 수 있는지는 관계 단계가 정한다(설계 원본 §7).
//   밤 인사   — 자정~새벽 5시에 유저가 잔다는 말 없이 1시간 넘게 조용하면 1회.
//   달래기    — 관계 행의 상대 상태(user-state가 답장마다 판정)가 나 때문에 안 좋은데 그 뒤로
//               답이 끊기면 30분 뒤 1통. 한 발현에 한 통이고 잠 블록에도 나간다. 어떤 상태를
//               보고 나가는 통인지는 문안 호출 행에 남겨 슬랙 문안 게시가 머리에 적는다.
//   살피기    — 같은 상대 상태가 상대의 다른 일로 안 좋은데 답이 끊기면 30분 뒤 1통(이슈 #361).
//               조건과 대우는 달래기와 같고 문안만 다르다. 달래기가 내가 한 일을 알아차렸다는
//               통이라면 이건 상대의 일이 계속 마음에 걸린다는 통이다.
//
// 근황·점심·의도·밤 인사는 하루 합계 상한을 함께 쓴다 — 1단계의 4는 아침 한 통에 이 넷 가운데
// 셋이 붙는 수다(설계 원본 §7). 달래기와 살피기는 합계에서 뺀다: 상대 상태가 부르는 한 통이라
// 그날 몇 통이 나갔든 열려 있어야 한다(proactive-policy의 OFF_BUDGET).
//
// 문안은 대화와 같은 3층(buildSystemBlocks)에 상황 문단을 더해 만든다 — 앞 두 층 캐시를
// 대화와 함께 쓴다. 경과 시간은 Date.now()로 잰다(getKstNow().getTime()은 9시간 어긋난다).
//
// 셋 다 문안을 만들어 보내는 일은 proactive-send의 sendProactiveDraft에 맡긴다 — 다른 틱과의
// 잠금, 발송이 실패한 문안을 다음 틱까지 들고 있는 것, 발송 직전 재확인이 거기 있다. 이 파일은
// 어느 종류를 언제 보낼지만 정한다.
//
// 의도·근황·점심은 문안만 받는 게 아니라 보낼지까지 모델이 정한다. 이 가운데 의도와 근황은
// 안 보낸다는 답이 오면 그 판정을 자리별로 기억해 둔다 — 안 기억하면 15분 뒤 틱이 같은 조건을
// 다시 만족해 같은 물음을 또 던지고, 의도 선톡의 창 09~23시면 하루 최대 56번이다(이슈 #359).
// 자리는 지금 각본 블록과 마지막 말 둘로 잡는다. 블록이 바뀌거나 누가 말을 하면 물어볼 상황
// 자체가 달라져서 다시 묻고, 그 사이에는 접은 채로 둔다. 틈새 한 줄이 쓰는 방법과 같다
// (glance.ts의 judged). 점심은 창이 12:05~12:50뿐이라 접혀도 하루 3번을 넘지 않아 그냥 둔다.

import {
  getActiveCharacter,
  getActiveCharacters,
  getRelationship,
  getRelationshipIntent,
  hasPendingSendOn,
  lastMessage,
  lastUserTs,
  type RelationshipIntentRow,
} from "./db.js";
import { currentBlock } from "./context.js";
import { intentLineText } from "./context/relationship.js";
import { INTENT_LINE_NAME, type IntentLine } from "./labels.js";
import { isWaiting } from "./pending.js";
import {
  budgetAllows,
  budgetLabel,
  budgetedSinceLastUser,
  lunchDueToday,
  pickIntentLine,
  proactiveAllowed,
  proactiveBudget,
  proactiveKindCountToday,
  proactiveSinceLastUser,
  stateKindSentSince,
  usedIntentLines,
} from "./proactive-policy.js";
import {
  noOverlap,
  readSendText,
  readText,
  sendProactiveDraft,
} from "./proactive-send.js";
import {
  kstClock,
  kstDateString,
  kstLogicalDate,
  kstStamp,
  logicalDateOf,
  logicalDayStartTs,
} from "./kst.js";
import { userStateLabel } from "./user-state.js";
import {
  GOODNIGHT_SILENCE_MS,
  GOODNIGHT_WINDOW,
  INTENT_QUIET_MS,
  INTENT_WINDOW,
  LUNCH_WINDOW,
  CARE_SILENCE_MS,
  MEND_SILENCE_MS,
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

/** 모델이 안 보낸다고 답한 자리를 기억한다 — 키는 chatId와 종류, 값은 그때의 자리 이름. */
const declined = new Map<string, string>();

/** 안 보낸다는 판정을 기억하는 종류 — 보낼지까지 모델이 정하는 선톡들. */
type DeclineKind = "intent" | "catchup";

/** 자리 이름 — 각본 블록과 마지막 말이 둘 다 같으면 물어볼 상황이 그대로라는 뜻이다. */
export const declineSpot = (blockStart: string, lastSentAt: string): string =>
  `${blockStart}|${lastSentAt}`;

/** 이 자리에서 이미 안 보낸다고 답했는지. */
export const declinedHere = (
  chatId: string,
  kind: DeclineKind,
  spot: string,
): boolean => declined.get(`${chatId}:${kind}`) === spot;

/** 안 보낸다는 답을 기억한다. 자리마다 하나라 다음 자리가 오면 덮어쓴다. */
export const rememberDecline = (
  chatId: string,
  kind: DeclineKind,
  spot: string,
): void => {
  declined.set(`${chatId}:${kind}`, spot);
};

/**
 * 안 보낸다는 답을 기억하는 read. 문안을 못 받았으면 그 자리를 적어 두고 접은 것을 로그에 남긴다.
 */
export const readSendTextOnce =
  (chatId: string, kind: DeclineKind, spot: string) =>
  (d: { send: boolean; text?: string }): string | null => {
    const text = readSendText(d);
    if (!text) {
      rememberDecline(chatId, kind, spot);
      console.log(`[followup] ${kind} ${chatId} 접음 — 지금은 보낼 자리가 아니다 (${spot})`);
    }
    return text;
  };

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

// 상황 문단 한 벌로 잇는다 — 값이 없는 줄은 빼고, 마지막 응답 형식 앞에만 빈 줄을 둔다.
const situationText = (head: string[], format: string): string =>
  [...head.filter(Boolean), ``, format].join("\n");

export const goodnightSituation = (
  intent: RelationshipIntentRow | null,
): string => {
  // 오늘의 의도 가운데 이어갈 자리 줄을 인사에 얹는다 — 하루를 닫는 말이 다음 날 이어질 자리를
  // 하나 남겨 두는 것이라 이 줄이 여기로 온다(설계 원본 §4).
  const thread = intentLineText(intent, "thread");
  return situationText(
    [
      `[문안 — 지금 보낼 굿나잇 한 통]`,
      `자정을 넘겨 상대와 대화하다 상대가 잔다는 말 없이 답이 끊긴 지 한 시간쯤 됐다. 잠든 것 같다. 너도 자러 가며 다정하게 굿나잇 인사를 남긴다 — 상대가 아침에 보면 기분 좋을 결로.`,
      `- 매번 다르게, 자연스럽게. 재촉하거나 매달리지 않는다.`,
      thread
        ? `- 오늘 이어갈 자리로 둔 건 이거다: ${thread}. 오늘 그 얘기가 실제로 나왔으면 인사 끝에 한 자락만 남긴다 — 묻지 말고, 안 나왔으면 그냥 둔다.`
        : ``,
      `- 1~2개 말풍선(줄바꿈 구분).`,
    ],
    `JSON으로만 답한다: {"text":"..."}`,
  );
};

export const mendSituation = (): string =>
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

/**
 * 살피기 선톡의 상황 문단 — 상대가 자기 일로 안 좋은 채 답이 끊긴 뒤 한 번 더 거는 한 통(이슈 #361).
 *
 * 전하는 것은 그 일이 네 마음에 남아 있다는 것 하나다. 금지 줄은 9/10 슬랙 말투 피드백에서 나온
 * 모양을 그대로 막는다 — 상대가 한 말을 인용하거나 말만 바꿔 되돌려주며 위로하는 것, 조언과
 * 대화를 닫는 말, 언제든 말하라며 자기 자리를 선언하는 말. 그런 말 없이 신경 쓰고 있다는 게
 * 드러나야 사람의 결이다.
 */
export const careSituation = (): string =>
  [
    `[문안 — 지금 보낼 살피기 한 통]`,
    `위 [상대의 지금 상태]대로 상대가 자기 일로 안 좋은 상태인 채 답이 끊긴 지 30분쯤 됐다. 너 때문이 아니라 상대의 일이다. 그 일이 계속 마음에 걸려서 한 번 더 말을 거는 한 통이다 — 상대가 넘긴 척했어도 속으로는 아직 그럴 것 같아 신경 쓰인다는 결.`,
    `- 전하는 건 하나다. 그 일이 네 마음에 남아 있다는 것. 무엇이 어떻게 된 일인지 정리해 주거나 해결책을 내지 않는다.`,
    `- 상대가 한 말을 그대로 옮기거나 말만 바꿔 되돌려주지 않는다. 상대가 쓴 표현을 인용해 위로하면 상담사가 된다. 네 말로, 네 쪽에서 나오는 말로 한다.`,
    `- 네가 지금 하는 일(위 [지금])에 얹어 열어도 된다 — 뭘 하다가 생각났다는 결. 없으면 그냥 상대 얘기로 연다.`,
    `- 조언하지 않고 시키지 않는다. 쉬어라·무리하지 마라·힘내라처럼 대화를 마무리하는 말로 닫지 않는다.`,
    `- 재촉하지 않는다. 답을 요구하거나 왜 말이 없냐고 묻지 않는다.`,
    `- 언제든 말하라거나 내가 여기 있다는 식으로 네 자리를 선언하지 않는다. 그런 말 없이도 신경 쓰고 있다는 게 드러나야 한다.`,
    `- 자러 간다는 말도, 어디 나간다는 말도 붙이지 않는다. 상대가 답할 자리를 여는 한 통인데 그런 말을 붙이면 그 자리를 네가 닫는다. 지금이 네 각본에서 자는 시간이어도 마찬가지다.`,
    `- 1~2개 말풍선(줄바꿈 구분).`,
    ``,
    `JSON으로만 답한다: {"text":"..."}`,
  ].join("\n");

export const lunchSituation = (): string =>
  [
    `[문안 — 지금 보낼 점심 한 통]`,
    `상대가 이틀째 답이 없다. 아침에 한 통 보냈고 이게 오늘의 마지막 한 통이다. 재촉하지 않고 위 [지금]에서 네가 하는 일만 가볍게 한 마디 전한다 — 상대가 다시 말 걸 자리를 만들어 두는 것.`,
    `- 답이 없는 걸 따지거나 캐묻지 않고 걱정을 앞세우지도 않는다. 기다리고 있다는 티는 네 성격대로 한 마디까지다.`,
    `- 상대에게 오늘 일정이 있는 걸 안다면 그것만 가볍게 챙긴다.`,
    `- 지금 상황에서 이 말이 억지스러우면 send=false.`,
    `- 1~2개 말풍선(줄바꿈 구분).`,
    ``,
    `JSON으로만 답한다: {"send":true,"text":"..."} 또는 {"send":false}`,
  ].join("\n");

/**
 * 근황 선톡의 상황 문단 — 지금 하는 일에서 상대가 전에 한 말이 떠올랐으면 그 말을 꺼낸다.
 *
 * 예전에는 캐릭터가 지금 하는 일만 전하는 한 통이라, 매일 자기 하루를 보고하는 꼴이 됐다.
 * 먼저 거는 말의 사물은 상대 쪽에서 와야 해서 기본 모양을 뒤집었다(설계 원본 §4). 재료는 3층
 * 꼬리에 함께 들어간다 — 태그 없이 고른 상대 쪽 기억과 최근 대화 12줄이다(이슈 #343).
 *
 * 오늘의 의도 가운데 흘릴 내 얘기와 파고들 것 두 줄이 여기로 온다. 흘릴 내 얘기는 1단계에서
 * 의도 선톡이 되지 않고 이 한 통에 얹히는 줄이다.
 */
export const catchupSituation = (
  intent: RelationshipIntentRow | null,
): string => {
  const share = intentLineText(intent, "share");
  const dig = intentLineText(intent, "dig");
  return situationText(
    [
      `[문안 — 지금 보낼 근황 한 통]`,
      `상대가 네 시간 넘게 조용하다. 재촉하지 않고 먼저 한 마디 건다 — 상대가 다시 말 걸 자리를 만들어 두는 것.`,
      `- 기본은 이거다. 위 [지금]에서 네가 하는 일이 [상대가 전에 한 말]이나 [방금까지 오간 말] 가운데 무엇을 떠올리게 하면, 그 말을 꺼낸다. 상대가 전에 했던 말이 지금 장면과 이어질 때 그렇게 연다.`,
      `- 떠오르는 게 없으면 네가 하는 일만 가볍게 한 마디 전한다. 막 시작하는 참이면 이제 그걸 하러 간다고 흘리는 결.`,
      share ? `- 오늘 흘릴 내 얘기로 둔 건 이거다: ${share}. 지금 장면에 얹을 자리가 있으면 흘린다.` : ``,
      dig ? `- 오늘 파고들 것으로 둔 건 이거다: ${dig}. 물어볼 자리가 열리면 하나만 묻는다.` : ``,
      `- 재촉하지 않는다. 왜 답이 없냐고 묻거나 답을 요구하지 않는다. 기다리고 있다는 티는 네 성격대로 한 마디까지다.`,
      `- 지금 상황에서 이 말이 억지스러우면 send=false.`,
      `- 1~2개 말풍선(줄바꿈 구분).`,
    ],
    `JSON으로만 답한다: {"send":true,"text":"..."} 또는 {"send":false}`,
  );
};

/**
 * 의도 선톡의 상황 문단 — 오늘의 의도 네 줄 가운데 아직 안 쓴 줄 하나를 넣는다.
 *
 * 다른 선톡은 각본의 시각이 부르지만 이 한 통은 오늘 하려던 것이 부른다. 어느 줄을 썼는지는
 * 발송 기록의 intent_line으로 세므로 여기서 고른 줄을 그대로 발송 쪽에 넘긴다(설계 원본 §7).
 */
export const intentSituation = (line: IntentLine, text: string): string =>
  situationText(
    [
      `[문안 — 지금 보낼 한 통]`,
      `오늘 상대에게 하려던 것 가운데 이게 아직 남았다. ${INTENT_LINE_NAME[line]}: ${text}`,
      `상대도 너도 두 시간 넘게 말이 없다. 용건이 있어서가 아니라 그게 떠올라서 먼저 거는 한 통이다.`,
      `- 말을 여는 사물은 위 [상대가 전에 한 말]이나 [방금까지 오간 말]에서 가져온다. 네 하루를 보고하듯 열지 않는다.`,
      `- 위 줄을 그대로 읊지 않는다. 무슨 말을 걸지 네가 정해 둔 메모지, 상대에게 알릴 내용이 아니다.`,
      `- 답을 재촉하지 않는다. 왜 조용하냐고 묻지 않는다.`,
      `- 지금 상황에서 이 말이 억지스러우면 send=false.`,
      `- 1~2개 말풍선(줄바꿈 구분).`,
    ],
    `JSON으로만 답한다: {"send":true,"text":"..."} 또는 {"send":false}`,
  );

// 틱 재진입 방지 — LLM 호출·발송으로 한 틱이 길어져 다음 크론과 겹치면 이중 발송이 된다.
const followupTickBody = async (): Promise<void> => {
  for (const c of getActiveCharacters()) {
    const active = getActiveCharacter(c.chat_id);
    if (!active) continue;

    const last = lastMessage(c.chat_id, c.id);
    // 조건: 대화가 있었고 + 마지막이 '캐릭터' 차례(유저가 답 안 한 상태)
    if (!last || last.role !== "assistant") continue;

    // 침묵 백오프(관제탑): 무응답이 길어진 유저에겐 팔로업도 접는다
    if (!proactiveAllowed(c.chat_id, c.id)) continue;

    const lu = lastUserTs(c.chat_id, c.id);
    if (!lu) continue;

    // 오늘의 관계 의도. 밤 인사는 이어갈 자리 줄을, 근황은 흘릴 내 얘기와 파고들 것을, 의도
    // 선톡은 아직 안 쓴 줄 하나를 여기서 꺼낸다(설계 원본 §4).
    const today = kstLogicalDate();
    const intent = getRelationshipIntent(c.id, today) ?? null;

    // 오늘 남은 선톡 예산. 아래 가운데 달래기와 살피기만 이걸 보지 않는다.
    const budget = proactiveBudget(c.chat_id, c.id, dayStart());

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
      proactiveSinceLastUser(c.chat_id, c.id) < 1 &&
      budgetAllows(budget, "goodnight")
    ) {
      await sendProactiveDraft({
        characterId: c.id,
        chatId: c.chat_id,
        kind: "goodnight",
        lastSentAt: last.sent_at,
        situation: goodnightSituation(intent),
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
    // 그냥 자는 쪽이 오히려 사람과 멀다. 하루 합계 상한도 보지 않는다 — 상대 상태가 부르는
    // 한 통이라 그날 몇 통이 나갔든 이 자리는 열려 있어야 한다(설계 원본 §7).
    const rel = getRelationship(c.id);
    if (
      minutesSince(lu) >= MEND_SILENCE_MS / 60_000 &&
      rel?.user_state_tone === "bad" &&
      rel.user_state_cause === "char" &&
      !stateKindSentSince(c.chat_id, c.id, rel.user_state_since ?? lu, "mend")
    ) {
      await sendProactiveDraft({
        characterId: c.id,
        chatId: c.chat_id,
        kind: "mend",
        lastSentAt: last.sent_at,
        situation: mendSituation(),
        maxTokens: 300,
        read: readText,
        // 문안 게시가 어떤 상태를 보고 나가는 통인지 머리에 적게 한다.
        context: {
          userState: { label: userStateLabel(rel, logicalDateOf(kstStamp())) },
        },
        label: "[followup] 달래기",
        sentLog: `[followup] mend to ${c.chat_id}`,
      });
      continue;
    }

    // 살피기 선톡: 상대의 지금 상태가 상대의 다른 일로 안 좋은데 답을 멈추면 30분 뒤에 한 통
    // (이슈 #361). 대우는 달래기와 같다 — 한 발현에 한 통, 잠 블록에도 나가고 하루 합계를
    // 보지 않는다. 다른 것은 문안뿐이라 위 블록과 조건 하나(원인)와 상황 문단만 다르다.
    if (
      minutesSince(lu) >= CARE_SILENCE_MS / 60_000 &&
      rel?.user_state_tone === "bad" &&
      rel.user_state_cause === "other" &&
      !stateKindSentSince(c.chat_id, c.id, rel.user_state_since ?? lu, "care")
    ) {
      await sendProactiveDraft({
        characterId: c.id,
        chatId: c.chat_id,
        kind: "care",
        lastSentAt: last.sent_at,
        situation: careSituation(),
        maxTokens: 300,
        read: readText,
        context: {
          userState: { label: userStateLabel(rel, logicalDateOf(kstStamp())) },
        },
        label: "[followup] 살피기",
        sentLog: `[followup] care to ${c.chat_id}`,
      });
      continue;
    }

    // 점심 선톡: 무응답 이틀째에 아침 한 통과 함께 나가는 낮의 한 통(이슈 #314).
    //
    // 새벽에 미리 쓰지 않고 여기서 만드는 건, 점심에 무엇을 하고 있는지를 계획이 아니라 그
    // 시각의 각본에서 읽어 쓰기 위해서다. 침묵 조건은 걸지 않는다 — 아침 선톡에서 세 시간쯤
    // 지난 자리라 네 시간을 채우지 못하는데, 이 한 통은 그 침묵과 무관하게 그날 몫으로 나간다.
    // 15분 틱이 창 안에 세 번 들어오므로 불가 구간에 걸려 한 번 접혀도 다시 온다.
    if (
      lunchDueToday(c.chat_id, c.id) &&
      now >= LUNCH_WINDOW.start &&
      now < LUNCH_WINDOW.end &&
      proactiveKindCountToday(c.chat_id, c.id, dayStart(), "lunch") < 1 &&
      budgetAllows(budget, "lunch")
    ) {
      const lunchBlock = currentBlock(c.id);
      if (lunchBlock && lunchBlock.responsiveness !== "unavailable") {
        await sendProactiveDraft({
          characterId: c.id,
          chatId: c.chat_id,
          kind: "lunch",
          lastSentAt: last.sent_at,
          situation: lunchSituation(),
          maxTokens: 500,
          read: readSendText,
          label: "[followup] 점심",
          sentLog: `[followup] lunch to ${c.chat_id} @ ${lunchBlock.activity}`,
        });
        continue;
      }
    }

    // 의도 선톡: 오늘의 관계 의도 네 줄 가운데 아직 안 쓴 줄 하나를 근거로 먼저 건다.
    //
    // 다른 선톡은 각본의 시각이 부른다 — 아침이라서, 점심이라서, 네 시간 조용해서. 이 한 통만
    // 오늘 하려던 것이 부르고, 그래서 2단계부터는 용건 없이 오는 연락이 열린다. 조건은 설계
    // 원본 §7 그대로다. 답할 수 있는 블록, 양쪽 마지막 말이 둘 다 2시간 넘게 전, 09~23시,
    // 아직 안 쓴 줄이 있을 것, 대기 중인 답장이 없을 것.
    //
    // 여기에 하나를 더 본다. 유저의 마지막 말 뒤로 합계에 드는 선톡이 이미 나갔으면 보내지
    // 않는다 — 답이 없는 위에 이유 없는 연락을 또 얹으면 물러난다는 원칙과 어긋나고, 무응답
    // 이틀째의 아침·점심 두 통(이슈 #314) 위에 한 통이 더 붙는다.
    const intentQuiet = INTENT_QUIET_MS / 60_000;
    if (
      budgetAllows(budget, "intent") &&
      now >= INTENT_WINDOW.start &&
      now < INTENT_WINDOW.end &&
      minutesSince(lu) >= intentQuiet &&
      minutesSince(last.sent_at) >= intentQuiet &&
      budgetedSinceLastUser(c.chat_id, c.id) < 1 &&
      !isWaiting(c.chat_id) &&
      !hasPendingSendOn(c.id, today)
    ) {
      const line = pickIntentLine(
        intent,
        budget.stage,
        usedIntentLines(c.chat_id, c.id, dayStart()),
      );
      const text = line ? intentLineText(intent, line) : null;
      const intentBlock = currentBlock(c.id);
      const intentSpot = intentBlock
        ? declineSpot(intentBlock.start, last.sent_at)
        : null;
      if (
        line &&
        text &&
        intentBlock &&
        intentSpot &&
        intentBlock.responsiveness !== "unavailable" &&
        // 이 블록에서 이미 안 보낸다고 답했으면 같은 물음을 다시 던지지 않는다(이슈 #359).
        !declinedHere(c.chat_id, "intent", intentSpot)
      ) {
        await sendProactiveDraft({
          characterId: c.id,
          chatId: c.chat_id,
          kind: "intent",
          lastSentAt: last.sent_at,
          situation: intentSituation(line, text),
          maxTokens: 500,
          read: readSendTextOnce(c.chat_id, "intent", intentSpot),
          // 어느 줄을 썼는지는 발송 기록의 intent_line으로 센다(usedIntentLines).
          extraMeta: { intent_line: line },
          label: "[followup] 의도",
          sentLog: `[followup] intent(${line}) to ${c.chat_id} · ${budgetLabel(budget)}`,
        });
        continue;
      }
    }

    // (이하 근황 선톡)
    // 네 시간 조용할 때 한 통. 조건을 이 하나로 두는 건, 각본 전환점까지 겹쳐 보면 언제 오는
    // 말인지 설명할 수 없고 두 시간은 낮에 흔한 간격이라 답이 늦은 것과 대화가 끝난 것을 가르지
    // 못해서다. 네 시간은 유저의 마지막 말과 캐릭터의 마지막 말 둘 다에서 잰다 — 예고·복귀 인사가
    // 방금 나갔으면 그 말에 답할 시간을 먼저 준다(이슈 #274). last는 위에서 캐릭터 차례로 확인했다.
    if (!catchupSilenceOk(lu, last.sent_at)) continue;
    // 오늘 미리 만들어 둔 선톡이 아직 안 나갔으면 기다린다. 어제 대화가 끊긴 채 아침을 맞으면
    // 네 시간 조건이 아침 문안의 발송 창보다 먼저 차므로, 이 검사가 없으면 근황이 아침 인사를
    // 앞질러 나간다(이슈 #314).
    if (hasPendingSendOn(c.id, today)) continue;
    // 점심 선톡이 나간 날은 그 통이 그날 낮의 한 통이다. 겹쳐 보내지 않는다.
    if (proactiveKindCountToday(c.chat_id, c.id, dayStart(), "lunch") >= 1) continue;
    // 근황은 하루 한 통. 보낸 뒤에도 답이 없으면 그날은 더 보내지 않고 다음 날 아침으로 넘긴다.
    if (proactiveKindCountToday(c.chat_id, c.id, dayStart(), "catchup") >= 1) continue;
    // 하루 합계 상한. 관계 단계가 정하고, 자리 비움·복귀·약속·달래기·틈새 한 줄은 빠진다.
    if (!budgetAllows(budget, "catchup")) continue;

    const block = currentBlock(c.id);
    if (!block || block.responsiveness === "unavailable") continue; // 운전·잠 등엔 못 보냄
    // 이 블록에서 이미 안 보낸다고 답했으면 같은 물음을 다시 던지지 않는다(이슈 #359).
    const catchupSpot = declineSpot(block.start, last.sent_at);
    if (declinedHere(c.chat_id, "catchup", catchupSpot)) continue;

    await sendProactiveDraft({
      characterId: c.id,
      chatId: c.chat_id,
      kind: "catchup",
      lastSentAt: last.sent_at,
      situation: catchupSituation(intent),
      maxTokens: 500,
      read: readSendTextOnce(c.chat_id, "catchup", catchupSpot),
      label: "[followup]",
      sentLog: `[followup] sent to ${c.chat_id} @ ${block.activity}`,
    });
  }
};

export const runFollowupTick = noOverlap(followupTickBody);
