import { chatJson } from "./llm.js";
import { config } from "./config.js";
import {
  db,
  getDayPlan,
  getDaySeed,
  getRelationshipState,
  saveRelationshipState,
  addSchedule,
  addCastMember,
  getCast,
  getArcs,
  saveArc,
  saveDayPlan,
  getUpcomingSchedules,
  insertScheduledSend,
  getUserPreferences,
  saveUserPreferences,
  type CharacterRow,
  type DaySeed,
} from "./db.js";
import type { Bible } from "./character.js";
import type { DayPlan } from "./day-plan.js";
import { ensureTodayPlan } from "./day-plan.js";
import {
  applyMonthPlan,
  ensureRhythmRunway,
  monthDays,
  monthsNeedingRhythm,
  type MonthPlan,
} from "./life-plan.js";
import { getKstNow, kstDateString, todayLabel } from "./kst.js";

// 밤 정리: 새벽 5시 컷오프로 어제 하루를 닫는다.
// 일기 응고(각본 대비·감정 관찰·내부 온도) + 기억/일정/인물 추출 + 오늘 각본 + 선톡 문안 준비.
//
// 실행 경로는 둘이다. 기본은 외부 scheduled task(구독)가 수집(gatherNightlyInput)→생성(자체 지능)
// →적용(applyNightlyOutput)을 수행하고, 이 파일의 runNightly는 그게 안 돌았을 때의 API 폴백이다.
// 두 경로 모두 일기 중복 체크로 이중 실행이 방지된다.

export interface DiaryOutput {
  diary: string;
  plan_vs_actual: string;
  user_mood: string;
  closeness: string;
  tomorrow: string[];
}

export interface ExtractOutput {
  user_facts: string[];
  char_facts: string[];
  schedules: {
    who: "user" | "char";
    date: string;
    time_hint: string | null;
    content: string;
  }[];
  people: {
    who: "char" | "user";
    name: string;
    relation: string;
    note: string;
  }[];
  // 유저 선호(매칭 전용). topics=몰입하는 소재, facets=우진의 어떤 성향에 반응이 좋은지
  preferences?: {
    topics: { topic: string; note: string }[];
    facets: { facet: string; response: string; note: string }[];
  } | null;
}

export interface SendDraft {
  window_start: string; // "HH:MM"
  window_end: string;
  text: string;
}

export interface NightlyOutput {
  entry: DiaryOutput;
  extract?: ExtractOutput | null;
  plan?: DayPlan | null; // 외부 경로가 오늘 각본까지 만들어 보낼 때
  send?: SendDraft | null; // 오늘의 선톡 문안 (근거 있을 때만)
  arcs?: {
    year?: string;
    season?: string;
    month?: string;
    week?: string;
  } | null; // 흐름 갱신이 필요할 때만
  rhythm?: ({ ym: string } & MonthPlan)[] | null; // 월 리듬(이벤트+시드) 생성이 필요했을 때
}

export interface NightlyGathered {
  characterId: number;
  chatId: string;
  diaryDate: string; // 일기 대상 날짜 (어제)
  today: string;
  todayLabel: string;
  diaryExists: boolean;
  convo: string; // 어제 대화 전문 (없으면 "")
  msgsCount: number;
  planBriefYesterday: string;
  planExistsToday: boolean;
  knownUserFacts: string;
  knownCast: string; // 이미 아는 우진의 주변 인물(이름·관계) — 추출 시 중복 방지용
  openLoops: string[];
  userSchedulesUpcoming: string; // 상대의 다가오는 일정 (선톡 근거)
  arcs: Record<string, string>;
  todaySeed: DaySeed | null; // 오늘의 컨디션 시드(있으면)
  rhythmNeeded: { ym: string; days: { date: string; label: string }[] }[]; // 이번 밤에 생성해야 할 월 리듬
  bible: Bible;
}

const nowStamp = (): string =>
  `${kstDateString()} ${getKstNow().toISOString().slice(11, 19)}`;

