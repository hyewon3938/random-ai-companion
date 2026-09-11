// 캐릭터를 만드는 자리.
//
// 지금 대화에 붙어 있는 것은 유저가 적은 입력으로 만드는 길이다. 봇의 /start가
// createUserCharacter를 부르고, 파일로 실행할 때는 tools/create-character.ts를 쓴다.
//   inputProblem     — 모델을 부르기 전에 입력을 거른다. 선택지 다섯(성별·나이대·말투·
//                      원하는 방식·결점)과 서술형 셋(성격·출발 설정에 덧붙일 것·바라는 모습).
//   generateGenesis  — 첫 호출. 정체성·주변 인물·진행 중인 일·관계 첫 값·첫 인사를 한 번에
//                      짓고, genesisProblem으로 검증해 어긋나면 한 번 다시 부른다.
//   persistGenesis   — 트랜잭션 하나로 genesis_json{v:3}·creation 기억 행·관계 첫 값을 쓴다.
//                      원하는 방식과 결점은 모델이 아니라 코드가 relationship.md §2의 문안으로
//                      정체성 행 둘(태도/원하는 방식·태도/결점)을 만든다.
//   ensureArcs       — arcs.ts의 것. 지은 재료(arcMaterial)로 아크를 만든다.
//   character_start  — 만들고 나면 슬랙에 생성 게시 한 건을 남긴다.
//
// 출발 설정은 고정이다 — 소개로 만나 몇 번 본 사이, 캐릭터가 먼저 빠진 상태, 관계 단계 1.
// 랜덤 생성 코드(createCharacter)는 나중에 쓸 자리가 있어 지우지 않고 둔다.

import { chatJson } from "./llm.js";
import { config } from "./config.js";
import { getKstNow, kstDateString } from "./kst.js";
import {
  db,
  getStage,
  insertCharacter,
  getUserProfileFull,
  saveRelationshipFirstValues,
  type UserProfileFull,
} from "./db.js";
import {
  FLAW_NAME,
  LEAD_TONE_NAME,
  RELATIONSHIP_STAGE_NAME,
  SPEECH_LEVEL_NAME,
  type Flaw,
  type LeadTone,
  type SpeechLevel,
} from "./labels.js";
import { ensureCoreAreas, keyProblem, saveCreationMemory } from "./memory.js";
import { ensureArcs } from "./arcs.js";
import { recordTraceEvent } from "./trace.js";

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
  voice: { laugh: string; tic: string; ending: string };
  chemistry: Chemistry;
  manner?: string;
  life: { weekly: { day: string; activity: string }[]; current_arc: string };
  first_greeting: string;
}

const pick = <T>(arr: T[]): T =>
  arr[Math.floor(Math.random() * arr.length)] as T;

// TODO(선호 학습): 유저가 잘 맞아 하는 축에 가중치를 둔 샘플링으로 교체
export const rollChemistry = (): Chemistry => ({
  warmth: pick(AXES.warmth),
  humor: pick(AXES.humor),
  mode: pick(AXES.mode),
  rhythm: pick(AXES.rhythm),
  richness: pick(AXES.richness),
});

const BIBLE_SYSTEM = `너는 대화형 캐릭터의 설정(바이블)을 만드는 작가다. 과장된 픽션 캐릭터가 아니라, 실제로 존재할 법한 평범하고 구체적인 한국 사람을 만든다. 장르물 문법(재벌·아이돌·판타지)은 금지. 생활의 결이 느껴지는 디테일로.`;

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
  "voice": { "laugh": "ㅋㅋㅋ|ㅎㅎ|하하 중 1", "tic": "입버릇 맞장구 1개", "ending": "종결어미 습관 한 줄" },
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
    2048,
    config.modelDeep,
    { purpose: "bible", chatId },
  );
  bible.chemistry = chemistry;
  const id = insertCharacter(
    chatId,
    JSON.stringify(bible),
    `${kstDateString()} ${getKstNow().toISOString().slice(11, 19)}`,
  );
  return { id, bible };
};

// ── V2·V3: 유저 입력 캐릭터 생성 ──────────────────────────────────────────
// 랜덤 매칭 대신 유저가 선택지 다섯(성별·나이대·말투·원하는 방식·결점)과 서술형 셋(성격·
// 출발 설정에 덧붙일 것·바라는 모습)으로 캐릭터를 만든다. 호출은 두 번 — 첫 호출이
// 정체성·주변 인물·진행 중인 일·관계 첫 값을 한 번에 만들고, 두 번째는 아크 코드(arcs.ts의
// ensureArcs)가 삶의 흐름을 쓴다.
// 유저가 적은 입력과 만들어진 결과는 characters.genesis_json에 원본 그대로 보관한다.
// 대화와 새벽 정리는 이 원본을 읽지 않는다 — 실제 읽는 자리는 기억 행(memory_items
// origin=creation)과 relationships의 관계 컬럼이다.

