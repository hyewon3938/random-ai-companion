// 안 보낸다는 판정을 기억하는 자리(followup.ts)를 검사한다. 모델은 부르지 않는다.
//
// 의도·근황 선톡은 보낼지까지 모델이 정하는데, 안 보낸다는 답을 안 기억하면 15분 뒤 틱이 같은
// 물음을 다시 던진다(이슈 #359). 자리는 각본 블록과 마지막 말 둘로 잡으므로, 같은 자리면 접은
// 채로 두고 둘 중 하나가 바뀌면 다시 묻는지 본다. 종류와 방이 서로 섞이지 않는 것도 함께 본다.
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
const { declineSpot, declinedHere, readSendTextOnce, rememberDecline } =
  await import("../src/followup.js");

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