const planBrief = (raw: string | undefined): string => {
  if (!raw) return "";
  try {
    const p = JSON.parse(raw) as DayPlan;
    return p.blocks.map((b) => `${b.start} ${b.activity}`).join(" / ");
  } catch {
    return "";
  }
};

export const gatherNightlyInput = (
  character: CharacterRow,
): NightlyGathered => {
  const bible = JSON.parse(character.bible_json) as Bible;
  const now = getKstNow();
  const shifted = new Date(now.getTime() - 5 * 3600_000);
  const today = kstDateString(shifted);
  const diaryDate = kstDateString(new Date(shifted.getTime() - 24 * 3600_000));

  const msgs = db
    .prepare(
      `SELECT role, ts, text FROM messages WHERE chat_id = ? AND role IN ('user','char') AND ts >= ? AND ts < ? ORDER BY id`,
    )
    .all(character.chat_id, `${diaryDate} 05:00:00`, `${today} 05:00:00`) as {
    role: string;
    ts: string;
    text: string;
  }[];

  const state = getRelationshipState(character.id);
  return {
    characterId: character.id,
    chatId: character.chat_id,
    diaryDate,
    today,
    todayLabel: todayLabel(),
    diaryExists: !!db
      .prepare(
        `SELECT 1 FROM diary_entries WHERE character_id = ? AND date = ? LIMIT 1`,
      )
      .get(character.id, diaryDate),
    convo: msgs
      .map(
        (m) =>
          `[${m.ts.slice(11, 16)}] ${m.role === "user" ? "상대" : "나"}: ${m.text.replace(/\n/g, " ")}`,
      )
      .join("\n"),
    msgsCount: msgs.length,
    planBriefYesterday: planBrief(getDayPlan(character.id, diaryDate)),
    planExistsToday: !!getDayPlan(character.id, today),
    knownUserFacts: state.user_facts.map((f) => f.fact).join(" / "),
    knownCast: getCast(character.id, "char")
      .map((c) => `${c.name}(${c.relation})`)
      .join(", "),
    openLoops: state.open_loops
      .filter((l) => l.status === "open")
      .map((l) => l.content),
    userSchedulesUpcoming: getUpcomingSchedules(character.id, today)
      .filter((s) => s.who === "user")
      .map(
        (s) => `${s.date}${s.time_hint ? ` ${s.time_hint}` : ""} ${s.content}`,
      )
      .join(" / "),
    arcs: getArcs(character.id),
    todaySeed: getDaySeed(character.id, today) ?? null,
    rhythmNeeded: monthsNeedingRhythm(character.id, today).map((ym) => ({
      ym,
      days: monthDays(ym),
    })),
    bible,
  };
};

