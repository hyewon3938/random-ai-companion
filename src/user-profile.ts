import { config } from "./config.js";
import { getUserProfile } from "./db.js";

// 상대(유저)를 '어떻게 알고, 어떻게 부르는지' — 전 캐릭터 공통 규칙. 네 발화 표면 모두에 주입한다:
// 실시간 대화(context.ts) + 아침 안부(nightly.ts) + 침묵 팔로업(followup.ts) + 자리 비움 예고(presence.ts).
//
// 프로필은 성별·나이대·하는 일·사는 지역 넷을 다룬다(이름은 뺐다). 시스템이 "OO씨로 불러라"라고
// 호칭을 강제했더니, 이미 반말로 자리 잡은 호칭(예: 이름+아)을 격식체로 되돌리고 이름까지 잘못
// 부르는 회귀가 났다(2026-07-12). 이름·호칭은 대화 흐름에서 자연스럽게 자리 잡게 두고, 시스템은
// 거기 끼어들지 않는다.
//
// 값이 들어오는 길은 둘로 갈린다 — 성별·나이대는 env(USER_GENDER/USER_AGE_BAND)나 가입 때 받고,
// 하는 일·사는 지역은 대화에서 분명히 드러나면 새벽 정리가 채운다(db.ts saveUserProfile).
// 모르는 값은 줄 자체를 넣지 않는다 — 성별을 넘겨짚지 않고(여성 유저에게 "그럼 내가 형이네" 방지)
// 대화로 알아간다. 하는 일·사는 지역은 연락이 닿을 시간대와 거리 감각을 가늠하는 자리다.

export interface UserProfile {
  gender?: string;
  ageBand?: string;
  job?: string;
  region?: string;
}

// 성별·나이대는 env(수동 지정)가 우선, 없으면 저장된 per-chat 값. 하는 일·사는 지역은 env가
// 없으므로 저장된 값뿐이다. 없는 값은 미상으로 둔다.
export const effectiveProfile = (chatId?: string): UserProfile => {
  const env = config.userProfile;
  const stored = chatId ? getUserProfile(chatId) : {};
  return {
    gender: env.gender ?? stored.gender,
    ageBand: env.ageBand ?? stored.ageBand,
    job: stored.job,
    region: stored.region,
  };
};

export const renderUserBlock = (chatId?: string): string => {
  const { gender, ageBand, job, region } = effectiveProfile(chatId);

  const known = [
    gender ? `성별은 ${gender}` : "",
    ageBand ? `나이대는 ${ageBand}` : "",
    job ? `하는 일은 ${job}` : "",
    region ? `사는 곳은 ${region}` : "",
  ].filter(Boolean);

  const idLine = known.length
    ? `- 상대에 대해 아는 것: ${known.join(", ")}. 확정된 사실이니 다시 넘겨짚지 않는다.`
    : "";

  // 하는 일·사는 지역은 쓰임이 따로 있다 — 언제 연락이 닿을지, 서로 어디쯤 떨어져 있는지.
  const lifeNames = [job ? "하는 일" : "", region ? "사는 곳" : ""].filter(
    Boolean,
  );
  const lifeLine = lifeNames.length
    ? `- 상대의 ${lifeNames.join("·")}은 연락이 닿을 시간대나 거리 감각을 가늠할 때 참고한다. 아는 것을 굳이 꺼내 보이거나 다시 캐묻지 않는다.`
    : "";

  const genderLine = gender
    ? `- 상대의 성별이 ${gender}임을 전제로 말한다. 성별을 잘못 짚는 말(예: 여성인 상대를 남자로 여겨 "그럼 내가 형이네"라고 하는 것)은 하지 않는다.`
    : `- 상대의 성별을 아직 모른다. 캐묻지 말고, 대화 속에서 자연스럽게 드러나면 그때 기억한다. 알기 전에는 함부로 추측하지 않고, 성별을 전제한 호칭·농담(형/오빠/누나/언니 등)을 피한다.`;

  return [
    `[상대를 부르는 법 — 절대 규칙]`,
    idLine,
    lifeLine,
    genderLine,
    `- 상대를 "야"라고 부르지 않는다(호명). ※ 반말 종결어미 "~야"(예: "그런 거야")는 무관하니 괜찮다 — 금지하는 건 상대를 "야!" 하고 부르는 것뿐이다.`,
    `- 상대에게 특정 호칭을 시키지 않는다. "오빠라고 불러", "오빠라고 해봐", "누나라고 해" 같은 요구는 하지 않는다 — 특히 아직 안 친한 사이에는. 네가 나이가 위라는 걸 가볍게 인지하는 정도("아 그럼 제가 좀 위네요")는 괜찮지만, 상대가 널 뭐라 부를지는 상대가 정한다.`,
    `- 상대를 부르는 호칭·말투는 이미 대화에서 자리 잡은 것을 그대로 따른다. 서로 말을 놓았거나 어떤 호칭으로 부르고 있으면 계속 그렇게 — 갑자기 더 격식 있는 쪽(예: 다시 "OO씨")으로 되돌아가지 않는다. 시스템이 호칭을 새로 정해주지 않는다.`,
  ]
    .filter(Boolean)
    .join("\n");
};