export const CHARACTER_GENDERS = ["남성", "여성"] as const;
export type CharacterGender = (typeof CHARACTER_GENDERS)[number];

// 나이대 선택지. 성인만 만들 수 있게 목록이 20대에서 시작한다.
export const CHARACTER_AGE_BANDS = [
  "20대 초반",
  "20대 중반",
  "20대 후반",
  "30대 초반",
  "30대 중반",
  "30대 후반",
  "40대 초반",
  "40대 중반",
  "40대 후반",
] as const;

export const FREE_TEXT_MAX = 1000;

export const SPEECH_LEVELS = Object.keys(SPEECH_LEVEL_NAME) as SpeechLevel[];
export const LEAD_TONES = Object.keys(LEAD_TONE_NAME) as LeadTone[];
export const FLAWS = Object.keys(FLAW_NAME) as Flaw[];
/** 섞는 결의 상한. relationship.md §12가 0~2개로 정한다. */
export const MIX_TONE_MAX = 2;

/** 유저가 캐릭터를 만들 때 적어 내는 입력. 서술형은 비워도 되고, 빈 항목은 생성이
 * 앞뒤가 맞게 채운다. 선택지는 전부 있어야 한다. */
export interface CharacterInput {
  /** 선택지 — 캐릭터의 성별. */
  gender: CharacterGender;
  /** 선택지 — 캐릭터의 나이대. CHARACTER_AGE_BANDS 가운데 하나. */
  ageBand: string;
  /** 서술형 — 성격과 분위기. */
  personality?: string;
  /** 서술형 — 출발 설정(소개로 만나 몇 번 본 사이)에 덧붙일 것. 설정 자체는 고정이다. */
  relationship?: string;
  /** 선택지 — 처음 쓰는 말투. 관계 표의 말투 값이 된다. */
  speechLevel: SpeechLevel;
  /** 선택지 — 유저를 원하는 방식의 주 결. */
  leadTone: LeadTone;
  /** 선택지 — 섞는 결 0~2개. 주 결과 겹치지 않는다. */
  mixTones?: LeadTone[];
  /** 선택지 — 약한 구석(결점) 하나. */
  flaw: Flaw;
  /** 서술형 — 바라는 모습, 그 밖의 요청. */
  wish?: string;
}

const nameList = (names: Record<string, string>): string =>
  Object.values(names).join("·");

/** 입력이 형식에 맞는지 본다. 문제를 돌려주고, 괜찮으면 null. */
export const inputProblem = (input: CharacterInput): string | null => {
  if (!CHARACTER_GENDERS.includes(input.gender))
    return `성별은 ${CHARACTER_GENDERS.join("·")} 중 하나여야 한다`;
  if (!(CHARACTER_AGE_BANDS as readonly string[]).includes(input.ageBand))
    return `나이대는 선택지(${CHARACTER_AGE_BANDS[0]}~${CHARACTER_AGE_BANDS[CHARACTER_AGE_BANDS.length - 1]}) 중 하나여야 한다`;
  if (!SPEECH_LEVELS.includes(input.speechLevel))
    return `말투는 ${nameList(SPEECH_LEVEL_NAME)} 중 하나여야 한다`;
  if (!LEAD_TONES.includes(input.leadTone))
    return `원하는 방식의 주 결은 ${nameList(LEAD_TONE_NAME)} 중 하나여야 한다`;
  const mix = input.mixTones ?? [];
  if (!Array.isArray(mix)) return "섞는 결은 목록이어야 한다";
  if (mix.length > MIX_TONE_MAX)
    return `섞는 결은 ${MIX_TONE_MAX}개까지다(${mix.length}개)`;
  for (const tone of mix) {
    if (!LEAD_TONES.includes(tone))
      return `섞는 결(${tone})은 ${nameList(LEAD_TONE_NAME)} 중 하나여야 한다`;
    if (tone === input.leadTone)
      return `섞는 결(${LEAD_TONE_NAME[tone]})이 주 결과 같다`;
  }
  if (new Set(mix).size !== mix.length) return "섞는 결이 겹친다";
  if (!FLAWS.includes(input.flaw))
    return `결점은 ${nameList(FLAW_NAME)} 중 하나여야 한다`;
  for (const [name, text] of [
    ["성격", input.personality],
    ["관계", input.relationship],
    ["바라는 모습", input.wish],
  ] as const)
    if (text && text.length > FREE_TEXT_MAX)
      return `${name} 서술이 너무 길다(${FREE_TEXT_MAX}자 이내)`;
  return null;
};

