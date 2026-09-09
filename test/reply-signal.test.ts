// 모델이 쓴 답 한 덩이를 말풍선과 신호로 가르는 자리를 검사한다.
//
// 형식이 깨졌을 때 무엇을 건지고 무엇을 버리는지가 전부 여기서 갈린다. 잘못 읽으면 신호가
// 조용히 사라지거나(답장은 그대로 나가서 실패로 안 잡힌다) JSON 조각이 그대로 말풍선이 되어
// 상대에게 간다. 어느 길로 읽었는지를 남기는 이름(json·stray·salvage·plain·empty)도 같이 본다.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EMPTY_SIGNALS,
  mergeSignals,
  parseReplyOutput,
} from "../src/reply-signal.js";

test("객체를 제대로 쓰면 그대로 읽는다", () => {
  const got = parseReplyOutput('{"reply":["헐 진짜?","그래서 어떻게 됐어?"]}');
  assert.equal(got.parse, "json");
  assert.deepEqual(got.bubbles, ["헐 진짜?", "그래서 어떻게 됐어?"]);
  assert.deepEqual(got.signals, EMPTY_SIGNALS);
});

test("같은 객체 안의 신호를 읽는다", () => {
  const got = parseReplyOutput(
    '{"reply":["오 축하해"],"note":"상대가 자격증에 붙었다","stay":true}',
  );
  assert.equal(got.parse, "json");
  assert.equal(got.signals.note, "상대가 자격증에 붙었다");
  assert.equal(got.signals.stay, true);
});

test("객체 밖으로 흘린 신호도 주워 온다", () => {
  const got = parseReplyOutput(
    '{"reply":["오 축하해"]}\nnote: 상대가 자격증에 붙었다',
  );
  // 주웠다는 것을 이름에 남긴다 — 형식 설명을 고쳐도 계속 새는지 보려는 것이다
  assert.equal(got.parse, "stray");
  assert.deepEqual(got.bubbles, ["오 축하해"]);
  assert.equal(got.signals.note, "상대가 자격증에 붙었다");
});

test("코드펜스를 둘러도 읽는다", () => {
  const got = parseReplyOutput('```json\n{"reply":["안녕"]}\n```');
  assert.equal(got.parse, "json");
  assert.deepEqual(got.bubbles, ["안녕"]);
});

test("잘린 답에서는 온전히 닫힌 말풍선만 건진다", () => {
  const got = parseReplyOutput('{"reply":["앞말풍선","뒤가 잘린');
  assert.equal(got.parse, "salvage");
  // 반 토막 난 말은 보내느니 버린다
  assert.deepEqual(got.bubbles, ["앞말풍선"]);
});

test("본문 속 대괄호를 배열 끝으로 오해하지 않는다", () => {
  const got = parseReplyOutput('{"reply":["[어제 22:10] 그때 말이야","뒤가 잘린');
  assert.equal(got.parse, "salvage");
  assert.deepEqual(got.bubbles, ["그때 말이야"]);
});

test("객체를 아예 안 쓰면 본문 그대로 내보낸다", () => {
  const got = parseReplyOutput("그냥 줄글로 답함");
  assert.equal(got.parse, "plain");
  assert.deepEqual(got.bubbles, ["그냥 줄글로 답함"]);
});

test("건질 게 없으면 빈 답으로 남긴다", () => {
  assert.equal(parseReplyOutput("").parse, "empty");
  assert.equal(parseReplyOutput('{"reply":[]}').parse, "empty");
});

test("기록의 시간 표시를 흉내 낸 머리표는 지운다", () => {
  const got = parseReplyOutput('{"reply":["[어제 22:10] 밥 먹었어?"]}');
  assert.deepEqual(got.bubbles, ["밥 먹었어?"]);
});

test("원소 안의 줄바꿈도 말풍선으로 나눈다", () => {
  const got = parseReplyOutput('{"reply":["오늘 뭐해?\\n나는 집"]}');
  assert.deepEqual(got.bubbles, ["오늘 뭐해?", "나는 집"]);
});

test("말풍선이 넘치면 뒷부분만 하나로 합친다", () => {
  const got = parseReplyOutput('{"reply":["1","2","3","4","5","6","7"]}');
  assert.deepEqual(got.bubbles, ["1", "2", "3", "4", "5", "6 7"]);
});

