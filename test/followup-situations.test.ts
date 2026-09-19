// 침묵 팔로업(followup.ts)의 상황 문단 여섯 — 굿나잇·달래기·살피기·점심·근황·의도 — 을 검사한다.
// 모델은 부르지 않는다.
//
// 각 문단이 제 머리글과 제 사정(자정 넘긴 침묵·나 때문에 안 좋은 상태·이틀째·네 시간·오늘
// 하려던 것)을 적는지, 굿나잇·달래기·살피기는 text만 받고 나머지는 send로 접을 수 있는 형식인지,
// 달래기에 변명·재촉·자러 간다는 말을 막는 줄이 있는지, 살피기에 상대 말 인용·조언·자리 선언을
// 막는 줄이 있는지, 여섯이 서로 다른지 본다.
//
// 오늘의 관계 의도를 받는 셋(굿나잇·근황·의도)은 그 줄이 문단에 실제로 들어가는지, 의도 행이
// 없는 날에도 문단이 제 모양을 지키는지 함께 본다(설계 원본 §4).
// 의도 문단은 남은 줄을 전부 받아 모델이 고르게 하므로, 줄마다 코드가 붙는지와 고른 줄 코드를 받는
// 형식인지도 본다(이슈 #471). 근황·의도 문단은 여는 방식을 넘긴 순서대로 적고 고른 방식 코드를
// 받는지, 근황 문단은 꺼낸 줄 코드를 받는지, 답 없이 남은 물음을 되풀이하지 않되 때가 된 물음은
// 한 번 짧게 물을 수 있다고 적는지 본다(이슈 #475).
//
// followup.ts가 DB와 봇 모듈을 함께 읽으므로 DB는 임시 파일로 새로 만들고 토큰은 가짜다.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// 타입만 가져온다 — 값이 아니라 컴파일 뒤 사라지므로 DB 경로를 정하기 전에 적어도 된다.
import type { RelationshipIntentRow } from "../src/db.js";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";

// DB 경로를 정한 뒤에 읽어야 임시 파일로 열린다 — 정적 import는 이 줄들보다 먼저 돈다.
const { db } = await import("../src/db.js");
const {
  careSituation,
  catchupLines,
  catchupSituation,
  goodnightSituation,
  intentSituation,
  lunchSituation,
  mendSituation,
} = await import("../src/followup.js");

const TEXT_ONLY = /JSON으로만 답한다: \{"text":"\.\.\."\}$/;
const ALL_OPENINGS = ["ask", "reminded", "my_day", "my_question"] as const;
const CATCHUP_PLAIN =
  /JSON으로만 답한다: \{"send":true,"opening":"고른 여는 방식의 코드","text":"\.\.\."\} 또는 \{"send":false\}$/;
const CATCHUP_WITH_LINES =
  /JSON으로만 답한다: \{"send":true,"opening":"고른 여는 방식의 코드","lines":\["문안에 실제로 꺼낸 줄의 코드"\],"text":"\.\.\."\} 또는 \{"send":false\}\. 꺼낸 줄이 없으면 lines는 빈 배열이다\.$/;
const SEND_OR_FOLD =
  /JSON으로만 답한다: \{"send":true,"text":"\.\.\."\} 또는 \{"send":false\}$/;

const intentRow = (
  over: Partial<RelationshipIntentRow> = {},
): RelationshipIntentRow => ({
  id: 1,
  character_id: 1,
  date: "2026-09-10",
  dig: "왜 그 팀을 그만뒀는지",
  share: "요즘 새벽에 러닝 나가는 얘기",
  move: null,
  move_note: null,
  lead_tone: null,
  thread: "다음 주 발표 준비",
  basis_json: null,
  created_at: "2026-09-10 04:00:00",
  ...over,
});

after(() => db.close());

test("굿나잇 문단은 자정 넘긴 침묵을 적고 text만 받는다", () => {
  const out = goodnightSituation(null);
  assert.match(out, /^\[문안 — 지금 보낼 굿나잇 한 통\]/);
  assert.match(out, /자정을 넘겨/);
  assert.match(out, /한 시간쯤 됐다/);
  assert.match(out, TEXT_ONLY);
  assert.doesNotMatch(out, /"send"/);
});