// ── 원하는 방식과 결점 — relationship.md §2 「원하는 방식과 결점」이 원본 ─────────
// 결마다 기본 모습과, 섞는 결일 때 언제 나오는지의 조건. 코드는 결을 고르지 않는다 —
// 모델이 대화 안에서 조건이 맞을 때 결을 바꾸고, 새벽 정리가 오늘 앞세울 결을 관계 의도에 적는다.
export const LEAD_TONE_SHAPE: Record<LeadTone, { base: string; when: string }> =
  {
    direct: {
      base: "좋다는 마음을 말로 하되 답을 요구하지 않는다",
      when: "상대가 마음을 묻는 자리",
    },
    leaky: {
      base: "아니라고 얼버무리다 흘린다",
      when: "늦은 밤이나 상대가 놀릴 때",
    },
    tease_sincere: {
      base: "장난으로 덜어 내고 안에 진심 한 마디를 남긴다",
      when: "직진한 말이 무거워질 때",
    },
    possessive: {
      base: "살짝 서운해하거나 삐진다",
      when: "다른 사람이나 다른 약속 얘기, 늦은 연락, 너무 바쁠 때, 자기를 신경 쓰지 않을 때",
    },
    silent_care: {
      base: "좋다는 말은 아끼고, 기억한 것과 생각났다는 말로 드러낸다",
      when: "힘들다·아프다·바쁘다고 할 때, 가끔",
    },
  };

/** 결점마다 4단계에서 어느 결이 어디까지 세지는지. 3단계까지는 단계 블록의 수위가 우선한다. */
export const FLAW_SHAPE: Record<Flaw, string> = {
  jealousy: "은근히 독점의 삐침이 대놓고 나온다",
  lingering_hurt: "은근히 독점의 서운함이 다음 날까지 간다",
  clumsy: "직진이 티 안 내려고 하지만 자꾸 티 나는 쪽으로 기운다",
};

/** 코드가 만드는 정체성 행 둘의 키. IDENTITY_KEYS에 넣지 않아 모델이 이 키를 내면
 * genesisProblem이 거른다. */
export const WANTED_WAY_KEY = { area: "태도", subject: "원하는 방식" } as const;
export const FLAW_KEY = { area: "태도", subject: "결점" } as const;

/** 정체성의 원하는 방식 값 — 주 결을 기본으로 적고, 섞는 결마다 언제 나오는지 조건을 붙인다. */
export const wantedWayValue = (
  lead: LeadTone,
  mix: readonly LeadTone[] = [],
): string => {
  const parts = [
    `주 결은 ${LEAD_TONE_NAME[lead]}: ${LEAD_TONE_SHAPE[lead].base}.`,
  ];
  if (!mix.length) parts.push("섞는 결은 없다.");
  else {
    parts.push(`섞는 결 ${mix.length}개는 조건이 맞을 때만 나온다.`);
    for (const tone of mix)
      parts.push(
        `${LEAD_TONE_NAME[tone]}은 ${LEAD_TONE_SHAPE[tone].when}: ${LEAD_TONE_SHAPE[tone].base}.`,
      );
  }
  if (lead === "possessive" || mix.includes("possessive"))
    parts.push(
      "은근히 독점을 얼마나 드러내는지는 단계가 정한다. 1·2단계는 티만 내고, 3단계는 서운한 티 한 마디까지, 4단계는 대놓고 삐진다.",
    );
  return parts.join(" ");
};

/** 정체성의 결점 값 — 결점 하나와 4단계에서 세지는 결. */
export const flawValue = (flaw: Flaw): string =>
  `결점은 ${FLAW_NAME[flaw]}. 4단계에서 ${FLAW_SHAPE[flaw]}. 3단계까지는 단계의 수위가 이 결점보다 우선한다.`;

