import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

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

const textOf = (blocks: Anthropic.ContentBlock[]): string =>
  blocks
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

export const chat = async (
  system: string | SystemBlock[],
  turns: ChatTurn[],
  maxTokens = 1024,
  model = config.model,
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
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: sys,
    messages: turns,
  });
  // 캐시 효과 관측: cw=캐시 쓰기(1회성), cr=캐시 읽기(절감분), in=전액 과금분
  const u = response.usage;
  console.log(
    `[llm] ${model} in=${u.input_tokens} cw=${u.cache_creation_input_tokens ?? 0} cr=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens}`,
  );
  return textOf(response.content).trim();
};

// JSON 응답 강제 + 파싱 실패 시 1회 재시도
export const chatJson = async <T>(
  system: string,
  userPrompt: string,
  maxTokens = 2048,
  model = config.model,
): Promise<T> => {
  const ask = async (extra: string): Promise<string> =>
    chat(
      system,
      [{ role: "user", content: userPrompt + extra }],
      maxTokens,
      model,
    );

  const parse = (raw: string): T => {
    const stripped = raw
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/```\s*$/m, "")
      .trim();
    return JSON.parse(stripped) as T;
  };

  const first = await ask("\n\n반드시 JSON 하나만 출력해. 다른 텍스트 금지.");
  try {
    return parse(first);
  } catch {
    const second = await ask(
      "\n\n직전 출력이 JSON 파싱에 실패했어. 코드펜스·설명 없이 순수 JSON 객체 하나만 다시 출력해.",
    );
    return parse(second);
  }
};
