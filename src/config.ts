import "dotenv/config";

const requireEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`missing env: ${key}`);
  return value;
};

export const config = {
  telegramToken: requireEnv("TELEGRAM_BOT_TOKEN"),
  anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
  model: process.env.MODEL ?? "claude-sonnet-5",
  dbPath: process.env.DB_PATH ?? "./data/companion.db",
};