// 생성 결과를 DB에 반영한다. 외부 scheduled task와 API 폴백이 공유하는 단일 쓰기 경로
export const applyNightlyOutput = (
  g: NightlyGathered,
  out: NightlyOutput,
): string => {
  const ts = nowStamp();

  const dup = db
    .prepare(
      `SELECT 1 FROM diary_entries WHERE character_id = ? AND date = ? LIMIT 1`,
    )
    .get(g.characterId, g.diaryDate);
  if (dup) return `skip: ${g.diaryDate} 일기 이미 있음`;

  db.prepare(
    `INSERT INTO diary_entries (character_id, date, entry_json) VALUES (?, ?, ?)`,
  ).run(g.characterId, g.diaryDate, JSON.stringify(out.entry));

  const state = getRelationshipState(g.characterId);
  const ex = out.extract;
  if (ex) {
    for (const f of ex.user_facts ?? [])
      state.user_facts.push({ fact: f, learned_at: g.diaryDate });
    if (ex.char_facts?.length) {
      state.char_facts = state.char_facts ?? [];
      for (const f of ex.char_facts)
        state.char_facts.push({ fact: f, learned_at: g.diaryDate });
    }
    for (const s of ex.schedules ?? [])
      if (s.date && s.content)
        addSchedule(
          g.characterId,
          s.who === "user" ? "user" : "char",
          s.date,
          s.time_hint ?? null,
          s.content,
          ts,
        );
    for (const p of ex.people ?? [])
      if (p.name)
        addCastMember(
          g.characterId,
          p.who === "user" ? "user" : "char",
          p.name,
          p.relation || "지인",
          p.note || null,
          ts,
        );
    // 유저 선호 누적(매칭 전용). 같은 소재·성향은 최신 note로 갱신
    if (ex.preferences) {
      const prefs = getUserPreferences(g.chatId);
      for (const t of ex.preferences.topics ?? [])
        if (t.topic) {
          const e = prefs.topics.find((x) => x.topic === t.topic);
          if (e) e.note = t.note || e.note;
          else
            prefs.topics.push({
              topic: t.topic,
              note: t.note || "",
              learned_at: g.diaryDate,
            });
        }
      for (const f of ex.preferences.facets ?? [])
        if (f.facet) {
          const e = prefs.facets.find((x) => x.facet === f.facet);
          if (e) {
            e.response = f.response || e.response;
            e.note = f.note || e.note;
          } else
            prefs.facets.push({
              facet: f.facet,
              response: f.response || "보통",
              note: f.note || "",
              learned_at: g.diaryDate,
            });
        }
      saveUserPreferences(g.chatId, prefs);
    }
  }
  let loopId = state.open_loops.reduce((m, l) => Math.max(m, l.id), 0);
  for (const t of out.entry.tomorrow ?? [])
    state.open_loops.push({
      id: ++loopId,
      content: t,
      due_hint: null,
      status: "open",
      created_at: g.diaryDate,
    });
  saveRelationshipState(g.characterId, state, ts);

  if (out.plan) saveDayPlan(g.characterId, g.today, JSON.stringify(out.plan));

  if (out.arcs) {
    for (const h of ["year", "season", "month", "week"] as const)
      if (out.arcs[h]) saveArc(g.characterId, h, out.arcs[h]);
  }

  if (out.rhythm)
    for (const r of out.rhythm)
      if (r.ym) applyMonthPlan(g.characterId, r.ym, r);

  if (out.send?.text)
    insertScheduledSend(
      g.characterId,
      g.chatId,
      g.today,
      out.send.window_start,
      out.send.window_end,
      out.send.text,
      ts,
    );

  return `ok: ${g.diaryDate} 일기 응고 (대화 ${g.msgsCount}개)${out.plan ? ` + ${g.today} 각본` : ""}${out.send?.text ? " + 선톡 준비" : ""}`;
};

// ── 이하 API 폴백 경로 ──────────────────────────────────────────

const DIARY_SYSTEM = `너는 주어진 인물 그 자체다. 하루를 마치고 혼자 일기를 쓴다. 담백하고 사적인 1인칭 문장으로, 과장 없이.`;

const diaryPrompt = (
  g: NightlyGathered,
): string => `너는 이 인물이다: ${JSON.stringify(g.bible.identity)} / 요즘: ${g.bible.life.current_arc}

오늘은 ${g.diaryDate}였다.

[오늘의 원래 흐름]
${g.planBriefYesterday || "(기록 없음)"}

[상대와 나눈 대화 전체]
${g.convo}

오늘을 정리해 JSON으로:
{"diary":"오늘의 일기. 1인칭, 5~10문장. 실제 보낸 하루와 상대와 나눈 것, 마음에 남은 것","plan_vs_actual":"원래 흐름과 실제로 보낸 하루가 달랐던 점 한두 줄","user_mood":"상대의 감정 흐름에 대한 관찰 한두 줄","closeness":"상대와의 거리감·온도 한 줄 (내부 기록, 상대에게 절대 언급하지 않는 것)","tomorrow":["내일 자연스럽게 이어가거나 물어볼 것 0~2개"]}`;

