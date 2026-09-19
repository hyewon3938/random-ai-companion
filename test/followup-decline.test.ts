// 안 보낸다는 판정을 기억하는 자리(followup.ts)를 검사한다. 모델은 부르지 않는다.
//
// 의도·근황 선톡은 보낼지까지 모델이 정하는데, 안 보낸다는 답을 안 기억하면 15분 뒤 틱이 같은
// 물음을 다시 던진다(이슈 #359). 자리는 각본 블록과 마지막 말 둘로 잡으므로, 같은 자리면 접은
// 채로 두고 둘 중 하나가 바뀌면 다시 묻는지 본다. 종류와 방이 서로 섞이지 않는 것도 함께 본다.
//
// 문안 호출이 실패한 자리도 같은 방식으로 기억하는지, 의도 선톡이 모델이 적은 줄 코드를 후보에서
// 찾아 발송 기록에 싣고 못 찾으면 접는지 함께 본다(이슈 #471).
//
// followup.ts가 DB와 봇 모듈을 함께 읽으므로 DB는 임시 파일로 새로 만들고 토큰은 가짜다.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "followup-decline-")), "t.db");
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";

const { db } = await import("../src/db.js");
const {
  declineSpot,
  declinedHere,
  pickedIntentLine,
  readIntentOnce,
  readSendTextOnce,
  rememberDecline,
  rememberFailure,
} = await import("../src/followup.js");

after(() => {
  db.close();
});

const LAST = "2026-09-10 14:02:00";

test("같은 블록·같은 마지막 말이면 다시 묻지 않는다", () => {
  const spot = declineSpot("13:00", LAST);
  assert.equal(declinedHere("chat-a", "intent", spot), false);
  rememberDecline("chat-a", "intent", spot);
  assert.equal(declinedHere("chat-a", "intent", spot), true);
});

test("블록이 바뀌거나 누가 말을 하면 다시 묻는다", () => {
  rememberDecline("chat-b", "catchup", declineSpot("13:00", LAST));
  // 각본이 다음 블록으로 넘어갔다
  assert.equal(declinedHere("chat-b", "catchup", declineSpot("15:00", LAST)), false);
  // 같은 블록인데 그 사이 말이 오갔다
  assert.equal(
    declinedHere("chat-b", "catchup", declineSpot("13:00", "2026-09-10 14:40:00")),
    false,
  );
});

test("종류와 방은 서로 섞이지 않는다", () => {
  const spot = declineSpot("13:00", LAST);
  rememberDecline("chat-c", "intent", spot);
  assert.equal(declinedHere("chat-c", "catchup", spot), false);
  assert.equal(declinedHere("chat-d", "intent", spot), false);
});

test("read는 문안을 받으면 그대로 주고 접었을 때만 자리를 적는다", () => {
  const spot = declineSpot("09:00", LAST);
  const read = readSendTextOnce("chat-e", "intent", spot);
  assert.equal(read({ send: true, text: "일어났어?" }), "일어났어?");
  assert.equal(declinedHere("chat-e", "intent", spot), false);
  assert.equal(read({ send: false }), null);
  assert.equal(declinedHere("chat-e", "intent", spot), true);
});

test("send가 참이어도 문안이 비면 접은 것으로 센다", () => {
  const spot = declineSpot("09:00", LAST);
  const read = readSendTextOnce("chat-f", "catchup", spot);
  assert.equal(read({ send: true, text: "" }), null);
  assert.equal(declinedHere("chat-f", "catchup", spot), true);
});

test("문안 호출이 실패한 자리만 기억한다", () => {
  const spot = declineSpot("11:00", LAST);
  rememberFailure("sent", "chat-g", "intent", spot);
  rememberFailure("held", "chat-g", "intent", spot);
  rememberFailure("skipped", "chat-g", "intent", spot);
  assert.equal(declinedHere("chat-g", "intent", spot), false);
  rememberFailure("failed", "chat-g", "intent", spot);
  assert.equal(declinedHere("chat-g", "intent", spot), true);
  // 종류가 다르면 따로 센다.
  assert.equal(declinedHere("chat-g", "catchup", spot), false);
});

test("고른 줄은 코드나 이름으로 찾고, 여럿이 겹치면 못 찾은 것으로 센다", () => {
  const both: ("dig" | "thread")[] = ["dig", "thread"];
  assert.equal(pickedIntentLine("thread", both), "thread");
  assert.equal(pickedIntentLine(" dig ", both), "dig");
  assert.equal(pickedIntentLine("이어갈 자리", both), "thread");
  // 앞뒤에 말을 붙였어도 그 안에 든 후보가 하나면 그 줄이다.
  assert.equal(pickedIntentLine("thread(이어갈 자리)", both), "thread");
  // 후보에 없는 줄이나 둘 다 든 말은 어느 줄인지 셀 수 없다.
  assert.equal(pickedIntentLine("share", both), null);
  assert.equal(pickedIntentLine("dig 아니면 thread", both), null);
  assert.equal(pickedIntentLine(undefined, both), null);
  // 후보가 하나면 line을 안 적었거나 잘못 적어도 그 줄이다.
  assert.equal(pickedIntentLine(undefined, ["dig"]), "dig");
  assert.equal(pickedIntentLine("share", ["dig"]), "dig");
});

test("의도 read는 고른 줄을 발송 기록 값으로 주고 못 찾으면 접는다", () => {
  const spot = declineSpot("15:00", LAST);
  const read = readIntentOnce("chat-h", spot, ["share", "thread"]);
  assert.deepEqual(read({ send: true, line: "share", text: "나 오늘 새벽에 뛰었어" }), {
    text: "나 오늘 새벽에 뛰었어",
    meta: { intent_line: "share" },
  });
  assert.equal(declinedHere("chat-h", "intent", spot), false);
  // 후보에 없는 줄을 적었으면 보내지 않고 그 자리를 기억한다.
  assert.equal(read({ send: true, line: "move", text: "뭐 해" }), null);
  assert.equal(declinedHere("chat-h", "intent", spot), true);
});

test("의도 read도 안 보낸다는 답이면 자리를 기억한다", () => {
  const spot = declineSpot("16:00", LAST);
  const read = readIntentOnce("chat-i", spot, ["dig"]);
  assert.equal(read({ send: false }), null);
  assert.equal(declinedHere("chat-i", "intent", spot), true);
});
