// 답장 게시 문안 그리기 — 호출 행과 판단 근거를 슬랙 본문 한 장으로 옮긴다.
//
// 게시 재료는 llm_calls·prompt_blobs에서 읽는다. 답장 경로에 게시 훅을 새로 달지 않는다 —
// 호출 원문이 이미 남으므로 읽는 쪽만 있으면 되고, 답장 파이프라인 안에 게시 코드가 끼면
// 게시 실패가 답장을 막을 자리가 생긴다.
//
// 한 건의 본문에 담는 것: 무슨 말에 답했는지, 텀이 어떻게 나왔는지, 무엇을 검색해 넣었는지,
// 모델이 뭐라고 썼는지, 발송 결과. *응답* 줄은 호출이 어떤 블록으로 왔고 왜 멈췄는지다 —
// 저장하는 본문은 텍스트 블록뿐이라, 출력 토큰이 글자 수보다 클 때 그 몫이 생각 과정으로
// 갔는지 이 줄에서 가른다.
//
// 하루 고정 두 덩이가 하루 중에 바뀌었을 때의 줄 단위 비교(lineDiff·changedSections)도
// 여기 있다. 무엇을 언제 게시함에 쌓을지는 trace/reply-post.ts가 정한다.

import { getBlob, getLlmCallBrief, type LlmCallRow } from "../db.js";
import {
  ACTIVITY_CATEGORY_NAME,
  RESPONSIVENESS_NAME,
  SPEECH_LEVEL_NAME,
  toActivityCategory,
  toResponsiveness,
  type SpeechLevel,
} from "../labels.js";
import { clockLabel } from "../kst.js";
import { PARSE_NAME, type ReplyParse } from "../reply-signal.js";
import {
  clip,
  esc,
  purposeName,
  quote,
  shortModel,
  tokenLine,
} from "./format.js";


// 저장된 문자열이 지금 아는 길 이름인지 대조해 이름을 붙인다 — 옛 기록·모르는 값은 그대로 적는다.
const parseName = (v: string): string =>
  v in PARSE_NAME ? PARSE_NAME[v as ReplyParse] : v;


export type CallRow = LlmCallRow;

export interface BlockHash {
  h: string;
  cache?: boolean;
}

/** 관계 한 항목이 바뀐 기록(relationship-update.ts RelChange). */
interface RelUpdateEntry {
  field?: string;
  from?: string | null;
  to?: string;
}

