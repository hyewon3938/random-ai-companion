// 대화 기록을 모델에 넘길 턴으로 옮기는 규약을 고정한다.
//
// 이슈 #190(캐릭터 발화를 답장과 같은 객체로 적기)과 #238(자리를 비운 구간에 시간 표시
// 붙이기)이 둘 다 이 변환에서 났다. 규약이 조용히 풀리면 모델은 평문으로 답하고 신호가
// 통째로 사라지는데, 답장 자체는 나가서 실패로도 안 잡힌다.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { MessageRow } from "../src/db.js";
import { lastTurns, toTurns } from "../src/turns.js";

const TODAY = "2026-09-02";

let seq = 0;
const at = (hhmmss: string): string => `2026-09-02 ${hhmmss}`;
const row = (role: "user" | "assistant", text: string, sent_at: string): MessageRow => ({
  id: ++seq,
  role,
  text,
  sent_at,
});

const turns = (rows: MessageRow[], markFrom?: string) =>
  toTurns(rows, { todayLogical: TODAY, markFrom });

test("연달아 보낸 말은 한 턴으로 합친다", () => {
  const got = turns([
    row("user", "밥 먹었어?", at("09:00:00")),
    row("user", "아직?", at("09:02:00")),
  ]);
  assert.deepEqual(got, [
    { role: "user", content: "[09:00] 밥 먹었어?\n아직?" },
  ]);
});

test("캐릭터 발화는 답장과 같은 객체로 적는다", () => {
  const got = turns([
    row("user", "안녕", at("09:00:00")),
    row("assistant", "안녕!", at("09:01:00")),
    row("assistant", "밥 먹었어?", at("09:01:30")),
  ]);
  assert.equal(got.length, 2);
  assert.equal(got[1]?.role, "assistant");
  assert.equal(got[1]?.content, '{"reply":["안녕!","밥 먹었어?"]}');
});

test("캐릭터가 먼저 말한 기록은 유저 자리를 앞에 채운다", () => {
  // 역할이 번갈아 와야 하는 규약이라, 첫 턴이 캐릭터면 그대로 넘길 수 없다
  const got = turns([row("assistant", "자니?", at("23:00:00"))]);
  assert.equal(got[0]?.role, "user");
  assert.equal(got[0]?.content, "(대화 시작)");
  assert.equal(got[1]?.role, "assistant");
});

test("한 시간 넘게 벌어지면 그 자리에서 덩이를 나눈다", () => {
  const got = turns([
    row("user", "ㅇㅇ", at("09:00:00")),
    row("user", "이제 일어남", at("11:00:00")),
  ]);
  assert.deepEqual(got, [
    { role: "user", content: "[09:00] ㅇㅇ\n[11:00] 이제 일어남" },
  ]);
});

test("캐릭터 발화도 시간 표시가 붙으면 객체를 나눈다", () => {
  const got = turns([
    row("user", "다녀올게", at("09:00:00")),
    row("assistant", "잘 다녀와", at("09:00:30")),
    row("assistant", "오늘 어땠어?", at("21:00:00")),
  ]);
  assert.equal(
    got[1]?.content,
    '{"reply":["잘 다녀와"]}\n[21:00] {"reply":["오늘 어땠어?"]}',
  );
});

test("자리를 비운 구간은 간격이 모자라도 표시한다", () => {
  const got = turns(
    [
      row("user", "나 밥 먹고 올게", at("19:00:00")),
      row("user", "왔다", at("19:30:00")),
    ],
    at("19:20:00"),
  );
  assert.deepEqual(got, [
    { role: "user", content: "[19:00] 나 밥 먹고 올게\n[19:30] 왔다" },
  ]);
});

test("오늘이 언제냐에 따라 어제로 적는다", () => {
  const got = toTurns([row("user", "잘 자", "2026-09-01 22:00:00")], {
    todayLogical: TODAY,
  });
  assert.equal(got[0]?.content, "[어제 22:00] 잘 자");
});

test("자를 때는 통 수가 아니라 턴 수로 센다", () => {
  const rows = [
    row("user", "1", at("09:00:00")),
    row("user", "2", at("09:01:00")),
    row("assistant", "3", at("09:02:00")),
    row("user", "4", at("09:03:00")),
  ];
  assert.deepEqual(lastTurns(rows, 2), rows.slice(2));
  // 한 사람이 연달아 보낸 말은 몇 통이든 한 턴이라 셋 다 남는다
  assert.deepEqual(lastTurns(rows.slice(0, 2), 1), rows.slice(0, 2));
});
