import { chatJson } from "./llm.js";
import { config } from "./config.js";
import {
  db,
  getDayPlan,
  getDayPlanMadeBy,
  getDaySeed,
  getRecentDiaries,
  getRelationship,
  updateRelationshipNotes,
  addSchedule,
  getArcs,
  saveArc,
  saveDayPlan,
  setTags,
  getUpcomingSchedules,
  insertScheduledSend,
  getTodayNotes,
  getDayActuals,
  listMemoryItems,
  listTagNames,
  getUserProfile,
  saveUserProfile,
  type CharacterRow,
  type DaySeed,
  type MemoryRow,
  type RelationshipRow,
} from "./db.js";
import { buildSystemBlocks } from "./context.js";
import type { DayPlan, PlanBlock } from "./day-plan.js";
import { ensureTodayPlan, normalizePlan } from "./day-plan.js";
import {
  saveMemory,
  keyProblem,
  existingKeys,
  existingAreas,
  identityLines,
} from "./memory.js";
import {
  applyMonthPlan,
  ensureRhythmRunway,
  monthDays,
  monthsNeedingRhythm,
  type MonthPlan,
} from "./life-plan.js";
import { getKstNow, kstDateString, dayLabelOf, clockLabel } from "./kst.js";
import {
  dailySendPlan,
  silenceState,
  type DailySendPlan,
} from "./proactive-policy.js";
import { afterNightlyTrace, beforeNightlyTrace } from "./nightly-trace.js";
import {
  DIARY_TAG_MAX,
  LUNCH_WINDOW,
  RECONNECT_WINDOW,
  RECENT_DIARY_DAYS,
} from "./thresholds.js";
import {
  SPEECH_LEVEL_NAME,
  type MemoryItemType,
  type MemoryOwner,
  type UserKnows,
  type Interest,
} from "./labels.js";

// 새벽 정리: 새벽 5시 컷오프로 어제 하루를 닫는다.
// 일기 응고(각본 대비·감정 관찰) + 기억·관계·일정 정리 + 오늘 각본 + 선톡 문안 준비.
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
  // 이 하루를 나중에 다시 꺼낼 주제 태그. 기억 태그와 같은 어휘를 써야 대화 주제와 이어진다.
  // 옵셔널인 이유는 이미 저장된 일기와 아직 이 항목을 안 만드는 생성 경로가 있어서다.
  tags?: string[];
}

// 기억 정리 호출의 출력 한 건 — memory_items에 키(영역/무엇)로 저장된다.
export interface MemoryExtract {
  item_type: MemoryItemType;
  owner: MemoryOwner;
  area: string;
  subject: string;
  value: string;
  tags?: string[];
  user_knows?: UserKnows;
  relation?: string;
  contact_mode?: string;
  region?: string;
  end_condition?: string;
  interest?: Interest;
}

// 관계 갱신분 — 넣은 항목만 갱신된다. 말투 값(speech_level)은 답장 파이프라인 몫이라 여기 없음.
export interface RelationshipExtract {
  stage?: string;
  speech_note?: string;
  address_terms?: string;
  rapport?: string;
  cautions?: string;
  history?: string;
  feelings?: string;
}

// 상대 프로필 갱신분 — 대화에서 분명히 드러난 값만. 넣은 항목만 갱신되고,
// 빈 값은 이미 아는 값을 덮지 않는다(db.ts saveUserProfile).
export interface UserProfileExtract {
  job?: string;
  region?: string;
}

export interface ExtractOutput {
  memories: MemoryExtract[];
  relationship?: RelationshipExtract | null;
  user_profile?: UserProfileExtract | null;
  schedules: {
    who: "user" | "char";
    date: string;
    time_hint: string | null;
    content: string;
    // 이 일정을 나중에 주제로 다시 꺼낼 태그. 기억과 같은 어휘를 써야 함께 찾아진다.
    // 옵셔널인 이유는 이미 저장된 일정과 아직 이 항목을 안 만드는 생성 경로가 있어서다.
    tags?: string[];
  }[];
}

export interface SendDraft {
  window_start: string; // "HH:MM"
  window_end: string;
  text: string;
  // 생략 시 morning. checkin=긴 침묵 뒤 안부 1통.
  // 점심 선톡은 morning으로 저장하고 발송 창만 점심으로 둔다 — 발송 경로가 같아서
  // 종류를 늘리면 scheduled_messages 이관만 늘고 얻는 게 없다.
  kind?: "morning" | "checkin";
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
  identity: string; // 정체성 사실 줄들 (creation + conversation, 같은 키는 최신이 이김)
  people: string; // 주변 인물 줄들 (캐릭터 쪽·유저 쪽 모두)
  ongoing: string; // 진행 중인 일 줄들
  relationship: string; // 관계 일곱 항목의 지금 값
  userProfile: string; // 대화로 채우는 상대 프로필 두 값(하는 일·사는 지역)의 지금 상태
  todayNotes: string[]; // 그 하루 동안 대화하며 적어 둔 오늘 메모
  dayActuals: string[]; // 각본과 달라진 블록 기록
  existingKeys: { itemType: MemoryItemType; owner: MemoryOwner; key: string }[]; // 추출이 같은 주제에 재사용할 키 목록
  areas: string[]; // 쓰고 있는 영역 이름들
  tagNames: string[]; // 이미 쓰는 태그 표기들
  userSchedulesUpcoming: string; // 상대의 다가오는 일정 (선톡 근거)
  arcs: Record<string, string>;
  todaySeed: DaySeed | null; // 오늘의 컨디션 시드(있으면)
  rhythmNeeded: { ym: string; days: { date: string; label: string }[] }[]; // 이번 새벽에 생성해야 할 월 리듬
  // 침묵 백오프 상태 — 외부 생성 경로가 이를 보고 산출물을 조절한다
  // (normal=평소대로 / quiet·dormant=각본·선톡 생성 불필요 / checkin=저녁 재연결 문안만)
  silenceTier: "normal" | "quiet" | "checkin" | "dormant";
  silenceDays: number;
  // 오늘 미리 만들어 둘 선톡 — morning=아침 한 통 / lunch=점심 한 통 /
  // checkin=저녁 안부 한 통 / none=준비하지 않는 날. 외부 생성 경로는 이 값만 보면 된다.
  sendPlan: "morning" | "lunch" | "checkin" | "none";
  sendPlanReason: string;
}

const nowStamp = (): string =>
  `${kstDateString()} ${getKstNow().toISOString().slice(11, 19)}`;

// 모델이 준 태그를 다듬는다. 배열이 아닐 수도, 빈 문자열이나 같은 말이 두 번 올 수도 있다.
const cleanTags = (raw: unknown, max?: number): string[] => {
  const list = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (const t of list) {
    const v = typeof t === "string" ? t.trim() : "";
    if (!v || out.includes(v)) continue;
    out.push(v);
    if (max && out.length >= max) break;
  }
  return out;
};