const quietDayPrompt = (
  g: NightlyGathered,
): string => `너는 이 인물이다: ${JSON.stringify(g.bible.identity)} / 요즘: ${g.bible.life.current_arc}

오늘은 ${g.diaryDate}였고, 상대와 대화가 없던 날이다. 아래 흐름대로 혼자 하루를 보냈다.

[오늘의 흐름]
${g.planBriefYesterday || "(평범한 하루)"}

JSON으로:
{"diary":"혼자 보낸 하루의 일기. 1인칭, 3~6문장. 대화가 없었던 것에 대한 감정이 있다면 안정형답게 담담하게","plan_vs_actual":"—","user_mood":"—","closeness":"—","tomorrow":[]}`;

const EXTRACT_SYSTEM = `너는 대화 기록에서 구조화된 정보만 뽑는 추출기다. 확실한 것만 뽑고, 없으면 빈 배열을 준다.`;

const extractPrompt = (
  g: NightlyGathered,
): string => `기준 날짜: ${g.diaryDate}. '나' = 캐릭터(char), '상대' = 유저.

[대화]
${g.convo}

[이미 아는 상대 사실 — 여기 있는 건 다시 뽑지 않는다]
${g.knownUserFacts || "(없음)"}

[이미 아는 '나'(캐릭터)의 주변 인물 — 이 사람들은 people에 다시 넣지 않는다]
${g.knownCast || "(없음)"}

JSON으로:
{"user_facts":["상대에 대해 새로 알게 된 사실 (직업·상황·취향·이름 등 확실한 것만)"],"char_facts":["'나'가 자기 자신에 대해 새로 말한 즉흥 디테일 (기본 설정에 없을 법한 것)"],"schedules":[{"who":"user 또는 char","date":"YYYY-MM-DD (기준 날짜로 환산 가능한 것만, 캐릭터의 직업 상식과 어긋나면 제외 — 예: 은행원의 일요일 근무)","time_hint":"오전/저녁/14:00 등 또는 null","content":"무슨 일정인지"}],"people":[{"who":"char 또는 user","name":"이름이나 호칭(예: 고등학교 친구)","relation":"관계","note":"한 줄"}],"preferences":{"topics":[{"topic":"상대가 몰입한 소재(영화·투자 등)","note":"어떻게 몰입했는지 한 줄"}],"facets":[{"facet":"'나'의 어떤 성향/모습","response":"높음|보통|낮음","note":"근거 한 줄"}]}}
- people의 who: '나'(캐릭터)의 주변 인물이면 char, 상대(유저)가 언급한 상대의 사람(친구·가족·동료)이면 user. 이름을 모르면 호칭 그대로.
- people 중복 금지: 위 '이미 아는 인물'에 있는 사람은 다시 넣지 않는다. 그 사람을 호칭으로만 부른 것(예: 이미 아는 '이수진(입행 동기)'을 대화에서 "입행 동기"라고만 함)도 새 인물이 아니다. 정말 처음 등장한 사람만 넣는다.
- preferences.topics: 상대가 '평소보다 말이 많아지거나 깊이 파고든' 소재 = 호감 소재. 길이만이 아니라 상대가 그 화제를 얼마나 이어가고 되묻고 신나 했는지(대화량·몰입)로 판단. 없으면 빈 배열.
- preferences.facets: 이 대화에서 드러난 '나(우진)'의 성향/모습(안정감 있는 태도·장난과 위트·은행원이라는 직업·취미 공유 등) 각각에 상대의 반응이 어땠는지. 반응이 뚜렷한 것만(response=높음/낮음), 미지근하면 생략. 근거 없이 지어내지 않는다.`;

const SEND_SYSTEM = `너는 주어진 인물 그 자체로, 상대에게 먼저 보낼 메신저 문안을 준비한다. 하루를 시작했다는 걸 가볍게 알리는 아침의 결이 기본이다.`;

