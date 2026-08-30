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
   */
  think?: boolean;
}

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

const textOf = (blocks: Anthropic.ContentBlock[]): string =>
  blocks
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

// 응답이 어떤 블록으로 왔는지 종류별 개수(예: `text:1` · `thinking:1,text:1`).
// 저장하는 본문은 textOf가 고른 텍스트 블록뿐이라, 다른 종류로 나간 몫은 출력 토큰에만 남고
// 글자 수에는 잡히지 않는다. 그 차이가 어디서 오는지 보려고 로그에 함께 적는다(이슈 #165).
const blockTypes = (blocks: Anthropic.ContentBlock[]): string => {
  const count = new Map<string, number>();
  for (const b of blocks) count.set(b.type, (count.get(b.type) ?? 0) + 1);
  return [...count].map(([type, n]) => `${type}:${n}`).join(",") || "none";
};

export const chat = async (
  system: string | SystemBlock[],
  turns: ChatTurn[],
  maxTokens = 1024,
  model = config.model,
  meta?: CallMeta,
  opts?: ChatOptions,
): Promise<string> => {
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
  // 출력 토큰이 저장된 글자 수보다 훨씬 크게 잡히는 호출이 있어(08-30 관측: 답장 1,200토큰에
  // 144자, 판정 16토큰에 0자) 그 몫이 어디로 갔는지 같은 줄에서 보이게 한다 — 블록 종류와
  // 멈춘 이유, 저장되는 글자 수. purpose를 앞에 적어 어느 호출인지 바로 찾게 한다.
  console.log(
    `[llm] ${meta?.purpose ?? "unknown"} ${model} in=${u.input_tokens} cw=${u.cache_creation_input_tokens ?? 0} cr=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens} chars=${[...out].length} blocks=${blockTypes(response.content)} stop=${response.stop_reason ?? "none"}`,
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
    output: out,
    usage: {
      input: u.input_tokens,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      output: u.output_tokens,
    },
  });
  return out;
};

// JSON 응답 강제 + 파싱 실패 시 1회 재시도.
// system은 chat과 같은 형태를 받는다 — SystemBlock[]로 주면 캐시 경계가 대화 경로와 같이 걸려,
// 선톡 문안처럼 3층 프롬프트를 그대로 쓰는 호출이 캐시를 공유한다.
export const chatJson = async <T>(
  system: string | SystemBlock[],
  userPrompt: string,
  maxTokens = 2048,
  model = config.model,
  meta?: CallMeta,
): Promise<T> => {
  // 재요청은 호출 원본에 별개의 행으로 남는다(attempt=2) — 무엇을 다시 물었는지가 보여야
  // JSON이 깨진 자리를 찾을 수 있다. 부른 쪽이 들고 있는 meta에는 마지막 행 번호를 돌려준다.
  const ask = async (extra: string, attempt: number): Promise<string> => {
    const sub = meta ? { ...meta, attempt } : undefined;
    const out = await chat(
      system,
      [{ role: "user", content: userPrompt + extra }],
      maxTokens,
      model,
      sub,
    );
    if (meta && sub) meta.callId = sub.callId;
    return out;
  };

  const parse = (raw: string): T => {
    const stripped = raw
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/```\s*$/m, "")
      .trim();
    return JSON.parse(stripped) as T;
  };

  const first = await ask("\n\n반드시 JSON 하나만 출력해. 다른 텍스트 금지.", 1);
  try {
    return parse(first);
  } catch {
    const second = await ask(
      "\n\n직전 출력이 JSON 파싱에 실패했어. 코드펜스·설명 없이 순수 JSON 객체 하나만 다시 출력해.",
      2,
    );
    return parse(second);
  }
};