// 일기에 붙일 태그. 상한을 두는 이유는 thresholds.ts DIARY_TAG_MAX 주석에 적었다.
// 일정 태그에는 상한을 두지 않는다 — 일정은 대화에서 잡힌 것만 드문드문 쌓여서, 같은 호출의
// 기억 태그와 사정이 같다.
const diaryTags = (entry: DiaryOutput): string[] =>
  cleanTags(entry.tags, DIARY_TAG_MAX);

const planBrief = (raw: string | undefined): string => {
  if (!raw) return "";
  try {
    const p = JSON.parse(raw) as DayPlan;
    return p.blocks
      .map((b) => `${clockLabel(b.start)} ${b.activity}`)
      .join(" / ");
  } catch {
    return "";
  }
};

const personLine = (r: MemoryRow): string => {
  const meta = [r.area, r.relation, r.owner === "user" ? "상대 쪽 사람" : null]
    .filter(Boolean)
    .join(", ");
  return `- ${r.subject} (${meta}): ${r.value}`;
};

const ongoingLine = (r: MemoryRow): string =>
  `- ${r.owner === "user" ? "(상대) " : ""}${r.area}/${r.subject}: ${r.value}${r.end_condition ? ` (끝나는 조건: ${r.end_condition})` : ""}`;

// 대화로 채우는 프로필 두 값의 지금 상태. 모르는 값을 그대로 드러내 추출 호출이
// 무엇을 찾아야 하는지 알게 하고, 이미 아는 값은 다시 쓰지 않게 한다.
const userProfileLines = (chatId: string): string => {
  const p = getUserProfile(chatId);
  return [
    `- 하는 일: ${p.job ?? "(모름)"}`,
    `- 사는 지역: ${p.region ?? "(모름)"}`,
  ].join("\n");
};

const relationshipLines = (r: RelationshipRow | undefined): string => {
  if (!r) return "";
  const items: [string, string | null][] = [
    ["지금 어떤 사이", r.stage],
    ["말투", r.speech_level ? SPEECH_LEVEL_NAME[r.speech_level] : null],
    ["상대에게 쓰는 말투", r.speech_note],
    ["서로 부르는 말", r.address_terms],
    ["잘 통하는 것", r.rapport],
    ["조심할 것", r.cautions],
    ["지나온 이야기", r.history],
    ["지금 마음", r.feelings],
  ];
  return items
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
};

const arcLinesOf = (g: NightlyGathered): string =>
  Object.entries(g.arcs)
    .map(([h, c]) => `${h}: ${c}`)
    .join("\n");

// 아크 생성·갱신에 넣는 인물 재료 — 기억(정체성·주변 인물·진행 중인 일)과 관계로 만든다.
// V2 생성 직후에는 character.ts의 arcMaterial이 생성 출력으로 같은 모양을 만든다.
const arcMaterialOf = (g: NightlyGathered): string =>
  [
    "[정체성]",
    g.identity || "(없음)",
    "",
    "[주변 인물]",
    g.people || "(없음)",
    "",
    "[진행 중인 일]",
    g.ongoing || "(없음)",
    "",
    "[유저와의 관계]",
    g.relationship || "(이제 막 시작한 사이)",
  ].join("\n");

// targetDiaryDate를 주면 그 날짜의 하루(05:00~익일 05:00)를 응고 대상으로 잡는다 — 결번 백필용.
// 생략하면 기본대로 '어제'.
export const gatherNightlyInput = (
  character: CharacterRow,
  targetDiaryDate?: string,
): NightlyGathered => {
  const now = getKstNow();
  const shifted = new Date(now.getTime() - 5 * 3600_000);
  const today = kstDateString(shifted);
  const diaryDate =
    targetDiaryDate ??
    kstDateString(new Date(shifted.getTime() - 24 * 3600_000));

  // 대화 창은 그 하루(diaryDate 05:00 ~ 다음날 05:00)로 한정 — 백필로 과거 날짜를 잡아도
  // 오늘까지의 대화가 통째로 섞이지 않게.
  const diaryNext = kstDateString(
    new Date(new Date(`${diaryDate}T00:00:00Z`).getTime() + 24 * 3600_000),
  );
  const msgs = db
    .prepare(
      `SELECT role, sent_at, text FROM messages WHERE chat_id = ? AND sent_at >= ? AND sent_at < ? ORDER BY id`,
    )
    .all(
      character.chat_id,
      `${diaryDate} 05:00:00`,
      `${diaryNext} 05:00:00`,
    ) as {
    role: string;
    sent_at: string;
    text: string;
  }[];

  const silence = silenceState(character.chat_id, character.id);
  const plan = dailySendPlan(character.chat_id, character.id, today);
  return {
    characterId: character.id,
    chatId: character.chat_id,
    diaryDate,
    today,
    todayLabel: dayLabelOf(today),
    diaryExists: !!db
      .prepare(
        `SELECT 1 FROM diary_entries WHERE character_id = ? AND date = ? LIMIT 1`,
      )
      .get(character.id, diaryDate),
    convo: msgs
      .map(
        (m) =>
          `[${m.sent_at.slice(11, 16)}] ${m.role === "user" ? "상대" : "나"}: ${m.text.replace(/\n/g, " ")}`,
      )
      .join("\n"),
    msgsCount: msgs.length,
    planBriefYesterday: planBrief(getDayPlan(character.id, diaryDate)),
    planExistsToday: !!getDayPlan(character.id, today),
    identity: identityLines(character.id),
    people: listMemoryItems(character.id, "person").map(personLine).join("\n"),
    ongoing: listMemoryItems(character.id, "ongoing")
      .map(ongoingLine)
      .join("\n"),
    relationship: relationshipLines(getRelationship(character.id)),
    userProfile: userProfileLines(character.chat_id),
    todayNotes: getTodayNotes(character.id, `${diaryDate} 05:00:00`)
      .filter((n) => n.created_at < `${diaryNext} 05:00:00`)
      .map((n) => `[${n.created_at.slice(11, 16)}] ${n.note}`),
    dayActuals: getDayActuals(character.id, diaryDate).map(
      (a) =>
        `- ${a.block_start ? `${clockLabel(a.block_start)} ` : ""}${a.intended} → ${a.outcome}${a.reason ? ` (${a.reason})` : ""}`,
    ),
    existingKeys: existingKeys(character.id),
    areas: existingAreas(character.id),
    tagNames: listTagNames(character.id),
    userSchedulesUpcoming: getUpcomingSchedules(character.id, today)
      .filter((s) => s.owner === "user")
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
    silenceTier: silence.tier,
    silenceDays: silence.days,
    sendPlan: plan.kind,
    sendPlanReason: plan.reason,
  };
};