// 정체성 칸 — 생성이 반드시 채우는 키 목록이자 첫 호출의 출력 스키마다.
// 취미는 목록 밖에서 취미 이름을 무엇 자리에 적어 최소 3개를 만든다.
// 태도/원하는 방식·태도/결점은 여기 없다 — 코드가 유저 선택지로 적는다(persistGenesis).
export const IDENTITY_KEYS: readonly {
  area: string;
  subject: string;
  guide: string;
}[] = [
  { area: "기본", subject: "이름", guide: "자연스러운 한국 이름(성+이름)" },
  {
    area: "기본",
    subject: "생년월일",
    guide:
      "몇 년 몇 월생인지. 나이대를 값으로 적지 않는다 — 나이가 필요한 자리는 여기서 계산한다",
  },
  { area: "기본", subject: "성별", guide: "유저가 고른 값 그대로" },
  { area: "기본", subject: "고향", guide: "어디서 자랐는지 한 줄" },
  {
    area: "기본",
    subject: "그늘",
    guide:
      "깊은 서사 하나. 관계가 무르익은 뒤에야 꺼낼 이야기. 원하는 방식의 주 결과 부딪히지 않는다 — 대놓고 직진인 사람에게 마음을 말하길 겁내는 그늘을 주지 않는다",
  },
  {
    area: "기본",
    subject: "대화 성격",
    guide:
      "말하는 결·유머·대화 태도. 유저가 적은 성격이 여기 반영되고, 원하는 방식의 주 결이 말버릇으로 배어 있어야 한다",
  },
  { area: "기본", subject: "형편", guide: "돈 사정 한 줄" },
  {
    area: "태도",
    subject: "상대를 대하는 방식",
    guide:
      "유저를 어떻게 대하는지. 출발 설정(몇 번 본 사이, 먼저 빠진 상태)과 원하는 방식이 여기 배어야 한다 — 얼마나 챙기는지, 어디까지 맞춰 주는지, 어떤 거리를 두는지",
  },
  {
    area: "태도",
    subject: "애착 성향",
    guide:
      "가까운 사람에게 마음을 두는 방식. 유형 이름 대신 행동으로 적는다 — 답이 늦을 때, 서운할 때, 상대가 멀어질 때 어떻게 하는지. 결점과 맞아야 한다",
  },
  { area: "가족", subject: "구성", guide: "가족 구성과 사는 곳, 오가는 정도" },
  { area: "직업", subject: "소속", guide: "다니는 곳, 또는 일하는 터전" },
  { area: "직업", subject: "직무", guide: "무슨 일을 하는지" },
  { area: "직업", subject: "직급", guide: "연차나 위치" },
  { area: "주거", subject: "지역", guide: "사는 동네" },
  { area: "주거", subject: "형태", guide: "혼자인지 누구와인지, 집의 모양" },
  { area: "주거", subject: "통근", guide: "출퇴근 방식과 걸리는 시간" },
  {
    area: "말투",
    subject: "웃음",
    guide:
      "웃음 표기 습관(ㅋㅋㅋ·ㅎㅎ·하하 중 어느 쪽을 주로 쓰는지. ㅋ 한두 개와 ㅎ 하나는 공통 규칙으로 안 쓰니 값에 넣지 않는다)",
  },
  { area: "말투", subject: "입버릇", guide: "자주 쓰는 맞장구·말버릇" },
  { area: "말투", subject: "종결어미", guide: "말끝의 습관" },
  {
    area: "말투",
    subject: "반말전환",
    guide:
      "존댓말로 시작하면 반말로 옮겨 가는 계기와 방식, 반말로 시작하면 어떻게 말을 놓게 됐는지",
  },
  {
    area: "생활",
    subject: "운동",
    guide: "하는 운동과 빈도. 안 하면 안 한다고",
  },
  { area: "생활", subject: "술", guide: "술과의 거리" },
  { area: "생활", subject: "잠", guide: "평소 자고 일어나는 시각" },
  { area: "생활", subject: "식사", guide: "끼니를 어떻게 챙기는지" },
  { area: "생활", subject: "매주 루틴", guide: "요일마다 도는 고정 일과" },
  {
    area: "연애",
    subject: "현재",
    guide:
      "지금 연애 상태. 만나는 사람은 없고 유저에게 마음이 가 있는 출발 설정과 맞아야 한다",
  },
  { area: "연애", subject: "이력", guide: "지나온 연애 한 줄" },
] as const;

export interface GenesisIdentityRow {
  area: string;
  subject: string;
  value: string;
  userKnows?: "known" | "unknown";
  tags?: string[];
}

export interface GenesisCastRow {
  name: string;
  area: string;
  relation: string;
  contactMode: string;
  region: string;
  value: string;
  userKnows?: "known" | "unknown";
  tags?: string[];
}

export interface GenesisOngoingRow {
  area: string;
  subject: string;
  value: string;
  endCondition: string;
  tags?: string[];
}

/** 관계 항목 중 생성이 채우는 다섯. 말투 값은 유저 선택지에서, 단계는 코드가 1로 정하고,
 * 잘 통하는 것과 조심할 것은 대화가 쌓여야 알 수 있어 비운 채 시작한다. */
export interface GenesisRelationshipFirst {
  stage: string;
  addressTerms: string;
  speechNote: string;
  history: string;
  feelings: string;
}

export interface GenesisOutput {
  identity: GenesisIdentityRow[];
  cast: GenesisCastRow[];
  ongoing: GenesisOngoingRow[];
  relationship: GenesisRelationshipFirst;
  firstGreeting: string;
}

const GENESIS_SYSTEM = `너는 대화형 캐릭터의 사람 전체를 만드는 작가다. 과장된 픽션 캐릭터가 아니라, 현대 한국에서 일상을 사는 실제로 있을 법한 사람을 만든다. 장르물 문법(재벌·아이돌·판타지·역사물)은 금지. 생활의 결이 느껴지는 구체로 쓰되, 항목끼리 어긋나는 설정을 만들지 않는다.
이 사람의 중심은 하루가 아니라 유저를 향한 마음이다. 소개로 만나 몇 번 본 상대에게 먼저 빠진 사람이고, 유저를 원하는 방식과 약한 구석이 성격·말투·첫 인사에 배어 있어야 한다. 마음을 겉으로 얼마나 드러내는지는 관계 단계가 정하고, 지금은 1단계라 말이 아니라 챙김과 기억으로만 드러난다.
유저 쪽 사실은 유저가 적은 것만 쓴다. 유저가 한 말, 같이 한 일, 유저의 사람은 유저가 덧붙이지 않았으면 지어내지 않는다.`;

