// 모델을 부르는 자리.
//
// 세 가지를 여기서 처리한다.
// - 프롬프트 앞 두 층 끝에 cache_control을 붙여 1시간 캐시를 태운다. 층을 안정도 순으로
//   쌓아 둔 이유가 여기서 값을 낸다(context.ts).
// - 호출 정보(meta)를 받으면 프롬프트와 응답 원문을 llm_calls에 적고 행 번호를 돌려준다.
//   트레이스와 피드백 수집이 그 번호로 호출을 되짚는다. 응답이 왜 멈췄고 어떤 블록으로
//   왔는지도 같은 행에 적는다 — 로그에만 두면 배포 한 번에 지워져 며칠치를 못 본다.
// - 응답 토큰과 캐시 적중(cw/cr)을 로그에 남긴다.
//
// JSON을 받아야 하는 자리는 chatJson을 쓴다. 읽지 못한 JSON은 한 번 더 부르는데, 생각 과정이
// 출력 상한을 써서 멈춘 경우면 생각 과정을 끄고 부른다(이슈 #471). 답장처럼 멈춘 이유를 부른
// 쪽이 직접 봐야 하는 자리는 chatWithStop을 쓴다.

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { recordLlmUsage, recordLlmCall } from "./db.js";
import type { CallPurpose } from "./labels.js";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

// 시스템 프롬프트를 안정도 층으로 나눠 받는다. cache=true인 블록 끝이 프롬프트 캐시 경계 —
// 캐시는 프리픽스 매칭이라 안정적인 층(바이블·규칙, 하루 단위 데이터)을 앞에 두고 경계를 걸면
// 그 앞부분 입력이 캐시 읽기(기본가의 ~0.1배)로 떨어진다. 시각처럼 매번 바뀌는 건 경계 뒤(꼬리)에.
export interface SystemBlock {
  text: string;
  cache?: boolean;
}

// 호출 하나하나를 원본 그대로 남긴다 — 답이 이상할 때 그때 무엇을 넣었는지 다시 볼 수 있게.
// 새로 만드는 호출 자리는 전부 이 값을 넘긴다. 넘기지 않으면 그 호출만 기록에서 빠진다.
export interface CallMeta {
  purpose: CallPurpose;
  characterId?: number;
  chatId?: string;
  /** 같은 자리에서 두 번 부른 경우의 차례 — JSON 재요청이 2가 된다. */
  attempt?: number;
  /** 남긴 행 번호. chat()이 채워 준다 — 뒤에 판단 근거를 붙일 때 쓴다. */
  callId?: number;
}

// 호출 하나에만 거는 선택지. 모델 기본값을 바꾸는 자리라, 넘기지 않으면 지금까지와 같다.
export interface ChatOptions {
  /**
   * 생각 과정을 쓸 것인가. sonnet은 이 값을 넘기지 않으면 상황에 따라 생각을 켜고 그 몫이
   * 출력 토큰으로 나가서, 상한이 낮은 호출은 상한을 생각에 다 쓰고 답이 통째로 빌 수 있다.
   * 붙잡기 판정(16토큰)·태그 고르기(128토큰)처럼 한 줄만 받는 호출에서 false로 끈다.
   * 생각 과정이 상한을 써서 답을 읽지 못한 호출을 다시 부를 때도 끈다(chatJson, 답장 재요청).
   */
  think?: boolean;
}

/** 응답 본문과 모델이 멈춘 이유. 상한에 닿아 멈췄으면 stopReason이 "max_tokens"다. */
export interface ChatStop {
  text: string;
  stopReason: string | null;
  /** 응답에 생각 블록이 있었는지. 상한에 닿은 몫이 생각 과정 때문인지 가르는 데 쓴다. */
  thought: boolean;
}

/**
 * 생각 과정이 출력 상한을 써서 멈춘 응답인지. 이런 응답만 생각을 끄고 다시 부른다 — 생각 블록
 * 없이 상한에 닿았으면 생각을 꺼도 같은 요청이라 같은 길이에서 또 잘린다.
 */
export const cutByThinking = (s: ChatStop): boolean =>
  s.stopReason === "max_tokens" && s.thought;

// 지금 도는 코드가 어느 판인지. 컨테이너에는 .git이 없고 src만 들어오므로(Dockerfile),
// 커밋 해시 대신 src 파일 내용으로 만든 지문을 적는다. 배포 전후를 가르는 데 쓴다.
let codeFingerprint: string | null = null;
const codeVersion = (): string => {
  if (codeFingerprint) return codeFingerprint;
  try {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const h = createHash("sha256");
    for (const f of readdirSync(dir)
      .filter((n) => n.endsWith(".ts"))
      .sort()) {
      h.update(f);
      h.update(readFileSync(join(dir, f)));
    }
    codeFingerprint = h.digest("hex").slice(0, 12);
  } catch {
    codeFingerprint = "unknown";
  }
  return codeFingerprint;
};

