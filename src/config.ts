import "dotenv/config";

const requireEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`missing env: ${key}`);
  return value;
};

export const config = {
  telegramToken: requireEnv("TELEGRAM_BOT_TOKEN"),
  anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
  // 실시간 대화: 매 메시지 호출이라 속도·비용 균형이 중요 — sonnet
  model: process.env.MODEL ?? "claude-sonnet-5",
  // 하루 단위 생성(일기·추출·각본·아크·캐릭터 생성): 하루 몇 콜뿐이고 품질이 기억·삶의 정확도 — opus
  // (밤 정리는 기본적으로 외부 scheduled task(구독)가 수행하고, 이 모델은 API 폴백 경로에서 쓰인다)
  modelDeep: process.env.MODEL_DEEP ?? "claude-opus-4-8",
  dbPath: process.env.DB_PATH ?? "./data/companion.db",
  // 유저 프로필(성별·나이대) — 매칭/온보딩 전 단계라 env로 미리 주입할 수 있다(단일 유저 PoC).
  // 안 넣으면 밤 정리가 대화로 학습한다. 이름은 다루지 않는다(호칭은 대화에 맡긴다 — user-profile.ts 참고).
  userProfile: {
    gender: process.env.USER_GENDER?.trim() || undefined,
    ageBand: process.env.USER_AGE_BAND?.trim() || undefined,
  },
  // 슬랙 트레이스 채널(viz.ts) — 둘 다 있어야 게시가 켜진다. 없으면 기능 전체가 no-op.
  slackBotToken: process.env.SLACK_BOT_TOKEN?.trim() || undefined,
  slackVizChannel: process.env.SLACK_VIZ_CHANNEL?.trim() || undefined,
};
