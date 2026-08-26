import { chatJson } from "./llm.js";
import { config } from "./config.js";
import {
  addSchedule,
  getArcs,
  getRecentDiaries,
  getSchedulesInMonth,
  monthHasSeeds,
  saveDaySeed,
} from "./db.js";
import type { Bible } from "./character.js";
import { dayLabel, getKstNow, kstDateString } from "./kst.js";

// 월 리듬(중간 지평): 한 달치 이벤트 + 매일의 컨디션/기상 시드를 미리 깔아둔다.
// 연(아크)은 러프, 월은 디테일, 일(각본)은 구체 — 세 지평이 이 층에서 만난다.
// 핵심은 인과: 회식·야근 같은 이벤트의 여파가 다음날 시드(피곤·기상 흐트러짐)로 이어지고,
// 기력은 급변 없이 며칠에 걸친 파도처럼 오르내린다. 그날 실제 여파(대화로 늦게 잠 등)는
// 하루 각본이 어제 일기를 읽어 이 시드를 덮어쓴다. 생성은 밤 정리 배치(구독 Opus)가 한 달에 한 번.

export interface MonthPlan {
  events: { date: string; time_hint: string | null; content: string }[];
  days: {
    date: string;
    energy: string;
    wake_hint: string;
    mood: string;
    note: string;
  }[];
}

const nowStamp = (): string =>
  `${kstDateString()} ${getKstNow().toISOString().slice(11, 19)}`;

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

const MONTH_SYSTEM = `너는 한 인물의 한 달을 미리 설계하는 작가다. 실제 그 사람의 삶처럼, 이벤트와 그 여파가 인과로 이어지는 흐름을 짠다. 기력은 급변하지 않고 며칠에 걸친 파도처럼 오르내린다.`;

const monthPrompt = (
  bible: Bible,
  ym: string,
  days: { date: string; label: string }[],
  arcs: string,
  diaries: string,
  existingChar: string,
  existingUser: string,
): string => `아래 인물의 ${ym} 한 달을 미리 설계해줘. 두 가지를 만든다: (1) 이 달의 이벤트 몇 개, (2) 매일의 컨디션 시드.

[인물]
${JSON.stringify({ identity: bible.identity, life: bible.life, tastes: bible.tastes }, null, 2)}

[삶의 큰 흐름 — 이 달이 이 결 위에 놓이게]
${arcs || "(없음)"}

[최근 일기 — 지금까지 삶이 어떻게 흘러왔는지, 자연스럽게 이어지게]
${diaries || "(없음)"}

[이 달의 날짜와 요일]
${days.map((d) => `${d.date} ${d.label}`).join("\n")}

[이미 잡힌 일정 — 겹치지 말고 참고만]
본인(char): ${existingChar || "(없음)"}
상대(user): ${existingUser || "(없음)"}

[이벤트 만들기 — events]
- 이 달에 3~7개. 실제 그 직업·성격의 사람이 겪을 법한 것으로: 평일 저녁 회식, 주말 약속·모임, 부모님 통화나 대구 방문, 승진 관련 중요 미팅·야근 몰리는 주, 서점·전시, 친구 만남, 병원, 경조사 등. 위 아크(승진 심사·장마 등)와 이어지게.
- 날짜는 요일에 맞게(회식은 평일 저녁, 나들이·모임은 주로 주말). 은행원 상식에 어긋나지 않게(일요일 근무 금지). time_hint는 "저녁"/"오전"/"점심" 등, 종일 일이면 null.

[컨디션 시드 만들기 — days: 이 달 '모든 날짜'에 하나씩]
- energy: 낮음 | 보통 | 높음 / wake_hint: 이른 | 보통 | 늦잠 / mood: 짧은 구 / note: 왜 이런지 한 줄(특별한 이유 없으면 "")
- **핵심 = 이벤트와 인과로 이어지기.** 회식·술자리 다음날은 energy 낮음 + wake_hint가 흐트러짐(못 자서 '이른' 또는 뻗어서 '늦잠') + note "어제 회식 여파"처럼. 야근 몰리는 주는 뒤로 갈수록 지침. 푹 쉰 주말 다음 월요일은 상대적으로 개운(energy 보통~높음). 주말은 대체로 여유·늦잠.
- **급변 금지.** 어제 '높음'이 오늘 갑자기 '낮음'이 되지 않게, 완만하게 오르내리게. 사람의 기력은 흐름을 탄다.
- 평범한 날(보통/보통)이 대부분이어도 좋다. 굴곡은 이벤트와 주기(주말·업무 몰림)에서 자연히 나오게 한다.

JSON: {"events":[{"date":"YYYY-MM-DD","time_hint":"저녁|오전|점심|null","content":"..."}],"days":[{"date":"YYYY-MM-DD","energy":"보통","wake_hint":"보통","mood":"...","note":""}]}
days에는 위 '이 달의 날짜'를 하나도 빠짐없이 전부 포함한다.`;

// 한 달치 리듬을 생성해 DB에 반영한다(이미 있으면 스킵). API 폴백·수동 도구가 직접 호출.
export const ensureMonthPlan = async (
  characterId: number,
  bible: Bible,
  ym: string,
): Promise<boolean> => {
  if (monthHasSeeds(characterId, ym)) return false;
  const arcs = Object.entries(getArcs(characterId))
    .map(([h, c]) => `${h}: ${c}`)
    .join(" / ");
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
  const fmt = (
    rows: { date: string; time_hint: string | null; content: string }[],
  ) =>
    rows
      .map(
        (s) => `${s.date}${s.time_hint ? ` ${s.time_hint}` : ""} ${s.content}`,
      )
      .join(" / ");
  const plan = await chatJson<MonthPlan>(
    MONTH_SYSTEM,
    monthPrompt(
      bible,
      ym,
      monthDays(ym),
      arcs,
      diaries,
      fmt(getSchedulesInMonth(characterId, ym, "char")),
      fmt(getSchedulesInMonth(characterId, ym, "user")),
    ),
    6000,
    config.modelDeep,
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
  const ts = nowStamp();
  for (const e of plan.events ?? [])
    if (e.date && e.content)
      addSchedule(
        characterId,
        "char",
        e.date,
        e.time_hint ?? null,
        e.content,
        ts,
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
  bible: Bible,
  today: string,
): Promise<void> => {
  const ym = today.slice(0, 7);
  await ensureMonthPlan(characterId, bible, ym);
  if (daysLeftInMonth(today) <= 6)
    await ensureMonthPlan(characterId, bible, nextMonthYm(ym));
};

// 시드가 없어 지금 생성이 필요한 달 목록(밤 정리가 이 신호를 받아 리듬을 생성).
export const monthsNeedingRhythm = (
  characterId: number,
  today: string,
): string[] => {
  const ym = today.slice(0, 7);
  const out: string[] = [];
  if (!monthHasSeeds(characterId, ym)) out.push(ym);
  if (daysLeftInMonth(today) <= 6) {
    const nm = nextMonthYm(ym);
    if (!monthHasSeeds(characterId, nm)) out.push(nm);
  }
  return out;
};