test("굿나잇 문단은 이어갈 자리 줄만 얹고 나머지 의도 줄은 빼놓는다", () => {
  const out = goodnightSituation(intentRow());
  assert.match(out, /다음 주 발표 준비/);
  assert.doesNotMatch(out, /왜 그 팀을 그만뒀는지/);
  assert.doesNotMatch(out, /새벽에 러닝/);
  assert.match(out, TEXT_ONLY);
});

test("달래기 문단은 상대 상태를 가리키고 변명·재촉·자러 간다는 말을 막는다", () => {
  const out = mendSituation();
  assert.match(out, /^\[문안 — 지금 보낼 달래기 한 통\]/);
  assert.match(out, /\[상대의 지금 상태\]/);
  assert.match(out, /30분쯤 됐다/);
  assert.match(out, /변명하지 않는다/);
  assert.match(out, /재촉하지 않는다/);
  assert.match(out, /자러 간다는 말도/);
  assert.match(out, TEXT_ONLY);
  assert.doesNotMatch(out, /"send"/);
});

test("살피기 문단은 상대의 일이 원인임을 적고 인용·조언·자리 선언·자러 간다는 말을 막는다", () => {
  const out = careSituation(32);
  assert.match(out, /^\[문안 — 지금 보낼 살피기 한 통\]/);
  assert.match(out, /\[상대의 지금 상태\]/);
  assert.match(out, /자기 일로 안 좋은 상태/);
  assert.match(out, /너 때문이 아니라/);
  // 끊긴 시간은 잰 값으로 적는다 — 한 시간 안은 10분 단위, 그 뒤는 시간 단위.
  assert.match(out, /끊긴 지 30분쯤 됐다/);
  assert.match(careSituation(47), /끊긴 지 40분쯤 됐다/);
  assert.match(careSituation(200), /끊긴 지 3시간쯤 됐다/);
  assert.match(out, /그대로 옮기거나 말만 바꿔 되돌려주지 않는다/);
  assert.match(out, /조언하지 않고/);
  assert.match(out, /재촉하지 않는다/);
  assert.match(out, /네 자리를 선언하지 않는다/);
  assert.match(out, /자러 간다는 말도/);
  assert.match(out, TEXT_ONLY);
  assert.doesNotMatch(out, /"send"/);
  // 달래기와 갈리는 자리 — 변명을 막는 줄은 달래기에만 있고, 여기엔 원인이 상대의 일이라고 적는다.
  assert.doesNotMatch(out, /변명하지 않는다/);
  assert.doesNotMatch(mendSituation(), /너 때문이 아니라/);
});

test("점심 문단은 이틀째 침묵과 아침 한 통을 적고 send로 접을 수 있다", () => {
  const out = lunchSituation();
  assert.match(out, /^\[문안 — 지금 보낼 점심 한 통\]/);
  assert.match(out, /이틀째 답이 없다/);
  assert.match(out, /아침에 한 통 보냈고/);
  assert.match(out, /억지스러우면 send=false/);
  assert.match(out, SEND_OR_FOLD);
});

test("근황 문단은 네 시간 침묵과 여는 방식을 적고 고른 방식 코드를 받는다", () => {
  const out = catchupSituation([], [...ALL_OPENINGS]);
  assert.match(out, /^\[문안 — 지금 보낼 근황 한 통\]/);
  assert.match(out, /네 시간 넘게 조용하다/);
  assert.match(out, /- ask\(뭐 하냐고 묻기\): 상대가 지금 뭐 하는지 묻는다\. 이 방식을 지금 써도 되는지는 \[관계 단계\]를 따른다\./);
  assert.match(out, /- reminded\(뭐 하다가 네 생각이 났다고 하기\): .*\[관계 단계\]를 따른다\./);
  assert.match(out, /- my_day\(내 일상 전하기\): /);
  assert.match(out, /- my_question\(내 일상에서 나온 물음\): /);
  assert.match(out, /상대가 한 말을 첫마디로 꺼내며 열지 않는다/);
  assert.match(out, /\[상대가 전에 한 말\]/);
  assert.match(out, /재촉하지 않는다/);
  assert.match(out, /억지스러우면 send=false/);
  assert.match(out, CATCHUP_PLAIN);
  // 줄을 안 넘긴 날은 줄 목록도 lines 칸도 없다.
  assert.doesNotMatch(out, /하려던 것/);
  assert.doesNotMatch(out, /"lines"/);
});

