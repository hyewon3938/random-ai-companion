// 침묵 팔로업(followup.ts)의 상황 문단 넷 — 굿나잇·달래기·점심·근황 — 을 검사한다. 모델은 부르지 않는다.
//
// 네 문단은 인자가 없고 분기도 없다. 각 문단이 제 머리글과 제 사정(자정 넘긴 침묵·나 때문에 안 좋은
// 상태·이틀째·네 시간)을 적는지, 굿나잇·달래기는 text만 받고 점심·근황은 send로 접을 수 있는
// 형식인지, 달래기에 변명·재촉·자러 간다는 말을 막는 줄이 있는지, 넷이 서로 다른지 본다.
//
// followup.ts가 DB와 봇 모듈을 함께 읽으므로 DB는 임시 파일로 새로 만들고 토큰은 가짜다.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";

// DB 경로를 정한 뒤에 읽어야 임시 파일로 열린다 — 정적 import는 이 줄들보다 먼저 돈다.
const { db } = await import("../src/db.js");
const { catchupSituation, goodnightSituation, lunchSituation, mendSituation } =
  await import("../src/followup.js");

const TEXT_ONLY = /JSON으로만 답한다: \{"text":"\.\.\."\}$/;
const SEND_OR_FOLD =
  /JSON으로만 답한다: \{"send":true,"text":"\.\.\."\} 또는 \{"send":false\}$/;

after(() => db.close());

test("굿나잇 문단은 자정 넘긴 침묵을 적고 text만 받는다", () => {
  const out = goodnightSituation();
  assert.match(out, /^\[문안 — 지금 보낼 굿나잇 한 통\]/);
  assert.match(out, /자정을 넘겨/);
  assert.match(out, /한 시간쯤 됐다/);
  assert.match(out, TEXT_ONLY);
  assert.doesNotMatch(out, /"send"/);
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

test("점심 문단은 이틀째 침묵과 아침 한 통을 적고 send로 접을 수 있다", () => {
  const out = lunchSituation();
  assert.match(out, /^\[문안 — 지금 보낼 점심 한 통\]/);
  assert.match(out, /이틀째 답이 없다/);
  assert.match(out, /아침에 한 통 보냈고/);
  assert.match(out, /억지스러우면 send=false/);
  assert.match(out, SEND_OR_FOLD);
});

test("근황 문단은 네 시간 침묵을 적고 send로 접을 수 있다", () => {
  const out = catchupSituation();
  assert.match(out, /^\[문안 — 지금 보낼 근황 한 통\]/);
  assert.match(out, /네 시간 넘게 조용하다/);
  assert.match(out, /재촉하지 않는다/);
  assert.match(out, /억지스러우면 send=false/);
  assert.match(out, SEND_OR_FOLD);
});

test("네 문단은 서로 다르고 인자 없이 같은 값을 돌려준다", () => {
  const all = [
    goodnightSituation(),
    mendSituation(),
    lunchSituation(),
    catchupSituation(),
  ];
  assert.equal(new Set(all).size, 4);
  assert.equal(goodnightSituation(), all[0]);
  assert.equal(catchupSituation(), all[3]);
});