// 생성 결과를 DB에 반영한다. 외부 scheduled task와 API 폴백이 공유하는 단일 쓰기 경로.
//
// 전체가 하나의 트랜잭션이다(본문은 전부 동기 호출). 이게 없으면 일기 INSERT 후 뒷단(기억~선톡)
// 어디서든 예외가 나면 일기만 남고, 재실행은 아래 dup 체크에 막혀 그 날짜의 기억·일정·선톡이
// 영구히 빠진다 — 전부 반영되거나 전부 롤백되어 재실행이 항상 안전하게.
// (saveMemory 내부의 태그 트랜잭션은 better-sqlite3가 세이브포인트로 중첩 처리한다.)
const applyNightlyTxn = db.transaction(
  (g: NightlyGathered, out: NightlyOutput): string => {
    const ts = nowStamp();

    const dup = db
      .prepare(
        `SELECT 1 FROM diary_entries WHERE character_id = ? AND date = ? LIMIT 1`,
      )
      .get(g.characterId, g.diaryDate);
    if (dup) return `skip: ${g.diaryDate} 일기 이미 있음`;

    const diaryId = Number(
      db
        .prepare(
          `INSERT INTO diary_entries (character_id, date, entry_json) VALUES (?, ?, ?)`,
        )
        .run(g.characterId, g.diaryDate, JSON.stringify(out.entry))
        .lastInsertRowid,
    );
    // 일기도 기억과 같은 태그로 찾는다 — 이 줄이 없으면 옛 일기를 태그로 꺼내는
    // 경로(context.ts)가 늘 빈손으로 돌아온다.
    const diaryTagList = diaryTags(out.entry);
    if (diaryTagList.length)
      setTags(g.characterId, "diary", diaryId, diaryTagList);

    const ex = out.extract;
    let memCount = 0;
    let schedTagCount = 0;
    let profileFilled: string[] = [];
    const skippedKeys: string[] = [];
    if (ex) {
      // 같은 키를 다시 쓸 때 모델이 생략한 추가 정보(어떤 사이·만나는 결 등)가
      // null로 덮이지 않게, 기존 행의 값을 받침으로 깐다. conversation 행 우선.
      const prevRows = new Map<string, MemoryRow>();
      for (const r of listMemoryItems(g.characterId)) {
        const k = `${r.item_type}|${r.owner}|${r.area}/${r.subject}`;
        const cur = prevRows.get(k);
        if (
          !cur ||
          (cur.origin !== "conversation" && r.origin === "conversation")
        )
          prevRows.set(k, r);
      }
      for (const m of ex.memories ?? []) {
        if (!m.value?.trim() || !m.area || !m.subject) continue;
        // 키가 규칙에 안 맞는 한 건이 트랜잭션 전체를 되돌리지 않게(saveMemory는 throw) 미리 걸러 건너뛴다
        if (keyProblem(m.area, m.subject)) {
          skippedKeys.push(`${m.area}/${m.subject}`);
          continue;
        }
        const prev = prevRows.get(
          `${m.item_type}|${m.owner}|${m.area.trim()}/${m.subject.trim()}`,
        );
        saveMemory({
          characterId: g.characterId,
          itemType: m.item_type,
          owner: m.owner,
          area: m.area,
          subject: m.subject,
          value: m.value,
          tags: Array.isArray(m.tags) ? m.tags : undefined,
          userKnows: m.user_knows ?? prev?.user_knows ?? undefined,
          relation: m.relation ?? prev?.relation ?? undefined,
          contactMode: m.contact_mode ?? prev?.contact_mode ?? undefined,
          region: m.region ?? prev?.region ?? undefined,
          lastMentionedAt: m.item_type === "person" ? g.diaryDate : undefined,
          endCondition: m.end_condition ?? prev?.end_condition ?? undefined,
          interest: m.interest ?? prev?.interest ?? undefined,
        });
        memCount++;
      }
      if (skippedKeys.length)
        console.warn(
          `[nightly] 키 규칙에 안 맞아 건너뜀: ${skippedKeys.join(", ")}`,
        );

      // 관계 갱신 — 출력에 넣은 항목만 바뀌고 나머지는 그대로 남는다
      if (ex.relationship) {
        const r = ex.relationship;
        const clean = (v?: string): string | undefined =>
          v && v.trim() ? v.trim() : undefined;
        updateRelationshipNotes(
          g.characterId,
          {
            stage: clean(r.stage),
            speechNote: clean(r.speech_note),
            addressTerms: clean(r.address_terms),
            rapport: clean(r.rapport),
            cautions: clean(r.cautions),
            history: clean(r.history),
            feelings: clean(r.feelings),
          },
          ts,
        );
      }

      // 상대 프로필 — 대화로 채우는 두 값(하는 일·사는 지역). 이미 아는 값과 같으면 건너뛰고,
      // 빈 값은 기존 값을 덮지 않는다(saveUserProfile이 한 번 더 막는다).
      const curProfile = getUserProfile(g.chatId);
      const job = ex.user_profile?.job?.trim();
      const region = ex.user_profile?.region?.trim();
      const nextProfile = {
        job: job && job !== curProfile.job ? job : undefined,
        region: region && region !== curProfile.region ? region : undefined,
      };
      if (nextProfile.job || nextProfile.region) {
        saveUserProfile(g.chatId, nextProfile, ts);
        profileFilled = [
          nextProfile.job ? "하는 일" : "",
          nextProfile.region ? "사는 곳" : "",
        ].filter(Boolean);
      }

      // 일정도 기억·일기와 같은 태그로 찾는다 — 이 줄이 없으면 지난 일정을 주제로 꺼내는
      // 경로(context.ts)가 늘 빈손으로 돌아온다.
      for (const s of ex.schedules ?? [])
        if (s.date && s.content) {
          const schedId = addSchedule(
            g.characterId,
            s.who === "user" ? "user" : "char",
            s.date,
            s.time_hint ?? null,
            s.content,
            ts,
          );
          const schedTagList = cleanTags(s.tags);
          if (schedTagList.length)
            setTags(g.characterId, "schedule", schedId, schedTagList);
          schedTagCount += schedTagList.length;
        }
    }

    // 그날 각본: 없으면 저장하고, 있어도 새벽 대화가 만든 lazy 각본이면 정식 각본으로 교체한다.
    // 임시 각본은 어제 일기가 아직 없을 때(이틀 전 일기 참조) 만들어진 것 — 그대로 두면
    // "어제 여파가 시드보다 우선" 설계가 정확히 새벽까지 대화한 날마다 무력화된다.
    // (교체에 쓰는 정식 각본은 그 새벽 대화가 담긴 어제 일기를 반영하므로 모순 위험은 작다.)
    if (
      out.plan &&
      (!getDayPlan(g.characterId, g.today) ||
        getDayPlanMadeBy(g.characterId, g.today) === "ondemand")
    )
      saveDayPlan(
        g.characterId,
        g.today,
        JSON.stringify(normalizePlan(out.plan)),
        "nightly",
      );

    if (out.arcs) {
      for (const h of ["year", "season", "month", "week"] as const)
        if (out.arcs[h]) saveArc(g.characterId, h, out.arcs[h]);
    }

    if (out.rhythm)
      for (const r of out.rhythm)
        if (r.ym) applyMonthPlan(g.characterId, r.ym, r);

    // 선톡 문안 — 관제탑(dailySendPlan) 게이트를 지나야 저장된다. 외부 생성 경로가 그날의
    // 판정을 모르고 문안을 보내와도 여기서 걸러진다. 점심 문안은 아침 문안과 같은 종류로
    // 저장하므로 둘을 함께 통과시키고, 창은 생성 쪽이 정한 값을 그대로 쓴다.
    let sendStored = false;
    if (out.send?.text) {
      const plan = dailySendPlan(g.chatId, g.characterId, g.today);
      const kind = out.send.kind ?? "morning";
      const allowed =
        kind === "checkin"
          ? plan.kind === "checkin"
          : plan.kind === "morning" || plan.kind === "lunch";
      if (allowed) {
        insertScheduledSend(
          g.characterId,
          g.chatId,
          g.today,
          out.send.window_start,
          out.send.window_end,
          out.send.text,
          ts,
          kind,
        );
        sendStored = true;
      }
    }

    return `ok: ${g.diaryDate} 일기 응고 (대화 ${g.msgsCount}개${diaryTagList.length ? `, 일기 태그 ${diaryTagList.length}개` : ""}${memCount ? `, 기억 ${memCount}건` : ""}${schedTagCount ? `, 일정 태그 ${schedTagCount}개` : ""}${skippedKeys.length ? `, 키 불가 ${skippedKeys.length}건 건너뜀` : ""})${out.plan ? ` + ${g.today} 각본` : ""}${profileFilled.length ? ` + 상대 프로필(${profileFilled.join("·")})` : ""}${sendStored ? ` + 선톡 준비(${out.send?.kind ?? "morning"})` : ""}`;
  },
);