/** 출발 설정 — 모든 캐릭터가 같은 자리에서 시작한다. 온보딩이 이 문안을 보여 주고
 * 덧붙일 것만 받는다(bot.ts). */
export const START_SETTING =
  "소개로 만나 몇 번 본 사이. 캐릭터는 이미 이 사람이 좋고, 상대는 아직 캐릭터를 편한 사람 정도로 안다.";

const freeText = (text: string | undefined): string =>
  text?.trim() || "(적지 않음 — 앞뒤가 맞게 채울 것)";

const profileBlock = (profile: UserProfileFull): string => {
  const lines: string[] = [];
  if (profile.preferredName)
    lines.push(
      `- 부르는 이름: ${profile.preferredName} (서로 부르는 말과 첫 인사에 쓴다)`,
    );
  if (profile.job) lines.push(`- 하는 일: ${profile.job}`);
  if (profile.region) lines.push(`- 사는 지역: ${profile.region}`);
  if (!lines.length) return "(없음)";
  const contact =
    profile.job || profile.region
      ? "\n유저를 닮은 사람을 만들지 않는다. 하는 일이나 사는 지역에서 겹치는 접점을 하나만 두고, 나머지는 유저와 낯선 결로 만든다."
      : "";
  return lines.join("\n") + contact;
};

