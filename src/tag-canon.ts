// 저장할 태그 이름을 이미 쓰는 이름으로 모으는 자리.
//
// 태그를 새로 짓는 자리는 새벽 정리 하나다. 같은 주제에 이름이 둘 붙으면 한쪽 이름으로 검색할
// 때 다른 쪽 기억이 안 걸리므로, 저장 직전에 후보 이름을 이미 쓰는 이름과 대조한다(이슈 #142).
//
// 두 단계다. 글자가 그대로 같은 후보는 그냥 저장되고, 남은 후보만 모델에게 물어 같은 주제를
// 가리키는지 판정한다. 모델 답도 저장된 목록에 대조해 거른다(tag-pick.ts의 mergeTags와 같은
// 이유) — 목록에 없는 이름으로 옮기면 이름만 하나 더 늘어난다.
//
// 판정은 새벽 정리 한 회차에 한 번이다. 기억·일기·일정의 후보를 한 번에 모아 묻고, 나온 표를
// setTags를 부르는 세 자리가 함께 쓴다. 호출이 실패하면 빈 표를 주어 후보가 그대로 새 이름으로
// 등록된다 — 이름이 갈라지는 것이 저장이 통째로 빠지는 것보다 낫다.

import { chat } from "./llm.js";
import type { CallMeta } from "./llm.js";
import { config } from "./config.js";
import { listTagNames } from "./db.js";
import { TAG_CANON_MAX } from "./thresholds.js";

/** 후보 이름 → 대신 쓸 기존 이름. 표에 없는 후보는 후보 그대로 저장된다. */
export type TagCanon = Map<string, string>;

/**
 * 태그 이름 한 개를 저장할 모양으로 다듬는다 — 앞뒤 공백을 떼고 안쪽 공백을 하나로 줄인다.
 *
 * 후보를 모으는 자리와 저장하는 자리가 같은 규칙을 써야 판정 표의 이름이 저장 직전에 그대로
 * 걸린다. 안쪽 공백까지 줄이는 것은 띄어쓰기만 다른 이름이 따로 쌓이지 않게 하려는 것이다.
 */
export const tidyTag = (v: string): string => v.trim().replace(/\s+/g, " ");

// 새 주제까지 기존 이름으로 밀어 넣으면 그 기억이 엉뚱한 주제에 걸린다 — 합칠지 말지를 두 갈래로
// 두고, 애매하면 그대로 두는 쪽을 고르게 한다.
const CANON_SYSTEM = `너는 저장된 주제 태그 이름을 관리한다.
새 후보가 이미 쓰는 이름과 같은 주제를 가리키면 그 이름으로 합치고, 다른 주제면 그대로 둔다.
- 후보마다 한 줄씩 "후보 -> 이미 쓰는 이름" 또는 "후보 -> 새로"라고 답한다.
- 옮길 이름은 이미 쓰는 목록에 있는 것만 적는다. 목록에 없는 말은 지어내지 않는다.
- 표기만 다르고 같은 것을 가리키면 합친다.
- 한쪽이 다른 쪽의 일부이거나 범위가 더 좁으면 합치지 않는다.
- 애매하면 새로라고 답한다.
다른 말은 하지 않는다.`;

/**
 * 저장할 태그 목록에 판정 표를 적용한다 — 빈 칸을 지우고 같은 이름이 두 번 들어가지 않게 한다.
 *
 * setTags를 부르는 세 자리(기억·일기·일정)가 저장 직전에 이 함수를 지난다. 표가 없으면
 * 다듬기만 하므로, 판정을 못 받은 경로도 지금까지와 같은 값을 저장한다.
 */
export const canonTags = (
  canon: TagCanon | undefined,
  tags: string[],
): string[] => {
  const out: string[] = [];
  for (const t of tags) {
    const v = tidyTag(t);
    if (!v) continue;
    const name = canon?.get(v) ?? v;
    if (!out.includes(name)) out.push(name);
  }
  return out;
};

/**
 * 모델 답에서 후보 → 기존 이름 표를 만든다. 물어본 후보와 이미 쓰는 이름에 둘 다 걸린 줄만 받는다.
 *
 * 목록에 없는 이름으로 옮기라는 답은 버린다 — 그 이름은 아직 아무 기억에도 안 붙어 있어서,
 * 합치는 대신 이름을 하나 더 만드는 셈이 된다. 합치지 말라는 답(새로)도 같은 자리에서 뺀다.
 */
/** 합치지 말라는 답으로 프롬프트가 정해 둔 말. 태그 이름으로 오해하지 않게 따로 뺀다. */
const KEEP_ANSWER = "새로";

export const parseCanon = (
  out: string,
  asked: string[],
  names: string[],
): TagCanon => {
  const askedSet = new Set(asked);
  const nameSet = new Set(names);
  const canon: TagCanon = new Map();
  for (const line of out.split("\n")) {
    const m = /^[-*\s]*(.+?)\s*(?:->|→|=>)\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const [, from, to] = m;
    if (to === KEEP_ANSWER) continue;
    if (!askedSet.has(from) || !nameSet.has(to) || from === to) continue;
    canon.set(from, to);
  }
  return canon;
};

/**
 * 후보 이름을 이미 쓰는 이름과 대조해 판정 표를 만든다 — 새벽 정리 한 회차에 한 번 부른다.
 *
 * 글자가 그대로 같은 후보와 처음 쓰는 캐릭터(이미 쓰는 이름이 없는 경우)는 물을 것이 없어
 * 호출 없이 빈 표로 돌아온다. 판정은 한 번 틀리면 그 이름으로 계속 쌓이므로 새벽 정리의 다른
 * 판정과 같은 모델을 쓴다.
 */
export const resolveTagCanon = async (
  characterId: number,
  candidates: string[],
): Promise<TagCanon> => {
  const names = listTagNames(characterId);
  const known = new Set(names);
  const fresh = [
    ...new Set(candidates.map(tidyTag).filter(Boolean)),
  ].filter((t) => !known.has(t));
  if (!names.length || !fresh.length) return new Map();

  // 한 회차에 물어보는 수를 끊는다 — 후보가 몰린 날에 답이 상한에 잘리면 뒤쪽 줄이 통째로
  // 버려진다. 넘친 후보는 그대로 새 이름으로 등록되고 다음 회차에 다시 후보가 된다.
  const asked = fresh.slice(0, TAG_CANON_MAX);
  const meta: CallMeta = { purpose: "tag_canon", characterId };
  try {
    const out = await chat(
      CANON_SYSTEM,
      [
        {
          role: "user",
          content: `이미 쓰는 이름: ${names.join(", ")}\n새 후보: ${asked.join(", ")}`,
        },
      ],
      // 한 줄이 후보 하나라 후보 수에 맞춰 잡는다. 생각 과정을 켜면 그 몫이 출력으로 나가
      // 답이 잘리므로 끈다(tag-pick.ts와 같은 이유).
      64 + asked.length * 48,
      config.modelDeep,
      meta,
      { think: false },
    );
    return parseCanon(out, asked, names);
  } catch (e) {
    // 판정을 못 받았다고 그날 저장을 통째로 접지 않는다 — 후보가 그대로 새 이름이 된다.
    console.error(
      "[tag-canon] 태그 이름 판정 실패:",
      e instanceof Error ? e.message : String(e),
    );
    return new Map();
  }
};
