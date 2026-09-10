// 환경변수를 한 번 읽어 두는 자리.
//
// 프로세스가 사는 동안 바뀌지 않는 값만 담는다 — 텔레그램 토큰, 모델 API 키, 쓸 모델 이름,
// DB 경로, 슬랙 채널. 값을 쓰는 쪽이 process.env를 직접 읽지 않게 해서, 이름을 바꿀 때
// 고칠 자리가 여기 하나가 된다.
//
// 토큰을 가리는 함수(redactToken)도 여기 둔다 — 콘솔과 슬랙 두 곳이 같은 규칙으로 가려야
// 하는데, 규칙을 두 파일에 적어 두면 한쪽만 고쳐진다.

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
  // 유저 프로필 중 성별·나이대 — 가입 절차 전 단계라 env로 미리 주입할 수 있다(단일 유저 PoC).
  // 안 넣으면 미상으로 두고 대화로 알아간다. 하는 일·사는 지역은 env가 없고, 대화에서 드러나면
  // 새벽 정리가 채운다. 이름은 다루지 않는다(호칭은 대화에 맡긴다 — user-profile.ts 참고).
  userProfile: {
    gender: process.env.USER_GENDER?.trim() || undefined,
    ageBand: process.env.USER_AGE_BAND?.trim() || undefined,
  },
  // 슬랙 트레이스 채널(trace.ts) — 둘 다 있어야 게시가 켜진다. 없으면 기능 전체가 no-op.
  slackBotToken: process.env.SLACK_BOT_TOKEN?.trim() || undefined,
  slackTraceChannel: process.env.SLACK_TRACE_CHANNEL?.trim() || undefined,
};

// 밖으로 나가는 글에서 봇 토큰을 가린다 — 콘솔 로그(bot.ts logErr)와 슬랙 게시(trace.ts)가
// 쓴다. 외부 라이브러리가 에러에 요청 정보를 담을 수 있어, 값 자체와 토큰 형태 둘 다 가린다.
// 토큰을 갖고 있는 이 파일에 두어야 두 자리가 같은 규칙을 쓴다.
export const redactToken = (s: string): string =>
  s
    .split(config.telegramToken)
    .join("<TOKEN>")
    .replace(/\d{6,}:[A-Za-z0-9_-]{30,}/g, "<TOKEN>");
