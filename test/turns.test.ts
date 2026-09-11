// 대화 기록을 모델에 넘길 턴으로 옮기는 규약을 고정한다.
//
// 이슈 #190(캐릭터 발화를 답장과 같은 객체로 적기)과 #238(자리를 비운 구간에 시간 표시
// 붙이기)이 둘 다 이 변환에서 났다. 규약이 조용히 풀리면 모델은 평문으로 답하고 신호가
// 통째로 사라지는데, 답장 자체는 나가서 실패로도 안 잡힌다.
//
// 메모 칸도 같은 자리에 있다(이슈 #346). 그 턴에 적은 메모가 칸에 안 실리면 기록이 다시
// 전부 null이 되고, 모델은 남길 것이 뚜렷한 자리에서도 메모를 안 낸다.
//
// 플러팅·처음 칸도 같은 이유로 늘 적는다(이슈 #385). 기록에 그 칸이 아예 없으면 모델은
// 칸이 없는 모양을 따라가 답장에서도 키를 빼고, 태그가 하나도 안 남는다.
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

// 늘 넣는 칸 셋(note·move·first)을 빈 값으로라도 적는다 — 칸이 없는 답장이 스무 턴
// 이어지면 모델이 그 모양을 따라가 채울 것이 있어도 칸을 안 채운다(이슈 #259·#385).
test("캐릭터 발화는 답장과 같은 객체로, 늘 넣는 칸까지 적는다", () => {
  const got = turns([
    row("user", "안녕", at("09:00:00")),
    row("assistant", "안녕!", at("09:01:00")),
    row("assistant", "밥 먹었어?", at("09:01:30")),
  ]);
  assert.equal(got.length, 2);
  assert.equal(got[1]?.role, "assistant");
  assert.equal(
    got[1]?.content,
    '{"reply":["안녕!","밥 먹었어?"],"note":[],"move":null,"first":null}',
  );
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
    '{"reply":["잘 다녀와"],"note":[],"move":null,"first":null}\n[21:00] {"reply":["오늘 어땠어?"],"note":[],"move":null,"first":null}',
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

const withNotes = (rows: MessageRow[], notes: Map<number, string[]>) =>
  toTurns(rows, { todayLogical: TODAY, notes });

test("그 턴에 적은 메모는 답장 객체의 메모 칸에 그대로 들어간다", () => {
  const asked = row("user", "나 내일 이사해", at("09:00:00"));
  const said = row("assistant", "몇 시에 시작해?", at("09:01:00"));
  const got = withNotes(
    [asked, said],
    new Map([[said.id, ["상대가 내일 이사한다고 했다"]]]),
  );
  assert.equal(
    got[1]?.content,
    '{"reply":["몇 시에 시작해?"],"note":["상대가 내일 이사한다고 했다"],"move":null,"first":null}',
  );
});

// 한 덩이는 답장 한 통이다. 서로 다른 답장의 메모를 한 배열에 합치면 어느 답장이 무엇을
// 적었는지가 기록에서 섞인다.
test("서로 다른 답장의 메모는 한 객체에 담지 않고 나눈다", () => {
  const first = row("assistant", "그렇구나", at("09:00:00"));
  const second = row("assistant", "그날 저녁은 비워둘게", at("09:00:30"));
  const got = withNotes(
    [first, second],
    new Map([
      [first.id, ["상대가 내일 이사한다고 했다"]],
      [second.id, ["내일 저녁에 시간을 비워두기로 했다"]],
    ]),
  );
  assert.equal(
    got[1]?.content,
    '[09:00] {"reply":["그렇구나"],"note":["상대가 내일 이사한다고 했다"],"move":null,"first":null}\n' +
      '{"reply":["그날 저녁은 비워둘게"],"note":["내일 저녁에 시간을 비워두기로 했다"],"move":null,"first":null}',
  );
});

// 한 답장이 메모를 여럿 남기면 기록에도 여러 원소로 적는다(이슈 #399) — 한 줄로 몰아 쓰지
// 말라는 지시를 기록의 모양이 거스르면 모델은 모양을 따라간다.
test("한 답장이 적은 메모 여럿은 한 객체의 배열로 들어간다", () => {
  const asked = row("user", "어디서 자랐어?", at("09:00:00"));
  const said = row("assistant", "나도 대전에서 컸어", at("09:01:00"));
  const got = withNotes(
    [asked, said],
    new Map([
      [
        said.id,
        ["상대가 대전에서 살았다", "내가 자란 동네를 둔산동이라고 말했다"],
      ],
    ]),
  );
  assert.equal(
    got[1]?.content,
    '{"reply":["나도 대전에서 컸어"],"note":["상대가 대전에서 살았다","내가 자란 동네를 둔산동이라고 말했다"],"move":null,"first":null}',
  );
});

test("유저 발화는 번호가 같아도 메모를 가져오지 않는다", () => {
  const asked = row("user", "나 내일 이사해", at("09:00:00"));
  const got = withNotes([asked], new Map([[asked.id, ["메모"]]]));
  assert.equal(got[0]?.content, "[09:00] 나 내일 이사해");
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
