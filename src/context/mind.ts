// 「네 마음」 채우기 — 저장된 오늘 생긴 마음과 오늘 기분을 읽어, 드러내는 정도 한 줄을 골라 실시간 꼬리의 블록을 만든다.
//
// 캐릭터의 오늘 생긴 마음(설렘·서운함·질투·언짢음과 세기)은 상대 상태 판정 호출(user-state)이 함께
// 정하고 relationship-update가 관계 행에 적는다(relationship.md 15절, 이슈 #473). 이 파일은 그 값을
// 프롬프트로 옮긴다. 마음 줄에는 생긴 시각과 지난 시간을 코드가 계산해 적는다 — 선톡 문안은 판정
// 없이 저장된 값을 읽어서, 몇 시간 전에 생긴 마음이라는 것을 모델이 알아야 누그러뜨린다.
//
// 드러내는 정도 줄은 단계 번호·마음 종류·상대 상태의 결로 표 한 장에서 고른다. 위에서부터 먼저 맞는
// 줄을 쓴다 — 상대 상태가 안 좋으면 부정적인 마음은 드러내지 않고, 언짢음은 어느 단계에서도 말로
// 하지 않으며, 서운함·질투는 단계가 오를수록 말로 하는 범위가 넓어진다. 줄은 단계 블록의 아직 안
// 하는 것과 어긋나지 않게 맞췄고, 코드가 하는 일은 줄을 고르는 데까지다. 답장 글은 검사하지 않는다.
//
// 오늘 기분(월 리듬의 day_seeds.mood)은 상대와 상관없이 정해진 값이라 이야깃거리로만 싣는다. 마음이
// 없으면 앞 두 줄을 빼고, 오늘 기분도 없으면 블록을 넣지 않는다. 마음 이름과 세기의 짧은 표기
// (mindLabel)는 판정 입력·관계 갱신 목록·슬랙 줄이 같은 모양으로 쓴다.

import type { RelationshipRow } from "../db.js";
import {
  MIND_NAME,
  isMindKind,
  isMindLevel,
  type MindKind,
  type MindLevel,
  type RelationshipStage,
  type UserStateTone,
} from "../labels.js";
import { clockLabel, logicalClockOf, logicalDateOf } from "../kst.js";

/** 관계 행에 저장된 오늘 생긴 마음. */
export interface StoredMind {
  kind: MindKind;
  level: MindLevel;
  reason: string;
  /** 그 마음이 생긴 시각(KST 타임스탬프). */
  since: string;
}

/**
 * 관계 행의 마음 칸을 읽는다. 종류가 목록 밖이거나 세기·생긴 시각이 없으면 없는 것으로 본다 —
 * DB에는 값 제약이 없어서 목록을 바꾼 뒤 남은 옛 값이 있을 수 있다.
 */
export const storedMind = (
  rel:
    | Pick<
        RelationshipRow,
        "mind_kind" | "mind_level" | "mind_reason" | "mind_since"
      >
    | null
    | undefined,
): StoredMind | null => {
  if (!rel) return null;
  const { mind_kind: kind, mind_level: level, mind_since: since } = rel;
  if (!isMindKind(kind) || !isMindLevel(level) || !since) return null;
  return { kind, level, reason: rel.mind_reason?.trim() ?? "", since };
};

/** 마음 이름과 세기를 한 덩이로 — 서운함 2. */
export const mindLabel = (m: { kind: MindKind; level: MindLevel }): string =>
  `${MIND_NAME[m.kind]} ${m.level}`;

/** 생긴 시각 — today(논리일)와 다른 날이면 M/D를 앞에 붙인다. 16:40 / 9/19 23:10 */
export const mindSinceLabel = (since: string, today: string): string => {
  const date = logicalDateOf(since);
  const day =
    date === today
      ? ""
      : `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))} `;
  return `${day}${clockLabel(logicalClockOf(since))}`;
};

