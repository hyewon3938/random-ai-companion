// 캐릭터의 마음 블록(context/mind.ts)이 저장된 값을 프롬프트 줄로 옮기는 자리를 검사한다 — 모델은 부르지 않는다(#473).
//
// 관계 행의 마음 칸을 읽을 때 목록 밖 값·빈 세기·빈 시각을 없는 것으로 보는지, 생긴 시각과 지난
// 시간 표기, 드러내는 정도 줄을 위에서부터 먼저 맞는 조건으로 고르는지, 블록이 마음·오늘 기분의
// 유무에 따라 줄을 빼는지 본다. 줄 문안은 relationship.md 15절 표와 같은 글자여야 한다.
// kst 모듈이 설정을 읽어 DB 경로와 키 자리만 채운다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "companion-test-")),
  "test.db",
);
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";

const {
  elapsedLabel,
  mindDisclosure,
  mindLabel,
  mindSection,
  mindSinceLabel,
  storedMind,
} = await import("../src/context/mind.js");
type MindSectionInput = import("../src/context/mind.js").MindSectionInput;

const HURT = {
  mind_kind: "hurt",
  mind_level: 2,
  mind_reason: "저녁 약속을 다른 사람과 잡았다고 했다",
  mind_since: "2026-09-20 16:40:00",
};

test("저장된 마음은 목록 안의 종류와 1~3 세기, 생긴 시각이 다 있을 때만 읽는다", () => {
  assert.deepEqual(storedMind(HURT), {
    kind: "hurt",
    level: 2,
    reason: "저녁 약속을 다른 사람과 잡았다고 했다",
    since: "2026-09-20 16:40:00",
  });
  assert.equal(storedMind(undefined), null);
  assert.equal(storedMind(null), null);
  // 목록 밖 종류 — DB에는 값 제약이 없어 옛 값이 남을 수 있다
  assert.equal(storedMind({ ...HURT, mind_kind: "angry" }), null);
  assert.equal(storedMind({ ...HURT, mind_kind: "toString" }), null);
  assert.equal(storedMind({ ...HURT, mind_level: 0 }), null);
  assert.equal(storedMind({ ...HURT, mind_level: 4 }), null);
  assert.equal(storedMind({ ...HURT, mind_since: null }), null);
  assert.equal(storedMind({ ...HURT, mind_kind: null }), null);
  // 이유가 비어도 마음은 있다
  assert.equal(storedMind({ ...HURT, mind_reason: null })?.reason, "");
  assert.equal(storedMind({ ...HURT, mind_reason: "  " })?.reason, "");
});

test("짧은 표기는 이름과 세기, 생긴 시각은 다른 날이면 M/D를 앞세운다", () => {
  assert.equal(mindLabel({ kind: "jealous", level: 1 }), "질투 1");
  assert.equal(mindSinceLabel("2026-09-20 16:40:00", "2026-09-20"), "16:40");
  assert.equal(
    mindSinceLabel("2026-09-19 23:10:00", "2026-09-20"),
    "9/19 23:10",
  );
  // 새벽 02:10은 앞 논리일이다
  assert.equal(mindSinceLabel("2026-09-21 02:10:00", "2026-09-20"), "02:10");
});

test("지난 시간은 분·시간으로 적고 1분이 안 되거나 거꾸로면 없다", () => {
  const from = "2026-09-20 16:40:00";
  assert.equal(elapsedLabel(from, "2026-09-20 17:05:00"), "25분");
  assert.equal(elapsedLabel(from, "2026-09-20 18:40:00"), "2시간");
  assert.equal(elapsedLabel(from, "2026-09-20 19:05:30"), "2시간 25분");
  assert.equal(elapsedLabel(from, "2026-09-20 16:40:59"), null);
  assert.equal(elapsedLabel(from, "2026-09-20 16:00:00"), null);
  assert.equal(elapsedLabel("깨진 값", "2026-09-20 16:00:00"), null);
});

