// 답장마다 상대의 지금 상태를 판정하는 작은 호출.
//
// 상대가 캐릭터에게 서운해했는데 답장이 그 뒤로 계속 웃으며 넘어가던 일(이슈 #309)에서
// 시작했다. 한 답장에 붙는 서운함 표시 하나로는 다음 턴에 아무것도 남지 않아, 답장 경로 밖에서
// 최근 대화와 지난 판정을 읽고 상대가 지금 어떤 상태인지·무엇 때문인지·언제부터인지를 정한다.
// 정한 값은 relationship-update가 관계 행에 적고, 프롬프트 조립(context/assemble)이 실시간
// 꼬리에 실어 답장과 선톡 문안 모두가 읽는다. 달래기 선톡(followup)은 이 값의 결과 원인을 본다.
//
// 상태는 자유 문장이고 원인은 둘(나 때문·상대의 다른 일), 결은 셋(좋음·보통·안 좋음)뿐이다.
// 풀렸다는 표시는 따로 없다 — 상태가 바뀌면 새 값이 앞 값을 덮는다. 바뀐 턴에는 판정 직전의
// 값(prev)도 돌려줘 슬랙 답장 게시가 이전 → 지금으로 적는다(이슈 #312). 주제 고르기(tag-pick)와
// 나란히 돌려 답장이 늦어지지 않게 한다.

import { chat, type CallMeta } from "./llm.js";
import { config } from "./config.js";
import {
  getRecentMessages,
  getRelationship,
  setCallContext,
  type MessageRow,
  type RelationshipRow,
  type UserStateValue,
} from "./db.js";
import {
  USER_STATE_CAUSE_NAME,
  USER_STATE_TONE_NAME,
  type UserStateCause,
  type UserStateTone,
} from "./labels.js";
import { logicalClockOf, clockLabel, logicalDateOf } from "./kst.js";
import { USER_STATE_TURNS } from "./thresholds.js";

/** 판정 결과. changed가 false면 지난 판정이 그대로다. */
export interface UserStateVerdict {
  changed: boolean;
  /** changed일 때 새 값. 실패했거나 그대로면 null. */
  state: UserStateValue | null;
  /** 호출이 비거나 형식이 깨져 판정을 못 받은 것 — 값을 그대로 둔다. */
  failed: boolean;
  callId: number | null;
  /** changed일 때 판정 직전의 값(한 줄 이름표). 없던 상태에서 생겼으면 null. */
  prev: string | null;
}

const SYSTEM = `너는 두 사람의 메시지 대화를 옆에서 읽는 관찰자다. 캐릭터가 아니라 제3자다.
[최근 대화]를 읽고 상대(유저)가 지금 어떤 상태인지 판정한다. [지난 판정]은 앞 답장 때 판정한 값이다.

판정 규칙:
- state: 상대의 지금 상태를 한 문장으로. 무엇 때문에 어떤 상태인지가 드러나게 쓴다(예: 연락한다고 해 놓고 안 해서 서운해한다 / 면접 결과를 기다리며 초조해한다 / 여행 계획을 세우며 들떠 있다).
- cause: 그 상태의 원인이 캐릭터라면 char, 상대의 다른 일(회사·가족·건강·날씨 등)이라면 other.
- tone: 좋으면 good, 특별할 것 없으면 neutral, 서운함·짜증·화·슬픔·불안처럼 안 좋으면 bad.
- since: 그 상태가 시작된 메시지의 시각을 HH:MM으로. [최근 대화]에 있는 시각 중에서 고른다.
- 지난 판정과 실제로 같은 상태면 changed를 false로 하고 나머지는 비운다. 상태가 풀렸거나 다른 상태로 옮겨 갔으면 changed를 true로 하고 새 값을 적는다. 풀렸는지는 상대가 그렇게 말했거나 말투가 분명히 달라졌을 때만 인정한다 — 캐릭터가 사과했다고 풀린 것은 아니다.
- 상대 말이 없거나 판정할 근거가 없으면 changed를 false로 한다.

JSON 한 줄로만 답한다:
{"changed":true,"state":"...","cause":"char|other","tone":"good|neutral|bad","since":"HH:MM"}
또는 {"changed":false}`;

const CAUSES: readonly UserStateCause[] = ["char", "other"];
const TONES: readonly UserStateTone[] = ["good", "neutral", "bad"];

/** 최근 대화를 판정 호출에 넣는 모양으로. 날짜가 바뀌는 줄에만 M/D를 앞에 붙인다. */
export const userStateTranscript = (rows: MessageRow[]): string => {
  if (!rows.length) return "(없음)";
  const lastDate = logicalDateOf(rows[rows.length - 1]!.sent_at);
  return rows
    .map((r) => {
      const date = logicalDateOf(r.sent_at);
      const day =
        date === lastDate
          ? ""
          : `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))} `;
      const who = r.role === "user" ? "상대" : "캐릭터";
      return `[${day}${clockLabel(logicalClockOf(r.sent_at))}] ${who}: ${r.text}`;
    })
    .join("\n");
};