/** 두 KST 타임스탬프 사이 — 25분, 2시간, 2시간 25분. 1분이 안 되거나 거꾸로면 null. */
export const elapsedLabel = (from: string, to: string): string | null => {
  const at = (ts: string): number => Date.parse(`${ts.replace(" ", "T")}Z`);
  const min = Math.floor((at(to) - at(from)) / 60_000);
  if (!Number.isFinite(min) || min < 1) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m}분`;
  return m ? `${h}시간 ${m}분` : `${h}시간`;
};

// 드러내는 정도 — relationship.md 15절 「드러내는 정도」 표가 원본이다. 표를 고치면 여기도 고친다.
const FIRST_THE_USER =
  "지금은 상대 상태가 먼저다. 이 마음은 드러내지 않고 상대 말을 먼저 받는다.";
const UPSET = "이 마음은 말로 하지 않는다. 말수가 줄고 장난이 빠지는 정도로만 드러난다.";
const FLUTTER =
  "들뜬 말투로 먼저 드러난다. 좋다는 말은 지금 단계가 하는 것에 적은 만큼만 한다.";
const HURT_OR_JEALOUS: Record<RelationshipStage, string> = {
  1: "말투와 답장 길이에만 반영하고 말로 꺼내지 않는다. 연락이 늦었던 일이면 기다렸다는 티 한 마디까지다.",
  2: "말투에 반영하고 걸리는 티 한 마디까지 낸다. 서운하다거나 질투 난다는 말은 하지 않는다.",
  3: "서운한 티나 가벼운 질투를 한 마디로 돌려서 말해도 된다. 따지거나 삐치지는 않는다.",
  4: "서운하다, 질투 난다고 직접 말해도 된다. 삐쳐도 되고 먼저 풀어도 된다. 얼마나 오래 가는지는 네 결점 값에 적힌 만큼이다.",
};

/**
 * 드러내는 정도 한 줄. 위에서부터 먼저 맞는 조건의 줄을 쓴다 — 상대 상태의 결이 안 좋음이면
 * 원인이 캐릭터든 다른 일이든 설렘 밖의 마음은 드러내지 않는다.
 */
export const mindDisclosure = (
  stage: RelationshipStage,
  kind: MindKind,
  tone: UserStateTone | null | undefined,
): string => {
  if (tone === "bad" && kind !== "flutter") return FIRST_THE_USER;
  if (kind === "upset") return UPSET;
  if (kind === "flutter") return FLUTTER;
  return HURT_OR_JEALOUS[stage];
};

/** 오늘 기분 — 월 리듬이 정해 둔 그날의 값. 이유는 없을 수 있다. */
export interface DayMood {
  mood: string;
  reason: string | null;
}

/** 블록을 만드는 데 드는 값. ContextInput의 일부와 같은 이름을 쓴다. */
export interface MindSectionInput {
  rel: Pick<
    RelationshipRow,
    "mind_kind" | "mind_level" | "mind_reason" | "mind_since" | "user_state_tone"
  > | undefined;
  stage: RelationshipStage;
  mood: DayMood | null;
  /** 지금 시각(KST 타임스탬프) — 지난 시간을 재는 기준. */
  stamp: string;
  logicalToday: string;
}

/** 끝의 마침표를 떼어 문장 뒤에 다시 붙일 수 있게 한다. */
const bare = (s: string): string => s.trim().replace(/[.。]+$/, "");

/** [네 마음] 블록. 마음도 오늘 기분도 없으면 빈 문자열. */
export const mindSection = (input: MindSectionInput): string => {
  const lines: string[] = [];
  const mind = storedMind(input.rel);
  if (mind) {
    const since = mindSinceLabel(mind.since, input.logicalToday);
    const elapsed = elapsedLabel(mind.since, input.stamp);
    const when = elapsed ? `${since}부터, ${elapsed} 지났다` : `${since}에 방금 생겼다`;
    const reason = bare(mind.reason);
    lines.push(
      `- 오늘 대화에서 생긴 마음: ${MIND_NAME[mind.kind]}, 세기 ${mind.level}/3. ${when}.${reason ? ` 계기: ${reason}.` : ""}`,
      `- 드러내는 정도: ${mindDisclosure(input.stage, mind.kind, input.rel?.user_state_tone)}`,
    );
  }
  const mood = input.mood?.mood.trim();
  if (mood) {
    const why = input.mood?.reason ? bare(input.mood.reason) : "";
    lines.push(
      `- 오늘 기분: ${bare(mood)}${why ? ` (${why})` : ""}. 상대를 대하는 태도는 이 기분과 상관없이 같고, 상대가 물을 때 이야깃거리로 꺼낸다.`,
    );
  }
  return lines.length ? [`[네 마음]`, ...lines].join("\n") : "";
};
