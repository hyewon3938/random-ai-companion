// 반응 점수 — 플러팅을 쓴 답장마다 유저의 첫 턴으로 표본을 매기고, 대화방·플러팅별 점수를 지수 이동 평균으로 갱신한다.
//
// relationship.md 「반응 점수」가 원본이다. 표본 하나는 플러팅을 쓴 답장 하나와 그 뒤 같은 논리일
// 안, 6시간 안에 온 유저의 첫 턴이다. 첫 턴은 답장 뒤 처음 온 유저 메시지부터 다음 캐릭터 말 전까지
// 이어 보낸 메시지 묶음이다. 신호 7개를 −1·0·+1로 매겨 가중치를 곱해 더한 값이 표본 값이고, 답이
// 없는 표본은 속도·길이·이어진 턴 수가 −1이라 −0.40이다.
//
// 평소 값은 일기 날짜까지 14일의 유저 턴에서 잰다. 답장 간격은 바로 앞 캐릭터 말부터 턴 첫 메시지까지,
// 글자 수는 턴 메시지를 이은 길이다. 표본과 같은 규칙(같은 논리일, 6시간 안)에 드는 턴만 모으고,
// 20개가 안 되면 속도와 길이 신호는 0이다.
//
// 턴에 붙는 판정은 관계 신호 행(relationship_signals)에서 읽는다. 이 행은 답장을 만들 때 적혀서 턴
// 첫 메시지 뒤, 다음 캐릭터 말 전에 있다. 되묻기는 턴에 물음표가 있거나 그 행이 캐릭터 근황을 물었다고
// 판정한 것이고, 플러팅 반응은 행의 prev_move가 이 플러팅일 때만 읽는다. 상대 상태는 그 행을 만든
// 판정 호출까지 같은 논리일에 상태를 바꾼 판정 가운데 마지막 것의 tone과 원인이다. 행이 없는 턴은
// 상대 상태와 플러팅 반응이 0이다.
//
// 새벽 정리가 두 번 부른다. 수집(gatherRelation)은 어제 표본을 지금 점수에 얹은 값으로 문턱과 추천
// 목록을 만들고, 저장(applyRelationOutput)은 같은 표본을 다시 세어 트랜잭션 안에서 적는다. 대화
// 기록과 판정 행은 어제 창 안에서만 읽어 두 번 모두 같은 값이 나오는 것이 보통이지만, 그 사이 05:00 뒤에
// 온 유저 메시지로 아직 안 나간 답장을 다시 만들면 어제 턴의 관계 신호 행이 창 밖으로 옮겨져 저장 쪽의
// 상대 상태와 플러팅 반응이 0이 될 수 있다. 일기가 이미 있는 날은 저장 전체를 건너뛰어 같은 날이 두 번
// 반영되지 않는다. 키가 대화방과 플러팅이라 캐릭터를 바꿔도 점수가 이어진다. 플러팅마다의
// 점수 숫자는 어느 프롬프트와 새벽 정리 입력에도 넣지 않는다.

import type {
  Move,
  MoveReaction,
  UserStateCause,
  UserStateTone,
} from "./labels.js";
import { MOVE_NAME } from "./labels.js";
import {
  getMessageRowsBetween,
  getRelationshipSignals,
  getUserStateChanges,
  type ReactionScoreRow,
  type RelationshipSignalRow,
} from "./db.js";
import { logicalDateOf, shiftDate } from "./kst.js";
import {
  REACTION_ALPHA,
  REACTION_BASELINE_DAYS,
  REACTION_BASELINE_MIN,
  REACTION_FOLLOW,
  REACTION_LAUGH_MIN,
  REACTION_LENGTH,
  REACTION_REPLY_WINDOW_MS,
  REACTION_SPEED,
  REACTION_WEIGHTS,
} from "./thresholds.js";

// ── 순수 계산 ─────────────────────────────────────────────────────────────────

export type SignalScore = -1 | 0 | 1;

export interface SampleSignals {
  speed: SignalScore;
  length: SignalScore;
  laugh: SignalScore;
  ask: SignalScore;
  follow: SignalScore;
  state: SignalScore;
  move: SignalScore;
}

/** 유저의 평소 값. 턴 수가 문턱에 못 미치면 속도·길이 신호를 매기지 않는다. */
export interface ReactionBaseline {
  turns: number;
  gapMedianMs: number | null;
  charsMedian: number | null;
}

/** 표본 하나에서 본 것. 답이 없으면 reply가 null이다. */
export interface SampleObservation {
  reply: {
    gapMs: number;
    chars: number;
    text: string;
    /** 첫 메시지부터 30분 안의 유저 메시지 수. 첫 메시지를 넣어 센다. */
    followCount: number;
  } | null;
  askedAboutChar: boolean;
  tone: UserStateTone | null;
  cause: UserStateCause | null;
  moveReaction: MoveReaction | null;
}

export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const round4 = (v: number): number => Math.round(v * 10_000) / 10_000;

const laughCount = (text: string): number =>
  (text.match(/[ㅋㅎ]/g) ?? []).length;