test("드러내는 정도는 상대 상태가 안 좋음 → 언짢음 → 설렘 → 단계 순으로 먼저 맞는 줄을 쓴다", () => {
  const first =
    "지금은 상대 상태가 먼저다. 이 마음은 드러내지 않고 상대 말을 먼저 받는다.";
  const upset =
    "이 마음은 말로 하지 않는다. 말수가 줄고 장난이 빠지는 정도로만 드러난다.";
  const flutter =
    "들뜬 말투로 먼저 드러난다. 좋다는 말은 지금 단계가 하는 것에 적은 만큼만 한다.";
  for (const kind of ["hurt", "jealous", "upset"] as const)
    assert.equal(mindDisclosure(4, kind, "bad"), first);
  // 설렘은 상대 상태가 안 좋아도 설렘 줄이다
  assert.equal(mindDisclosure(2, "flutter", "bad"), flutter);
  for (const stage of [1, 2, 3, 4] as const) {
    assert.equal(mindDisclosure(stage, "upset", "neutral"), upset);
    assert.equal(mindDisclosure(stage, "flutter", null), flutter);
    assert.equal(
      mindDisclosure(stage, "hurt", "good"),
      mindDisclosure(stage, "jealous", undefined),
    );
  }
  assert.equal(
    mindDisclosure(1, "hurt", null),
    "말투와 답장 길이에만 반영하고 말로 꺼내지 않는다. 연락이 늦었던 일이면 기다렸다는 티 한 마디까지다.",
  );
  assert.equal(
    mindDisclosure(2, "hurt", null),
    "말투에 반영하고 걸리는 티 한 마디까지 낸다. 서운하다거나 질투 난다는 말은 하지 않는다.",
  );
  assert.equal(
    mindDisclosure(3, "jealous", "neutral"),
    "서운한 티나 가벼운 질투를 한 마디로 돌려서 말해도 된다. 따지거나 삐치지는 않는다.",
  );
  assert.equal(
    mindDisclosure(4, "hurt", "neutral"),
    "서운하다, 질투 난다고 직접 말해도 된다. 삐쳐도 되고 먼저 풀어도 된다. 얼마나 오래 가는지는 네 결점 값에 적힌 만큼이다.",
  );
});

const block = (over: Partial<MindSectionInput> = {}): string =>
  mindSection({
    rel: { ...HURT, user_state_tone: null },
    stage: 3,
    mood: { mood: "조금 가라앉음", reason: "어제 늦게까지 일해서" },
    stamp: "2026-09-20 19:05:00",
    logicalToday: "2026-09-20",
    ...over,
  });

test("마음 블록은 마음 줄·드러내는 정도·오늘 기분 순이고 지난 시간을 코드가 적는다", () => {
  assert.equal(
    block(),
    [
      "[네 마음]",
      "- 오늘 대화에서 생긴 마음: 서운함, 세기 2/3. 16:40부터, 2시간 25분 지났다. 계기: 저녁 약속을 다른 사람과 잡았다고 했다.",
      "- 드러내는 정도: 서운한 티나 가벼운 질투를 한 마디로 돌려서 말해도 된다. 따지거나 삐치지는 않는다.",
      "- 오늘 기분: 조금 가라앉음 (어제 늦게까지 일해서). 상대를 대하는 태도는 이 기분과 상관없이 같고, 상대가 물을 때 이야깃거리로 꺼낸다.",
    ].join("\n"),
  );
});

test("방금 생긴 마음·이유 없는 마음·끝에 마침표가 붙은 값도 한 문장으로 읽힌다", () => {
  const now = block({ stamp: "2026-09-20 16:40:20", mood: null });
  assert.ok(
    now.includes(
      "- 오늘 대화에서 생긴 마음: 서운함, 세기 2/3. 16:40에 방금 생겼다. 계기:",
    ),
  );
  const bare = block({
    rel: {
      ...HURT,
      mind_reason: null,
      user_state_tone: "bad",
    },
    mood: { mood: "좋음.", reason: null },
  });
  assert.ok(
    bare.includes("세기 2/3. 16:40부터, 2시간 25분 지났다.\n- 드러내는 정도: 지금은 상대 상태가 먼저다."),
  );
  assert.ok(bare.includes("- 오늘 기분: 좋음. 상대를 대하는"));
  const dotted = block({
    rel: { ...HURT, mind_reason: "약속을 잊었다.", user_state_tone: null },
  });
  assert.ok(dotted.includes("계기: 약속을 잊었다.\n"));
});

test("마음이 없으면 앞 두 줄을 빼고, 오늘 기분도 없으면 블록을 넣지 않는다", () => {
  const empty = {
    mind_kind: null,
    mind_level: null,
    mind_reason: null,
    mind_since: null,
    user_state_tone: null,
  };
  const moodOnly = block({ rel: empty });
  assert.ok(moodOnly.startsWith("[네 마음]\n- 오늘 기분: 조금 가라앉음"));
  assert.ok(!moodOnly.includes("드러내는 정도"));
  assert.equal(block({ rel: empty, mood: null }), "");
  assert.equal(block({ rel: undefined, mood: { mood: " ", reason: null } }), "");
  const mindOnly = block({ mood: null });
  assert.ok(mindOnly.includes("- 드러내는 정도:"));
  assert.ok(!mindOnly.includes("오늘 기분"));
});