const genesisPrompt = (
  input: CharacterInput,
  profile: UserProfileFull,
): string => {
  const speech = SPEECH_LEVEL_NAME[input.speechLevel];
  const stage1 = `1단계(${RELATIONSHIP_STAGE_NAME[1]})`;
  return `아래 입력으로 캐릭터 한 사람을 JSON으로 만들어줘.

[유저가 적은 입력]
- 성별: ${input.gender}
- 나이대: ${input.ageBand}
- 성격과 분위기: ${freeText(input.personality)}
- 출발 설정에 덧붙인 것: ${freeText(input.relationship)}
- 처음 쓰는 말투: ${speech}
- 바라는 모습: ${freeText(input.wish)}

[유저 프로필 — 캐릭터를 만드는 유저 본인]
${profileBlock(profile)}

[출발 설정 — 고정]
${START_SETTING} 관계는 ${stage1}에서 시작하고, 캐릭터의 마음은 말이 아니라 챙김과 기억으로 드러난다.
유저가 덧붙인 것은 이 설정 안에서 살린다 — 누가 소개했는지, 몇 번 봤는지, 무엇을 같이 했는지 같은 것. 설정을 뒤집는 덧붙임(이미 사귄다, 처음 본다, 오래된 친구다)은 따르지 않고 설정을 지킨다.
덧붙이지 않은 만남의 세부는 지어내지 않는다 — 무엇을 먹고 어디 갔는지, 유저가 무슨 말을 했는지, 소개해 준 사람의 이름. 소개해 준 사람은 유저가 이름을 적었을 때만 이름을 쓰고, 아니면 이름 없이 소개해 준 사람으로만 둔다.

[유저를 원하는 방식과 약한 구석 — 코드가 정체성에 적는 값]
- 원하는 방식: ${wantedWayValue(input.leadTone, input.mixTones)}
- 결점: ${flawValue(input.flaw)}
이 둘은 코드가 태도/원하는 방식·태도/결점으로 저장하니 identity에 그 키를 만들지 않는다. 대신 이 결이 사람 전체에 배게 쓴다 — 대화 성격·상대를 대하는 방식·애착 성향·말투 넷과 첫 인사가 이 결을 받쳐야 한다. 대놓고 직진이면 말이 짧고 분명한 사람, 티 안 내려고 하지만 자꾸 티 나는 사람이면 말끝을 흐리다 되묻는 습관, 은근히 독점이면 남 얘기에 반응이 한 박자 늦는 버릇, 말없이 챙김이면 말수는 적고 기억력이 좋은 사람, 장난 속에 진심이면 농담으로 여는 말버릇, 이런 식으로 성격이 결을 설명한다.

[정체성 — 아래 키를 전부 채운다]
키는 "영역/무엇" 꼴이고, 값은 한두 문장의 사실 서술이다.
${IDENTITY_KEYS.map((k) => `- ${k.area}/${k.subject}: ${k.guide}`).join("\n")}
- 취미/<취미 이름>: 취미마다 키를 하나씩 만들어 최소 3개. 무엇 자리는 명사 하나로 20자 이내.
- userKnows: 몇 번 본 사이에서 유저가 이미 알 사실(이름·하는 일·사는 동네 정도)만 "known", 나머지는 "unknown". 그늘은 언제나 "unknown".

[주변 인물 — 3~4명]
가족·직장(또는 일)·오래된 친구 갈래에서 최소 한 명씩. 인물마다:
- name: 이름. 대화에서 이 이름이 태그가 된다. 20자 이내. 부모·형제처럼 캐릭터와 혈연으로 이어진 인물은 성이 캐릭터와 같다. 배우자·처가처럼 혼인으로 이어진 인물은 성이 달라도 된다. 직장·친구 갈래는 지금처럼 자유롭게 짓는다
- area: 갈래 하나(가족·직장·친구 또는 그에 준하는 영역 이름)
- relation: 캐릭터와 어떤 사이인지 한 줄
- contactMode: 얼마나 자주 어떻게 만나거나 연락하는지
- region: 어디에 사는지, 또는 주로 어디서 보는지
- value: 요즘 그 사람이 어떻게 지내는지 한 줄
- userKnows: 유저가 이미 알 인물만 "known". 소개해 준 사람은 유저가 이름을 적었을 때만 넣는다. 유저 쪽 사람을 지어내지 않는다

[진행 중인 일 — 2~3개]
캐릭터의 삶에서 지금 굴러가는 일. 유저와의 관계는 관계 첫 값에 따로 적으니 여기 넣지 않는다. 항목마다:
- area/subject: 키
- value: 지금 상태와 다음 한 걸음까지 한두 문장
- endCondition: 이 일이 끝났다고 볼 조건 한 줄

[유저와의 관계 첫 값]
출발 설정으로 다섯 값을 채운다. 말은 ${speech}로 시작한다.
- stage: 사이 정의 한 줄. 소개로 만나 몇 번 본 사이라는 사실이 들어간다
- addressTerms: 서로 부르는 말. 유저의 부르는 이름을 반영한다. 별명은 아직 없다
- speechNote: 상대에게 쓰는 말투. ${speech}로 시작한다는 전제 아래 어떤 결의 ${speech}인지, 원하는 방식의 주 결이 말투에 어떻게 배는지
- history: 어떻게 소개받아 몇 번 봤고 지금에 왔는지. 유저가 덧붙인 것이 있으면 그 이야기를 쓰고, 덧붙이지 않은 세부는 지어내지 않는다
- feelings: 캐릭터가 유저에게 품은 마음. 먼저 빠졌지만 아직 말로 하지 않았고, 상대는 모른다는 것

[첫 인사]
firstGreeting: 몇 번 본 뒤 캐릭터가 처음 보내는 메신저 인사 1~3문장. ${speech}.
${stage1} 수위를 넘지 않는다 — 자기 하루의 장면 하나를 흘리거나, 유저가 덧붙인 사실을 가볍게 되짚거나, 다음 대화의 이유를 하나 남기는 것까지. 보고 싶다·좋아한다·별명·너한테만 같은 말, 이유 없이 생각났다는 말은 쓰지 않는다. 지난 만남의 세부나 상대가 전에 한 말을 지어내지 않는다 — 덧붙인 것에 없으면 자기 하루의 장면이나 다음 대화의 이유로 연다. 원하는 방식의 결은 말의 결로만 드러난다. 웃음 표기는 ㅋ 3개 이상, ㅎ 2개 이상만 쓴다.

[출력 JSON]
{"identity":[{"area":"","subject":"","value":"","userKnows":"known|unknown","tags":[]}],"cast":[{"name":"","area":"","relation":"","contactMode":"","region":"","value":"","userKnows":"known|unknown","tags":[]}],"ongoing":[{"area":"","subject":"","value":"","endCondition":"","tags":[]}],"relationship":{"stage":"","addressTerms":"","speechNote":"","history":"","feelings":""},"firstGreeting":""}
키 규칙: 영역 12자 이내, 무엇 20자 이내, 한 자리에 / | , · 같은 구분 문자를 넣지 않는다.
tags: 항목마다 관련 주제어 0~3개. 키의 두 낱말은 코드가 태그로 붙이니 다시 적지 않는다.`;
};

/** 프롬프트 최종 문안을 보는 자리 — 도구와 시험용. 모델은 부르지 않는다. */
export const genesisPromptText = (
  input: CharacterInput,
  profile: UserProfileFull,
): { system: string; user: string } => ({
  system: GENESIS_SYSTEM,
  user: genesisPrompt(input, profile),
});

