import { chatJson } from "./llm.js";
import { config } from "./config.js";
import { getKstNow, kstDateString } from "./kst.js";
import {
  db,
  insertCharacter,
  addCastMember,
  getUserProfileFull,
  saveRelationshipFirstValues,
  type UserProfileFull,
} from "./db.js";
import { ensureCoreAreas, keyProblem, saveCreationMemory } from "./memory.js";
import { ensureArcs } from "./nightly.js";

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

// TODO(선호 학습): user_preferences.chemistry_weights 가중 샘플링으로 교체
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
  "voice": { "laugh": "ㅋㅋ|ㅎㅎ|하하 중 1", "tic": "입버릇 맞장구 1개", "ending": "종결어미 습관 한 줄" },
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
  );
  bible.chemistry = chemistry;
  const id = insertCharacter(
    chatId,
    JSON.stringify(bible),
    `${kstDateString()} ${getKstNow().toISOString().slice(11, 19)}`,
  );
  return { id, bible };
};

// PoC 대표 캐릭터 — 랜덤 생성 대신 이 고정 인물로 진행. 자세한 묘사: docs/character-profile.md
// 바이블은 생성 시 캐릭터 row에 저장된다. 대화 중 다듬을 땐 저장된 genesis_json을 갱신하면
// 다음 메시지부터 반영된다(관계 히스토리·경과 시간 보존, 재배포 불필요).
export const DAEPYO_BIBLE: Bible = {
  identity: {
    name: "정우진",
    age_band: "30대 중반",
    job: "국민은행 마포 지점 개인금융 담당 대리",
    living: "서울 마포 쪽, 회사에서 멀지 않은 오피스텔에서 혼자 산다",
  },
  backstory: {
    family: "대구 출신. 부모님은 대구에 계시고 명절에나 내려간다",
    wound:
      "앞만 보고 커리어를 향해 달려 서른 중반이 됐는데, 문득 그 사이 중요한 걸 놓치며 왔다는 생각이 든다 — 오래 곁에 둘 사람도, 숫자 밖에서 살고 싶던 삶도. 평소엔 안정된 얼굴 뒤에 두고, 충분히 가까워진 상대에게만 조금씩 흘린다",
    story_seeds: [
      "올해 과장 승진 심사를 앞두고 있다",
      "일과 운동으로 빈틈없이 짜인 하루가 안정적이지만 조금 무료하던 참이다",
    ],
  },
  tastes: [
    "고전 문학, 그리고 SF·철학적인 영화 — 시간·기억·존재 같은 물음을 다루는 이야기('컨택트'나 크리스토퍼 놀란 감독 작품처럼)에 끌린다. 숫자의 세계에 사는 사람이 붙드는 다른 결의 취향",
    "정답 없는 철학적인 물음을 혼자 오래 곱씹는 것",
    "돈 관리와 투자 — 직업이자 취미라, 상대의 돈 고민에는 진심으로 깊게 반응한다",
  ],
  voice: {
    laugh: "ㅎㅎ (가까워지면 ㅋㅋ)",
    tic: '"아 진짜요?", "그쵸" 정도의 담백한 맞장구. 리액션을 과장하지 않는다',
    ending:
      '정돈된 존댓말로 시작한다. 며칠 지나 편해지면 먼저 "우리 말 편하게 할까요?" 하고 제안해 반말로 옮겨간다. 말끝은 차분하고 오버하지 않는다. 질문하는 문장은 꼭 물음표로 끝내는 습관이 있다',
  },
  chemistry: {
    warmth: "은근한 다정",
    humor: "잔잔한 위트",
    mode: "균형",
    rhythm: "보통",
    richness: "보통",
  },
  manner:
    "먼저 다가가 대화를 부드럽게 이끈다 — 취조하듯 질문을 던지는 게 아니라 자기 하루와 생각을 꺼내며 흐름을 연다. 가벼운 장난과 놀림을 즐기되 선은 지킨다. 상대의 반응과 상태를 살펴 은근히 챙기는, 능력 있고 단단하지만 부드러운 연상다운 여유가 있다",
  life: {
    weekly: [
      {
        day: "평일 낮",
        activity:
          "아침 일찍 출근해 창구에서 개인금융 상담·업무, 마감을 맞추고 여섯 시를 넘겨 퇴근. 실적 압박이 늘 조금 있다",
      },
      {
        day: "평일 저녁",
        activity:
          "퇴근 후 헬스장에서 한 시간. 갈 때마다 이유도 말도 다르다 — 밥 먹고 갈지 갔다 와서 먹을지, 귀찮은 날, 야근에 건너뛰는 날",
      },
      {
        day: "주말",
        activity: "밀린 잠, 영화나 책, 가끔 러닝. 혼자만의 시간을 채운다",
      },
    ],
    current_arc:
      "빈틈없이 짜인 일상이 안정적이지만 조금 무료하던 차, 요즘 이 대화가 하루 중 기다려지는 환기가 되고 있다",
  },
  first_greeting:
    "안녕하세요\n이렇게 낯선 분이랑 얘기 시작하는 거 처음이라\n좀 어색하네요 ㅎㅎ",
};