const sendPrompt = (
  g: NightlyGathered,
  moment: string,
): string => `너는 이 인물이다: ${JSON.stringify(g.bible.identity)}
오늘은 ${g.today} (${g.todayLabel}).

[이번 문안을 보내는 시점]
${moment}

[상대와 아직 이어가지 못한 것들]
${g.openLoops.join(" / ") || "(없음)"}

[상대의 다가오는 일정 (들은 것)]
${g.userSchedulesUpcoming || "(없음)"}

규칙:
- 아침이면 웬만하면 보낸다. 네 하루가 시작됐다는 걸 가볍게 알리는 결 — 위의 '보내는 시점' 그대로의 상황에서 쓰는 말이어야 한다(막 일어났으면 일어난 결, 출근길이면 이동 중의 결, 자리에 앉았으면 한숨 돌린 결). 자기 삶 공유는 그 자체로 근거다.
- 각본상 오늘 유난히 일찍 깼거나 늦잠이면 그 결을 자연스럽게 반영한다(예: "오늘따라 눈이 일찍 떠졌네요" / 늦잠이라 허둥지둥해서 회사 와서야 연락).
- 이어갈 것(위 목록)이나 상대의 오늘 일정이 있으면 그중 하나를 자연스럽게 엮는다. 특히 상대의 일정이 오늘이면 그걸 챙기는 게 우선이다.
- 한 통에 하나만. 캐묻지 않는다. 용건 없는 애정 표시성 핑은 금지.
- 지금 관계의 말투(존댓말이면 존댓말)를 유지한다. 질문엔 물음표. 1~3개 말풍선(줄바꿈 구분). 이모지 없음.
- 상대 일정이 점심·저녁에 있으면 window를 "점심"/"저녁"으로 바꿔도 된다(그 외엔 "아침").
- 아주 가끔은(그날 각본이 유난히 정신없으면) 건너뛰어도 사람답다 → send=false.

JSON: {"send":true,"window":"아침|점심|저녁","text":"..."} 또는 {"send":false}`;