test("근황·의도 문단은 넘긴 여는 방식만 넘긴 순서대로 적는다", () => {
  const openings = ["my_question", "ask", "my_day"] as const;
  const catchup = catchupSituation([], [...openings]);
  const intent = intentSituation(
    [{ line: "thread", text: "다음 주 발표 준비" }],
    [...openings],
  );
  for (const out of [catchup, intent]) {
    assert.doesNotMatch(out, /- reminded\(/);
    assert.ok(out.indexOf("- my_question(") < out.indexOf("- ask("));
    assert.ok(out.indexOf("- ask(") < out.indexOf("- my_day("));
    assert.match(out, /위에 먼저 적은 것을 고르고, 코드를 답에 적는다/);
  }
});

test("근황 문단은 답 없이 남은 물음을 되풀이하지 않되 때가 된 물음은 한 번 짧게 묻게 한다", () => {
  const out = catchupSituation([], [...ALL_OPENINGS]);
  assert.match(out, /물음이나 부탁을 같은 모양으로 다시 하지 않고, 그 말과 같은 첫마디로 열지 않는다/);
  assert.match(out, /때가 정해진 일을 앞두고 물은 것이고 지금 시각이 그 때가 됐으면/);
  assert.match(out, /정했는지 묻는 식이다/);
  assert.match(out, /이미 그렇게 다시 물은 말이면 더 묻지 않는다/);
});

test("근황 문단은 넘긴 줄을 코드와 함께 적고 꺼낸 줄 코드를 받는다", () => {
  const lines = catchupLines(intentRow(), []);
  assert.deepEqual(lines, [
    { line: "share", text: "요즘 새벽에 러닝 나가는 얘기" },
    { line: "dig", text: "왜 그 팀을 그만뒀는지" },
  ]);
  const out = catchupSituation(lines, [...ALL_OPENINGS]);
  assert.match(out, /- share\(흘릴 내 얘기\): 요즘 새벽에 러닝 나가는 얘기\. 지금 장면에 얹을 자리가 있으면 흘린다\./);
  assert.match(out, /- dig\(파고들 것\): 왜 그 팀을 그만뒀는지\. .*물음으로 끝내지 않고/);
  assert.match(out, /언제부터 꺼낼지 적혀 있으면 그 전에는 그 줄을 쓰지 않는다/);
  // 이어갈 자리는 근황 문단에 오지 않는다.
  assert.doesNotMatch(out, /다음 주 발표 준비/);
  assert.match(out, CATCHUP_WITH_LINES);
});

test("근황에 얹는 줄은 오늘 이미 쓴 줄과 값이 빈 줄을 뺀다", () => {
  assert.deepEqual(catchupLines(intentRow(), ["dig"]), [
    { line: "share", text: "요즘 새벽에 러닝 나가는 얘기" },
  ]);
  assert.deepEqual(catchupLines(intentRow({ share: null }), []), [
    { line: "dig", text: "왜 그 팀을 그만뒀는지" },
  ]);
  assert.deepEqual(catchupLines(intentRow(), ["share", "dig"]), []);
  assert.deepEqual(catchupLines(null, []), []);
});

test("의도 행이 빈 날에도 근황·굿나잇 문단은 제 형식을 지킨다", () => {
  const empty = intentRow({ dig: null, share: null, thread: null });
  const catchup = catchupSituation(catchupLines(empty, []), [...ALL_OPENINGS]);
  const goodnight = goodnightSituation(empty);
  assert.match(catchup, CATCHUP_PLAIN);
  assert.match(goodnight, TEXT_ONLY);
  // 값이 없는 줄은 빈 줄로 남지 않는다 — 응답 형식 앞 한 줄만 비운다.
  assert.doesNotMatch(catchup.replace(/\n\n[^\n]*$/, ""), /\n\n/);
  assert.doesNotMatch(goodnight.replace(/\n\n[^\n]*$/, ""), /\n\n/);
});

const PICK_LINE =
  /JSON으로만 답한다: \{"send":true,"line":"고른 줄의 코드","opening":"고른 여는 방식의 코드","text":"\.\.\."\} 또는 \{"send":false\}$/;

test("의도 문단은 남은 줄을 코드와 함께 전부 적고 고른 줄 코드를 받는다", () => {
  const out = intentSituation(
    [
      { line: "share", text: "요즘 새벽에 러닝 나가는 얘기" },
      { line: "dig", text: "왜 그 팀을 그만뒀는지" },
    ],
    [...ALL_OPENINGS],
  );
  assert.match(out, /^\[문안 — 지금 보낼 한 통\]/);
  assert.match(out, /- share\(흘릴 내 얘기\): 요즘 새벽에 러닝 나가는 얘기/);
  assert.match(out, /- dig\(파고들 것\): 왜 그 팀을 그만뒀는지/);
  // 적은 순서가 곧 동률일 때 고를 순서라 목록 순서를 지킨다.
  assert.ok(out.indexOf("- share(") < out.indexOf("- dig("));
  assert.match(out, /두 시간 넘게 말이 없다/);
  assert.match(out, /지금 상황에 맞는 줄 하나를 골라/);
  assert.match(out, /지금 맞는 줄이 여럿이면 위에 먼저 적은 줄을 고른다/);
  assert.match(out, /그대로 읊지 않는다/);
  assert.match(out, /\[상대가 전에 한 말\]/);
  assert.match(out, /지금 맞는 줄이 없거나 어느 줄로 걸어도 억지스러우면 send=false/);
  assert.match(out, PICK_LINE);
});

test("의도 문단은 줄마다 정하던 여는 모양 대신 여는 방식을 받고 고른 줄을 여는 말 뒤에 잇게 한다", () => {
  const out = intentSituation(
    [{ line: "thread", text: "다음 주 발표 준비" }],
    [...ALL_OPENINGS],
  );
  assert.doesNotMatch(out, /이어갈 자리를 고르면/);
  assert.match(out, /- ask\(뭐 하냐고 묻기\)/);
  assert.match(out, /고른 줄의 얘기는 여는 말 뒤에 잇는다/);
  assert.match(out, /상대가 한 말을 첫마디로 꺼내며 열지 않는다/);
  // 답 없이 남은 말을 다루는 줄은 근황 문단과 같고, 그 말이 꺼낸 줄은 고르지 않는다는 말이 붙는다.
  assert.match(out, /그 말이 이미 꺼낸 얘기의 줄은 고르지 않는다/);
  assert.match(out, /때가 정해진 일을 앞두고 물은 것이고 지금 시각이 그 때가 됐으면/);
});

test("의도 문단은 줄에 적힌 시점과 장면 전에는 그 줄을 고르지 않게 하고 메모가 새벽에 적힌 것을 밝힌다", () => {
  const out = intentSituation(
    [
      { line: "move", text: "기억해서 챙기기 카페 앞을 지날 때" },
      { line: "thread", text: "오후 네 시 모임 어땠는지 저녁부터" },
    ],
    [...ALL_OPENINGS],
  );
  assert.match(out, /새벽에 지난 대화를 읽고 적어 둔 메모다/);
  assert.match(out, /아까·방금 한 얘기라고 부르지 않는다/);
  assert.match(out, /네가 하는 일 안에 그것이 실제로 있을 때만이다/);
  assert.match(out, /언제부터 꺼낼지 적혀 있으면 그 전에는 그 줄을 고르지 않는다/);
  assert.match(out, /지금이 그 장면일 때만 그 줄을 고른다/);
  assert.doesNotMatch(out, /떠올라서 먼저 거는/);
});

test("여섯 문단은 서로 다르고 같은 인자에 같은 값을 돌려준다", () => {
  const all = [
    goodnightSituation(null),
    mendSituation(),
    careSituation(32),
    lunchSituation(),
    catchupSituation([], [...ALL_OPENINGS]),
    intentSituation([{ line: "thread", text: "다음 주 발표 준비" }], [...ALL_OPENINGS]),
  ];
  assert.equal(new Set(all).size, 6);
  assert.equal(goodnightSituation(null), all[0]);
  assert.equal(catchupSituation([], [...ALL_OPENINGS]), all[4]);
});