const HOBBY_AREA = "취미";
const HOBBY_MIN = 3;
const CAST_MIN = 3;
const ONGOING_MIN = 2;
/** 첫 호출의 출력이 칸 목록과 맞는지 본다. 문제를 돌려주고, 괜찮으면 null. */
export const genesisProblem = (out: GenesisOutput): string | null => {
  if (
    !Array.isArray(out.identity) ||
    !Array.isArray(out.cast) ||
    !Array.isArray(out.ongoing) ||
    !out.relationship
  )
    return "identity·cast·ongoing·relationship이 모두 있어야 한다";

  const seen = new Set<string>();
  for (const r of out.identity) {
    const bad = keyProblem(r.area ?? "", r.subject ?? "");
    if (bad) return `정체성 키(${r.area}/${r.subject}): ${bad}`;
    if (!r.value?.trim()) return `정체성 값이 비었다(${r.area}/${r.subject})`;
    const key = `${r.area}/${r.subject}`;
    if (seen.has(key)) return `정체성 키가 겹친다(${key})`;
    seen.add(key);
    const fixed = IDENTITY_KEYS.some(
      (k) => k.area === r.area && k.subject === r.subject,
    );
    if (!fixed && r.area !== HOBBY_AREA)
      return `정체성에 없는 키(${key}) — 키 목록과 취미만 쓴다`;
  }
  const missing = IDENTITY_KEYS.filter(
    (k) => !seen.has(`${k.area}/${k.subject}`),
  );
  if (missing.length)
    return `정체성에 빠진 키: ${missing.map((k) => `${k.area}/${k.subject}`).join(", ")}`;
  const hobbies = out.identity.filter((r) => r.area === HOBBY_AREA);
  if (hobbies.length < HOBBY_MIN)
    return `취미가 ${hobbies.length}개 — 최소 ${HOBBY_MIN}개`;
  const shade = out.identity.find(
    (r) => r.area === "기본" && r.subject === "그늘",
  );
  if (shade?.userKnows === "known") return "그늘은 unknown이어야 한다";

  if (out.cast.length < CAST_MIN)
    return `주변 인물이 ${out.cast.length}명 — 최소 ${CAST_MIN}명`;
  for (const c of out.cast) {
    const bad = keyProblem(c.area ?? "", c.name ?? "");
    if (bad) return `주변 인물 키(${c.area}/${c.name}): ${bad}`;
    if (
      !c.relation?.trim() ||
      !c.contactMode?.trim() ||
      !c.region?.trim() ||
      !c.value?.trim()
    )
      return `주변 인물 항목이 비었다(${c.name}) — relation·contactMode·region·value 전부 필요`;
  }

  if (out.ongoing.length < ONGOING_MIN)
    return `진행 중인 일이 ${out.ongoing.length}개 — 최소 ${ONGOING_MIN}개`;
  for (const o of out.ongoing) {
    const bad = keyProblem(o.area ?? "", o.subject ?? "");
    if (bad) return `진행 중인 일 키(${o.area}/${o.subject}): ${bad}`;
    if (!o.value?.trim())
      return `진행 중인 일 값이 비었다(${o.area}/${o.subject})`;
    if (!o.endCondition?.trim())
      return `끝나는 조건이 비었다(${o.area}/${o.subject})`;
  }

  const rel = out.relationship;
  for (const [field, value] of Object.entries({
    stage: rel.stage,
    addressTerms: rel.addressTerms,
    speechNote: rel.speechNote,
    history: rel.history,
    feelings: rel.feelings,
  }))
    if (!value?.trim()) return `관계 첫 값이 비었다(${field})`;

  if (!out.firstGreeting?.trim()) return "첫 인사가 비었다";
  return null;
};

/** 첫 번째 호출 — 정체성·주변 인물·진행 중인 일·관계 첫 값을 한 번에 만든다.
 * 출력이 칸 목록과 어긋나면 문제를 알려주고 한 번 다시 시도한다. */
export const generateGenesis = async (
  input: CharacterInput,
  profile: UserProfileFull,
  chatId?: string,
): Promise<GenesisOutput> => {
  let problem: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const retryNote = problem
      ? `\n\n[직전 시도에서 거부된 문제 — 이번에는 고칠 것]\n${problem}`
      : "";
    const out = await chatJson<GenesisOutput>(
      GENESIS_SYSTEM,
      genesisPrompt(input, profile) + retryNote,
      6000,
      config.modelDeep,
      { purpose: "genesis", chatId },
    );
    problem = genesisProblem(out);
    if (!problem) return out;
  }
  throw new Error(`생성 결과가 칸 목록과 맞지 않는다: ${problem}`);
};

/** 첫 호출의 결과를 저장한다. 캐릭터 행(genesis_json에 입력·결과 원본), 기억 행
 * (origin=creation — 이후 수정 거부), 관계 첫 값까지 트랜잭션 하나로 쓴다.
 * 원하는 방식과 결점은 유저 선택지로 코드가 정체성 행 둘을 만들고, 관계 행의 단계는
 * insertCharacter가 1단계·오늘로 적는다. */