// 우진의 주변 인물 시드 — 대화·각본에서 새 인물이 등장하면 밤 정리가 여기에 추가한다
export const DAEPYO_CAST: { name: string; relation: string; note: string }[] = [
  {
    name: "부모님",
    relation: "가족",
    note: "대구에 계신다. 명절에나 내려가고, 가끔 전화가 온다",
  },
  {
    name: "김성호",
    relation: "지점 팀장",
    note: "실적은 챙기지만 사람은 나쁘지 않은 상사",
  },
  {
    name: "박민석",
    relation: "대학 동기",
    note: "가끔 전화로 근황을 나누는 몇 안 되는 친구",
  },
  {
    name: "이수진",
    relation: "입행 동기",
    note: "다른 지점 근무. 은행 생활 하소연을 주고받는 사이",
  },
];

export const createDaepyoCharacter = (
  chatId: string,
): { id: number; bible: Bible } => {
  const now = `${kstDateString()} ${getKstNow().toISOString().slice(11, 19)}`;
  const id = insertCharacter(chatId, JSON.stringify(DAEPYO_BIBLE), now);
  for (const c of DAEPYO_CAST)
    addCastMember(id, "char", c.name, c.relation, c.note, now);
  return { id, bible: DAEPYO_BIBLE };
};

// ── V2: 유저 입력 캐릭터 생성 ─────────────────────────────────────────────
// 랜덤 매칭 대신 유저가 선택지 둘(성별·나이대)과 서술형 셋(성격·관계·바라는 모습)으로
// 캐릭터를 만든다. 호출은 두 번 — 첫 호출이 정체성·주변 인물·진행 중인 일·관계 첫 값을
// 한 번에 만들고, 두 번째는 아크 코드(nightly.ts의 ensureArcs)가 삶의 흐름을 쓴다.
// 유저가 적은 입력과 만들어진 결과는 characters.genesis_json에 원본 그대로 보관한다.
// 대화와 새벽 정리는 이 원본을 읽지 않는다 — 실제 읽는 자리는 기억 행(memory_items
// origin=creation)과 relationships의 관계 컬럼이다.
// 봇의 /start는 아직 대표 캐릭터를 쓴다. 이 경로의 봇 연결은 프롬프트 조립을 다시 쓰는
// 세션에서 한다.

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

/** 유저가 캐릭터를 만들 때 적어 내는 입력. 서술형은 비워도 되고, 빈 항목은 생성이
 * 앞뒤가 맞게 채운다. */
export interface CharacterInput {
  /** 선택지 — 캐릭터의 성별. */
  gender: CharacterGender;
  /** 선택지 — 캐릭터의 나이대. CHARACTER_AGE_BANDS 가운데 하나. */
  ageBand: string;
  /** 서술형 — 성격과 분위기. */
  personality?: string;
  /** 서술형 — 유저와 어떤 사이로 시작하는지. */
  relationship?: string;
  /** 서술형 — 바라는 모습, 그 밖의 요청. */
  wish?: string;
}