test("참으로 읽는 값은 좁게 잡는다", () => {
  // 형식이 흔들려도 신호는 명시적으로 켠 것만 켠다
  assert.equal(parseReplyOutput('{"reply":["ㅇㅇ"],"stay":"yes"}').signals.stay, false);
  assert.equal(parseReplyOutput('{"reply":["ㅇㅇ"],"stay":"true"}').signals.stay, true);
});

test("두 답의 신호를 합칠 때는 먼저 나온 값을 남긴다", () => {
  const a = { ...EMPTY_SIGNALS, note: "먼저", stay: false };
  const b = { ...EMPTY_SIGNALS, note: "나중", stay: true };
  const got = mergeSignals(a, b);
  assert.equal(got.note, "먼저");
  assert.equal(got.stay, true);
});

test("연락 약속은 객체 안에서도 흘린 줄에서도 읽는다", () => {
  const inside = parseReplyOutput(
    '{"reply":["통화 끝나고 연락할게"],"promise":"통화 끝나고 다시 연락"}',
  );
  assert.equal(inside.parse, "json");
  assert.equal(inside.signals.promise, "통화 끝나고 다시 연락");
  const stray = parseReplyOutput(
    '{"reply":["통화 끝나고 연락할게"]}\npromise: 통화 끝나고 다시 연락',
  );
  assert.equal(stray.parse, "stray");
  assert.equal(stray.signals.promise, "통화 끝나고 다시 연락");
});

test("약속을 안 하면 null이고 합칠 때는 앞 것이 남는다", () => {
  assert.equal(parseReplyOutput('{"reply":["응"]}').signals.promise, null);
  const merged = mergeSignals(
    { ...EMPTY_SIGNALS, promise: "회의 끝나고 연락" },
    { ...EMPTY_SIGNALS, promise: "저녁 먹고 연락" },
  );
  assert.equal(merged.promise, "회의 끝나고 연락");
  assert.equal(
    mergeSignals(EMPTY_SIGNALS, { ...EMPTY_SIGNALS, promise: "저녁 먹고 연락" })
      .promise,
    "저녁 먹고 연락",
  );
});

test("관계 신호 셋은 목록에 있는 코드만 받는다", () => {
  const got = parseReplyOutput(
    '{"reply":["오늘 저녁엔 헬스 가"],"note":null,"move":"nickname","first":"first_nickname","first_by":"character","told_plan":true}',
  );
  assert.equal(got.parse, "json");
  assert.equal(got.signals.move, "nickname");
  assert.deepEqual(got.signals.first, { kind: "first_nickname", by: "character" });
  assert.equal(got.signals.toldPlan, true);

  // 지어낸 코드와 뜻 이름은 버린다. 처음의 주인을 안 적으면 캐릭터가 먼저 한 것으로 본다
  const bad = parseReplyOutput(
    '{"reply":["응"],"note":null,"move":"별명","first":"first_tease","told_plan":"maybe"}',
  );
  assert.equal(bad.signals.move, null);
  assert.deepEqual(bad.signals.first, { kind: "first_tease", by: "character" });
  assert.equal(bad.signals.toldPlan, false);

  const none = parseReplyOutput('{"reply":["응"],"note":null}');
  assert.equal(none.signals.move, null);
  assert.equal(none.signals.first, null);
  assert.equal(none.signals.toldPlan, false);
});

test("관계 신호도 흘린 줄에서 읽고 합칠 때는 앞 것이 남는다", () => {
  const got = parseReplyOutput('{"reply":["응"]}\nmove: laugh\ntold_plan: true');
  assert.equal(got.parse, "stray");
  assert.equal(got.signals.move, "laugh");
  assert.equal(got.signals.toldPlan, true);

  const merged = mergeSignals(
    { ...EMPTY_SIGNALS, move: "laugh" },
    { ...EMPTY_SIGNALS, move: "nickname", first: { kind: "first_laugh", by: "user" }, toldPlan: true },
  );
  assert.equal(merged.move, "laugh");
  assert.deepEqual(merged.first, { kind: "first_laugh", by: "user" });
  assert.equal(merged.toldPlan, true);
});
