// 애착 신호 분석: messages 원시 로그에서 행동 신호를 날짜별로 집계한다 (README의 신호 표 대응).
// 기본은 정량(LLM 콜 없음). --tag 를 붙이면 취약성 개방·관계 감정 표현을 LLM(opus)으로 태깅한다.
// 사용: docker exec random-ai-companion npx tsx src/tools/analyze.ts [--tag]
import { db, type CharacterRow } from "../db.js";
import { chatJson } from "../llm.js";
import { config } from "../config.js";

const row = db
  .prepare(
    `SELECT * FROM characters WHERE status = 'active' ORDER BY id DESC LIMIT 1`,
  )
  .get() as CharacterRow | undefined;
if (!row) {
  console.log("no active character");
  process.exit(0);
}

interface Msg {
  role: string;
  sent_at: string;
  text: string;
}
const msgs = db
  .prepare(
    `SELECT role, sent_at, text FROM messages WHERE chat_id = ? ORDER BY id`,
  )
  .all(row.chat_id) as Msg[];

// 하루 경계 = 새벽 5시 (밤 정리 컷오프와 동일)
const dayOf = (ts: string): string => {
  const d = new Date(ts.replace(" ", "T") + "+09:00");
  return new Date(d.getTime() + 9 * 3600_000 - 5 * 3600_000)
    .toISOString()
    .slice(0, 10);
};
const epoch = (ts: string): number =>
  new Date(ts.replace(" ", "T") + "+09:00").getTime();

// 감정 언어 (거친 사전 — 정량 근사치. 정밀 판정은 --tag)
const EMOTION =
  /좋아|좋다|좋네|행복|설레|기대|보고 ?싶|기다렸|기다리|고마|감사|힘들|지쳤|피곤|속상|서운|우울|불안|걱정|외로|재밌|즐거|웃겼|편해|편하|안심|아쉽/g;

// 호감 스파이크: 유저가 '평소보다 길게' 답하는 순간 = 그 소재에 몰입/호감이 붙은 신호.
// 절대 길이가 아니라 이 유저의 평소 패턴(중앙값)에 상대적으로 측정한다.
const userLens = msgs
  .filter((m) => m.role === "user")
  .map((m) => m.text.length)
  .sort((a, b) => a - b);
const medianLen = userLens.length
  ? userLens[Math.floor(userLens.length / 2)]
  : 0;
const SPIKE_MULT = 1.8;
const SPIKE_FLOOR = 30; // 평소가 아주 짧아도 이 미만은 스파이크로 세지 않는다(노이즈 방지)
const spikeThreshold = Math.max(
  SPIKE_FLOOR,
  Math.round(medianLen * SPIKE_MULT),
);
const isSpike = (len: number): boolean => len >= spikeThreshold;
const spikes: { ts: string; text: string; len: number }[] = [];

interface DayStat {
  date: string;
  userMsgs: number;
  charMsgs: number;
  userChars: number;
  userInitiated: number; // 3시간+ 침묵 뒤 유저가 먼저 연 횟수
  activeHours: Set<string>;
  emotionHits: number;
  lengthSpikes: number; // 평소보다 길게 답한 메시지 수 (호감 신호)
  firstUser: string | null;
  lastUser: string | null;
  userTexts: string[];
}

const days = new Map<string, DayStat>();
let prev: Msg | null = null;
for (const m of msgs) {
  const d = dayOf(m.sent_at);
  if (!days.has(d))
    days.set(d, {
      date: d,
      userMsgs: 0,
      charMsgs: 0,
      userChars: 0,
      userInitiated: 0,
      activeHours: new Set(),
      emotionHits: 0,
      lengthSpikes: 0,
      firstUser: null,
      lastUser: null,
      userTexts: [],
    });
  const s = days.get(d)!;
  if (m.role === "user") {
    s.userMsgs++;
    s.userChars += m.text.length;
    s.activeHours.add(m.sent_at.slice(11, 13));
    s.emotionHits += (m.text.match(EMOTION) ?? []).length;
    if (isSpike(m.text.length)) {
      s.lengthSpikes++;
      spikes.push({ ts: m.sent_at, text: m.text, len: m.text.length });
    }
    s.userTexts.push(m.text);
    if (!s.firstUser) s.firstUser = m.sent_at.slice(11, 16);
    s.lastUser = m.sent_at.slice(11, 16);
    if (!prev || epoch(m.sent_at) - epoch(prev.sent_at) > 3 * 3600_000)
      s.userInitiated++;
  } else {
    s.charMsgs++;
  }
  prev = m;
}

// 선톡 반응: 발송된 선톡 후 첫 유저 응답까지 걸린 시간
const sends = db
  .prepare(
    `SELECT date, sent_at FROM scheduled_messages WHERE character_id = ? AND status = 'sent'`,
  )
  .all(row.id) as { date: string; sent_at: string }[];