const addMin = (hhmm: string, m: number): string => {
  const [h, mm] = hhmm.split(":").map(Number);
  const t = Math.min(23 * 60 + 59, (h ?? 0) * 60 + (mm ?? 0) + m);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

// 오늘 각본에서 아침의 기준점(기상·출근·자리)을 찾는다 — 아침 안부의 발송 시점을 삶과 연동
const morningAnchors = (
  raw: string | undefined,
): { wake?: string; commuteStart?: string; deskStart?: string } => {
  if (!raw) return {};
  try {
    const p = JSON.parse(raw) as DayPlan;
    const wake = p.blocks.find((b) => /기상|일어/.test(b.activity));
    const commute = p.blocks.find(
      (b) =>
        /출근|이동|운전/.test(b.activity) &&
        b.start >= "05:00" &&
        b.start < "10:30",
    );
    return {
      wake: wake?.start,
      commuteStart: commute?.start,
      deskStart: commute?.end,
    };
  } catch {
    return {};
  }
};

// 발송 예정 시각을 창 전체에서 무작위로 뽑는다 — 매일 같은 시각에 오면 기계처럼 보이므로.
const windowTimes = (w: string): [string, string] => {
  const range: [number, number] = w.includes("점심")
    ? [12 * 60 + 5, 12 * 60 + 50]
    : w.includes("저녁")
      ? [19 * 60 + 20, 20 * 60 + 40]
      : [9 * 60, 9 * 60 + 50]; // 아침 09:00~09:50
  const span = Math.max(1, range[1] - range[0] - 12);
  const s = range[0] + Math.floor(Math.random() * span); // 창 안 무작위 발송 예정 시각
  const f = (m: number): string =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return [f(s), f(range[1])];
};

const ARC_SYSTEM = `너는 한 인물의 삶의 큰 흐름을 짜는 작가다. 과장 없이, 실제 그 사람의 한 해에 있을 법한 결로.`;

const arcPrompt = (
  bible: Bible,
  today: string,
): string => `오늘은 ${today}다. 아래 인물의 삶의 큰 흐름을 JSON으로 짜줘.

[인물]
${JSON.stringify({ identity: bible.identity, backstory: bible.backstory.story_seeds, life: bible.life }, null, 2)}

{"year":"올해의 큰 진행 사건 1~2문장","season":"이 계절의 결 1~2문장","month":"이번 달의 상황 1~2문장","week":"이번 주의 특이사항 1문장 (없으면 '평범한 주')"}`;

export const ensureArcs = async (
  characterId: number,
  bible: Bible,
): Promise<void> => {
  if (Object.keys(getArcs(characterId)).length) return;
  const arcs = await chatJson<{
    year: string;
    season: string;
    month: string;
    week: string;
  }>(ARC_SYSTEM, arcPrompt(bible, kstDateString()), 1000, config.modelDeep);
  saveArc(characterId, "year", arcs.year);
  saveArc(characterId, "season", arcs.season);
  saveArc(characterId, "month", arcs.month);
  saveArc(characterId, "week", arcs.week);
};

export const runNightly = async (character: CharacterRow): Promise<string> => {
  const g = gatherNightlyInput(character);
  await ensureArcs(g.characterId, g.bible);
  // 이번 달(+월말이면 다음 달) 리듬을 확보한다. ensureTodayPlan이 오늘 시드를 읽어 각본에 잇는다
  await ensureRhythmRunway(g.characterId, g.bible, g.today);

  if (g.diaryExists) {
    await ensureTodayPlan(g.characterId, g.bible);
    return `skip: ${g.diaryDate} 일기 이미 있음`;
  }

  let entry: DiaryOutput;
  let extract: ExtractOutput | null = null;
  let send: SendDraft | null = null;

  if (g.msgsCount) {
    entry = await chatJson<DiaryOutput>(
      DIARY_SYSTEM,
      diaryPrompt(g),
      2000,
      config.modelDeep,
    );
    extract = await chatJson<ExtractOutput>(
      EXTRACT_SYSTEM,
      extractPrompt(g),
      1500,
      config.modelDeep,
    );
  } else {
    entry = await chatJson<DiaryOutput>(
      DIARY_SYSTEM,
      quietDayPrompt(g),
      1200,
      config.modelDeep,
    );
  }

  // 오늘 각본을 먼저 만들고, 아침 안부의 발송 시점을 그 각본의 삶(기상·출근·자리)과 연동한다
  await ensureTodayPlan(g.characterId, g.bible);
  const anchors = morningAnchors(getDayPlan(g.characterId, g.today));
  const isWorkday = g.todayLabel.includes("근무");
  const styles: [string, string, string][] = [];
  if (anchors.wake)
    styles.push([
      `막 일어난 참 (기상 ${anchors.wake}쯤)`,
      anchors.wake,
      addMin(anchors.wake, 25),
    ]);
  if (isWorkday && anchors.commuteStart)
    styles.push([
      `출근길 (이동 시작 ${anchors.commuteStart}쯤)`,
      anchors.commuteStart,
      addMin(anchors.commuteStart, 25),
    ]);
  if (isWorkday && anchors.deskStart)
    styles.push([
      `출근해서 자리에 앉아 한숨 돌린 참 (${anchors.deskStart}쯤)`,
      addMin(anchors.deskStart, 5),
      addMin(anchors.deskStart, 45),
    ]);
  const style = styles.length
    ? styles[Math.floor(Math.random() * styles.length)]
    : null;

  // 선톡 문안: 아침의 자기 삶 공유가 기본, 오픈 루프·상대 일정이 있으면 엮는다
  const loopsForSend = [...g.openLoops, ...(entry.tomorrow ?? [])];
  {
    const draft = await chatJson<{
      send: boolean;
      window?: string;
      text?: string;
    }>(
      SEND_SYSTEM,
      sendPrompt(
        { ...g, openLoops: loopsForSend },
        style ? style[0] : "아침 (여유로운 시간대)",
      ),
      800,
      config.modelDeep,
    );
    if (draft.send && draft.text) {
      if (draft.window && /점심|저녁/.test(draft.window)) {
        const [ws, we] = windowTimes(draft.window);
        send = { window_start: ws, window_end: we, text: draft.text };
      } else if (style) {
        send = {
          window_start: style[1],
          window_end: style[2],
          text: draft.text,
        };
      } else {
        const [ws, we] = windowTimes("아침");
        send = { window_start: ws, window_end: we, text: draft.text };
      }
    }
  }

  const result = applyNightlyOutput(g, { entry, extract, send });
  return result;
};
