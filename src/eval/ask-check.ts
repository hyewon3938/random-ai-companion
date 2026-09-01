// 답 고르기와 신호 합치기를 검사한다 — 모델도 DB도 부르지 않아 값이 안 든다.
//
// 형식이 깨진 답을 다시 부르는 것까지는 트레이스로 보이지만, 두 답 중 어느 쪽을 쓰기로
// 했고 신호를 어떻게 합쳤는지는 밖에서 안 보인다. 여기서 답 두 개를 정해 놓고 고른 결과를
// 본다.
// 사용: yarn eval:ask
import { askReply } from "../reply-ask.js";
import type { ReplyParse } from "../reply-signal.js";

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

const same = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

let bad = 0;
for (const f of fixtures) {
  let calls = 0;
  const draft = await askReply(async (attempt) => {
    calls++;
    return {
      text: attempt === 1 ? f.first : (f.retry ?? ""),
      callId: attempt === 1 ? 11 : 22,
    };
  });
  const problems: string[] = [];
  if (draft.parse !== f.wantParse)
    problems.push(`형식 ${draft.parse}(기대 ${f.wantParse})`);
  if (!same(draft.bubbles, f.wantBubbles))
    problems.push(`말풍선 [${draft.bubbles}](기대 [${f.wantBubbles}])`);
  if (calls !== (f.wantRetried ? 2 : 1))
    problems.push(`호출 ${calls}번(기대 ${f.wantRetried ? 2 : 1})`);
  if ((draft.retryCallId !== null) !== f.wantRetried)
    problems.push(`재생성 기록 ${draft.retryCallId}`);
  if (f.wantNote !== undefined && draft.signals.note !== f.wantNote)
    problems.push(`메모 ${draft.signals.note}(기대 ${f.wantNote})`);
  if (f.wantStay !== undefined && draft.signals.stay !== f.wantStay)
    problems.push(`stay ${draft.signals.stay}(기대 ${f.wantStay})`);
  if (problems.length) bad++;
  console.log(
    `${problems.length ? "✕" : "○"} ${f.name}${problems.length ? " — " + problems.join(" · ") : ""}`,
  );
}

console.log(
  `\n답 고르기 픽스처 ${fixtures.length - bad}/${fixtures.length} 통과`,
);
if (bad) process.exit(1);
