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
  catchupSituation,
  goodnightSituation,
  intentSituation,
  lunchSituation,
  mendSituation,
} = await import("../src/followup.js");

const TEXT_ONLY = /JSON으로만 답한다: \{"text":"\.\.\."\}$/;
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

test("근황 문단은 상대가 전에 한 말을 먼저 보라고 적는다", () => {
  const out = catchupSituation(null);
  assert.match(out, /^\[문안 — 지금 보낼 근황 한 통\]/);
  assert.match(out, /네 시간 넘게 조용하다/);
  assert.match(out, /\[상대가 전에 한 말\]/);
  assert.match(out, /재촉하지 않는다/);
  assert.match(out, /억지스러우면 send=false/);
  assert.match(out, SEND_OR_FOLD);
});

test("근황 문단은 흘릴 내 얘기와 파고들 것을 얹고 이어갈 자리는 빼놓는다", () => {
  const out = catchupSituation(intentRow());
  assert.match(out, /새벽에 러닝 나가는 얘기/);
  assert.match(out, /왜 그 팀을 그만뒀는지/);
  assert.doesNotMatch(out, /다음 주 발표 준비/);
});

test("의도 행이 빈 날에도 근황·굿나잇 문단은 제 형식을 지킨다", () => {
  const empty = intentRow({ dig: null, share: null, thread: null });
  const catchup = catchupSituation(empty);
  const goodnight = goodnightSituation(empty);
  assert.match(catchup, SEND_OR_FOLD);
  assert.match(goodnight, TEXT_ONLY);
  // 값이 없는 줄은 빈 줄로 남지 않는다 — 응답 형식 앞 한 줄만 비운다.
  assert.doesNotMatch(catchup.replace(/\n\n[^\n]*$/, ""), /\n\n/);
  assert.doesNotMatch(goodnight.replace(/\n\n[^\n]*$/, ""), /\n\n/);
});

test("의도 문단은 고른 줄의 이름과 내용을 적고 그대로 읊지 말라고 한다", () => {
  const out = intentSituation("dig", "왜 그 팀을 그만뒀는지");
  assert.match(out, /^\[문안 — 지금 보낼 한 통\]/);
  assert.match(out, /파고들 것: 왜 그 팀을 그만뒀는지/);
  assert.match(out, /두 시간 넘게 말이 없다/);
  assert.match(out, /그대로 읊지 않는다/);
  assert.match(out, /\[상대가 전에 한 말\]/);
  assert.match(out, SEND_OR_FOLD);
});

test("여섯 문단은 서로 다르고 같은 인자에 같은 값을 돌려준다", () => {
  const all = [
    goodnightSituation(null),
    mendSituation(),
    careSituation(32),
    lunchSituation(),
    catchupSituation(null),
    intentSituation("thread", "다음 주 발표 준비"),
  ];
  assert.equal(new Set(all).size, 6);
  assert.equal(goodnightSituation(null), all[0]);
  assert.equal(catchupSituation(null), all[4]);
});
