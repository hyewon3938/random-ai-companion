// 답 고르기와 신호 합치기를 검사한다 — 모델도 DB도 부르지 않아 값이 안 든다.
//
// 형식이 깨진 답을 다시 부르는 것까지는 트레이스로 보이지만, 두 답 중 어느 쪽을 쓰기로
// 했고 신호를 어떻게 합쳤는지는 밖에서 안 보인다. 여기서 답 두 개를 정해 놓고 고른 결과를
// 본다.
import assert from "node:assert/strict";
import { test } from "node:test";

import { askReply } from "../src/reply-ask.js";
import type { ReplyParse } from "../src/reply-signal.js";

const JSON_OK = '{"reply":["헐 진짜?","그래서 어떻게 됐어?"]}';
const JSON_NOTE = '{"reply":["오 축하해"],"note":"자격증 붙음"}';
const JSON_STAY = '{"reply":["그럼 좀 더 있을게"],"stay":true}';
const PLAIN = "그냥 줄글로 답함";
const PLAIN2 = "두 번째도 줄글";
const CUT = '{"reply":["앞말풍선","뒤가 잘린';

const fixtures: {
  name: string;
  first: string;
  /** 두 번째 답. 없으면 다시 부르지 않아야 하는 자리다. */
  retry?: string;
  wantParse: ReplyParse;
  wantBubbles: string[];
  wantNote?: string | null;
  wantStay?: boolean;
  wantRetried: boolean;
}[] = [
  {
    name: "첫 답이 멀쩡하면 다시 안 부른다",
    first: JSON_OK,
    wantParse: "json",
    wantBubbles: ["헐 진짜?", "그래서 어떻게 됐어?"],
    wantRetried: false,
  },
  {
    name: "평문이면 다시 불러 JSON을 쓴다",
    first: PLAIN,
    retry: JSON_OK,
    wantParse: "json",
    wantBubbles: ["헐 진짜?", "그래서 어떻게 됐어?"],
    wantRetried: true,
  },
  {
    name: "둘 다 평문이면 첫 답을 쓴다",
    first: PLAIN,
    retry: PLAIN2,
    wantParse: "plain",
    wantBubbles: [PLAIN],
    wantRetried: true,
  },
  {
    name: "다시 부른 답이 더 나쁘면 첫 답을 쓴다",
    first: CUT,
    retry: PLAIN,
    wantParse: "salvage",
    wantBubbles: ["앞말풍선"],
    wantRetried: true,
  },
  {
    name: "첫 답의 신호는 갈아 끼워도 남는다",
    first: JSON_NOTE.replace('{"reply":["오 축하해"],', '{"reply":[],'),
    retry: JSON_OK,
    wantParse: "json",
    wantBubbles: ["헐 진짜?", "그래서 어떻게 됐어?"],
    wantNote: "자격증 붙음",
    wantRetried: true,
  },
  {
    name: "다시 부른 답의 신호도 받는다",
    first: PLAIN,
    retry: JSON_STAY,
    wantParse: "json",
    wantBubbles: ["그럼 좀 더 있을게"],
    wantStay: true,
    wantRetried: true,
  },
];

for (const f of fixtures) {
  test(f.name, async () => {
    let calls = 0;
    const draft = await askReply(async (attempt) => {
      calls++;
      return {
        text: attempt === 1 ? f.first : (f.retry ?? ""),
        callId: attempt === 1 ? 11 : 22,
      };
    });
    assert.equal(draft.parse, f.wantParse);
    assert.deepEqual(draft.bubbles, f.wantBubbles);
    assert.equal(calls, f.wantRetried ? 2 : 1);
    assert.equal(draft.retryCallId !== null, f.wantRetried);
    if (f.wantNote !== undefined) assert.equal(draft.signals.note, f.wantNote);
    if (f.wantStay !== undefined) assert.equal(draft.signals.stay, f.wantStay);
  });
}