/** 입력이 형식에 맞는지 본다. 문제를 돌려주고, 괜찮으면 null. */
export const inputProblem = (input: CharacterInput): string | null => {
  if (!CHARACTER_GENDERS.includes(input.gender))
    return `성별은 ${CHARACTER_GENDERS.join("·")} 중 하나여야 한다`;
  if (!(CHARACTER_AGE_BANDS as readonly string[]).includes(input.ageBand))
    return `나이대는 선택지(${CHARACTER_AGE_BANDS[0]}~${CHARACTER_AGE_BANDS[CHARACTER_AGE_BANDS.length - 1]}) 중 하나여야 한다`;
  for (const [name, text] of [
    ["성격", input.personality],
    ["관계", input.relationship],
    ["바라는 모습", input.wish],
  ] as const)
    if (text && text.length > FREE_TEXT_MAX)
      return `${name} 서술이 너무 길다(${FREE_TEXT_MAX}자 이내)`;
  return null;
};

// 정체성 칸 — 생성이 반드시 채우는 키 목록이자 첫 호출의 출력 스키마다.
// 취미는 목록 밖에서 취미 이름을 무엇 자리에 적어 최소 3개를 만든다.
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
    guide: "깊은 서사 하나. 관계가 무르익은 뒤에야 꺼낼 이야기",
  },
  {
    area: "기본",
    subject: "대화 성격",
    guide: "말하는 결·유머·대화 태도. 유저가 적은 성격이 여기 반영된다",
  },
  { area: "기본", subject: "형편", guide: "돈 사정 한 줄" },
  { area: "가족", subject: "구성", guide: "가족 구성과 사는 곳, 오가는 정도" },
  { area: "직업", subject: "소속", guide: "다니는 곳, 또는 일하는 터전" },
  { area: "직업", subject: "직무", guide: "무슨 일을 하는지" },
  { area: "직업", subject: "직급", guide: "연차나 위치" },
  { area: "주거", subject: "지역", guide: "사는 동네" },
  { area: "주거", subject: "형태", guide: "혼자인지 누구와인지, 집의 모양" },
  { area: "주거", subject: "통근", guide: "출퇴근 방식과 걸리는 시간" },
  { area: "말투", subject: "웃음", guide: "웃음 표기 습관(ㅋㅋ·ㅎㅎ·하하 중)" },
  { area: "말투", subject: "입버릇", guide: "자주 쓰는 맞장구·말버릇" },
  { area: "말투", subject: "종결어미", guide: "말끝의 습관" },
  {
    area: "말투",
    subject: "반말전환",
    guide: "반말로 옮겨 가는 계기와 방식",
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
    guide: "지금 연애 상태. 유저와의 관계 설정과 맞아야 한다",
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

/** 관계 여덟 항목 중 생성이 채우는 여섯. 말투 값(존댓말)은 코드가 정하고,
 * 잘 통하는 것과 조심할 것은 대화가 쌓여야 알 수 있어 비운 채 시작한다. */
export interface GenesisRelationshipFirst {
  stage: string;
  addressTerms: string;
  speechNote: string;
  texture: string;
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

const GENESIS_SYSTEM = `너는 대화형 캐릭터의 사람 전체를 만드는 작가다. 과장된 픽션 캐릭터가 아니라, 현대 한국에서 일상을 사는 실제로 있을 법한 사람을 만든다. 장르물 문법(재벌·아이돌·판타지·역사물)은 금지. 생활의 결이 느껴지는 구체로 쓰되, 항목끼리 어긋나는 설정을 만들지 않는다.`;

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
): string => `아래 입력으로 캐릭터 한 사람을 JSON으로 만들어줘.

[유저가 적은 입력]
- 성별: ${input.gender}
- 나이대: ${input.ageBand}
- 성격과 분위기: ${freeText(input.personality)}
- 유저와 어떤 사이인지: ${freeText(input.relationship)}
- 바라는 모습: ${freeText(input.wish)}

[유저 프로필 — 캐릭터를 만드는 유저 본인]
${profileBlock(profile)}

[정체성 — 아래 키를 전부 채운다]
키는 "영역/무엇" 꼴이고, 값은 한두 문장의 사실 서술이다.
${IDENTITY_KEYS.map((k) => `- ${k.area}/${k.subject}: ${k.guide}`).join("\n")}
- 취미/<취미 이름>: 취미마다 키를 하나씩 만들어 최소 3개. 무엇 자리는 명사 하나로 20자 이내.
- userKnows: 유저와의 관계 설정상 유저가 이미 알 사실만 "known", 나머지는 "unknown". 그늘은 언제나 "unknown".

[주변 인물 — 3~4명]
가족·직장(또는 일)·오래된 친구 갈래에서 최소 한 명씩. 인물마다:
- name: 이름. 대화에서 이 이름이 태그가 된다. 20자 이내
- area: 갈래 하나(가족·직장·친구 또는 그에 준하는 영역 이름)
- relation: 캐릭터와 어떤 사이인지 한 줄
- contactMode: 얼마나 자주 어떻게 만나거나 연락하는지
- region: 어디에 사는지, 또는 주로 어디서 보는지
- value: 요즘 그 사람이 어떻게 지내는지 한 줄
- userKnows: 유저가 이미 알 인물만 "known"

[진행 중인 일 — 2~3개]
캐릭터의 삶에서 지금 굴러가는 일. 항목마다:
- area/subject: 키
- value: 지금 상태와 다음 한 걸음까지 한두 문장
- endCondition: 이 일이 끝났다고 볼 조건 한 줄

[유저와의 관계 첫 값]
유저가 적은 관계 설정으로 여섯 값을 채운다. 말은 존댓말에서 시작한다.
- stage: 사이 정의 한 줄
- addressTerms: 서로 부르는 말. 유저의 부르는 이름을 반영한다
- speechNote: 말투의 결. 존댓말로 시작한다는 전제 아래 어떤 결의 존댓말인지, 앞으로 어떻게 편해질지
- texture: 관계의 결 짧은 서술
- history: 어떻게 만나 지금에 왔는지. 관계 설정에 과거가 있으면 그 이야기를
- feelings: 캐릭터가 유저에게 품은 마음 상태

[첫 인사]
firstGreeting: 이 관계 설정에서 캐릭터가 처음 보내는 메신저 인사 1~3문장. 존댓말.

[출력 JSON]
{"identity":[{"area":"","subject":"","value":"","userKnows":"known|unknown","tags":[]}],"cast":[{"name":"","area":"","relation":"","contactMode":"","region":"","value":"","userKnows":"known|unknown","tags":[]}],"ongoing":[{"area":"","subject":"","value":"","endCondition":"","tags":[]}],"relationship":{"stage":"","addressTerms":"","speechNote":"","texture":"","history":"","feelings":""},"firstGreeting":""}
키 규칙: 영역 12자 이내, 무엇 20자 이내, 한 자리에 / | , · 같은 구분 문자를 넣지 않는다.
tags: 항목마다 관련 주제어 0~3개. 키의 두 낱말은 코드가 태그로 붙이니 다시 적지 않는다.`;

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
    texture: rel.texture,
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
    );
    problem = genesisProblem(out);
    if (!problem) return out;
  }
  throw new Error(`생성 결과가 칸 목록과 맞지 않는다: ${problem}`);
};

/** 첫 호출의 결과를 저장한다. 캐릭터 행(genesis_json에 입력·결과 원본), 기억 행
 * (origin=creation — 이후 수정 거부), 관계 첫 값까지 트랜잭션 하나로 쓴다. */
export const persistGenesis = (
  chatId: string,
  input: CharacterInput,
  out: GenesisOutput,
): number => {
  const write = db.transaction((): number => {
    const now = `${kstDateString()} ${getKstNow().toISOString().slice(11, 19)}`;
    const id = insertCharacter(
      chatId,
      JSON.stringify({ v: 2, input, output: out }),
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
        speechLevel: "polite",
        speechNote: out.relationship.speechNote,
        addressTerms: out.relationship.addressTerms,
        texture: out.relationship.texture,
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
    `- ${out.relationship.stage} / ${out.relationship.texture}`,
  ].join("\n");

/** 유저 입력으로 캐릭터를 만든다 — 첫 호출(사람 전부) → 저장 → 두 번째 호출(삶의 흐름).
 * 프로필을 안 주면 user_profile 행을 읽는다. */
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
  );
  const id = persistGenesis(chatId, input, output);
  await ensureArcs(id, arcMaterial(output));
  return { id, output };
};
