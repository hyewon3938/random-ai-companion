// 하루의 경계가 자정이 아니라 새벽 5시라는 규칙을 고정한다.
//
// 자정부터 04:59까지 온 말은 전날의 연장이다. 이 한 줄이 어긋나면 기록에 붙는 표시가
// "02:00"에서 "어제 02:00"으로 뒤바뀌고, 선톡을 참는 침묵 일수도 하루씩 밀린다.
// 여기 함수들은 오늘 날짜를 인자로 받게 돼 있어서 시계를 고정한 채로 검사할 수 있다.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  contactGapOf,
  lastTalkedLabel,
  logicalClockToTs,
  logicalDateOf,
  logicalDaysAgo,
  nightSleepOf,
  shiftDate,
  timeMarkerFor,
} from "../src/kst.js";

test("자정을 넘긴 시각은 아직 전날이다", () => {
  assert.equal(logicalDateOf("2026-09-02 00:10:00"), "2026-09-01");
  assert.equal(logicalDateOf("2026-09-02 04:59:59"), "2026-09-01");
});

test("새벽 5시부터 새 날이다", () => {
  assert.equal(logicalDateOf("2026-09-02 05:00:00"), "2026-09-02");
  assert.equal(logicalDateOf("2026-09-02 23:30:00"), "2026-09-02");
});

test("며칠 전인지도 같은 경계로 센다", () => {
  assert.equal(logicalDaysAgo("2026-08-30 12:00:00", "2026-09-02"), 3);
  // 9/2 새벽 3시에 보는 9/2 새벽 2시 — 둘 다 9/1에 속해 아직 오늘이다
  assert.equal(logicalDaysAgo("2026-09-02 02:00:00", "2026-09-01"), 0);
});

test("앞 발화가 없으면 시각을 붙인다", () => {
  assert.equal(timeMarkerFor("2026-09-02 09:00:00", null, "2026-09-02"), "09:00");
});

test("한 시간 안에 이어진 말에는 붙이지 않는다", () => {
  assert.equal(
    timeMarkerFor("2026-09-02 09:30:00", "2026-09-02 09:00:00", "2026-09-02"),
    null,
  );
});

test("한 시간 넘게 벌어지면 시각을 붙인다", () => {
  assert.equal(
    timeMarkerFor("2026-09-02 10:05:00", "2026-09-02 09:00:00", "2026-09-02"),
    "10:05",
  );
});

test("날이 바뀌면 간격이 짧아도 붙인다", () => {
  assert.equal(
    timeMarkerFor("2026-09-01 22:10:00", "2026-08-31 23:00:00", "2026-09-02"),
    "어제 22:10",
  );
});

test("새벽 2시 대화는 그 밤 안에서는 오늘로 적는다", () => {
  // 9/2 새벽에 보면 오늘, 같은 말을 9/2 낮에 보면 어제
  assert.equal(timeMarkerFor("2026-09-02 02:00:00", null, "2026-09-01"), "02:00");
  assert.equal(
    timeMarkerFor("2026-09-02 02:00:00", null, "2026-09-02"),
    "어제 02:00",
  );
});

test("사흘 전부터는 요일까지 적는다", () => {
  assert.equal(
    timeMarkerFor("2026-08-30 21:40:00", null, "2026-09-02"),
    "3일 전(일) 21:40",
  );
});

test("마지막으로 대화한 날은 날짜를 함께 적는다", () => {
  assert.equal(
    lastTalkedLabel("2026-08-30 21:40:00", "2026-09-02"),
    "3일 전(8/30 일) 21:40",
  );
  assert.equal(
    lastTalkedLabel("2026-09-02 02:00:00", "2026-09-01"),
    "오늘(9/2 수) 02:00",
  );
});

test("같은 날 세 시간 넘게 지나 온 연락에는 텀 문구가 붙는다", () => {
  assert.deepEqual(contactGapOf("2026-09-05 14:06:00", "2026-09-05 18:36:00"), {
    label:
      "네가 14:06에 마지막으로 말한 뒤 상대 연락은 18:36에 왔다. 4시간 반 만이다.",
    longing: false,
  });
  // 딱 기준만큼도 붙는다. 분은 반 시간 단위로 뭉갠다
  assert.deepEqual(contactGapOf("2026-09-05 09:00:00", "2026-09-05 12:00:00"), {
    label: "네가 09:00에 마지막으로 말한 뒤 상대 연락은 12:00에 왔다. 3시간 만이다.",
    longing: false,
  });
  assert.match(
    contactGapOf("2026-09-05 09:00:00", "2026-09-05 14:10:00")?.label ?? "",
    /5시간 만이다\.$/,
  );
});