/** 지난 판정을 한 줄로 — 프롬프트와 트레이스가 같은 모양을 쓴다. today는 YYYY-MM-DD. */
export const userStateLabel = (
  rel: Pick<
    RelationshipRow,
    "user_state" | "user_state_cause" | "user_state_tone" | "user_state_since"
  >,
  today: string,
): string | null => {
  if (!rel.user_state) return null;
  const parts: string[] = [];
  if (rel.user_state_since) {
    const date = logicalDateOf(rel.user_state_since);
    const clock = clockLabel(logicalClockOf(rel.user_state_since));
    const day =
      date === today
        ? ""
        : `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))} `;
    parts.push(`${day}${clock}부터`);
  }
  if (rel.user_state_cause)
    parts.push(USER_STATE_CAUSE_NAME[rel.user_state_cause]);
  if (rel.user_state_tone) parts.push(USER_STATE_TONE_NAME[rel.user_state_tone]);
  return parts.length
    ? `${rel.user_state} (${parts.join(" · ")})`
    : rel.user_state;
};

/** HH:MM(각본 표기, 자정 뒤 24 넘김도 받는다)을 최근 대화 안의 타임스탬프로 되돌린다. */
const sinceOf = (hhmm: string, rows: MessageRow[]): string | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const want = `${m[1]!.padStart(2, "0")}:${m[2]}`;
  const hit = rows.find(
    (r) =>
      clockLabel(logicalClockOf(r.sent_at)) === want ||
      logicalClockOf(r.sent_at) === want,
  );
  if (hit) return hit.sent_at;
  const last = rows[rows.length - 1];
  if (!last) return null;
  // 대화에 없는 시각이면 마지막 메시지의 날짜에 그 시각을 붙인다.
  return `${last.sent_at.slice(0, 10)} ${clockLabel(want)}:00`;
};

/** 모델 답을 판정으로 읽는다. 형식이 깨졌으면 null. rows는 since를 시각으로 되돌리는 데 쓴다. */
export const parseUserStateVerdict = (
  raw: string,
  rows: MessageRow[],
): { changed: boolean; state: UserStateValue | null } | null => {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let o: unknown;
  try {
    o = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const v = o as Record<string, unknown>;
  if (v.changed !== true) return { changed: false, state: null };
  const state = typeof v.state === "string" ? v.state.trim() : "";
  const cause = CAUSES.find((c) => c === v.cause);
  const tone = TONES.find((t) => t === v.tone);
  if (!state || !cause || !tone) return null;
  const since =
    (typeof v.since === "string" ? sinceOf(v.since, rows) : null) ??
    rows[rows.length - 1]?.sent_at ??
    null;
  if (!since) return null;
  return { changed: true, state: { state, cause, tone, since } };
};

const noChange = (
  failed: boolean,
  callId: number | null,
): UserStateVerdict => ({
  changed: false,
  state: null,
  failed,
  callId,
  prev: null,
});

/**
 * 상대의 지금 상태를 판정한다. 실패하면 값을 그대로 둔다 — 없던 상태를 만들지 않는 쪽이
 * 안전하다. 판정 호출 기록에 결과를 남겨 트레이스가 답장 옆에 나란히 적을 수 있게 한다.
 */
export const judgeUserState = async (
  characterId: number,
  chatId: string,
): Promise<UserStateVerdict> => {
  const rows = getRecentMessages(chatId, USER_STATE_TURNS);
  if (!rows.some((r) => r.role === "user")) return noChange(false, null);
  const rel = getRelationship(characterId);
  const last = rows[rows.length - 1]!;
  const prev = rel ? userStateLabel(rel, logicalDateOf(last.sent_at)) : null;
  const content = [
    `[지난 판정]\n${prev ?? "(없음)"}`,
    `[최근 대화]\n${userStateTranscript(rows)}`,
  ].join("\n\n");
  const meta: CallMeta = { purpose: "user_state", characterId, chatId };
  try {
    const out = await chat(
      SYSTEM,
      [{ role: "user", content }],
      160,
      config.model,
      meta,
      { think: false },
    );
    const parsed = parseUserStateVerdict(out, rows);
    const callId = meta.callId ?? null;
    if (!parsed) {
      console.warn("[user-state] 판정 형식이 깨졌다 — 값을 그대로 둔다");
      if (callId) record(callId, { failed: true });
      return noChange(true, callId);
    }
    if (callId)
      record(callId, {
        changed: parsed.changed,
        state: parsed.state,
        prev,
      });
    return { ...parsed, failed: false, callId, prev: parsed.changed ? prev : null };
  } catch (e) {
    console.warn("[user-state] 판정 호출 실패 — 값을 그대로 둔다:", e);
    return noChange(true, meta.callId ?? null);
  }
};

const record = (callId: number, ctx: unknown): void => {
  try {
    setCallContext(callId, { userState: ctx });
  } catch {
    /* 판정은 그대로 쓴다 */
  }
};
