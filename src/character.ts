import { chatJson } from "./llm.js";
import { getKstNow, kstDateString } from "./kst.js";
import { insertCharacter } from "./db.js";

// 케미 축: 코드에서 뽑아 프롬프트에 명시 주입 (LLM에 맡기면 평균으로 수렴함)
// docs/character-design.md §2가 원본
export interface Chemistry {
  warmth: string;
  humor: string;
  mode: string;
  rhythm: string;
  richness: string;
}

const AXES: Record<keyof Chemistry, string[]> = {
  warmth: ["다정다감", "은근한 다정", "담백"],
  humor: ["장난꾸러기", "잔잔한 위트", "진지"],
  mode: ["경청형", "균형", "질문형"],
  rhythm: ["속사포", "보통", "느긋"],
  richness: ["디테일러", "보통", "미니멀"],
};

export interface Bible {
  identity: { name: string; age_band: string; job: string; living: string };
  backstory: { family: string; wound: string; story_seeds: string[] };
  tastes: string[];
  voice: { laugh: string; emoji_level: string; tic: string; ending: string };
  chemistry: Chemistry;
  life: { weekly: { day: string; activity: string }[]; current_arc: string };
  first_greeting: string;
}

const pick = <T>(arr: T[]): T =>
  arr[Math.floor(Math.random() * arr.length)] as T;

// TODO(선호 학습): user_preferences.chemistry_weights 가중 샘플링으로 교체
export const rollChemistry = (): Chemistry => ({
  warmth: pick(AXES.warmth),
  humor: pick(AXES.humor),
  mode: pick(AXES.mode),
  rhythm: pick(AXES.rhythm),
  richness: pick(AXES.richness),
});

const BIBLE_SYSTEM = `너는 대화형 캐릭터의 설정(바이블)을 만드는 작가다. 과장된 픽션 캐릭터가 아니라, 실제로 존재할 법한 평범하고 구체적인 한국의 30대 전후 사람을 만든다. 장르물 문법(재벌·아이돌·판타지)은 금지. 생활의 결이 느껴지는 디테일로.`;

const biblePrompt = (
  chemistry: Chemistry,
  seedNote: string,
): string => `아래 제약으로 인물 하나를 JSON으로 생성해.

[케미 축 — 반드시 이 값 그대로]
${JSON.stringify(chemistry, null, 2)}

[시드 참고 — 관심사에 접점 1개만 반영, 나머지는 낯설게]
${seedNote || "(없음 — 전부 자유롭게)"}

[필수 JSON 구조]
{
  "identity": { "name": "자연스러운 한국 이름", "age_band": "예: 30대 초반", "job": "구체적 직업", "living": "사는 모양 한 줄" },
  "backstory": { "family": "한 줄", "wound": "깊은 서사 1개 (관계 중반 이후에만 공개될 것)", "story_seeds": ["진행 중인 근황 2개"] },
  "tastes": ["취향 3개"],
  "voice": { "laugh": "ㅋㅋ|ㅎㅎ|하하 중 1", "emoji_level": "안 씀|가끔|자주 중 1", "tic": "입버릇 맞장구 1개", "ending": "종결어미 습관 한 줄" },
  "chemistry": (위 케미 축 그대로),
  "life": { "weekly": [{ "day": "요일", "activity": "고정 활동" }, ...2~3개], "current_arc": "요즘의 진행형 사건 한 줄" },
  "first_greeting": "이 인물이 낯선 상대에게 처음 보내는 메신저 인사 1~2문장. 존댓말. 자기 정보는 이름 정도만."
}`;

export const createCharacter = async (
  chatId: string,
  seedNote = "",
): Promise<{ id: number; bible: Bible }> => {
  const chemistry = rollChemistry();
  const bible = await chatJson<Bible>(
    BIBLE_SYSTEM,
    biblePrompt(chemistry, seedNote),
  );
  bible.chemistry = chemistry;
  const id = insertCharacter(
    chatId,
    JSON.stringify(bible),
    `${kstDateString()} ${getKstNow().toISOString().slice(11, 19)}`,
  );
  return { id, bible };
};