export const textOf = (blocks: Anthropic.ContentBlock[]): string =>
  blocks
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

// 응답이 어떤 블록으로 왔는지 종류별 개수(예: `text:1` · `thinking:1,text:1`).
// 저장하는 본문은 textOf가 고른 텍스트 블록뿐이라, 다른 종류로 나간 몫은 출력 토큰에만 남고
// 글자 수에는 잡히지 않는다. 그 차이가 어디서 오는지 보려고 로그에 함께 적는다(이슈 #165).
export const blockTypes = (blocks: Anthropic.ContentBlock[]): string => {
  const count = new Map<string, number>();
  for (const b of blocks) count.set(b.type, (count.get(b.type) ?? 0) + 1);
  return [...count].map(([type, n]) => `${type}:${n}`).join(",") || "none";
};

// 모델을 한 번 부르고 본문과 멈춘 이유를 함께 돌려준다. 멈춘 이유는 호출 행에도 적힌다.
export const chatWithStop = async (
  system: string | SystemBlock[],
  turns: ChatTurn[],
  maxTokens = 1024,
  model = config.model,
  meta?: CallMeta,
  opts?: ChatOptions,
): Promise<ChatStop> => {
  // TTL 1시간: 대화는 답장 텀이 10~30분씩 벌어지는 게 보통이라 5분 캐시는 그 사이 증발한다.
  // 1시간 쓰기는 2배지만 저녁 대화 내내 읽기(0.1배)로 회수 — 3회 이상 재사용이면 이득.
  const sys =
    typeof system === "string"
      ? system
      : system.map((b) => ({
          type: "text" as const,
          text: b.text,
          ...(b.cache
            ? {
                cache_control: {
                  type: "ephemeral" as const,
                  ttl: "1h" as const,
                },
              }
            : {}),
        }));
  const blocks: SystemBlock[] =
    typeof system === "string" ? [{ text: system }] : system;
  const turnsText = turns.map((t) => `[${t.role}] ${t.content}`).join("\n");
  const started = Date.now();

  // 호출 원본을 남긴다. 기록이 실패해도 대화는 그대로 간다.
  const keep = (row: {
    output?: string;
    usage?: {
      input: number;
      cacheWrite: number;
      cacheRead: number;
      output: number;
    };
    error?: string;
    stopReason?: string;
    blockTypes?: string;
  }): void => {
    if (!meta) return;
    try {
      meta.callId = recordLlmCall({
        purpose: meta.purpose,
        model,
        characterId: meta.characterId,
        chatId: meta.chatId,
        maxTokens,
        attempt: meta.attempt,
        system: blocks,
        turns: turnsText,
        latencyMs: Date.now() - started,
        codeVersion: codeVersion(),
        ...row,
      });
    } catch (e) {
      console.error("[llm] 호출 기록 실패:", e);
    }
  };

  // 생각 과정은 끄는 호출만 값을 싣는다 — 값이 없으면 모델 기본값 그대로다.
  const thinking: Anthropic.ThinkingConfigParam | undefined =
    opts?.think === false ? { type: "disabled" } : undefined;

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: sys,
      messages: turns,
      thinking,
    });
  } catch (e) {
    keep({ error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
  // 캐시 효과 관측: cw=캐시 쓰기(1회성), cr=캐시 읽기(절감분), in=전액 과금분.
  // 로그와 별개로 논리일 단위 DB 누적(llm_usage) — 사람이 로그를 뒤지지 않아도 확인 가능하게.
  const u = response.usage;
  const out = textOf(response.content).trim();
  const shape = {
    stopReason: response.stop_reason ?? undefined,
    blockTypes: blockTypes(response.content),
  };
  // 출력 토큰이 저장된 글자 수보다 훨씬 크게 잡히는 호출이 있어(08-30 관측: 답장 1,200토큰에
  // 144자, 판정 16토큰에 0자) 그 몫이 어디로 갔는지 같은 줄에서 보이게 한다 — 블록 종류와
  // 멈춘 이유, 저장되는 글자 수. purpose를 앞에 적어 어느 호출인지 바로 찾게 한다.
  // 같은 두 값을 llm_calls에도 적는다(아래 keep) — 로그는 배포 한 번에 지워진다(#218).
  console.log(
    `[llm] ${meta?.purpose ?? "unknown"} ${model} in=${u.input_tokens} cw=${u.cache_creation_input_tokens ?? 0} cr=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens} chars=${[...out].length} blocks=${shape.blockTypes} stop=${shape.stopReason ?? "none"}`,
  );
  try {
    recordLlmUsage(
      model,
      u.input_tokens,
      u.cache_creation_input_tokens ?? 0,
      u.cache_read_input_tokens ?? 0,
      u.output_tokens,
    );
  } catch {
    /* 사용량 기록 실패가 대화를 막지 않는다 */
  }
  keep({
    ...shape,
    output: out,
    usage: {
      input: u.input_tokens,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      output: u.output_tokens,
    },
  });
  return {
    text: out,
    stopReason: response.stop_reason ?? null,
    thought: response.content.some(
      (b) => b.type === "thinking" || b.type === "redacted_thinking",
    ),
  };
};

// 본문만 필요한 자리. 인자는 chatWithStop과 같다.
export const chat = async (
  system: string | SystemBlock[],
  turns: ChatTurn[],
  maxTokens = 1024,
  model = config.model,
  meta?: CallMeta,
  opts?: ChatOptions,
): Promise<string> =>
  (await chatWithStop(system, turns, maxTokens, model, meta, opts)).text;

/** JSON을 달라는 요청 끝에 붙이는 문구. */
export const JSON_ASK = "\n\n반드시 JSON 하나만 출력해. 다른 텍스트 금지.";
/** 첫 응답이 형식 때문에 읽히지 않았을 때 다시 부르며 붙이는 문구. */
export const JSON_RETRY_ASK =
  "\n\n직전 출력이 JSON 파싱에 실패했어. 코드펜스·설명 없이 순수 JSON 객체 하나만 다시 출력해.";

/** JSON 요청을 한 번 보내는 자리. extra는 요청 끝에 붙일 문구다. */
export type JsonAskOnce = (
  extra: string,
  attempt: number,
  opts?: ChatOptions,
) => Promise<ChatStop>;

export const parseJson = <T>(raw: string): T => {
  const stripped = raw
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/```\s*$/m, "")
    .trim();
  return JSON.parse(stripped) as T;
};

// JSON을 받고, 읽지 못하면 한 번 더 부른다. 모델을 부르는 일은 넘겨받아서 모델 없이도
// 어느 문구와 선택지로 다시 불렀는지 검사할 수 있다(test/llm-json-retry.test.ts).
// 생각 블록이 있고 상한에 닿아 멈춘 응답은 생각 과정이 상한을 거의 다 써서 JSON이 비었거나
// 중간에 잘린 경우라, 형식을 다시 일러도 같은 상한에서 또 잘린다. 그때는 같은 요청을 생각
// 과정만 끄고 다시 보낸다. 생각 블록 없이 상한에 닿았거나 형식이 틀린 응답은 형식을 다시
// 일러 부른다. 상한에 닿았어도 JSON을 읽었으면 그대로 쓴다.
export const askJson = async <T>(once: JsonAskOnce): Promise<T> => {
  const first = await once(JSON_ASK, 1);
  try {
    return parseJson<T>(first.text);
  } catch {
    const second = cutByThinking(first)
      ? await once(JSON_ASK, 2, { think: false })
      : await once(JSON_RETRY_ASK, 2);
    return parseJson<T>(second.text);
  }
};

// JSON 응답 강제 + 읽기 실패 시 1회 재시도(askJson).
// system은 chat과 같은 형태를 받는다 — SystemBlock[]로 주면 캐시 경계가 대화 경로와 같이 걸려,
// 선톡 문안처럼 3층 프롬프트를 그대로 쓰는 호출이 캐시를 공유한다.
export const chatJson = async <T>(
  system: string | SystemBlock[],
  userPrompt: string,
  maxTokens = 2048,
  model = config.model,
  meta?: CallMeta,
): Promise<T> =>
  // 재요청은 호출 원본에 별개의 행으로 남는다(attempt=2) — 무엇을 다시 물었는지가 보여야
  // JSON이 깨진 자리를 찾을 수 있다. 부른 쪽이 들고 있는 meta에는 마지막 행 번호를 돌려준다.
  askJson<T>(async (extra, attempt, opts) => {
    const sub = meta ? { ...meta, attempt } : undefined;
    const out = await chatWithStop(
      system,
      [{ role: "user", content: userPrompt + extra }],
      maxTokens,
      model,
      sub,
      opts,
    );
    if (meta && sub) meta.callId = sub.callId;
    return out;
  });