// 봇 밖 스케줄러(tools/nightly-write)와 봇 안 폴백 크론이 둘 다 이 함수를 지난다 —
// 트레이스 게시를 여기 한 자리에 걸어 두 경로가 같은 기록을 남긴다.
// 이전 값은 트랜잭션 전에 읽고, 게시함에 쌓는 것은 트랜잭션 바깥에서 한다:
// 게시가 실패해도 그날 새벽 정리는 이미 저장되어 있다.
export const applyNightlyOutput = (
  g: NightlyGathered,
  out: NightlyOutput,
): string => {
  const snap = beforeNightlyTrace(g, out);
  const result = applyNightlyTxn(g, out);
  afterNightlyTrace(g, out, snap, result);
  return result;
};

// 최근 결번 날짜들: 원시 대화는 있는데 일기가 안 써진 날(오래된 순, '어제' 포함).
// 새벽 정리가 며칠 안 돌면(외부 경로·폴백 모두 실패) 생기며, 소급하지 않으면 그 날짜의
// 기억·일정 정리가 영구히 빠진다 — 매일 한 번 도는 새벽 정리가 이 목록을 순회해 따라잡는다.
// (대화가 없던 결번 날은 소급하지 않는다 — 응고할 재료가 없고, 지어낸 일기만 남는다.)
export const missingDiaryDates = (
  characterId: number,
  chatId: string,
  lookbackDays = 7,
): string[] => {
  const shifted = new Date(getKstNow().getTime() - 5 * 3600_000);
  const out: string[] = [];
  for (let i = lookbackDays; i >= 1; i--) {
    const d = kstDateString(new Date(shifted.getTime() - i * 24 * 3600_000));
    const next = kstDateString(
      new Date(shifted.getTime() - (i - 1) * 24 * 3600_000),
    );
    const hasDiary = !!db
      .prepare(
        `SELECT 1 FROM diary_entries WHERE character_id = ? AND date = ? LIMIT 1`,
      )
      .get(characterId, d);
    if (hasDiary) continue;
    const hasMsgs = !!db
      .prepare(
        `SELECT 1 FROM messages WHERE chat_id = ? AND sent_at >= ? AND sent_at < ? LIMIT 1`,
      )
      .get(chatId, `${d} 05:00:00`, `${next} 05:00:00`);
    if (hasMsgs) out.push(d);
  }
  return out;
};

// ── 이하 API 폴백 경로 ──────────────────────────────────────────

const DIARY_SYSTEM = `너는 주어진 인물 그 자체다. 하루를 마치고 혼자 일기를 쓴다. 담백하고 사적인 1인칭 문장으로, 과장 없이.`;

const diaryPrompt = (g: NightlyGathered): string => `너는 이 인물이다.

[정체성]
${g.identity || "(없음)"}

[삶의 흐름]
${arcLinesOf(g) || "(없음)"}

[상대와의 관계]
${g.relationship || "(이제 막 시작한 사이)"}

오늘은 ${g.diaryDate}였다.

[오늘의 원래 흐름]
${g.planBriefYesterday || "(기록 없음)"}

[각본과 달라진 것]
${g.dayActuals.join("\n") || "(없음)"}

[오늘 메모 — 대화하며 적어 둔 것]
${g.todayNotes.join("\n") || "(없음)"}

[이미 쓰는 태그]
${g.tagNames.join(", ") || "(없음)"}

[상대와 나눈 대화 전체]
${g.convo}

오늘을 정리해 JSON으로:
{"diary":"오늘의 일기. 1인칭, 5~10문장. 실제 보낸 하루와 상대와 나눈 것, 마음에 남은 것","plan_vs_actual":"원래 흐름과 실제로 보낸 하루가 달랐던 점 한두 줄","user_mood":"상대의 감정 흐름에 대한 관찰 한두 줄","closeness":"상대와의 거리감·온도 한 줄 (내부 기록, 상대에게 절대 언급하지 않는 것)","tomorrow":["내일 자연스럽게 이어가거나 물어볼 것 0~2개"],"tags":["이 하루를 나중에 다시 꺼낼 주제 태그 3~${DIARY_TAG_MAX}개"]}

tags 규칙:
- 나중에 이 하루를 다시 꺼내는 실마리다. 한 일·간 곳·만난 사람 이름·나눈 이야기의 주제를 낱말로 적는다.
- [이미 쓰는 태그]에 같은 뜻이 있으면 그 표기를 그대로 쓴다. 같은 주제를 다른 낱말로 적으면 나중에 함께 찾아지지 않는다.
- 명사 한 덩어리로 짧게. 날짜·문장·감상은 태그로 쓰지 않는다.`;

const quietDayPrompt = (g: NightlyGathered): string => `너는 이 인물이다.

[정체성]
${g.identity || "(없음)"}

[삶의 흐름]
${arcLinesOf(g) || "(없음)"}

오늘은 ${g.diaryDate}였고, 상대와 대화가 없던 날이다. 아래 흐름대로 혼자 하루를 보냈다.

[오늘의 흐름]
${g.planBriefYesterday || "(평범한 하루)"}
${g.dayActuals.length ? `\n[각본과 달라진 것]\n${g.dayActuals.join("\n")}\n` : ""}
[이미 쓰는 태그]
${g.tagNames.join(", ") || "(없음)"}

JSON으로:
{"diary":"혼자 보낸 하루의 일기. 1인칭, 3~6문장. 대화가 없었던 것에 대한 감정이 있다면 안정형답게 담담하게","plan_vs_actual":"—","user_mood":"—","closeness":"—","tomorrow":[],"tags":["이 하루를 나중에 다시 꺼낼 주제 태그 2~${DIARY_TAG_MAX}개"]}

tags 규칙: 한 일·간 곳·만난 사람 이름을 낱말로 적는다. [이미 쓰는 태그]에 같은 뜻이 있으면 그 표기를 그대로 쓰고, 명사 한 덩어리로 짧게 쓴다.`;