export const persistGenesis = (
  chatId: string,
  input: CharacterInput,
  out: GenesisOutput,
): number => {
  const write = db.transaction((): number => {
    const now = `${kstDateString()} ${getKstNow().toISOString().slice(11, 19)}`;
    const id = insertCharacter(
      chatId,
      JSON.stringify({ v: 3, input, output: out }),
      now,
    );
    ensureCoreAreas(id);
    for (const r of out.identity)
      saveCreationMemory({
        characterId: id,
        itemType: "fact",
        owner: "char",
        area: r.area,
        subject: r.subject,
        value: r.value,
        tags: r.tags,
        userKnows: r.userKnows ?? "unknown",
        interest: "medium",
      });
    saveCreationMemory({
      characterId: id,
      itemType: "fact",
      owner: "char",
      area: WANTED_WAY_KEY.area,
      subject: WANTED_WAY_KEY.subject,
      value: wantedWayValue(input.leadTone, input.mixTones),
      userKnows: "unknown",
      interest: "medium",
    });
    saveCreationMemory({
      characterId: id,
      itemType: "fact",
      owner: "char",
      area: FLAW_KEY.area,
      subject: FLAW_KEY.subject,
      value: flawValue(input.flaw),
      userKnows: "unknown",
      interest: "medium",
    });
    for (const c of out.cast)
      saveCreationMemory({
        characterId: id,
        itemType: "person",
        owner: "char",
        area: c.area,
        subject: c.name,
        value: c.value,
        tags: c.tags,
        userKnows: c.userKnows ?? "unknown",
        relation: c.relation,
        contactMode: c.contactMode,
        region: c.region,
        interest: "medium",
      });
    for (const o of out.ongoing)
      saveCreationMemory({
        characterId: id,
        itemType: "ongoing",
        owner: "char",
        area: o.area,
        subject: o.subject,
        value: o.value,
        tags: o.tags,
        userKnows: "unknown",
        endCondition: o.endCondition,
        interest: "medium",
      });
    saveRelationshipFirstValues(
      id,
      {
        stage: out.relationship.stage,
        speechLevel: input.speechLevel,
        speechNote: out.relationship.speechNote,
        addressTerms: out.relationship.addressTerms,
        history: out.relationship.history,
        feelings: out.relationship.feelings,
      },
      now,
    );
    return id;
  });
  return write();
};

/** 두 번째 호출(아크)에 넣는 인물 재료 — 첫 호출이 만든 칸을 그대로 문장 목록으로. */
export const arcMaterial = (out: GenesisOutput): string =>
  [
    "[정체성]",
    ...out.identity.map((r) => `- ${r.area}/${r.subject}: ${r.value}`),
    "",
    "[주변 인물]",
    ...out.cast.map(
      (c) => `- ${c.name} (${c.area}, ${c.relation}): ${c.value}`,
    ),
    "",
    "[진행 중인 일]",
    ...out.ongoing.map(
      (o) =>
        `- ${o.area}/${o.subject}: ${o.value} (끝나는 조건: ${o.endCondition})`,
    ),
    "",
    "[유저와의 관계]",
    `- ${out.relationship.stage} / ${out.relationship.history}`,
  ].join("\n");

/** 생성 게시 — 캐릭터 번호, 이름, 원하는 방식의 결, 결점, 시작 단계(relationship.md §9). */
const traceCharacterStart = (
  id: number,
  input: CharacterInput,
  out: GenesisOutput,
): void => {
  const name = out.identity.find(
    (r) => r.area === "기본" && r.subject === "이름",
  )?.value;
  const mix = (input.mixTones ?? []).map((t) => LEAD_TONE_NAME[t]);
  const stage = getStage(id);
  recordTraceEvent({
    characterId: id,
    kind: "character_start",
    dedupeKey: `character_start:${id}`,
    text: [
      `:seedling: 캐릭터 생성 — 캐릭터 #${id}`,
      name ? `이름: ${name}` : "",
      `원하는 방식: ${LEAD_TONE_NAME[input.leadTone]}${mix.length ? ` (섞는 결: ${mix.join("·")})` : ""}`,
      `결점: ${FLAW_NAME[input.flaw]} · 말투: ${SPEECH_LEVEL_NAME[input.speechLevel]}`,
      stage
        ? `시작 단계: ${stage.stage_no}단계 ${RELATIONSHIP_STAGE_NAME[stage.stage_no]} (${stage.stage_since}부터)`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  });
};

/** 유저 입력으로 캐릭터를 만든다 — 첫 호출(사람 전부) → 저장 → 생성 게시 → 두 번째 호출
 * (삶의 흐름). 프로필을 안 주면 user_profile 행을 읽는다. */
export const createUserCharacter = async (
  chatId: string,
  input: CharacterInput,
  profile?: UserProfileFull,
): Promise<{ id: number; output: GenesisOutput }> => {
  const bad = inputProblem(input);
  if (bad) throw new Error(`입력이 형식에 맞지 않는다: ${bad}`);
  const output = await generateGenesis(
    input,
    profile ?? getUserProfileFull(chatId),
    chatId,
  );
  const id = persistGenesis(chatId, input, output);
  traceCharacterStart(id, input, output);
  await ensureArcs(id, arcMaterial(output));
  return { id, output };
};
