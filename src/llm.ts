import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

const textOf = (blocks: Anthropic.ContentBlock[]): string =>
  blocks
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

export const chat = async (
  system: string,
  turns: ChatTurn[],
  maxTokens = 1024,
): Promise<string> => {
  const response = await client.messages.create({
    model: config.model,
    max_tokens: maxTokens,
    system,
    messages: turns,
  });
  return textOf(response.content).trim();
};

// JSON 응답 강제 + 파싱 실패 시 1회 재시도
export const chatJson = async <T>(
  system: string,
  userPrompt: string,
  maxTokens = 2048,
): Promise<T> => {
  const ask = async (extra: string): Promise<string> =>
    chat(system, [{ role: "user", content: userPrompt + extra }], maxTokens);

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