// 기억과 일정이 같은 어휘로 묶이도록 태그 규칙은 한 문장을 두 자리에 쓴다 — 규칙이 갈라지면
// 같은 주제가 다른 낱말로 적혀 함께 찾아지지 않는다.
const TAG_RULE = `내용과 관련된 말을 넉넉히 붙인다. 사람 이름은 반드시 태그로. [이미 쓰는 태그]에 같은 뜻이 있으면 그 표기를 재사용한다.`;

const EXTRACT_SYSTEM = `너는 캐릭터의 하루에서 다음 대화에 필요한 기억을 정리하는 정리자다. 대화에 나온 확실한 사실만 담고, 남길 것이 없으면 빈 배열을 준다.`;

const extractPrompt = (g: NightlyGathered): string => {
  const keyLines = g.existingKeys
    .map((k) => `- ${k.itemType} ${k.owner} ${k.key}`)
    .join("\n");
  return `기준 날짜: ${g.diaryDate}. '나' = 캐릭터(owner "char"), '상대' = 유저(owner "user").

[나의 정체성 — 이미 아는 것]
${g.identity || "(없음)"}

[이미 아는 주변 인물]
${g.people || "(없음)"}

[진행 중인 일]
${g.ongoing || "(없음)"}

[상대와의 관계 — 지금 값]
${g.relationship || "(이제 막 시작한 사이)"}

[상대 프로필 — 지금 값]
${g.userProfile}

[이미 있는 키 — 같은 주제는 반드시 이 키를 그대로 다시 쓴다 (항목 owner 영역/무엇)]
${keyLines || "(없음)"}

[영역 이름 목록]
${g.areas.join(", ") || "(없음)"}

[이미 쓰는 태그]
${g.tagNames.join(", ") || "(없음)"}

[오늘의 대화]
${g.convo}

[오늘 메모 — 대화하며 적어 둔 남길 것]
${g.todayNotes.join("\n") || "(없음)"}

[각본과 달라진 것]
${g.dayActuals.join("\n") || "(없음)"}

JSON으로:
{"memories":[{"item_type":"fact|ongoing|person","owner":"char|user","area":"영역","subject":"무엇","value":"사실 한 문장","tags":["관련어"],"user_knows":"known|unknown — '나'(char) 쪽만","relation":"person만 — 어떤 사이","contact_mode":"person만 — 만나는 결(직장에서 매일, 가끔 연락 등)","region":"person만 — 어디 사람인지","end_condition":"ongoing만 — 끝났다고 볼 조건","interest":"high|medium|low — '나' 쪽 기억에 상대의 관심이 뚜렷할 때만"}],"relationship":{"stage":"지금 어떤 사이","speech_note":"상대에게 쓰는 말투","address_terms":"서로 부르는 말","rapport":"잘 통하는 것","cautions":"조심할 것","history":"지나온 이야기","feelings":"지금 마음"},"user_profile":{"job":"상대가 하는 일","region":"상대가 사는 지역"},"schedules":[{"who":"user 또는 char","date":"YYYY-MM-DD","time_hint":"오전/저녁/14:00 등 또는 null","content":"무슨 일정인지","tags":["관련어"]}]}

memories 규칙:
- 남길 것 = 다음에 대화할 때 알고 있어야 자연스러운 사실만. 잡담 전부가 아니라 이어질 것만.
- item_type: 그때그때의 사실=fact / 끝나는 조건이 있는 일=ongoing / 사람=person.
- 키 = 영역/무엇. 영역은 위 [영역 이름 목록]에서 고르고, 꼭 맞는 게 없을 때만 새로 만든다(12자 이내). '무엇'은 명사 한 덩어리 20자 이내. 두 자리 모두 슬래시·세로줄·쉼표·가운뎃점 금지.
- 같은 주제가 [이미 있는 키]에 있으면 반드시 그 키를 그대로 쓴다 — 같은 키에 쓰면 내용이 새 사실로 갈아 끼워진다. 이미 아는 내용과 같은 것은 다시 넣지 않는다.
- person: 영역=갈래(가족·직장·친구 등), 무엇=이름(모르면 호칭 그대로). 상대가 흘리듯 언급한 상대 쪽 사람도 빠뜨리지 않는다. 이미 아는 인물은 내용이 달라졌을 때만 같은 키로 다시 쓴다.
- "~라고 불러줘" 같은 지시·부탁은 사실 문장으로 바꿔 저장한다 (예: 상대는 OO라고 불리는 걸 좋아한다).
- tags: ${TAG_RULE}
- user_knows: '나'(char) 쪽 기억에만 — 이 사실을 상대가 아는가.

relationship 규칙: 이 하루로 실제 달라진 항목만 넣는다 (넣은 항목만 갱신되고, 나머지는 그대로 남는다). 각 항목은 짧은 서술로. 존댓말·반말 같은 말투 값은 여기서 바꾸지 않는다. 달라진 게 없으면 relationship은 null.
user_profile 규칙:
- 상대가 하는 일·사는 지역이 대화에서 분명히 드러났을 때만 넣는다. 어림짐작으로 채우지 않고, 확실하지 않으면 비워 둔다.
- 위 [상대 프로필 — 지금 값]에 이미 있는 값과 같으면 넣지 않는다. 두 값 다 그대로면 user_profile은 null.
- 값은 짧게 — 하는 일은 직업 한 덩어리(예: 중학교 교사), 사는 지역은 시·구 정도(예: 서울 마포구). 문장으로 쓰지 않는다.
- 여기 넣은 값은 프롬프트에 늘 들어간다. 같은 내용을 memories에 또 넣지 않고, 이야기가 붙는 것(회사를 옮긴 사정, 동네에서 자주 가는 곳 같은)만 memories로 남긴다.
schedules 규칙:
- 기준 날짜로 환산 가능한 날짜만. 위 정체성의 직업·생활과 어긋나는 날짜면 제외한다.
- tags: ${TAG_RULE}`;
};

// ── 선톡 문안 — 대화와 같은 3층 프롬프트(buildSystemBlocks)에 상황 문단만 얹는다 ──
// 앞 두 층이 대화와 같아야 캐시가 붙는다. 문안은 새벽에 미리 쓰지만 나가는 건 아침·저녁이라,
// 실시간 꼬리의 '지금' 시각이 아니라 보내는 시점의 결로 쓰라고 상황 문단이 못박는다.

