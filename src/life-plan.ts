// 월 리듬 — 한 달치 이벤트와 매일 컨디션 시드를 미리 만든다.
//
// 컨디션을 날마다 독립된 주사위로 뽑으면 어제와 오늘이 이어지지 않는다. 한 달을 한 번에
// 만들어 이벤트와 컨디션을 인과로 연결하고(회식 다음 날은 피곤한 식으로) 급변 없는 파도를
// 만든다. ensureRhythmRunway가 항상 1개월쯤 앞을 채워 둔다.
//
// 새벽 정리 배치가 opus로 만든다.
//
// 유저와는 메시지로만 이어진 사이라 유저와 만나는 이벤트는 만들지 않는다. 대화에서 잡힌 약속은
// 일정 표로 들어오지만 여기서 지어내지는 않는다(이슈 #322).
//
// 문화 스크립트를 펼치는 자리도 여기 하나다(이슈 #405). 결혼·장례·명절처럼 절차가 정해진 일은
// 이 달 재료에 그 이름이 걸렸을 때만 해당 이벤트의 단계를 프롬프트에 넣는다. 하루 각본이 같은
// 표를 읽으면 매일 같은 절차를 다시 보게 되어 단계 순서가 튄다.
//
// 운영의 월 리듬은 봇 밖 생성 경로가 만든다. 그쪽도 같은 절차를 봐야 해서 새벽 정리 수집이
// rhythmMaterial을 불러 그 결과를 넘긴다(이슈 #411) — 절차를 외부 문서에 옮겨 적으면 사본이
// 하나 더 생겨 원본과 어긋나기 시작한다.

import { chatJson } from "./llm.js";
import { config } from "./config.js";
import {
  addSchedule,
  findCultureEvents,
  getArcs,
  getCultureEvent,
  getRecentDiaries,
  getSchedulesInMonth,
  listMemoryItems,
  monthHasSeeds,
  saveDaySeed,
} from "./db.js";
import { identityLines } from "./memory.js";
import { RHYTHM_RUNWAY_DAYS } from "./thresholds.js";
import { dayLabel, kstStamp } from "./kst.js";

// 월 리듬(중간 지평): 한 달치 이벤트 + 매일의 컨디션/기상 시드를 미리 깔아둔다.
// 연(아크)은 러프, 월은 디테일, 일(각본)은 구체 — 세 지평이 이 층에서 만난다.
// 핵심은 인과: 회식·야근 같은 이벤트의 여파가 다음날 시드(피곤·기상 흐트러짐)로 이어지고,
// 기력은 급변 없이 며칠에 걸친 파도처럼 오르내린다. 그날 실제 여파(대화로 늦게 잠 등)는
// 하루 각본이 어제 일기를 읽어 이 시드를 덮어쓴다. 생성은 밤 정리 배치(구독 Opus)가 한 달에 한 번.

export interface MonthPlan {
  events: {
    date: string;
    time_hint: string | null;
    content: string;
    // 문화 스크립트를 펼쳐 나온 단계면 그 원본인 진행 중인 일의 번호. 아니면 없거나 null이다.
    from_ongoing?: number | null;
  }[];
  days: {
    date: string;
    energy: string;
    wake_hint: string;
    mood: string;
    note: string;
  }[];
}

// "YYYY-MM"의 모든 날짜 + 요일 라벨. 정오 UTC로 만들어 롤오버·타임존 영향 없음
export const monthDays = (ym: string): { date: string; label: string }[] => {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days: { date: string; label: string }[] = [];
  for (let d = 1; d <= last; d++) {
    const ds = `${ym}-${String(d).padStart(2, "0")}`;
    days.push({ date: ds, label: dayLabel(new Date(`${ds}T12:00:00Z`)) });
  }
  return days;
};

