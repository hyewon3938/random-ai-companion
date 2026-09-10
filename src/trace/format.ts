// 슬랙 게시 문안이 공통으로 쓰는 표기 도우미 — 이스케이프·날짜·자르기·인용·토큰 줄.
//
// 게시함(trace.ts)·아침 각본 게시·답장 게시·새벽 정리 게시가 같은 문안 규칙을 쓴다.
// 여기는 문자열만 만드는 순수 함수와 이름표를 두고, DB나 게시함은 부르지 않는다 —
// trace.ts가 이 파일을 쓰므로 거꾸로 trace.ts를 들여오면 순환이 된다.

import {
  CALL_PURPOSE_NAME,
  PROACTIVE_KIND_NAME,
  type CallPurpose,
} from "../labels.js";
import { getKstNow } from "../kst.js";

// 슬랙 표기 규칙 — &·<·>는 링크·멘션 문법과 겹쳐 그대로 보내면 깨진다.
export const esc = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"] as const;

export const dateLabel = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${DAY_NAMES[d.getUTCDay()]})`;
};

// 슬랙 메시지 한 개 상한(4000자)보다 여유 있게 자른다. 프롬프트 전문이 대상이다.
export const CHUNK = 3500;
export const chunked = (s: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += CHUNK) out.push(s.slice(i, i + CHUNK));
  return out;
};

export const clip = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n)}… (${s.length}자)`;

export const quote = (s: string): string =>
  s
    .split("\n")
    .map((l) => `> ${esc(l)}`)
    .join("\n");

export const shortModel = (m: string): string => m.replace(/^claude-/, "");

export const purposeName = (p: string): string =>
  p in CALL_PURPOSE_NAME ? CALL_PURPOSE_NAME[p as CallPurpose] : p;

/** 지금 KST 시각을 HH:MM:SS로. 발송·폐기처럼 게시 시점을 적는 자리가 쓴다. */
export const clock = (): string => getKstNow().toISOString().slice(11, 19);

/** llm_calls 행 하나를 가리키는 게시함 키. 답장 게시가 스레드 부모로 쓴다. */
export const callKey = (id: number): string => `call:${id}`;

/** 발송 종류의 이름. 먼저 거는 연락은 labels.ts의 목록을 그대로 쓰고, 답장·복구처럼
 *  선톡이 아닌 종류만 여기서 더한다 — 두 곳에 적어 두면 종류가 늘 때 한쪽만 빠진다. */
export const SEND_KIND_NAME: Record<string, string> = {
  ...PROACTIVE_KIND_NAME,
};

/** 토큰 네 칸만 있으면 어느 호출 행이든 받는다 — 전체 행과 요약 행이 같은 줄을 쓴다. */
export type TokenCounts = {
  input_tokens: number | null;
  cache_write_tokens: number | null;
  cache_read_tokens: number | null;
  output_tokens: number | null;
};

export const tokenLine = (row: TokenCounts): string | null => {
  const bits: string[] = [];
  if (row.input_tokens) bits.push(`입력 ${row.input_tokens.toLocaleString()}`);
  if (row.cache_write_tokens)
    bits.push(`캐시 쓰기 ${row.cache_write_tokens.toLocaleString()}`);
  if (row.cache_read_tokens)
    bits.push(`캐시 읽기 ${row.cache_read_tokens.toLocaleString()}`);
  if (row.output_tokens)
    bits.push(`출력 ${row.output_tokens.toLocaleString()}`);
  return bits.length ? `*토큰* ${bits.join(" · ")}` : null;
};