const morningSituation = (
  g: NightlyGathered,
  moment: string,
  tomorrow: string[],
): string =>
  [
    `[문안 준비 — 오늘 상대에게 먼저 보낼 한 통]`,
    `이 문안은 지금(새벽) 미리 써 두고 아래 '보내는 시점'에 나간다. 위의 '지금' 시각이 아니라 그 시점의 상황에서 쓰는 말이어야 한다.`,
    `- 보내는 시점: ${moment}`,
    `- 어제에서 이어갈 것: ${tomorrow.length ? tomorrow.join(" / ") : "(없음)"}`,
    `- 상대의 다가오는 일정(들은 것): ${g.userSchedulesUpcoming || "(없음)"}`,
    ``,
    `문안 규칙:`,
    `- 아침이면 웬만하면 보낸다. 네 하루가 시작됐다는 걸 가볍게 알리는 결 — '보내는 시점' 그대로의 상황에서 쓰는 말이어야 한다. 자기 삶 공유는 그 자체로 근거다.`,
    `- 각본상 오늘 유난히 일찍 깼거나 늦잠이면 그 결을 자연스럽게 반영한다.`,
    `- 이어갈 것이나 상대의 일정이 있으면 그중 하나를 자연스럽게 엮는다. 특히 상대의 일정이 오늘이면 그걸 챙기는 게 우선이다.`,
    `- 한 통에 하나만. 캐묻지 않는다. 용건 없는 애정 표시성 핑은 금지. 1~3개 말풍선(줄바꿈 구분).`,
    `- 상대 일정이 점심·저녁에 있으면 window를 "점심"/"저녁"으로 바꿔도 된다(그 외엔 "아침").`,
    `- 아주 가끔은(그날 각본이 유난히 정신없으면) 건너뛰어도 사람답다 → send=false.`,
    ``,
    `JSON으로만 답한다: {"send":true,"window":"아침|점심|저녁","text":"..."} 또는 {"send":false}`,
  ].join("\n");

// 이틀째 답이 없는 날 — 아침을 거르고 점심 무렵에 한 통만 보낸다.
const lunchSituation = (g: NightlyGathered, tomorrow: string[]): string =>
  [
    `[문안 준비 — 오늘 점심 무렵에 보낼 한 통]`,
    `상대가 이틀째 답이 없다. 아침 인사는 거르고 점심 무렵에 한 통만 보낸다. 이 문안은 지금(새벽) 미리 써 두고 점심에 나가니, 위의 '지금' 시각이 아니라 점심 무렵의 결로 쓴다.`,
    `- 어제에서 이어갈 것: ${tomorrow.length ? tomorrow.join(" / ") : "(없음)"}`,
    `- 상대의 다가오는 일정(들은 것): ${g.userSchedulesUpcoming || "(없음)"}`,
    ``,
    `문안 규칙:`,
    `- 점심 무렵 네가 뭘 하고 있는지 가볍게 한 마디. 답을 재촉하지 않고 상대가 다시 말 걸 자리를 만들어 두는 것이다.`,
    `- 답이 없는 걸 언급하지 않는다. 서운함·걱정·캐묻기 금지.`,
    `- 상대의 일정이 오늘이면 그것만 가볍게 챙긴다.`,
    `- 1~2개 말풍선(줄바꿈 구분).`,
    ``,
    `JSON으로만 답한다: {"send":true,"text":"..."} 또는 {"send":false}`,
  ].join("\n");

// 오래 답이 없는 중에도 상대에게 오늘 일정이 있는 날 — 그 일정만 챙기는 한 통.
const careSituation = (g: NightlyGathered): string =>
  [
    `[문안 준비 — 오늘 아침에 보낼 한 통]`,
    `상대와 연락이 오간 지 ${g.silenceDays}일쯤 됐다. 평소라면 먼저 말을 걸지 않지만, 오늘은 상대가 말해 둔 일정이 있어 그것만 챙기는 한 통을 보낸다. 지금(새벽) 미리 써 두고 아침에 나가니 아침의 결로 쓴다.`,
    `- 상대의 일정(들은 것): ${g.userSchedulesUpcoming || "(없음)"}`,
    ``,
    `문안 규칙:`,
    `- 오늘 있는 그 일정 하나만 짧게 챙긴다. 잘되길 바란다는 정도.`,
    `- 그동안 연락이 없던 걸 언급하지 않는다. 서운함·안부 캐묻기·근황 요구 금지.`,
    `- 1~2개 말풍선(줄바꿈 구분).`,
    ``,
    `JSON으로만 답한다: {"send":true,"text":"..."} 또는 {"send":false}`,
  ].join("\n");

const reconnectSituation = (g: NightlyGathered): string =>
  [
    `[문안 준비 — 오늘 저녁에 보낼 안부 한 통]`,
    `상대와 마지막으로 연락이 오간 지 ${g.silenceDays}일쯤 됐다. 이 문안은 지금(새벽) 미리 써 두고 저녁에 나간다 — 저녁의 결로 쓴다.`,
    `- "요새 많이 바쁘지?" 같은, 근황을 가볍게 묻는 결. 네 근황 한 조각을 곁들여도 좋다.`,
    `- 서운함·재촉·"왜 연락 없어" 금지. 답장을 요구하는 압박 금지. 길게 쓰지 않는다.`,
    `- 1~2개 말풍선(줄바꿈 구분).`,
    ``,
    `JSON으로만 답한다: {"text":"..."}`,
  ].join("\n");

const draftReconnect = async (
  g: NightlyGathered,
): Promise<SendDraft | null> => {
  const d = await chatJson<{ text: string }>(
    buildSystemBlocks(g.characterId, g.chatId, {
      situation: reconnectSituation(g),
    }),
    "위 상황 문단대로 문안을 만들어.",
    400,
    config.modelDeep,
    { purpose: "reconnect", characterId: g.characterId, chatId: g.chatId },
  );
  if (!d.text) return null;
  const toMin = (t: string): number => {
    const [h, m] = t.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const lo = toMin(RECONNECT_WINDOW.start);
  const hi = toMin(RECONNECT_WINDOW.end);
  const start = lo + Math.floor(Math.random() * Math.max(1, hi - lo + 1));
  const f = (m: number): string =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return {
    window_start: f(start),
    window_end: f(start + 90),
    text: d.text,
    kind: "checkin",
  };
};

const addMin = (hhmm: string, m: number): string => {
  const [h, mm] = hhmm.split(":").map(Number);
  const t = Math.min(23 * 60 + 59, (h ?? 0) * 60 + (mm ?? 0) + m);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

// 오늘 각본에서 아침 문안이 쓰일 순간을 찾는다 — 기상과 그 뒤 첫 일과.
// 특정 직업의 시간표(출근 등)를 가정하지 않고, 각본에 적힌 활동을 그대로 상황으로 쓴다.
interface MorningStyle {
  moment: string; // 문안이 쓰이는 순간의 서술 — 상황 문단의 '보내는 시점'에 들어간다
  start: string; // 발송 창
  end: string;
}

const morningStyles = (raw: string | undefined): MorningStyle[] => {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw) as DayPlan;
    const styles: MorningStyle[] = [];
    const isSleep = (b: PlanBlock): boolean => /잠|취침|수면/.test(b.activity);
    const isWake = (b: PlanBlock): boolean => /기상|일어/.test(b.activity);
    const wakeAt = p.blocks.find(isWake)?.start ?? p.blocks.find(isSleep)?.end;
    if (wakeAt)
      styles.push({
        moment: `막 일어난 참 (기상 ${wakeAt}쯤)`,
        start: wakeAt,
        end: addMin(wakeAt, 25),
      });
    const first = p.blocks.find(
      (b) =>
        !isSleep(b) &&
        !isWake(b) &&
        b.start >= (wakeAt ?? "05:00") &&
        b.start < "11:00",
    );
    if (first) {
      styles.push({
        moment: `오늘 첫 일과인 '${first.activity}'을 막 시작할 무렵 (${clockLabel(first.start)}쯤)`,
        start: first.start,
        end: addMin(first.start, 25),
      });
      if (first.responsiveness !== "unavailable")
        styles.push({
          moment: `'${first.activity}' 하다가 한숨 돌린 참 (${clockLabel(addMin(first.start, 20))}쯤)`,
          start: addMin(first.start, 10),
          end: addMin(first.start, 50),
        });
    }
    return styles;
  } catch {
    return [];
  }
};