const nextMonthYm = (ym: string): string => {
  const [y, m] = ym.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

const daysLeftInMonth = (today: string): number => {
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate() - d;
};

const dayMark = (daysBefore: number): string =>
  daysBefore === 0
    ? "당일"
    : daysBefore > 0
      ? `D-${daysBefore}`
      : `D+${-daysBefore}`;

/**
 * 이 달 재료에 이름이 걸린 이벤트의 절차만 문안으로 만든다. 하나도 안 걸리면 빈 문자열이라
 * 그 달 프롬프트에는 이 블록이 아예 없다.
 *
 * 표를 통째로 실으면 이 달과 상관없는 절차가 한 달 내내 프롬프트에 앉아 있게 되고, 모델은
 * 자리를 채우려고 없는 이벤트를 만든다. 걸린 이벤트는 역할을 전부 싣는다 — 형제의 결혼인지
 * 친구의 결혼인지는 재료 문장을 봐야 갈리는 일이라 고르는 건 모델 몫이다.
 */
export const culturePrompt = (material: string): string =>
  findCultureEvents(material)
    .map((event) => {
      const byRole = new Map<string, string[]>();
      for (const r of getCultureEvent(event)) {
        const lines = byRole.get(r.role) ?? [];
        lines.push(`${dayMark(r.days_before)} ${r.step}`);
        byRole.set(r.role, lines);
      }
      return [...byRole]
        .map(([role, lines]) => `### ${event} — ${role}\n${lines.join("\n")}`)
        .join("\n\n");
    })
    .join("\n\n");

// 진행 중인 일 — 문화 스크립트가 펼쳐 나온 일정이 어느 줄에서 나왔는지 되짚을 수 있게 번호를
// 같이 적는다. 상대 쪽 진행 중인 일은 상대의 일이라 캐릭터의 이벤트로 펼치지 않는다.
const ongoingLines = (characterId: number): string =>
  listMemoryItems(characterId, "ongoing")
    .filter((r) => r.owner === "char")
    .map((r) => `- [${r.id}] ${r.area} · ${r.subject}: ${r.value}`)
    .join("\n");

const arcLines = (characterId: number): string =>
  Object.entries(getArcs(characterId))
    .map(([h, c]) => `${h}: ${c}`)
    .join(" / ");

const scheduleLines = (
  rows: { date: string; time_hint: string | null; content: string }[],
): string =>
  rows
    .map((s) => `${s.date}${s.time_hint ? ` ${s.time_hint}` : ""} ${s.content}`)
    .join(" / ");

/**
 * 월 리듬 프롬프트의 재료 가운데 절차를 찾는 데 쓰는 것들. 봇 안 경로와 봇 밖 생성 경로가
 * 이 함수 하나를 불러 같은 문장을 받는다(이슈 #411). 절차 문장을 외부 문서에 옮겨 적어 두면
 * culture_scripts 원본과 어긋나기 시작해서, 표를 읽는 자리를 여기 하나로 둔다.
 *
 * 절차를 찾을 재료는 앞일이 적힌 곳만 본다 — 아크·진행 중인 일·이 달에 이미 잡힌 일정.
 * 일기는 지나간 일이라 지난달에 다녀온 결혼식이 이 달 절차를 불러온다.
 */
export const rhythmMaterial = (
  characterId: number,
  ym: string,
): { arcs: string; ongoing: string; existingChar: string; culture: string } => {
  const arcs = arcLines(characterId);
  const ongoing = ongoingLines(characterId);
  const existingChar = scheduleLines(
    getSchedulesInMonth(characterId, ym, "char"),
  );
  return {
    arcs,
    ongoing,
    existingChar,
    culture: culturePrompt([arcs, ongoing, existingChar].join("\n")),
  };
};

const MONTH_SYSTEM = `너는 한 인물의 한 달을 미리 설계하는 작가다. 실제 그 사람의 삶처럼, 이벤트와 그 여파가 인과로 이어지는 흐름을 짠다. 기력은 급변하지 않고 며칠에 걸친 파도처럼 오르내린다.`;

const monthPrompt = (
  persona: string,
  ym: string,
  days: { date: string; label: string }[],
  arcs: string,
  diaries: string,
  existingChar: string,
  existingUser: string,
  ongoing: string,
  culture: string,
): string => `아래 인물의 ${ym} 한 달을 미리 설계해줘. 두 가지를 만든다: (1) 이 달의 이벤트 몇 개, (2) 매일의 컨디션 시드.

[인물 — 같은 항목이 두 줄이면 아래쪽이 최신]
${persona || "(없음)"}

[삶의 큰 흐름 — 이 달이 이 결 위에 놓이게]
${arcs || "(없음)"}

[최근 일기 — 지금까지 삶이 어떻게 흘러왔는지, 자연스럽게 이어지게]
${diaries || "(없음)"}

[이 달의 날짜와 요일]
${days.map((d) => `${d.date} ${d.label}`).join("\n")}

[이미 잡힌 일정 — 겹치지 말고 참고만]
본인(char): ${existingChar || "(없음)"}
상대(user): ${existingUser || "(없음)"}

[진행 중인 일 — 대괄호 안 번호는 아래 events의 from_ongoing에 그대로 적는다]
${ongoing || "(없음)"}
${
  culture
    ? `
[이 달에 걸린 일의 절차 — 걸린 것만 실었다]
한국에서 이 일이 실제로 지나가는 순서다. D-숫자는 그 일이 있는 날에서 거꾸로 센 날, 당일은 그날, D+숫자는 그 뒤다. 한 이벤트에 역할이 여럿이면 이 인물이 선 자리를 위 재료에서 골라 그 역할의 단계만 쓴다.

${culture}
`
    : ""
}
[이벤트 만들기 — events]
- 이 달에 3~7개. 실제 그 직업·성격의 사람이 겪을 법한 것으로: 저녁 모임, 주말 약속, 가족 연락이나 방문, 일이 몰리는 주의 중요한 일정, 문화생활, 친구 만남, 병원, 경조사 등. 위 [인물]의 생활·취향과 위 아크에서 뽑아 쓰고, 인물과 무관한 이벤트는 만들지 않는다.
- 날짜는 요일에 맞게(회식·야근은 평일, 나들이·모임은 주로 주말). 위 [인물]의 직업 상식에 어긋나는 날에 일 일정을 넣지 않는다. time_hint는 "저녁"/"오전"/"점심" 등, 종일 일이면 null.
- 상대(user)와는 메시지로만 이어진 사이라 실제로 만날 수 없다. 상대와 만나는 이벤트(같이 가기·데이트·방문·상대가 오는 자리)는 만들지 않는다. 상대가 이 달에 들어오는 자리는 메시지를 주고받는 시간뿐이다.
- 위 [절차]에 실린 일이 이 인물에게 실제로 걸려 있으면(그 일이 있는 날이 재료에 적혀 있거나 이 달 안에 잡혀 있으면) 그 역할의 단계 가운데 날짜가 이 달 안에 떨어지는 것을 이벤트로 만든다. 날짜는 그 일이 있는 날에서 D-숫자만큼 앞으로, D+숫자만큼 뒤로 센 날이다. 이 달 밖으로 떨어지는 단계와, 재료에 걸려 있지 않은 일의 단계는 만들지 않는다. 이렇게 만든 단계는 위 3~7개에 넣지 않는다.
- 그 단계가 위 [진행 중인 일]의 한 줄에서 나왔으면 from_ongoing에 그 번호를 적는다. 아니면 null.

[컨디션 시드 만들기 — days: 이 달 '모든 날짜'에 하나씩]
- energy: 낮음 | 보통 | 높음 / wake_hint: 이른 | 보통 | 늦잠 / mood: 짧은 구 / note: 왜 이런지 한 줄(특별한 이유 없으면 "")
- **핵심 = 이벤트와 인과로 이어지기.** 회식·술자리 다음날은 energy 낮음 + wake_hint가 흐트러짐(못 자서 '이른' 또는 뻗어서 '늦잠') + note "어제 회식 여파"처럼. 야근 몰리는 주는 뒤로 갈수록 지침. 푹 쉰 주말 다음 월요일은 상대적으로 개운(energy 보통~높음). 주말은 대체로 여유·늦잠.
- **급변 금지.** 어제 '높음'이 오늘 갑자기 '낮음'이 되지 않게, 완만하게 오르내리게. 사람의 기력은 흐름을 탄다.
- 평범한 날(보통/보통)이 대부분이어도 좋다. 굴곡은 이벤트와 주기(주말·업무 몰림)에서 자연히 나오게 한다.

JSON: {"events":[{"date":"YYYY-MM-DD","time_hint":"저녁|오전|점심|null","content":"...","from_ongoing":null}],"days":[{"date":"YYYY-MM-DD","energy":"보통","wake_hint":"보통","mood":"...","note":""}]}
days에는 위 '이 달의 날짜'를 하나도 빠짐없이 전부 포함한다.`;

// 한 달치 리듬을 생성해 DB에 반영한다(이미 있으면 스킵). API 폴백·수동 도구가 직접 호출.
export const ensureMonthPlan = async (
  characterId: number,
  ym: string,
): Promise<boolean> => {
  if (monthHasSeeds(characterId, ym)) return false;
  const diaries = getRecentDiaries(characterId, 3)
    .map((d) => {
      try {
        return `${d.date}: ${(JSON.parse(d.entry_json) as { diary?: string }).diary ?? ""}`;
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .join("\n");
  const { arcs, ongoing, existingChar, culture } = rhythmMaterial(
    characterId,
    ym,
  );
  const plan = await chatJson<MonthPlan>(
    MONTH_SYSTEM,
    monthPrompt(
      identityLines(characterId),
      ym,
      monthDays(ym),
      arcs,
      diaries,
      existingChar,
      scheduleLines(getSchedulesInMonth(characterId, ym, "user")),
      ongoing,
      culture,
    ),
    6000,
    config.modelDeep,
    { purpose: "life_plan", characterId },
  );
  applyMonthPlan(characterId, ym, plan);
  return true;
};

// 생성 결과 반영(외부 scheduled task 경로와 공유). 해당 월 시드가 이미 있으면 중복 방지.
export const applyMonthPlan = (
  characterId: number,
  ym: string,
  plan: MonthPlan,
): void => {
  if (monthHasSeeds(characterId, ym)) return;
  const ts = kstStamp();
  // 모델이 적어 온 번호가 이 캐릭터의 진행 중인 일인지 확인하고 넣는다. 없는 행을 가리키는
  // 번호를 그대로 적으면 나중에 원본을 되짚을 때 빈손이 되고, 그게 링크가 없는 것보다 나쁘다.
  const ongoingIds = new Set(
    listMemoryItems(characterId, "ongoing").map((r) => r.id),
  );
  for (const e of plan.events ?? [])
    if (e.date && e.content)
      addSchedule(
        characterId,
        "char",
        e.date,
        e.time_hint ?? null,
        e.content,
        ts,
        "rhythm",
        "unknown",
        e.from_ongoing && ongoingIds.has(e.from_ongoing)
          ? { kind: "memory", id: e.from_ongoing }
          : null,
      );
  for (const s of plan.days ?? [])
    if (s.date)
      saveDaySeed(characterId, {
        date: s.date,
        energy: s.energy || "보통",
        wake_hint: s.wake_hint || "보통",
        mood: s.mood || "",
        reason: s.note || null,
      });
};

// 항상 ~1개월 런웨이를 앞서 둔다: 이번 달 + (월말 임박 시) 다음 달. 이미 있으면 no-op(비용 0).
export const ensureRhythmRunway = async (
  characterId: number,
  today: string,
): Promise<void> => {
  const ym = today.slice(0, 7);
  await ensureMonthPlan(characterId, ym);
  if (daysLeftInMonth(today) <= RHYTHM_RUNWAY_DAYS)
    await ensureMonthPlan(characterId, nextMonthYm(ym));
};

// 시드가 없어 지금 생성이 필요한 달 목록(밤 정리가 이 신호를 받아 리듬을 생성).
export const monthsNeedingRhythm = (
  characterId: number,
  today: string,
): string[] => {
  const ym = today.slice(0, 7);
  const out: string[] = [];
  if (!monthHasSeeds(characterId, ym)) out.push(ym);
  if (daysLeftInMonth(today) <= RHYTHM_RUNWAY_DAYS) {
    const nm = nextMonthYm(ym);
    if (!monthHasSeeds(characterId, nm)) out.push(nm);
  }
  return out;
};