/** 순수 계산. 신호 7개를 −1·0·+1로 매긴다. */
export const scoreSignals = (
  o: SampleObservation,
  b: ReactionBaseline,
): SampleSignals => {
  if (!o.reply)
    return {
      speed: -1,
      length: -1,
      laugh: 0,
      ask: 0,
      follow: -1,
      state: 0,
      move: 0,
    };
  const r = o.reply;
  const enough = b.turns >= REACTION_BASELINE_MIN;
  let speed: SignalScore = 0;
  if (enough && b.gapMedianMs !== null) {
    if (r.gapMs <= b.gapMedianMs * REACTION_SPEED.fast) speed = 1;
    else if (r.gapMs > b.gapMedianMs * REACTION_SPEED.slow) speed = -1;
  }
  let length: SignalScore = 0;
  if (enough && b.charsMedian !== null) {
    if (r.chars > b.charsMedian * REACTION_LENGTH.long) length = 1;
    else if (r.chars < b.charsMedian * REACTION_LENGTH.short) length = -1;
  }
  return {
    speed,
    length,
    laugh: laughCount(r.text) >= REACTION_LAUGH_MIN ? 1 : 0,
    ask: /[?？]/.test(r.text) || o.askedAboutChar ? 1 : 0,
    follow: r.followCount >= REACTION_FOLLOW.min ? 1 : 0,
    state:
      o.tone === "good" ? 1 : o.tone === "bad" && o.cause === "char" ? -1 : 0,
    move:
      o.moveReaction === "accepted"
        ? 1
        : o.moveReaction === "rejected"
          ? -1
          : 0,
  };
};

/** 순수 계산. 신호에 가중치를 곱해 더한 표본 값. */
export const sampleValue = (s: SampleSignals): number =>
  round4(
    (Object.keys(REACTION_WEIGHTS) as (keyof SampleSignals)[]).reduce(
      (a, k) => a + REACTION_WEIGHTS[k] * s[k],
      0,
    ),
  );

/** 순수 계산. 지수 이동 평균 한 걸음. sampleCount는 이 표본을 넣기 전의 표본 수다. */
export const emaStep = (
  score: number,
  sampleCount: number,
  s: number,
): number => {
  const alpha =
    sampleCount < REACTION_ALPHA.earlySamples
      ? REACTION_ALPHA.early
      : REACTION_ALPHA.late;
  return round4(score + alpha * (s - score));
};

/** 순수 계산. 표본을 순서대로 점수 행에 얹은 결과. 저장된 행과 같은 순서(점수 내림차순, 같으면
 * 플러팅 코드 순)로 돌려주고, 표본이 없던 행은 그대로 둔다. */
export const applySamples = (
  chatId: string,
  scores: ReactionScoreRow[],
  samples: { move: Move; value: number }[],
  now: string,
): ReactionScoreRow[] => {
  const byMove = new Map<Move, ReactionScoreRow>(
    scores.map((r) => [r.move, { ...r }]),
  );
  for (const x of samples) {
    const cur = byMove.get(x.move) ?? {
      chat_id: chatId,
      move: x.move,
      score: 0,
      sample_count: 0,
      updated_at: now,
    };
    byMove.set(x.move, {
      ...cur,
      score: emaStep(cur.score, cur.sample_count, x.value),
      sample_count: cur.sample_count + 1,
      updated_at: now,
    });
  }
  return [...byMove.values()].sort(
    (a, b) =>
      b.score - a.score || (a.move < b.move ? -1 : a.move > b.move ? 1 : 0),
  );
};

// ── 턴 묶기 ───────────────────────────────────────────────────────────────────

export interface TurnMessage {
  id: number;
  role: string;
  text: string;
  sent_at: string;
}

/** 캐릭터 말 뒤에 온 유저 메시지 묶음. */
export interface UserTurn {
  /** 바로 앞 캐릭터 말의 시각. */
  prevAt: string;
  /** 첫 메시지의 번호와 시각. */
  firstId: number;
  at: string;
  /** 다음 캐릭터 말의 시각. 창 안에 없으면 null이다. */
  nextAt: string | null;
  text: string;
  chars: number;
}

const msOf = (ts: string): number => Date.parse(`${ts.replace(" ", "T")}Z`);

/** 두 저장 시각의 차이(ms). */
export const gapMs = (from: string, to: string): number =>
  msOf(to) - msOf(from);

/** 순수 계산. 보낸 순서의 메시지를 유저 턴으로 묶는다. 앞에 캐릭터 말이 없는 유저 메시지는 답이
 * 아니라 턴으로 치지 않는다. */
export const userTurnsOf = (rows: TurnMessage[]): UserTurn[] => {
  const out: UserTurn[] = [];
  let prevAt: string | null = null;
  let cur: UserTurn | null = null;
  for (const r of rows) {
    if (r.role === "assistant") {
      if (cur) cur.nextAt = r.sent_at;
      cur = null;
      prevAt = r.sent_at;
    } else if (r.role === "user") {
      if (cur) {
        cur.text += `\n${r.text}`;
        cur.chars += [...r.text].length;
      } else if (prevAt !== null) {
        cur = {
          prevAt,
          firstId: r.id,
          at: r.sent_at,
          nextAt: null,
          text: r.text,
          chars: [...r.text].length,
        };
        out.push(cur);
        prevAt = null;
      }
    }
  }
  return out;
};

