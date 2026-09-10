// 아크·월 리듬·일정·하루 각본·일기·작품 사실 카드 표의 저장 함수.
//
// 캐릭터의 삶을 이루는 표들이다. 아크와 월 리듬은 미리 만들어 두고, 일정은 대화와 새벽
// 정리가 넣고 시각과 상대가 아는지를 고치며, 각본은 하루에 하나, 일기는 새벽 정리가
// 하루에 하나 쓴다. 작품 사실 카드는 각본에 실제 작품이 들어갈 때 작품마다 한 번 쌓인다.

import { db } from "./connection.js";
import type { UserKnows, ScheduleOrigin, ScheduleStatus } from "../labels.js";

// 삶의 큰 흐름: 연/계절/월/주 단위 이벤트 아크. 하루 각본이 이를 참고한다
export const getArcs = (characterId: number): Record<string, string> => {
  const rows = db
    .prepare(`SELECT period, content FROM arcs WHERE character_id = ?`)
    .all(characterId) as { period: string; content: string }[];
  return Object.fromEntries(rows.map((r) => [r.period, r.content]));
};

export const saveArc = (
  characterId: number,
  period: "year" | "season" | "month" | "week",
  content: string,
): void => {
  db.prepare(
    `INSERT OR REPLACE INTO arcs (character_id, period, content) VALUES (?, ?, ?)`,
  ).run(characterId, period, content);
};

// 컨디션/기상 리듬 시드: 월 단위로 미리 깔아두는 하루의 성향(기력·기상·기분).
// 이벤트(회식 등)의 여파가 다음날 시드에 인과로 이어지게 밤 정리가 한 달치를 생성한다.
// 하루 각본은 이 시드 + 어제 일기(실제 여파)를 이어 그날 기상 시각·활동량을 확정한다.
export interface DaySeed {
  date: string;
  energy: string; // 낮음 | 보통 | 높음
  wake_hint: string; // 이른 | 보통 | 늦잠
  mood: string; // 짧은 구
  reason: string | null; // 왜 이런지 (예: 어제 회식 여파)
}

export const getDaySeed = (
  characterId: number,
  date: string,
): DaySeed | undefined =>
  db
    .prepare(
      `SELECT date, energy, wake_hint, mood, reason FROM day_seeds WHERE character_id = ? AND date = ?`,
    )
    .get(characterId, date) as DaySeed | undefined;

export const getMonthSeeds = (
  characterId: number,
  ym: string, // "YYYY-MM"
): DaySeed[] =>
  db
    .prepare(
      `SELECT date, energy, wake_hint, mood, reason FROM day_seeds WHERE character_id = ? AND date LIKE ? ORDER BY date`,
    )
    .all(characterId, `${ym}-%`) as DaySeed[];

export const monthHasSeeds = (characterId: number, ym: string): boolean =>
  !!db
    .prepare(
      `SELECT 1 FROM day_seeds WHERE character_id = ? AND date LIKE ? LIMIT 1`,
    )
    .get(characterId, `${ym}-%`);

