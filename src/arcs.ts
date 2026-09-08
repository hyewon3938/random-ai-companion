// 아크 — 캐릭터 삶의 큰 흐름(올해·계절·이달·이번 주)을 만들고 달력 경계에서 이어 쓴다.
//
// 처음 한 번은 캐릭터를 만든 직후(character.ts)와 새벽 정리(nightly.ts)가 ensureArcs로
// 만든다. 그 뒤로는 refreshArcs가 달력 경계에서만 이어 쓴다 — 매주 월요일에 이번 주,
// 매달 1일에 이달(분기 시작 달은 계절까지, 1월 1일은 올해까지). 어느 칸을 다시 쓸지는
// arcRefreshTargets가 날짜만 보고 정하므로 모델을 부르지 않고 검사할 수 있다.
//
// 새벽 정리가 모은 값을 통째로 받지 않고 인물 재료와 지금까지의 흐름을 문자열로 받는다.
// 캐릭터의 삶(3번 영역)이 새벽 정리(6번)의 타입에 기대지 않게 두는 자리다.
//
// 유저와는 메시지로만 이어진 사이라 유저와 만날 계획을 세우거나 재는 문장은 흐름에 넣지 않는다.
// 둘 사이는 대화의 결과 마음의 거리로만 적는다(이슈 #322).

import { config } from "./config.js";
import { getArcs, getRecentDiaries, saveArc } from "./db.js";
import { kstDateString } from "./kst.js";
import { chatJson } from "./llm.js";
import { RECENT_DIARY_DAYS } from "./thresholds.js";

export type ArcHorizon = "year" | "season" | "month" | "week";

type ArcOutput = Record<ArcHorizon, string>;

const ARC_SYSTEM = `너는 한 인물의 삶의 큰 흐름을 짜는 작가다. 과장 없이, 실제 그 사람의 한 해에 있을 법한 결로.`;

const ARC_USER_RULE = `[상대와의 사이]
상대(유저)와는 메시지로만 이어진 사이라 실제로 만날 수 없다. 상대와 만나는 계획을 세우거나 만날지 재는 문장(데이트를 꺼내 볼지, 주말에 같이 갈지)은 흐름에 넣지 않는다. 둘 사이는 대화의 결과 마음의 거리로만 적는다.`;

const ARC_JSON_SHAPE = `{"year":"올해의 큰 진행 사건 1~2문장","season":"이 계절의 결 1~2문장","month":"이번 달의 상황 1~2문장","week":"이번 주의 특이사항 1문장 (없으면 '평범한 주')"}`;

const arcPrompt = (
  personBlock: string,
  today: string,
): string => `오늘은 ${today}다. 아래 인물의 삶의 큰 흐름을 JSON으로 짜줘.

[인물]
${personBlock}

${ARC_USER_RULE}

${ARC_JSON_SHAPE}`;

// 아크가 하나도 없을 때만 네 칸을 한 번에 만든다. 이미 있으면 모델을 부르지 않는다.
export const ensureArcs = async (
  characterId: number,
  personBlock: string,
): Promise<void> => {
  if (Object.keys(getArcs(characterId)).length) return;
  const arcs = await chatJson<ArcOutput>(
    ARC_SYSTEM,
    arcPrompt(personBlock, kstDateString()),
    1000,
    config.modelDeep,
    { purpose: "arc", characterId },
  );
  saveArc(characterId, "year", arcs.year);
  saveArc(characterId, "season", arcs.season);
  saveArc(characterId, "month", arcs.month);
  saveArc(characterId, "week", arcs.week);
};

// 오늘 다시 쓸 칸. 월요일이면 이번 주, 1일이면 이달, 분기 시작 달(3·6·9·12월)의 1일이면
// 계절까지, 1월 1일이면 올해까지. 날짜만 보고 정하므로 순수 함수다.
export const arcRefreshTargets = (today: string): ArcHorizon[] => {
  const targets: ArcHorizon[] = [];
  if (new Date(`${today}T00:00:00Z`).getUTCDay() === 1) targets.push("week");
  if (today.endsWith("-01")) {
    targets.push("month");
    const month = Number(today.slice(5, 7));
    if ([3, 6, 9, 12].includes(month)) targets.push("season");
    if (month === 1) targets.push("year");
  }
  return targets;
};

const HORIZON_LABEL: Record<ArcHorizon, string> = {
  week: "주",
  month: "달",
  season: "계절",
  year: "해",
};

export type ArcRefreshInput = {
  characterId: number;
  chatId: string;
  today: string;
  // 인물 재료 — 정체성·주변 인물·진행 중인 일·관계. nightly.ts의 arcMaterialOf가 만든다.
  personBlock: string;
  // 지금까지의 흐름을 "칸: 내용" 한 줄씩 이은 것. 없으면 빈 문자열.
  arcLines: string;
};

const arcRefreshPrompt = (
  input: ArcRefreshInput,
  diaries: string,
): string => `오늘은 ${input.today}다. 아래 인물의 삶의 큰 흐름을 이어서 갱신해줘. 기존 흐름과 단절되지 않게 — 진행 중인 사건은 자연스럽게 진행시키고, 매듭지어질 때가 된 것은 마무리하고, 새 흐름이 필요하면 이 인물답게 잔잔하게 연다.

[인물]
${input.personBlock}

[지금까지의 흐름]
${input.arcLines || "(없음)"}

[최근 일기 — 실제로 산 나날]
${diaries || "(없음)"}

${ARC_USER_RULE}

${ARC_JSON_SHAPE}`;

const recentDiaryLines = (characterId: number): string =>
  getRecentDiaries(characterId, RECENT_DIARY_DAYS)
    .map((d) => {
      try {
        return `${d.date}: ${(JSON.parse(d.entry_json) as { diary?: string }).diary ?? ""}`;
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .join("\n");

// 달력 경계에서 기존 흐름과 최근 일기를 주고 단절 없이 이어 쓴다. ensureArcs가 만든 값이
// 생성 시점에 영구 고정되지 않게 하는 자리다. 경계가 아닌 날은 모델을 부르지 않는다.
export const refreshArcs = async (input: ArcRefreshInput): Promise<void> => {
  const targets = arcRefreshTargets(input.today);
  if (!targets.length) return;
  const arcs = await chatJson<ArcOutput>(
    ARC_SYSTEM,
    arcRefreshPrompt(input, recentDiaryLines(input.characterId)),
    1000,
    config.modelDeep,
    { purpose: "arc", characterId: input.characterId, chatId: input.chatId },
  );
  for (const horizon of targets)
    if (arcs[horizon]) saveArc(input.characterId, horizon, arcs[horizon]);
  console.log(
    `[arcs] 아크 갱신 (${targets.map((h) => HORIZON_LABEL[h]).join(" ")})`,
  );
};