test("기준에 못 미치는 틈에는 문구가 없다", () => {
  assert.equal(contactGapOf("2026-09-05 14:06:00", "2026-09-05 16:30:00"), null);
});

test("같은 날 여섯 시간 넘게 기다린 자리는 긴 텀이다", () => {
  // 아침에 보낸 말에 저녁에 온 답
  assert.deepEqual(contactGapOf("2026-09-05 09:10:00", "2026-09-05 19:10:00"), {
    label: "네가 09:10에 마지막으로 말한 뒤 상대 연락은 19:10에 왔다. 10시간 만이다.",
    longing: true,
  });
  // 새벽에 온 연락은 자던 시간이라 긴 텀으로 치지 않는다
  assert.equal(
    contactGapOf("2026-09-05 21:00:00", "2026-09-06 04:00:00")?.longing,
    false,
  );
});

test("날짜가 바뀐 연락은 하루가 통째로 지났을 때만 문구가 붙는다", () => {
  // 밤에 끝난 대화에 다음 날 아침 답이 오는 텀은 직전 대화 절 몫이다
  assert.equal(contactGapOf("2026-09-05 22:00:00", "2026-09-06 09:00:00"), null);
  assert.equal(contactGapOf("2026-09-05 02:00:00", "2026-09-05 09:00:00"), null);
  // 자정을 넘겨도 같은 논리일이면 시간으로 적는다
  assert.deepEqual(contactGapOf("2026-09-05 22:00:00", "2026-09-06 01:30:00"), {
    label: "네가 22:00에 마지막으로 말한 뒤 상대 연락은 01:30에 왔다. 3시간 반 만이다.",
    longing: false,
  });
});

test("며칠 만에 온 연락은 날로 세어 적고 전부 긴 텀이다", () => {
  assert.deepEqual(contactGapOf("2026-09-05 21:00:00", "2026-09-06 20:00:00"), {
    label:
      "네가 어제(9/5 토) 21:00에 마지막으로 말한 뒤 상대 연락은 20:00에 왔다. 하루 만이다.",
    longing: true,
  });
  assert.match(
    contactGapOf("2026-09-03 21:00:00", "2026-09-06 20:00:00")?.label ?? "",
    /^네가 3일 전\(9\/3 목\) 21:00에 .* 사흘 만이다\.$/,
  );
});

test("날짜를 옮기고 각본 표기를 벽시계로 되돌린다", () => {
  assert.equal(shiftDate("2026-09-06", -1), "2026-09-05");
  assert.equal(shiftDate("2026-08-31", 1), "2026-09-01");
  assert.equal(logicalClockToTs("2026-09-05", "23:30"), "2026-09-05 23:30:00");
  assert.equal(logicalClockToTs("2026-09-05", "26:40"), "2026-09-06 02:40:00");
});

// 피곤함은 늦게 잤는지가 아니라 잔 시간으로 정한다(이슈 #289). 잠든 시각에 기준 시간을 더한
// 값을 주고, 각본은 기상 시각을 그 값과 견준다.
test("각본의 잠보다 대화가 늦게 끝났으면 대화 끝이 잠든 시각이다", () => {
  assert.deepEqual(nightSleepOf("2026-09-05", "24:30", "2026-09-06 02:40:00"), {
    bedtime: "02:40",
    enoughSleepFrom: "08:40",
  });
});

test("대화가 각본의 잠보다 먼저 끝났으면 각본대로 잔 것이다", () => {
  assert.deepEqual(nightSleepOf("2026-09-05", "23:00", "2026-09-05 22:30:00"), {
    bedtime: "23:00",
    enoughSleepFrom: "05:00",
  });
});

test("저녁에 끝난 대화는 취침이 아니라 잠든 시각 후보에서 뺀다", () => {
  assert.deepEqual(nightSleepOf("2026-09-05", null, "2026-09-05 21:00:00"), null);
  assert.deepEqual(nightSleepOf("2026-09-05", "23:00", "2026-09-05 21:00:00"), {
    bedtime: "23:00",
    enoughSleepFrom: "05:00",
  });
});

test("새벽 5시부터 이어지는 아침 꼬리 잠은 밤 잠이 아니다", () => {
  assert.deepEqual(nightSleepOf("2026-09-05", "05:00", null), null);
});

test("다른 논리일의 말은 어젯밤 잠에 쓰지 않는다", () => {
  assert.deepEqual(nightSleepOf("2026-09-05", null, "2026-09-06 06:00:00"), null);
});