export const saveDaySeed = (characterId: number, s: DaySeed): void => {
  db.prepare(
    `INSERT OR REPLACE INTO day_seeds (character_id, date, energy, wake_hint, mood, reason) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(characterId, s.date, s.energy, s.wake_hint, s.mood, s.reason ?? null);
};

// 일정 슬롯: 하루 각본보다 성긴 층. 캐릭터의 예정(owner='char')과 유저에게 들은 예정(owner='user')을
// 캐릭터별로 보관한다. 대화에서 잡힌 약속의 추출·기록은 밤 정리 몫.
export interface ScheduleRow {
  id: number;
  owner: string;
  date: string;
  time_hint: string | null;
  content: string;
}

export const getUpcomingSchedules = (
  characterId: number,
  fromDate: string,
  limit = 12,
): ScheduleRow[] =>
  db
    .prepare(
      `SELECT id, owner, date, time_hint, content FROM schedules
       WHERE character_id = ? AND status = 'active' AND date >= ?
       ORDER BY date, id LIMIT ?`,
    )
    .all(characterId, fromDate, limit) as ScheduleRow[];

// 각본 블록이 가리키는 원본 일정 한 건. 붙잡기 판정이 '유저가 아는가'를 원본에서 읽는다 —
// 각본에는 이 값이 없고, 블록의 출처(source_id)를 따라와야 나온다.
// character_id를 함께 걸어 각본에 엉뚱한 번호가 적혀도 다른 캐릭터의 일정에 닿지 않게 한다.
// status는 걸지 않는다 — 취소·미룸으로 표시된 일정이라도 유저가 아는지는 그대로다.
export interface ScheduleDetailRow extends ScheduleRow {
  user_knows: UserKnows;
}

export interface ScheduleStateRow extends ScheduleRow {
  status: ScheduleStatus;
}

// 상태와 '상대가 아는가'를 함께 읽는 줄. 새벽 정리가 이미 저장된 일정을 모델에게 보여줄 때
// 쓴다 — 지금 값을 안 보여주면 이번에 말한 일정만 골라 known으로 고칠 수가 없다(이슈 #345).
export interface ScheduleKnowsRow extends ScheduleStateRow {
  user_knows: UserKnows;
}

export const getScheduleById = (
  characterId: number,
  id: number,
): ScheduleDetailRow | null =>
  (db
    .prepare(
      `SELECT id, owner, date, time_hint, content, user_knows FROM schedules
       WHERE character_id = ? AND id = ?`,
    )
    .get(characterId, id) as ScheduleDetailRow | undefined) ?? null;

// 그날 유저에게 있는 일정 — 오래 답이 없는 동안에도 이 일정만은 챙겨 아침에 한 통 보낸다.
export const hasUserScheduleOn = (characterId: number, date: string): boolean =>
  !!db
    .prepare(
      `SELECT 1 FROM schedules WHERE character_id = ? AND owner = 'user' AND status = 'active' AND date = ? LIMIT 1`,
    )
    .get(characterId, date);

// 넣은 행 번호를 돌려준다 — 저장 직후 이 일정에 주제 태그를 붙이려면 번호가 있어야 한다.
//
// 같은 캐릭터·주인·날짜에 내용이 글자까지 같은 행이 있으면 넣지 않고 그 번호를 돌려준다.
// 이건 마지막 방어선일 뿐이다: 실제로 겹치는 일정은 표현이 조금씩 달라서 글자 일치로는
// 안 걸린다(운영 데이터에서 확인한 세 쌍 가운데 걸리는 것은 0쌍). 같은 일을 두 번 적지
// 않게 하는 주된 장치는 저장 전에 이미 있는 일정을 모델에게 보여주는 쪽이다
// (nightly.ts 추출 프롬프트의 [이미 저장된 일정], life-plan.ts 월 프롬프트의 [이미 잡힌 일정]).
//
// origin은 이 행을 만든 경로다. 기본값에 기대지 말고 부르는 쪽이 넣는다 — 안 넣으면 전부
// conversation으로 들어가 나중에 중복이 생겼을 때 어느 경로가 넣었는지 가릴 수 없다.
//
// userKnows도 부르는 쪽이 넣는다. 넣지 않던 동안 모든 행이 기본값 unknown으로 들어가서,
// 답장 텀 판정의 '상대가 안다' 갈래에 닿는 일정이 하나도 없었다(이슈 #345). 상대 쪽 일정은
// 상대가 제 일정을 모를 리 없으니 기억 표와 같게 known으로 고정한다.
export const addSchedule = (
  characterId: number,
  owner: "char" | "user",
  date: string,
  timeHint: string | null,
  content: string,
  now: string,
  origin: ScheduleOrigin,
  userKnows: UserKnows = "unknown",
): number => {
  const dup = db
    .prepare(
      `SELECT id FROM schedules
       WHERE character_id = ? AND owner = ? AND date = ? AND content = ? LIMIT 1`,
    )
    .get(characterId, owner, date, content) as { id: number } | undefined;
  if (dup) return dup.id;
  return Number(
    db
      .prepare(
        `INSERT INTO schedules (character_id, owner, date, time_hint, content, origin, user_knows, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        characterId,
        owner,
        date,
        timeHint,
        content,
        origin,
        owner === "user" ? "known" : userKnows,
        now,
      )
      .lastInsertRowid,
  );
};

// 이미 있는 일정 줄의 시각만 고쳐 적는다. 오후라고만 적힌 줄의 시각이 대화에서 정해진 날,
// 새벽 정리가 새 줄을 만드는 대신 이 자리로 온다 — 같은 일을 두 줄로 쌓지 않으면서 다음 날
// 각본이 그 시각을 쓰게 하려면 원본 줄의 값을 고치는 수밖에 없다(이슈 #278).
//
// 고치는 것은 time_hint 하나뿐이다. 주인·날짜·내용까지 열어 두면 새벽 정리 한 번이 이미 저장된
// 일정을 다른 일로 바꿔 놓을 수 있고, 그 자리에는 되돌릴 값이 남지 않는다.
// character_id를 함께 걸어 생성이 엉뚱한 번호를 답해도 다른 캐릭터의 일정에 닿지 않게 한다.
// status를 active로 거르는 것은 취소·미룸으로 접힌 일정의 시각을 다시 적을 이유가 없어서다.
export const setScheduleTimeHint = (
  characterId: number,
  id: number,
  timeHint: string,
): boolean =>
  db
    .prepare(
      `UPDATE schedules SET time_hint = ?
       WHERE character_id = ? AND id = ? AND status = 'active'`,
    )
    .run(timeHint, characterId, id).changes > 0;