// 답장 호출에 붙는 판단 근거(bot.ts attach)의 모양. 없는 값이 많아 전부 옵셔널이다.
export interface CallContext {
  timing?: {
    waitMs?: number;
    path?: string;
    block?: {
      start: string;
      end: string;
      activity: string;
      responsiveness: string;
      category: string;
      fallback?: boolean;
    } | null;
    justWoke?: boolean;
    asked?: boolean;
    heldJudged?: boolean;
    /** 판정을 물었는데 답을 못 받았는가. */
    holdFailed?: boolean;
    held?: { outcome: string; activity: string } | null;
    /** 붙잡기 판정을 물었으면 그 호출 번호. */
    holdCallId?: number | null;
  };
  gathered?: {
    activity?: string;
    blockStart?: string | null;
    /** 그 구간에 처음 온 메시지가 답장을 받기까지 기다린 시간. */
    waitedMs?: number | null;
  };
  /** 약속 시각에 만든 답장 — 어느 약속을 지키는 자리였는가(이슈 #308). */
  promised?: {
    promise?: string;
    activity?: string;
    blockStart?: string | null;
  };
  /**
   * 도착 대기 — 유저 말이 다 오기를 기다린 시간(waitMs), 첫 메시지가 온 뒤 답장을 만들기
   * 시작할 때까지 걸린 시간(spanMs), 그동안 도착한 메시지 수(msgs). 답장 텀과 다른 값이다.
   */
  arrival?: { waitMs: number; spanMs: number; msgs: number };
  search?: {
    tags?: string[];
    /** 고를 수 있었던 태그 수 — 걸린 것이 없을 때 검색이 돌긴 했는지 가른다. */
    tagPool?: number;
    /** 검색어를 무엇이 골랐는지 — model이면 짧은 호출, match면 그 호출이 실패해 글자 일치만. */
    tagBy?: string;
    /** 주제를 고른 호출 번호. */
    tagCallId?: number | null;
    memories?: string[];
    oldDiaries?: string[];
    /** 주제로 찾아 넣은 일정 — 날짜와 내용. */
    schedules?: string[];
    dropped?: string[];
  };
  turns?: number;
  /** 한 번에 답한 유저 메시지 수(나눠 보낸 것을 묶은 결과). */
  userMsgs?: number;
  /** 객체의 신호 칸 — 키 이름은 그대로 둔다(이미 올라간 기록과 어긋나지 않게). */
  stay?: boolean;
  note?: string | null;
  userUpset?: boolean;
  /** 이 답장에서 한 연락 약속과 코드가 정한 시각. 시각을 못 정했으면 dropped에 사유. */
  promise?: {
    text: string;
    sendAt?: string;
    block?: string;
    activity?: string;
    dropped?: string;
  };
  /** 객체를 어느 길로 읽었는지(json·stray·salvage·plain·empty). */
  outputParse?: string;
  bubbles?: number;
  bubbleLens?: number[];
  dropped?: string;
  /** 첫 답이 비어 다시 부른 호출 번호. */
  retryCallId?: number | null;
  /** 이 호출이 다른 호출에 딸린 것이면 그 부모 번호 — 재생성 호출이 여기 걸린다. */
  partOf?: number;
  /** 이 답장이 접거나 미룬 일정. by는 판정으로 접었는지 답장 표시로 접었는지. */
  dayActual?: {
    blockStart?: string | null;
    activity?: string;
    outcome?: string;
    by?: string;
  };
  /** 이 답장을 만들며 바뀐 관계 항목. 한 답장에서 셋까지 바뀔 수 있어 목록으로 온다.
   *  이미 쌓인 기록은 항목 하나가 객체로 들어 있어 두 모양을 다 읽는다. */
  relUpdate?: RelUpdateEntry | RelUpdateEntry[];
  /** 발송 예정 시각(만들어 두고 기다리는 답장). */
  sendAt?: string;
  /** 몰아 답장처럼 그 자리에서 바로 보낸 경우의 발송 결과. */
  sent?: string;
  /** 붙잡기 판정 호출이 자기 행에 남기는 것 — 무엇을 두고 판정했는가. */
  hold?: {
    block?: {
      start: string;
      end: string;
      activity: string;
      responsiveness: string;
      category: string;
    } | null;
    held?: boolean;
    /** 답이 비어 판정을 못 받았는가. */
    failed?: boolean;
  };
}

const PATH_NAME: Record<string, string> = {
  no_plan: "각본 없음",
  sleeping: "자다 깸",
  already_held: "이미 접어 둔 상태",
  table: "텀 표",
  until_end: "구간 끝",
  held: "붙잡혀 접음",
  recover: "복구 발송",
};

export const parseHashes = (raw: string | null): BlockHash[] => {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as BlockHash[]) : [];
  } catch {
    return [];
  }
};

export const parseContext = (raw: string | null): CallContext | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CallContext;
  } catch {
    return null;
  }
};