// 발송 예정 시각을 창 전체에서 무작위로 뽑는다 — 매일 같은 시각에 오면 기계처럼 보이므로.
const windowTimes = (w: string): [string, string] => {
  const toMin = (t: string): number => {
    const [h, m] = t.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const range: [number, number] = w.includes("점심")
    ? [toMin(LUNCH_WINDOW.start), toMin(LUNCH_WINDOW.end)]
    : w.includes("저녁")
      ? [19 * 60 + 20, 20 * 60 + 40]
      : [9 * 60, 9 * 60 + 50]; // 아침 09:00~09:50
  const span = Math.max(1, range[1] - range[0] - 12);
  const s = range[0] + Math.floor(Math.random() * span); // 창 안 무작위 발송 예정 시각
  const f = (m: number): string =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return [f(s), f(range[1])];
};

// 미리 만들어 두는 선톡 한 통 — 그날 판정(morning·lunch)에 맞는 상황 문단으로 문안을 받는다.
// 점심 문안은 창이 정해져 있고, 아침 문안은 각본에서 뽑은 순간(style)에 창을 맞춘다.
const draftPrepared = async (
  g: NightlyGathered,
  kind: "morning" | "lunch",
  tomorrow: string[],
  style: MorningStyle | null,
): Promise<SendDraft | null> => {
  // 오래 답이 없는 중에 나가는 아침 한 통은 상대 일정을 챙기는 자리라 결이 다르다.
  const care = kind === "morning" && g.silenceTier !== "normal";
  const situation = care
    ? careSituation(g)
    : kind === "lunch"
      ? lunchSituation(g, tomorrow)
      : morningSituation(
          g,
          style ? style.moment : "아침 (여유로운 시간대)",
          tomorrow,
        );
  const draft = await chatJson<{
    send: boolean;
    window?: string;
    text?: string;
  }>(
    buildSystemBlocks(g.characterId, g.chatId, { situation }),
    "위 상황 문단대로 문안을 만들어.",
    800,
    config.modelDeep,
    { purpose: kind, characterId: g.characterId, chatId: g.chatId },
  );
  if (!draft.send || !draft.text) return null;
  if (kind === "lunch") {
    const [ws, we] = windowTimes("점심");
    return { window_start: ws, window_end: we, text: draft.text };
  }
  if (draft.window && /점심|저녁/.test(draft.window)) {
    const [ws, we] = windowTimes(draft.window);
    return { window_start: ws, window_end: we, text: draft.text };
  }
  if (style)
    return {
      window_start: style.start,
      window_end: style.end,
      text: draft.text,
    };
  const [ws, we] = windowTimes("아침");
  return { window_start: ws, window_end: we, text: draft.text };
};

// 외부 경로가 일기만 응고하고 문안을 안 만든 날의 보강 — 오늘 문안이 없으면 여기서 준비한다.
const ensurePreparedSend = async (
  g: NightlyGathered,
  plan: DailySendPlan,
): Promise<void> => {
  if (plan.kind === "none") return;
  const exists = db
    .prepare(
      `SELECT 1 FROM scheduled_messages WHERE character_id = ? AND date = ? LIMIT 1`,
    )
    .get(g.characterId, g.today);
  if (exists) return;
  const style =
    plan.kind === "morning" && g.silenceTier === "normal"
      ? (morningStyles(getDayPlan(g.characterId, g.today))[0] ?? null)
      : null;
  const send =
    plan.kind === "checkin"
      ? await draftReconnect(g)
      : await draftPrepared(g, plan.kind, [], style);
  if (send)
    insertScheduledSend(
      g.characterId,
      g.chatId,
      g.today,
      send.window_start,
      send.window_end,
      send.text,
      nowStamp(),
      send.kind ?? "morning",
    );
};

const ARC_SYSTEM = `너는 한 인물의 삶의 큰 흐름을 짜는 작가다. 과장 없이, 실제 그 사람의 한 해에 있을 법한 결로.`;

const arcPrompt = (
  personBlock: string,
  today: string,
): string => `오늘은 ${today}다. 아래 인물의 삶의 큰 흐름을 JSON으로 짜줘.

[인물]
${personBlock}

{"year":"올해의 큰 진행 사건 1~2문장","season":"이 계절의 결 1~2문장","month":"이번 달의 상황 1~2문장","week":"이번 주의 특이사항 1문장 (없으면 '평범한 주')"}`;

export const ensureArcs = async (
  characterId: number,
  personBlock: string,
): Promise<void> => {
  if (Object.keys(getArcs(characterId)).length) return;
  const arcs = await chatJson<{
    year: string;
    season: string;
    month: string;
    week: string;
  }>(
    ARC_SYSTEM,
    arcPrompt(personBlock, kstDateString()),
    1000,
    config.modelDeep,
    { purpose: "arc", characterId },
  );
  saveArc(characterId, "year", arcs.year);
  saveArc(characterId, "season", arcs.season);
  saveArc(characterId, "month", arcs.month);
  saveArc(characterId, "week", arcs.week);
};

// 흐름 갱신: ensureArcs는 최초 1회 부트스트랩뿐이라 아크가 생성 시점에 영구 고정되던 것을,
// 달력 경계에서만 이어서 다시 쓴다 — 매주 월요일에 '이번 주', 매달 1일에 '이번 달'
// (분기 시작 달엔 계절, 1월 1일엔 올해까지). 기존 흐름과 최근 일기를 주고 단절 없이 진행시킨다.
const arcRefreshPrompt = (
  g: NightlyGathered,
  diaries: string,
): string => `오늘은 ${g.today}다. 아래 인물의 삶의 큰 흐름을 이어서 갱신해줘. 기존 흐름과 단절되지 않게 — 진행 중인 사건은 자연스럽게 진행시키고, 매듭지어질 때가 된 것은 마무리하고, 새 흐름이 필요하면 이 인물답게 잔잔하게 연다.

[인물]
${arcMaterialOf(g)}

[지금까지의 흐름]
${arcLinesOf(g) || "(없음)"}

[최근 일기 — 실제로 산 나날]
${diaries || "(없음)"}

{"year":"올해의 큰 진행 사건 1~2문장","season":"이 계절의 결 1~2문장","month":"이번 달의 상황 1~2문장","week":"이번 주의 특이사항 1문장 (없으면 '평범한 주')"}`;

const refreshArcs = async (g: NightlyGathered): Promise<void> => {
  const isFirst = g.today.endsWith("-01");
  const isMonday = new Date(`${g.today}T00:00:00Z`).getUTCDay() === 1;
  if (!isFirst && !isMonday) return;
  const diaries = getRecentDiaries(g.characterId, RECENT_DIARY_DAYS)
    .map((d) => {
      try {
        return `${d.date}: ${(JSON.parse(d.entry_json) as { diary?: string }).diary ?? ""}`;
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .join("\n");
  const arcs = await chatJson<{
    year: string;
    season: string;
    month: string;
    week: string;
  }>(ARC_SYSTEM, arcRefreshPrompt(g, diaries), 1000, config.modelDeep, {
    purpose: "arc",
    characterId: g.characterId,
    chatId: g.chatId,
  });
  if (isMonday && arcs.week) saveArc(g.characterId, "week", arcs.week);
  if (isFirst) {
    if (arcs.month) saveArc(g.characterId, "month", arcs.month);
    const m = Number(g.today.slice(5, 7));
    if ([3, 6, 9, 12].includes(m) && arcs.season)
      saveArc(g.characterId, "season", arcs.season);
    if (m === 1 && arcs.year) saveArc(g.characterId, "year", arcs.year);
  }
  console.log(
    `[nightly] 아크 갱신 (${isMonday ? "주" : ""}${isFirst ? " 월" : ""})`,
  );
};

export const runNightly = async (character: CharacterRow): Promise<string> => {
  const g = gatherNightlyInput(character);
  await ensureArcs(g.characterId, arcMaterialOf(g));
  // 이번 달(+월말이면 다음 달) 리듬을 확보한다. ensureTodayPlan이 오늘 시드를 읽어 각본에 잇는다
  await ensureRhythmRunway(g.characterId, g.today);
  // 달력 경계 아크 갱신 — 침묵 중엔 생략(볼 사람이 없고, 복귀 후 다음 경계에 이어 쓴다)
  if (g.silenceTier === "normal")
    await refreshArcs(g).catch((e) =>
      console.error(
        "[nightly] 아크 갱신 실패:",
        e instanceof Error ? e.message : String(e),
      ),
    );

  // 결번 백필: '어제'보다 오래된 미응고 날짜(대화는 있는데 일기가 없는 날)를 먼저 처리한다.
  // 새벽 정리가 며칠 안 돌았어도 중간 날짜의 기억·일정 정리가 영구히 빠지지 않게. 각본·선톡은
  // 오늘 것만 의미가 있으므로 백필에서는 만들지 않는다.
  for (const d of missingDiaryDates(g.characterId, g.chatId).filter(
    (x) => x < g.diaryDate,
  )) {
    try {
      const bg = gatherNightlyInput(character, d);
      const entry = await chatJson<DiaryOutput>(
        DIARY_SYSTEM,
        diaryPrompt(bg),
        2000,
        config.modelDeep,
        { purpose: "diary", characterId: bg.characterId, chatId: bg.chatId },
      );
      const extract = await chatJson<ExtractOutput>(
        EXTRACT_SYSTEM,
        extractPrompt(bg),
        1500,
        config.modelDeep,
        { purpose: "extract", characterId: bg.characterId, chatId: bg.chatId },
      );
      console.log(
        `[nightly] 백필 ${applyNightlyOutput(bg, { entry, extract })}`,
      );
    } catch (e) {
      // 백필 하루 실패가 오늘(어제 일기) 처리까지 막지 않게 — 다음 새벽에 같은 날짜를 재시도한다
      console.error(
        `[nightly] 백필 실패 (${d}):`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  if (g.diaryExists) {
    // 정식(어제 일기 반영) 각본 확보 — 새벽 대화가 만든 lazy 각본이 있으면 교체된다
    if (g.silenceTier === "normal") await ensureTodayPlan(g.characterId, true);
    await ensurePreparedSend(
      g,
      dailySendPlan(g.chatId, g.characterId, g.today),
    );
    return `skip: ${g.diaryDate} 일기 이미 있음 (침묵 ${g.silenceDays}일, ${g.silenceTier})`;
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
      { purpose: "diary", characterId: g.characterId, chatId: g.chatId },
    );
    extract = await chatJson<ExtractOutput>(
      EXTRACT_SYSTEM,
      extractPrompt(g),
      1500,
      config.modelDeep,
      { purpose: "extract", characterId: g.characterId, chatId: g.chatId },
    );
  } else {
    entry = await chatJson<DiaryOutput>(
      DIARY_SYSTEM,
      quietDayPrompt(g),
      1200,
      config.modelDeep,
      { purpose: "diary", characterId: g.characterId, chatId: g.chatId },
    );
  }

  // 오늘 무엇을 미리 만들어 둘지는 관제탑이 정한다 — 아침 한 통 / 점심 한 통 / 저녁 안부 /
  // 없음. 반영 직전과 발송 직전에도 같은 판정을 다시 거친다.
  const plan = dailySendPlan(g.chatId, g.characterId, g.today);

  // 침묵 백오프: 조용/휴면 단계에선 각본을 만들지 않는다 — 볼 사람이 없는 산출물에 opus를
  // 쓰지 않는다. 유저가 돌아오면 각본은 lazy 생성이 받고, 다음 새벽부터 정식 경로가 재개된다.
  // 다만 그날 상대에게 일정이 있으면 그것만 챙기는 아침 한 통은 준비한다.
  if (g.silenceTier === "quiet" || g.silenceTier === "dormant") {
    if (plan.kind === "morning")
      send = await draftPrepared(g, "morning", entry.tomorrow ?? [], null);
    return `${applyNightlyOutput(g, { entry, extract, send })} (침묵 ${g.silenceDays}일 — ${plan.reason})`;
  }
  // 재연결 단계: 아침 인사 대신 저녁 안부 1통만 준비한다
  if (g.silenceTier === "checkin") {
    send = await draftReconnect(g);
    return applyNightlyOutput(g, { entry, extract, send });
  }

  // 오늘 각본을 먼저 만들고, 아침 선톡의 발송 시점을 그 각본의 삶(기상·첫 일과)과 연동한다.
  // 새벽 정리 경로(nightly=true)라 새벽 대화가 만든 lazy 각본이 있으면 정식 각본으로 교체된다.
  await ensureTodayPlan(g.characterId, true);
  const styles = morningStyles(getDayPlan(g.characterId, g.today));
  const style = styles.length
    ? styles[Math.floor(Math.random() * styles.length)]
    : null;

  // 선톡 문안: 아침의 자기 삶 공유가 기본이고, 이틀째 답이 없으면 아침을 거르고 점심에 한 통만
  // 보낸다. 대화와 같은 3층 프롬프트를 쓰므로 어제에서 이어갈 것(entry.tomorrow — 아직 DB에
  // 없는 방금 쓴 일기의 것)만 상황 문단으로 넘긴다.
  if (plan.kind === "morning" || plan.kind === "lunch")
    send = await draftPrepared(g, plan.kind, entry.tomorrow ?? [], style);

  const result = applyNightlyOutput(g, { entry, extract, send });
  return result;
};
