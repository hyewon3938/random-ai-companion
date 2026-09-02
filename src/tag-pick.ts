// 이번 발화로 무엇을 검색할지 주제 태그를 고르는 자리.
//
// 답장을 만들기 전에 짧은 호출(128토큰) 한 번으로, 이미 저장된 태그 이름 중에서 관련 있는
// 것을 고른다. 답은 저장된 목록에 대조해 거른다(mergeTags) — 목록에 없는 말을 그대로 받으면
// 유저가 쓴 낱말이 태그가 되어 검색이 헛돈다.
//
// 글자가 일치하는 태그(tagSearch)와 합쳐 최대 TAG_PICK_MAX개까지 쓰고, 호출이 실패하면
// 글자 일치만으로 이어 간다.

import { chat } from "./llm.js";
import type { CallMeta } from "./llm.js";
import { config } from "./config.js";
import { listTagNames } from "./db.js";
import { tagSearch } from "./memory.js";
import { TAG_PICK_MAX } from "./thresholds.js";

/** 이번 발화의 검색어를 무엇이 골랐는지. */
export type TagPicker = "model" | "match" | "none";

export interface TagPick {
  /** 이번 발화로 검색할 태그 이름. */
  tags: string[];
  /** 고를 수 있었던 태그 수 — 하나도 못 고른 이유가 없어서인지 안 걸려서인지 가른다. */
  pool: number;
  by: TagPicker;
  /** 주제를 고른 모델 호출 번호 — 트레이스가 답장 옆에 나란히 적는다. */
  callId: number | null;
}

// 이번 메시지가 어떤 주제에 걸리는지만 고른다. 목록에 있는 이름만 고르게 해서, 유저가 쓰는
// 낱말로 태그가 불어나지 않게 한다 — 태그를 새로 짓는 자리는 새벽 정리 하나뿐이다.
const PICK_SYSTEM = `너는 메신저 대화를 읽고 한 가지만 고른다.
아래 태그 목록에서 상대가 방금 보낸 말과 관련 있는 것을 골라 쉼표로 이어 답한다.
- 목록에 있는 이름만 고른다. 목록에 없는 말은 지어내지 않는다.
- 글자가 같지 않아도 같은 주제를 가리키면 고른다.
- 관련 있는 것이 없으면 없음이라고만 답한다.
- 최대 ${TAG_PICK_MAX}개.
다른 말은 하지 않는다.`;

/**
 * 모델이 답한 이름 중 목록에 있는 것만 남기고, 글자가 일치한 태그와 합친다.
 *
 * 목록에 없는 말은 버린다 — 유저가 쓴 낱말이 그대로 태그가 되면 주제로 묶이지 않는다.
 */
export const mergeTags = (
  out: string,
  names: string[],
  matched: string[],
): string[] => {
  const known = new Set(names);
  const picked = out
    .split(/[,\n·]/)
    .map((s) => s.trim())
    .filter((s) => known.has(s));
  return [...new Set([...picked, ...matched])].slice(0, TAG_PICK_MAX);
};

/**
 * 이번 발화로 검색할 태그를 고른다 — 답장을 만들기 전에 도는 짧은 호출이다.
 *
 * 모델이 고른 것과 글자가 그대로 일치하는 것을 함께 쓴다. 글자 일치는 태그 이름이 발화에
 * 그대로 들어 있는 경우라 근거가 확실하고, 모델이 놓친 것을 받쳐 준다.
 * 호출이 실패하면 글자 일치만으로 검색해 지금까지의 동작을 그대로 유지한다.
 */
export const pickTags = async (
  characterId: number,
  text: string,
): Promise<TagPick> => {
  const names = listTagNames(characterId);
  const matched = tagSearch(characterId, text);
  if (!names.length || !text.trim())
    return { tags: [], pool: names.length, by: "none", callId: null };

  const meta: CallMeta = { purpose: "tags", characterId };
  try {
    const out = await chat(
      PICK_SYSTEM,
      [
        {
          role: "user",
          content: `태그 목록: ${names.join(", ")}\n상대가 방금 보낸 말: ${text}`,
        },
      ],
      128,
      config.model,
      meta,
      // 생각 과정을 켜면 상한 128토큰을 거기서 다 쓰고 답이 비어 돌아온다.
      { think: false },
    );
    // 빈 답은 고른 것이 없는 게 아니라 못 고른 것이다 — 글자 일치만으로 이어 간다.
    if (!out.trim())
      return {
        tags: matched.tags.slice(0, TAG_PICK_MAX),
        pool: names.length,
        by: "match",
        callId: meta.callId ?? null,
      };
    return {
      tags: mergeTags(out, names, matched.tags),
      pool: names.length,
      by: "model",
      callId: meta.callId ?? null,
    };
  } catch {
    // 고르지 못했다고 검색을 통째로 접지 않는다 — 글자가 일치하는 것만으로 이어 간다.
    return {
      tags: matched.tags.slice(0, TAG_PICK_MAX),
      pool: names.length,
      by: "match",
      callId: meta.callId ?? null,
    };
  }
};