export const fmtWait = (ms: number): string => {
  if (ms < 1000) return "바로";
  if (ms < 60_000) return `${Math.round(ms / 1000)}초`;
  const m = Math.floor(ms / 60_000);
  // 몰아 답장은 몇 시간을 기다리기도 한다 — 분으로만 적으면 크기가 안 잡힌다.
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm ? `${h}시간 ${rm}분` : `${h}시간`;
  }
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m}분 ${s}초` : `${m}분`;
};

// 대화 기록은 통째로 올리지 않는다 — 그날 나눈 말이 다 들어 있고, 이미 텔레그램에 있다.
// 이번에 답한 말만 꺼낸다. 유저가 나눠 보내면 여러 통이 한 답장으로 묶이므로 묶인 만큼 전부.
const MAX_SHOWN_TURNS = 6;

const lastUserTurns = (hash: string | null): string[] => {
  if (!hash) return [];
  const blob = getBlob(hash);
  if (!blob) return [];
  const parts = blob.split(/\n(?=\[(?:user|assistant)\] )/);
  const mine: string[] = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const line = parts[i];
    if (!line.startsWith("[user] ")) break;
    const text = line.slice("[user] ".length).trim();
    if (text) mine.unshift(text);
  }
  return mine.length > MAX_SHOWN_TURNS ? mine.slice(-MAX_SHOWN_TURNS) : mine;
};

/** 다른 호출을 한 줄로 가리킬 때 — 몇 번 호출을 언제 어느 모델로 불렀는지. */
const callBrief = (id: number | null | undefined): string | null => {
  if (!id) return null;
  const row = getLlmCallBrief(id);
  return row
    ? `#${row.id} ${row.created_at.slice(11, 19)} ${shortModel(row.model)}`
    : `#${id}`;
};

// 아는 중단 사유는 한글로 옮기고, 모르는 값은 그대로 적는다.
const STOP_REASON_NAME: Record<string, string> = {
  end_turn: "할 말을 마쳤다",
  max_tokens: "상한에서 잘렸다",
  stop_sequence: "멈춤 문자열을 만났다",
  refusal: "모델이 답하기를 거절했다",
};

// 응답이 어떤 블록으로 왔고 왜 멈췄는지. 저장하는 본문은 텍스트 블록뿐이라, 출력 토큰이
// 글자 수보다 훨씬 클 때 그 몫이 생각 과정으로 갔는지 여기서 가른다. 이 값이 없는 옛 행은
// 줄을 만들지 않는다.
const shapeLine = (row: CallRow): string | null => {
  const bits: string[] = [];
  if (row.block_types) bits.push(`블록 ${esc(row.block_types)}`);
  if (row.stop_reason)
    bits.push(
      `멈춤 ${STOP_REASON_NAME[row.stop_reason] ?? esc(row.stop_reason)}`,
    );
  return bits.length ? `*응답* ${bits.join(" · ")}` : null;
};

const headLine = (row: CallRow, icon: string, label: string): string => {
  const bits = [
    `호출 #${row.id}`,
    row.created_at.slice(11, 19),
    shortModel(row.model),
  ];
  if (row.attempt > 1) bits.push(`${row.attempt}번째 시도`);
  if (row.latency_ms) bits.push(`${(row.latency_ms / 1000).toFixed(1)}초`);
  return `${icon} *${label}* · ${bits.join(" · ")}`;
};

type Block = NonNullable<NonNullable<CallContext["timing"]>["block"]>;

/** 지금 하는 일 한 줄 — 두 태그가 텀과 붙잡기 판정을 모두 정한다. */
const blockText = (b: Block): string => {
  const r = toResponsiveness(b.responsiveness);
  const c = toActivityCategory(b.category);
  const resp = r ? RESPONSIVENESS_NAME[r] : b.responsiveness;
  const cat = c ? ACTIVITY_CATEGORY_NAME[c] : b.category;
  const tail = b.fallback ? " — 각본에 이 시각 블록이 없어 잠으로 봤다" : "";
  return `${clockLabel(b.start)}~${clockLabel(b.end)} ${b.activity} [${resp}/${cat}]${tail}`;
};