/** 표본으로 치는 간격인지 — 같은 논리일 안, 6시간 안. */
const withinReplyWindow = (from: string, to: string): boolean =>
  logicalDateOf(from) === logicalDateOf(to) &&
  gapMs(from, to) <= REACTION_REPLY_WINDOW_MS;

/** 순수 계산. 표본과 같은 규칙에 드는 턴으로 평소 값을 잰다. */
export const baselineOf = (turns: UserTurn[]): ReactionBaseline => {
  const kept = turns.filter((t) => withinReplyWindow(t.prevAt, t.at));
  return {
    turns: kept.length,
    gapMedianMs: median(kept.map((t) => gapMs(t.prevAt, t.at))),
    charsMedian: median(kept.map((t) => t.chars)),
  };
};

// ── 새벽 정리 수집 ────────────────────────────────────────────────────────────

export interface ReactionSample {
  move: Move;
  /** 플러팅을 쓴 답장의 시각. */
  at: string;
  signals: SampleSignals;
  value: number;
}

const dayStart = (date: string): string => `${date} 05:00:00`;

const moveOf = (json: string | null): Move | null => {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    const m =
      v && typeof v === "object" ? (v as Record<string, unknown>).move : null;
    return typeof m === "string" && Object.hasOwn(MOVE_NAME, m)
      ? (m as Move)
      : null;
  } catch {
    return null;
  }
};

/** 턴의 관계 신호 행 — 턴 첫 메시지 뒤, 다음 캐릭터 말까지 처음 적힌 행. */
const signalOf = (
  turn: UserTurn,
  signals: RelationshipSignalRow[],
): RelationshipSignalRow | undefined =>
  signals.find(
    (s) => s.at >= turn.at && (turn.nextAt === null || s.at <= turn.nextAt),
  );

/**
 * 한 논리일의 반응 표본. 그날 캐릭터 답장이 쓴 플러팅마다 하나씩, 보낸 순서로 돌려준다. 같은 날
 * 같은 플러팅을 여러 번 썼으면 표본도 그만큼이다.
 */
export const collectReactionSamples = (
  chatId: string,
  characterId: number,
  diaryDate: string,
): ReactionSample[] => {
  const dayFrom = dayStart(diaryDate);
  const dayTo = dayStart(shiftDate(diaryDate, 1));
  const rows = getMessageRowsBetween(
    chatId,
    characterId,
    dayStart(shiftDate(diaryDate, 1 - REACTION_BASELINE_DAYS)),
    dayTo,
  );
  const moveRows = rows.flatMap((r) => {
    const move =
      r.role === "assistant" && r.sent_at >= dayFrom
        ? moveOf(r.meta_json)
        : null;
    return move ? [{ id: r.id, at: r.sent_at, move }] : [];
  });
  if (!moveRows.length) return [];

  const turns = userTurnsOf(rows);
  const baseline = baselineOf(turns);
  const signals = getRelationshipSignals(characterId, dayFrom, dayTo);
  const changes = getUserStateChanges(characterId, dayFrom, dayTo);
  const userTimes = rows.filter((r) => r.role === "user").map((r) => r.sent_at);

  return moveRows.map(({ id, at, move }) => {
    const turn = turns.find((t) => t.firstId > id);
    const answered = turn !== undefined && withinReplyWindow(at, turn.at);
    const signal = answered ? signalOf(turn, signals) : undefined;
    const state = signal
      ? changes
          .filter((c) =>
            signal.call_id !== null
              ? c.id <= signal.call_id
              : c.created_at <= signal.at,
          )
          .at(-1)
      : undefined;
    const observation: SampleObservation = {
      reply: answered
        ? {
            gapMs: gapMs(at, turn.at),
            chars: turn.chars,
            text: turn.text,
            followCount: userTimes.filter(
              (u) =>
                u >= turn.at && gapMs(turn.at, u) <= REACTION_FOLLOW.windowMs,
            ).length,
          }
        : null,
      askedAboutChar: signal?.asked_about_char === 1,
      tone: state?.tone ?? null,
      cause: state?.cause ?? null,
      moveReaction:
        signal && signal.prev_move === move ? signal.move_reaction : null,
    };
    const signalsScored = scoreSignals(observation, baseline);
    return {
      move,
      at,
      signals: signalsScored,
      value: sampleValue(signalsScored),
    };
  });
};

/** 어제 표본을 지금 점수에 얹은 점수 행. 수집이 문턱과 추천 목록을 만들 때 쓴다. */
export const projectReactionScores = (
  chatId: string,
  characterId: number,
  diaryDate: string,
  scores: ReactionScoreRow[],
  now: string,
): ReactionScoreRow[] =>
  applySamples(
    chatId,
    scores,
    collectReactionSamples(chatId, characterId, diaryDate),
    now,
  );