// 캐릭터가 상대에게 말한 일정에 그 사실을 적는다. 시각 고치기와 달리 status를 걸지 않는다 —
// 취소·미룸으로 접힌 일정이라도 이미 말한 것은 말한 것이라, 답장 텀 판정은 그대로 읽는다.
// 받는 값을 known 하나로 좁혀 둔 것은 되돌리는 쓰기를 막으려는 것이다: 한 번 말한 일을
// 다음 새벽에 모델이 빠뜨렸다고 해서 모르는 일로 돌아가면 같은 이야기를 처음처럼 다시 꺼낸다.
export const markScheduleKnown = (characterId: number, id: number): boolean =>
  db
    .prepare(
      `UPDATE schedules SET user_knows = 'known'
       WHERE character_id = ? AND id = ? AND user_knows <> 'known'`,
    )
    .run(characterId, id).changes > 0;

// 같은 주인·날짜에 지금 살아 있는 일정들. 새벽 정리가 대화에서 뽑은 일정을 넣기 전에
// 이 목록과 견줘 같은 일이면 넣지 않는다(nightly.ts). status를 active로 거르는 것은
// 취소·미룸으로 표시된 줄과는 겹쳐도 막지 않으려는 것이다 — 접혔던 일이 다시 잡히면 그건
// 새로 적을 일정이다.
export const getActiveSchedulesOn = (
  characterId: number,
  owner: "char" | "user",
  date: string,
): ScheduleRow[] =>
  db
    .prepare(
      `SELECT id, owner, date, time_hint, content FROM schedules
       WHERE character_id = ? AND owner = ? AND date = ? AND status = 'active'
       ORDER BY id`,
    )
    .all(characterId, owner, date) as ScheduleRow[];

// 새벽 정리 추출에 '이미 저장된 일정'으로 보여줄 행들.
// getUpcomingSchedules와 두 가지가 다르다. status를 거르지 않는다 — 취소·미룸으로 표시된
// 일정을 감추면 모델이 그것을 못 보고 새 일정으로 다시 적는다. 그리고 상한이 훨씬 크다 —
// 이 목록의 목적이 '겹치는지 보여주기'라 가려진 행이 곧 중복이 된다.
export const getSchedulesFrom = (
  characterId: number,
  fromDate: string,
  limit: number,
): ScheduleKnowsRow[] =>
  db
    .prepare(
      `SELECT id, owner, date, time_hint, content, status, user_knows FROM schedules
       WHERE character_id = ? AND date >= ?
       ORDER BY date, id LIMIT ?`,
    )
    .all(characterId, fromDate, limit) as ScheduleKnowsRow[];