/** 판정을 부르지 않은 이유 — 조건대로 걸렀는지 여기서 확인한다. */
const holdSkipReason = (t: NonNullable<CallContext["timing"]>): string => {
  if (t.path === "recover") return "복구 발송이라 텀 계산 자체를 타지 않았다";
  if (t.path === "no_plan") return "각본이 없어 지금 하는 일을 모른다";
  if (t.path === "sleeping")
    return "자는 중이라 표를 건너뛰고 깨는 대로 답한다";
  if (t.path === "already_held")
    return "이미 접어 둔 일정이라 다시 묻지 않는다";
  // 판정은 답장 불가 구간에서만, 그중에서도 접을 수 있는 일정에서만 돈다.
  const r = t.block ? toResponsiveness(t.block.responsiveness) : null;
  if (r !== "unavailable") return "답장 불가 구간이 아니다";
  const c = t.block ? toActivityCategory(t.block.category) : null;
  if (c === "official") return "공적 일정이라 접을 수 없다";
  return "판정을 부르지 않았다";
};

export const timingLines = (ctx: CallContext): string[] => {
  const t = ctx.timing;
  if (!t) {
    if (ctx.promised) {
      const activity = ctx.promised.activity ?? "하던 일";
      const start = ctx.promised.blockStart;
      return [
        `*텀* 약속 연락 — ${esc(start ? `${start} ${activity}` : activity)} 구간이 끝나 약속대로 답했다`,
        `*지킨 약속* ${esc(ctx.promised.promise ?? "")}`,
      ];
    }
    if (!ctx.gathered) return [];
    const activity = ctx.gathered.activity ?? "하던 일";
    const start = ctx.gathered.blockStart;
    const out = [
      `*텀* 몰아 답장 — ${esc(activity)} 구간이 끝나 바로 보냈다`,
      `*지금 하는 일* ${esc(start ? `${start} ${activity}` : activity)} — 방금 끝났다`,
    ];
    const waited = ctx.gathered.waitedMs;
    if (typeof waited === "number") {
      const n = ctx.userMsgs ?? 1;
      out.push(
        `*쌓인 메시지* ${esc(`${n}통 · 첫 메시지가 온 지 ${fmtWait(waited)} 만에 답한다`)}`,
      );
    }
    return out;
  }
  const out: string[] = [];
  // 도착 대기는 답장 텀 앞에 붙는 시간이다 — 텀만 보면 유저가 기다린 시간과 어긋난다.
  if (ctx.arrival) {
    const a = ctx.arrival;
    const bits = [`${fmtWait(a.waitMs)} 기다림`];
    if (a.msgs > 1) bits.push(`메시지 ${a.msgs}통`);
    bits.push(`첫 메시지로부터 ${fmtWait(a.spanMs)}`);
    out.push(`*도착 대기* ${esc(bits.join(" · "))}`);
  }
  const bits = [`${fmtWait(t.waitMs ?? 0)} 뒤`];
  if (ctx.sendAt) bits.push(`${ctx.sendAt.slice(11, 19)} 발송 예정`);
  if (t.path)
    bits.push(
      // 자는 시간에 두 번째로 온 연락이면 이미 깨어 있었다 — 텀이 짧은 이유가 여기 있다.
      t.path === "sleeping" && t.justWoke === false
        ? "자다 깨서 이어 답하는 중"
        : (PATH_NAME[t.path] ?? t.path),
    );
  out.push(`*텀* ${esc(bits.join(" · "))}`);
  out.push(
    `*지금 하는 일* ${t.block ? esc(blockText(t.block)) : "각본에 이 시각 블록이 없다"}`,
  );
  if (t.asked) {
    const ref = callBrief(t.holdCallId);
    // 판정 실패를 "아님"으로 적으면 모델이 실제로 아니라고 답한 것과 구분되지 않는다.
    const verdict = t.holdFailed
      ? ":warning: 판정 실패 — 답을 못 받아 일정을 그대로 뒀다"
      : t.heldJudged
        ? "붙잡음"
        : "아님";
    const tail = t.held ? ` → 일정 ${t.held.outcome}` : "";
    out.push(
      `*붙잡기 판정* 물었다 · ${verdict}${esc(tail)}${ref ? ` (호출 ${ref})` : ""}`,
    );
  } else {
    out.push(`*붙잡기 판정* 묻지 않음 — ${holdSkipReason(t)}`);
  }
  return out;
};