const sendReact = sends.map((snd) => {
  const reply = msgs.find(
    (m) => m.role === "user" && snd.sent_at && m.sent_at > snd.sent_at,
  );
  return {
    date: snd.date,
    minutes: reply
      ? Math.round((epoch(reply.sent_at) - epoch(snd.sent_at)) / 60000)
      : null,
  };
});

console.log(
  `\n=== 애착 신호 집계 — ${row.chat_id} (하루 경계 = 새벽 5시) ===\n`,
);
console.log(
  "날짜        유저 메시지  캐릭 메시지  유저 글자수  선제 시작  활동 시간대  감정어  호감스파이크  첫활동~막활동",
);
for (const s of [...days.values()].sort((a, b) => a.date.localeCompare(b.date)))
  console.log(
    `${s.date}  ${String(s.userMsgs).padStart(6)}  ${String(s.charMsgs).padStart(6)}  ${String(s.userChars).padStart(7)}  ${String(s.userInitiated).padStart(7)}  ${String(s.activeHours.size).padStart(9)}  ${String(s.emotionHits).padStart(5)}  ${String(s.lengthSpikes).padStart(9)}  ${s.firstUser ?? "--:--"} ~ ${s.lastUser ?? "--:--"}`,
  );
console.log(
  `\n신호 대응: 유저의 선제 연락=선제시작 · 일상 침투=활동시간대 확산 · 취약성/관계감정≈감정어(정밀은 --tag) · 관심·호감=호감스파이크 · 분리 반응=프로브 날 선제시작·선톡반응`,
);
console.log(
  `호감 스파이크 = 유저 평소 길이(중앙값 ${medianLen}자)의 ${SPIKE_MULT}배(≥${spikeThreshold}자)로 답한 순간 = 그 소재에 몰입한 신호. 절대치가 아니라 이 유저 기준 상대치.`,
);
if (spikes.length) {
  console.log(`\n길게 반응한 순간 (호감 소재 후보, 최근 상위 8개):`);
  for (const sp of spikes.slice(-8).reverse())
    console.log(
      `  ${sp.ts.slice(0, 16)} (${sp.len}자) ${sp.text.replace(/\n/g, " ").slice(0, 70)}`,
    );
}
if (sendReact.length) {
  console.log(`\n선톡 반응 (발송→첫 답장):`);
  for (const r of sendReact)
    console.log(
      `  ${r.date}: ${r.minutes === null ? "무응답" : `${r.minutes}분`}`,
    );
}

// LLM 정밀 태깅 (opus): 취약성 개방 · 관계 감정 표현
if (process.argv.includes("--tag")) {
  console.log(`\n=== LLM 태깅 (${config.modelDeep}) ===`);
  for (const s of [...days.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  )) {
    if (!s.userTexts.length) continue;
    const r = await chatJson<{
      vulnerability: number;
      relational: number;
      examples: string[];
    }>(
      `너는 대화 신호 태거다. 유저 발화 목록에서 (1) 취약성 개방(감정·고민·속마음을 드러낸 발화 수), (2) 관계 감정 표현(상대에 대한 호감·기다림·반가움 표현 수)을 센다. JSON만.`,
      `발화 목록:\n${s.userTexts.map((t) => `- ${t.replace(/\n/g, " ")}`).join("\n")}\n\nJSON: {"vulnerability": n, "relational": n, "examples": ["대표 예시 1~3개"]}`,
      600,
      config.modelDeep,
    );
    console.log(
      `${s.date}: 취약성 ${r.vulnerability} · 관계감정 ${r.relational} · 예) ${r.examples.join(" / ")}`,
    );
  }

  // 호감 소재: '평소보다 길게 반응한' 발화들을 묶어 유저가 몰입하는 소재를 추출
  if (spikes.length) {
    const r = await chatJson<{ topics: { topic: string; why: string }[] }>(
      `너는 유저의 호감 소재를 찾는 분석기다. 유저가 '평소보다 길게' 반응한 발화 목록을 보고, 어떤 소재·화제에서 유저가 몰입(호감)하는지 소재로 묶어 뽑는다. JSON만.`,
      `평소보다 길게 반응한 발화들:\n${spikes.map((s) => `- ${s.text.replace(/\n/g, " ")}`).join("\n")}\n\nJSON: {"topics":[{"topic":"소재 이름","why":"왜 호감 소재로 보이는지 한 줄"}]}`,
      800,
      config.modelDeep,
    );
    console.log(`\n=== 호감 소재 (길게 반응한 순간에서 추출) ===`);
    for (const t of r.topics) console.log(`  · ${t.topic} — ${t.why}`);
  }
}
