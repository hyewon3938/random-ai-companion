import { Bot } from "grammy";
import { config } from "./config.js";
import { createCharacter, type Bible } from "./character.js";
import { buildSystemPrompt } from "./context.js";
import { chat, type ChatTurn } from "./llm.js";
import {
  getActiveCharacter,
  getRecentMessages,
  getRelationshipState,
  logMessage,
} from "./db.js";
import { getKstNow } from "./kst.js";

export const bot = new Bot(config.telegramToken);

const nowIso = (): string =>
  getKstNow().toISOString().replace("T", " ").slice(0, 19);

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// 연속 동일 role 메시지 병합 (API는 user/assistant 교대를 기대)
const toTurns = (rows: { role: string; text: string }[]): ChatTurn[] => {
  const turns: ChatTurn[] = [];
  for (const row of rows) {
    const role = row.role === "user" ? "user" : "assistant";
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += `\n${row.text}`;
    else turns.push({ role, content: row.text });
  }
  if (turns[0]?.role === "assistant")
    turns.unshift({ role: "user", content: "(대화 시작)" });
  return turns;
};

bot.command("start", async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (getActiveCharacter(chatId)) {
    await ctx.reply("이미 연결된 상대가 있어. 그냥 말을 걸면 돼.");
    return;
  }
  await ctx.reply("누군가와 연결해줄게. 어떤 사람인지는 대화하면서 알아가.");
  await ctx.replyWithChatAction("typing");
  // TODO(온보딩 시드): 나이대·직업 분야·관심사 1개 문답 후 seedNote로 전달
  const { id, bible } = await createCharacter(chatId);
  await sleep(1500);
  await ctx.reply(bible.first_greeting);
  logMessage(chatId, id, "char", bible.first_greeting, nowIso(), {
    first: true,
  });
});

// TODO(D1 전): /새로만나기 — 비가역 확인 → 아카이브 → "어떤 점이 아쉬웠어?" → user_preferences 반영 → 신규 매칭

bot.on("message:text", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const character = getActiveCharacter(chatId);
  if (!character) {
    await ctx.reply("아직 연결된 상대가 없어. /start 로 시작해줘.");
    return;
  }
  logMessage(chatId, character.id, "user", ctx.message.text, nowIso());

  await ctx.replyWithChatAction("typing");
  const bible = JSON.parse(character.bible_json) as Bible;
  const state = getRelationshipState(character.id);
  const system = buildSystemPrompt(character.id, bible, state);
  const turns = toTurns(getRecentMessages(chatId, 40));

  const reply = await chat(system, turns);
  // TODO(리듬): 1~3 버블 분할 발화 + 버블별 typing + 유저 길이 미러링
  await sleep(1000 + Math.random() * 2000);
  await ctx.reply(reply);
  logMessage(chatId, character.id, "char", reply, nowIso());
});

bot.catch((err) => {
  console.error("[bot] error:", err.error);
});