const searchLines = (ctx: CallContext): string[] => {
  const s = ctx.search;
  if (!s) return [];
  // 태그는 답장을 만들기 전에 짧은 호출이 저장된 이름 중에서 고르고, 글자가 일치하는
  // 것을 코드가 더한다. 걸린 것이 없을 때도 고를 수 있었던 수를 적어 검색이 돌았다는
  // 것을 보인다.
  const pool = s.tagPool ? ` (붙어 있는 태그 ${s.tagPool}개 중)` : "";
  const bits = [
    s.tags?.length
      ? `태그 ${s.tags.join("·")}${pool}`
      : `걸린 태그 없음${pool}`,
  ];
  if (s.tagBy === "match")
    bits.push("주제 고르기 실패 — 글자가 일치하는 태그만");
  const found = s.memories?.length ?? 0;
  bits.push(
    found ? `기억 ${found}건 — ${s.memories?.join(" / ")}` : "기억 0건",
  );
  if (s.oldDiaries?.length) bits.push(`옛 일기 ${s.oldDiaries.join("·")}`);
  if (s.schedules?.length) bits.push(`일정 ${s.schedules.join(" / ")}`);
  if (s.dropped?.length)
    bits.push(
      `개수 상한에 걸려 빠짐 ${s.dropped.length}건 — ${s.dropped.join(" / ")}`,
    );
  return [`*검색* ${esc(bits.join(" · "))}`];
};

const outcomeLines = (ctx: CallContext): string[] => {
  const out: string[] = [];
  if (ctx.bubbles)
    out.push(
      `*보낸 말* 말풍선 ${ctx.bubbles}개${ctx.bubbleLens?.length ? ` (${ctx.bubbleLens.join("·")}자)` : ""}`,
    );
  // 붙였는지 안 붙였는지를 늘 적는다 — 없을 때 줄이 사라지면 모델이 안 붙인 건지
  // 기록이 안 된 건지 구별되지 않는다.
  out.push(
    `*답장 신호* 남음 ${ctx.stay ? "붙임" : "없음"} · 서운함 ${
      ctx.userUpset ? "붙임" : "없음"
    }${ctx.outputParse ? ` · 형식 ${parseName(ctx.outputParse)}` : ""}`,
  );
  // 메모는 붙었는지와 무엇을 적었는지를 같은 줄에서 본다 — 다른 신호와 묶어 두면
  // '메모 없음' 세 글자가 줄 안에 묻혀 저장 여부를 확인하러 스레드를 뒤지게 된다.
  out.push(
    ctx.note
      ? `*오늘 메모* ${esc(clip(ctx.note, 200))}`
      : "*오늘 메모* 추가 없음",
  );
  if (ctx.promise) {
    const p = ctx.promise;
    out.push(
      p.dropped
        ? `*약속* ${esc(p.text)} — 못 걸었다: ${esc(p.dropped)}`
        : `*약속* ${esc(p.text)} → ${esc(p.sendAt ?? "")}${p.activity ? ` (${esc(p.activity)} 끝)` : ""}`,
    );
  }
  if (ctx.dayActual) {
    const d = ctx.dayActual;
    const by = d.by === "judge" ? "붙잡기 판정" : "답장의 남음 신호";
    out.push(
      `*각본과 달라진 하루* ${esc(`${d.blockStart ?? ""} ${d.activity ?? ""}`.trim())} → ${esc(d.outcome ?? "")} (${by})`,
    );
  }
  if (ctx.relUpdate) {
    const name = (v: string | null | undefined): string =>
      !v
        ? "없음"
        : v in SPEECH_LEVEL_NAME
          ? SPEECH_LEVEL_NAME[v as SpeechLevel]
          : v;
    const list = Array.isArray(ctx.relUpdate) ? ctx.relUpdate : [ctx.relUpdate];
    for (const r of list)
      out.push(
        `*관계 갱신* ${esc(r.field ?? "")} ${esc(name(r.from))} → ${esc(name(r.to))}`,
      );
  }
  if (ctx.sent) out.push(`*발송* 말풍선 ${esc(ctx.sent)} 나감 — 바로 보냈다`);
  if (ctx.dropped) out.push(`:wastebasket: *폐기* ${esc(ctx.dropped)}`);
  return out;
};

