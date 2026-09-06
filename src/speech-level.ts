// 지금 이 관계가 반말인지 존댓말인지 — 최근 캐릭터 답장의 종결어미로 판정한다.
//
// 반말 전환이 명시 상태로 저장돼 있지 않아, 선톡·팔로업 등 최근 대화를 안 보는 경로가
// 씨앗 말투(존댓말)로 되돌아가는 회귀를 막기 위한 힌트다. 표본이 적으면 null(판단 보류).
// 선톡은 표본에서 뺀다 — 선톡이 존댓말로 잘못 나가면 그게 판정을 존댓말로 오염시켜 다음
// 선톡도 존댓말이 되는 악순환을 막는다. 저장값(relationships.speech_level)이 있으면 그쪽이
// 먼저고, 이 판정은 없을 때만 쓴다(context.ts).

import { recentReplyTexts } from "./db.js";

export type SpeechLevelGuess = "반말" | "존댓말" | null;

const SAMPLE = 14;
const MIN_SAMPLE = 3;

const JON =
  /(요|에요|예요|세요|까요|네요|어요|아요|죠|습니다|ㅂ니다|십시오)[?!~.… ]*$/;
const BAN =
  /(어|아|지|자|래|니|봐|줘|거든|거야|잖아|는데|던데|더라|을게|ㄹ게|야|음)[?!~.… ]*$/;

/** 답장 본문 목록의 마지막 줄 어미를 세어 판정한다. 표본이 MIN_SAMPLE보다 적으면 null. */
export const speechLevelOf = (texts: readonly string[]): SpeechLevelGuess => {
  let jon = 0;
  let ban = 0;
  for (const text of texts) {
    const last =
      text
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .pop() ?? "";
    if (JON.test(last)) jon++;
    else if (BAN.test(last)) ban++;
  }
  if (jon + ban < MIN_SAMPLE) return null;
  return ban > jon ? "반말" : "존댓말";
};

export const currentSpeechLevel = (chatId: string): SpeechLevelGuess =>
  speechLevelOf(recentReplyTexts(chatId, SAMPLE));