// 태그로 찾은 일정 여러 건. 날짜 조건을 걸지 않는다 — 이 경로가 꺼내는 것은 주로 지난 일정이고,
// 가까운 앞일은 이미 [다가오는 일정]이 싣는다(겹치는 행은 읽는 쪽이 뺀다).
// status도 걸지 않는다: 취소·미룸으로 표시된 일정도 대화에 나오면 그대로 답해야 하고,
// 예정처럼 말하지 않도록 상태를 프롬프트에 함께 적는다.
export const getSchedulesByIds = (
  characterId: number,
  ids: number[],
): ScheduleStateRow[] => {
  if (!ids.length) return [];
  const holes = ids.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT id, owner, date, time_hint, content, status FROM schedules
       WHERE character_id = ? AND id IN (${holes})`,
    )
    .all(characterId, ...ids) as ScheduleStateRow[];
};

export const getSchedulesInMonth = (
  characterId: number,
  ym: string, // "YYYY-MM"
  owner?: "char" | "user",
): ScheduleRow[] =>
  db
    .prepare(
      `SELECT id, owner, date, time_hint, content FROM schedules
       WHERE character_id = ? AND status = 'active' AND date LIKE ?${owner ? " AND owner = ?" : ""}
       ORDER BY date, id`,
    )
    .all(
      ...(owner ? [characterId, `${ym}-%`, owner] : [characterId, `${ym}-%`]),
    ) as ScheduleRow[];

export const getDayPlan = (
  characterId: number,
  date: string,
): string | undefined =>
  (
    db
      .prepare(
        `SELECT plan_json FROM day_plans WHERE character_id = ? AND date = ?`,
      )
      .get(characterId, date) as { plan_json: string } | undefined
  )?.plan_json;

// made_by: 밤 정리 정식 생성(nightly) vs 그날 첫 대화에서 만든 임시 각본(ondemand).
// 임시 각본은 어제 일기가 아직 없을 때 만들어진 것이라 밤 정리가 교체할 수 있다.
export const saveDayPlan = (
  characterId: number,
  date: string,
  planJson: string,
  madeBy: "nightly" | "ondemand" = "nightly",
): void => {
  db.prepare(
    `INSERT OR REPLACE INTO day_plans (character_id, date, plan_json, made_by) VALUES (?, ?, ?, ?)`,
  ).run(characterId, date, planJson, madeBy);
};

export const getDayPlanMadeBy = (
  characterId: number,
  date: string,
): string | undefined =>
  (
    db
      .prepare(
        `SELECT made_by FROM day_plans WHERE character_id = ? AND date = ?`,
      )
      .get(characterId, date) as { made_by: string } | undefined
  )?.made_by;

/**
 * 캐릭터가 본 작품의 사실 카드(#287). 각본에 실제 작품이 들어가면 새벽 정리가 그 작품을 한 번
 * 찾아보고 여기에 적는다. 답장 경로는 오늘 각본이나 진행 중인 일에 제목이 있을 때만 읽는다.
 * 장면은 여러 줄이라 JSON 배열로 넣고 꺼낼 때 되돌린다.
 */
export interface WorkFact {
  title: string;
  summary: string;
  scenes: string[];
  differences: string | null;
}

/** 이미 카드가 있는 제목. 새벽 정리가 같은 작품을 두 번 찾지 않으려고 본다. */
export const listWorkFactTitles = (characterId: number): string[] =>
  (
    db
      .prepare(
        `SELECT title FROM work_facts WHERE character_id = ? ORDER BY title`,
      )
      .all(characterId) as { title: string }[]
  ).map((r) => r.title);

const parseScenes = (raw: string): string[] => {
  try {
    const v: unknown = JSON.parse(raw);
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  } catch {
    /* 옛 행이나 깨진 값은 통째로 한 장면으로 본다 */
  }
  return raw.trim() ? [raw.trim()] : [];
};

export const getWorkFactsByTitles = (
  characterId: number,
  titles: string[],
): WorkFact[] => {
  if (!titles.length) return [];
  const holes = titles.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT title, summary, scenes, differences FROM work_facts
       WHERE character_id = ? AND title IN (${holes}) ORDER BY title`,
    )
    .all(characterId, ...titles) as {
    title: string;
    summary: string;
    scenes: string;
    differences: string | null;
  }[];
  return rows.map((r) => ({
    title: r.title,
    summary: r.summary,
    scenes: parseScenes(r.scenes),
    differences: r.differences,
  }));
};

export const saveWorkFact = (
  characterId: number,
  fact: WorkFact,
  now: string,
): void => {
  db.prepare(
    `INSERT OR REPLACE INTO work_facts
       (character_id, title, summary, scenes, differences, made_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    characterId,
    fact.title,
    fact.summary,
    JSON.stringify(fact.scenes),
    fact.differences,
    now,
  );
};

export const hasDiaryOn = (characterId: number, date: string): boolean =>
  !!db
    .prepare(
      `SELECT 1 FROM diary_entries WHERE character_id = ? AND date = ? LIMIT 1`,
    )
    .get(characterId, date);

export const getDiaryOn = (
  characterId: number,
  date: string,
): { id: number; entry_json: string } | undefined =>
  db
    .prepare(
      `SELECT id, entry_json FROM diary_entries WHERE character_id = ? AND date = ?`,
    )
    .get(characterId, date) as { id: number; entry_json: string } | undefined;

// 일기 한 편을 넣고 행 번호를 돌려준다. 태그는 이 번호로 단다.
export const insertDiary = (
  characterId: number,
  date: string,
  entryJson: string,
): number =>
  Number(
    db
      .prepare(
        `INSERT INTO diary_entries (character_id, date, entry_json) VALUES (?, ?, ?)`,
      )
      .run(characterId, date, entryJson).lastInsertRowid,
  );

export const getRecentDiaries = (
  characterId: number,
  limit: number,
): { date: string; entry_json: string }[] => {
  const rows = db
    .prepare(
      `SELECT date, entry_json FROM diary_entries WHERE character_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(characterId, limit) as { date: string; entry_json: string }[];
  return rows.reverse();
};

/** 태그 검색으로 찾은 일기를 id로 읽는다. 날짜 오름차순. */
export const getDiariesByIds = (
  ids: number[],
): { id: number; date: string; entry_json: string }[] => {
  if (!ids.length) return [];
  const holes = ids.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT id, date, entry_json FROM diary_entries WHERE id IN (${holes}) ORDER BY date`,
    )
    .all(...ids) as { id: number; date: string; entry_json: string }[];
};