/** 이 답장 하나에 모델을 몇 번 불렀는지. 한 번이면 머리 줄이 이미 말해 준다. */
const callsLine = (row: CallRow, ctx: CallContext): string | null => {
  const parts: string[] = [];
  const hold = callBrief(ctx.timing?.holdCallId);
  if (hold) parts.push(`붙잡기 판정 ${hold}`);
  const picked = callBrief(ctx.search?.tagCallId);
  if (picked) parts.push(`주제 고르기 ${picked}`);
  parts.push(
    `답장 #${row.id} ${row.created_at.slice(11, 19)} ${shortModel(row.model)}`,
  );
  const retry = callBrief(ctx.retryCallId);
  if (retry) parts.push(`재생성 ${retry}`);
  return parts.length > 1
    ? `*모델 호출* ${parts.length}번 — ${esc(parts.join(" · "))}`
    : null;
};

export const renderReply = (row: CallRow, ctx: CallContext | null): string => {
  const lines = [headLine(row, ":speech_balloon:", "답장")];
  const asked = lastUserTurns(row.turns_hash);
  if (asked.length) {
    const n = ctx?.userMsgs ?? asked.length;
    if (n > 1) lines.push(`_유저 메시지 ${n}통을 묶어 한 번에 답한다_`);
    lines.push(asked.map((t) => quote(clip(t, 300))).join("\n>\n"));
  }
  if (ctx) {
    lines.push(...timingLines(ctx), ...searchLines(ctx));
  } else {
    lines.push("_판단 근거가 붙지 않았다 — 생성 도중 끊겼을 수 있다._");
  }
  const output = row.output_hash ? getBlob(row.output_hash) : null;
  if (output) lines.push("*모델이 쓴 답*", quote(clip(output, 700)));
  if (row.error) lines.push(`:x: *호출 실패* ${esc(row.error)}`);
  if (ctx) {
    lines.push(...outcomeLines(ctx));
    const calls = callsLine(row, ctx);
    if (calls) lines.push(calls);
  }
  const shape = shapeLine(row);
  if (shape) lines.push(shape);
  const tokens = tokenLine(row);
  if (tokens) lines.push(tokens);
  return lines.join("\n");
};

/** 첫 답이 비어 다시 부른 호출 — 답장 스레드에 딸아 붙인다. */
export const renderRetry = (row: CallRow, parent: number): string => {
  const lines = [
    `:repeat: *재생성* · 호출 #${row.id} · ${row.created_at.slice(11, 19)} · ${shortModel(row.model)} — 답장 #${parent}의 첫 답이 비어 다시 불렀다`,
  ];
  const out = row.output_hash ? getBlob(row.output_hash) : null;
  if (out) lines.push(quote(clip(out, 500)));
  if (row.error) lines.push(`:x: *호출 실패* ${esc(row.error)}`);
  const shape = shapeLine(row);
  if (shape) lines.push(shape);
  const tokens = tokenLine(row);
  if (tokens) lines.push(tokens);
  return lines.join("\n");
};

