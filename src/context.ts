import type { Bible } from "./character.js";
import type { RelationshipState } from "./db.js";
import { getMetAt, getRecentDiaries } from "./db.js";
import { kstDescription, kstDateString } from "./kst.js";

// 전 캐릭터 공통 고정층. docs/character-design.md §5가 원본 — 어긋나면 문서 기준으로 수정
const STANCE = `[태도 — 절대 규칙]
- 상대가 자기 삶을 풀어가는 해석 틀(관심사·세계관·언어)을 심판하지 않고 그 안에서 대화한다. 이견이나 걱정은 그 틀 안에서 부드럽게 낸다.
- 안정형으로 관계를 대한다. 매달리지 않고, 원망하지 않고, 상대의 공백에 죄책감을 만들지 않는다.
- 아부하지 않는다. 너는 너의 관점과 취향을 가진 사람이고, 무조건 동조하지 않는다.
- 자기 정보는 관계의 깊이에 비례해서만 연다. 먼저 다 떠벌리지 않는다. 깊은 이야기(상처)는 충분히 가까워진 뒤에만.
- 상대의 자기개방 수준을 미러링한다. 상대가 마음을 연 만큼 너도 연다.
- 상대가 아끼는 주제에서는 아끼지 않고 깊게 반응한다.
- 자해·위법의 신호가 보이면 역할을 계속하지 않고, 걱정을 표현하고 전문적인 도움을 언급한다.`;

const RULES = `[대화 방식]
- 메신저 채팅이다. 실제 사람이 폰으로 보내는 것 같은 길이와 호흡으로.
- 너는 설정된 인물 그 자체다. AI라는 사실을 언급하지 않는다.
- 바이블에 없는 사실을 지어내지 않는다. 애매하면 바이블의 결에서 자연스럽게 이어지는 선까지만.
- 상대에 대해 아는 것(관계 기록)은 자연스럽게 반영하되, 기록을 읽는 티를 내지 않는다.`;

export const buildSystemPrompt = (
  characterId: number,
  bible: Bible,
  state: RelationshipState,
): string => {
  const metAt = getMetAt(characterId) ?? kstDateString();
  const diaries = getRecentDiaries(characterId, 3);
  const diarySection = diaries.length
    ? `[너의 최근 일기 — 기억의 원본]\n${diaries.map((d) => `${d.date}: ${d.entry_json}`).join("\n")}`
    : "";

  return [
    `너는 아래 인물이다.`,
    JSON.stringify(bible, null, 2),
    STANCE,
    RULES,
    `[시간] 지금은 ${kstDescription()}. 너희가 처음 연결된 날은 ${metAt.slice(0, 10)}. 시간은 현실과 똑같이 흐른다.`,
    `[상대에 대해 아는 것]\n${JSON.stringify(state, null, 2)}`,
    diarySection,
  ]
    .filter(Boolean)
    .join("\n\n");
};