export const renderHold = (row: CallRow, ctx: CallContext | null): string => {
  const lines = [headLine(row, ":mag:", "붙잡기 판정")];
  const prompt = row.turns_hash ? getBlob(row.turns_hash) : null;
  if (prompt) lines.push(quote(clip(prompt.replaceAll("[user] ", ""), 400)));
  const block = ctx?.hold?.block;
  if (block) lines.push(`*지금 하는 일* ${esc(blockText(block))}`);
  const out = row.output_hash ? getBlob(row.output_hash) : null;
  const held = ctx?.hold?.held;
  const cat = block ? toActivityCategory(block.category) : null;
  const meant = ctx?.hold?.failed
    ? " — 답이 비어 판정을 못 받았다. 일정을 그대로 두고 구간이 끝날 때 몰아 답한다"
    : held === undefined
      ? ""
      : held
        ? cat === "personal"
          ? " — 이 일정을 취소하고 바로 답한다"
          : " — 만나기로 한 상대에게 양해를 구하고 미룬다"
        : " — 일정을 그대로 두고 구간이 끝날 때 몰아 답한다";
  lines.push(`*판정* ${out ? esc(out.trim()) : "(없음)"}${meant}`);
  if (row.error)
    lines.push(`:x: *호출 실패* ${esc(row.error)} — 일정을 그대로 둔다`);
  // 판정은 상한이 16토큰이라 생각 과정이 켜지면 그것만으로 상한을 다 쓴다 — 답이 비었을 때
  // 왜 비었는지가 이 줄에서 갈린다.
  const shape = shapeLine(row);
  if (shape) lines.push(shape);
  return lines.join("\n");
};

export const renderDraft = (row: CallRow): string => {
  const name = purposeName(row.purpose);
  const lines = [headLine(row, ":memo:", `${name} 문안`)];
  const raw = row.output_hash ? getBlob(row.output_hash) : null;
  if (raw) {
    let shown = false;
    try {
      const v = JSON.parse(raw) as { send?: boolean; text?: string };
      if (typeof v.send === "boolean") {
        lines.push(`*보낼까* ${v.send ? "보낸다" : "접는다"}`);
        if (v.text) lines.push(quote(clip(v.text, 500)));
        shown = true;
      }
    } catch {
      /* JSON이 아니면 원문 그대로 */
    }
    if (!shown) lines.push(quote(clip(raw, 500)));
  }
  if (row.error) lines.push(`:x: *호출 실패* ${esc(row.error)}`);
  const shape = shapeLine(row);
  if (shape) lines.push(shape);
  const tokens = tokenLine(row);
  if (tokens) lines.push(tokens);
  return lines.join("\n");
};

// ── 하루 고정 두 덩이의 비교 ────────────────────────────────────────────

export const LAYER_NAME = ["잘 바뀌지 않는 데이터", "하루 동안 같은 데이터"] as const;

export const lineDiff = (
  before: string,
  after: string,
  maxLines = 60,
): string => {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 250_000)
    return `(줄 수 ${a.length} → ${b.length} — 너무 커서 줄 단위 비교는 생략)`;
  const w = b.length + 1;
  const dp = new Int32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1])
      out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  if (!out.length) return "(줄 단위로는 같다 — 공백만 바뀌었다)";
  return out.length > maxLines
    ? [...out.slice(0, maxLines), `… ${out.length - maxLines}줄 더`].join("\n")
    : out.join("\n");
};

/** 프롬프트를 대괄호 머리글로 갈라 대목 이름 → 본문으로 만든다. 머리글 앞의 글은 이름 없이 담는다. */
const sectionsOf = (text: string): Map<string, string> => {
  const out = new Map<string, string>();
  let name = "";
  for (const line of text.split("\n")) {
    const head = /^\[([^\]]+)\]/.exec(line);
    if (head) name = head[1].split(" — ")[0].trim();
    out.set(name, out.has(name) ? `${out.get(name)}\n${line}` : line);
  }
  return out;
};

/** 내용이 달라진 대목의 이름. 머리글 없는 앞부분만 달라졌으면 이름을 댈 수 없어 빈 배열. */
export const changedSections = (before: string, after: string): string[] => {
  const a = sectionsOf(before);
  const b = sectionsOf(after);
  return [...new Set([...a.keys(), ...b.keys()])].filter(
    (name) => name !== "" && a.get(name) !== b.get(name),
  );
};

/** 바뀐 대목 이름을 세 개까지, 못 찾으면 덩이 이름으로. */
export const changeLabel = (names: string[], layer: 0 | 1): string => {
  if (!names.length) return LAYER_NAME[layer];
  return names.length > 3
    ? `${names.slice(0, 3).join(" · ")} 외 ${names.length - 3}곳`
    : names.join(" · ");
};
