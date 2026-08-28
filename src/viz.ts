// 슬랙 트레이스 채널 — 캐릭터 파이프라인이 안에서 내린 판단을 슬랙에 게시한다.
//
// 원칙 셋.
// - 게시를 위한 모델 호출은 없다. DB에 이미 있는 값과 코드 계산만으로 만든다.
// - 보여줄 내용은 viz_events 행으로 먼저 쌓고(게시함), 1분 틱이 슬랙으로 내보낸다.
//   재시작·슬랙 장애에도 보낼 것이 남고, 봇 밖에서 도는 배치가 남긴 행도 같은 길로 나간다.
// - SLACK_BOT_TOKEN·SLACK_VIZ_CHANNEL 둘 중 하나라도 없으면 전체가 no-op —
//   토큰 없이 먼저 배포해도 안전하다.

import { config } from "./config.js";
import {
  db,
  getDayPlan,
  getDayPlanMadeBy,
  getDaySeed,
  type CharacterRow,
  type DaySeed,
} from "./db.js";
import {
  blockCategory,
  buildPlanPrompt,
  PLAN_SYSTEM,
  type DayPlan,
  type PlanBlock,
} from "./day-plan.js";
import { isSleeping } from "./reply-timing.js";
import {
  ACTIVITY_CATEGORY_NAME,
  RESPONSIVENESS_NAME,
  toResponsiveness,
} from "./labels.js";
import { getKstNow, kstDateString } from "./kst.js";
import { silenceState } from "./proactive-policy.js";

export const vizEnabled = (): boolean =>
  Boolean(config.slackBotToken && config.slackVizChannel);

const nowIso = (): string =>
  getKstNow().toISOString().replace("T", " ").slice(0, 19);

// ── 게시함에 쌓기 ───────────────────────────────────────────────────────

export interface VizEventInput {
  characterId?: number;
  kind: string;
  text: string;
  /** 같은 키가 이미 쌓였으면 다시 쌓지 않는다(재게시 방지). */
  dedupeKey?: string;
  /** 이 행이 스레드의 부모가 될 때, 자식들이 가리킬 키. */
  threadKey?: string;
  /** 이 행이 스레드에 달릴 때, 부모 행의 threadKey. */
  parentKey?: string;
}

export const recordVizEvent = (e: VizEventInput): void => {
  if (!vizEnabled()) return;
  try {
    db.prepare(
      `INSERT OR IGNORE INTO viz_events
         (character_id, kind, dedupe_key, thread_key, parent_key, text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      e.characterId ?? null,
      e.kind,
      e.dedupeKey ?? null,
      e.threadKey ?? null,
      e.parentKey ?? null,
      e.text,
      nowIso(),
    );
  } catch (err) {
    // 트레이스 기록 실패가 본 기능(답장·선톡)을 멈추면 안 된다 — 적고 넘어간다.
    console.error("[viz] 기록 실패:", err);
  }
};

// ── 슬랙 발송 ───────────────────────────────────────────────────────────

interface SlackResult {
  ok: boolean;
  ts?: string;
  error?: string;
}

const postToSlack = async (
  text: string,
  threadTs?: string,
): Promise<SlackResult> => {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${config.slackBotToken}`,
    },
    body: JSON.stringify({
      channel: config.slackVizChannel,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      unfurl_links: false,
      unfurl_media: false,
    }),
  });
  return (await res.json()) as SlackResult;
};

// 다시 보내도 같은 이유로 실패하는 응답 — 재시도 없이 바로 접는다.
// not_in_channel은 앱을 채널에 초대해야 풀린다(로그로 안내).
const PERMANENT_ERRORS = new Set([
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "msg_too_long",
]);

const MAX_ATTEMPTS = 3;
const BATCH = 20;

interface VizRow {
  id: number;
  kind: string;
  parent_key: string | null;
  text: string;
  attempts: number;
}

const parentOf = (
  parentKey: string,
): { status: string; slack_ts: string | null } | undefined =>
  db
    .prepare(
      `SELECT status, slack_ts FROM viz_events
        WHERE thread_key = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(parentKey) as { status: string; slack_ts: string | null } | undefined;

const markFailure = (row: VizRow, error: string, permanent: boolean): void => {
  const attempts = row.attempts + 1;
  const giveUp = permanent || attempts >= MAX_ATTEMPTS;
  db.prepare(
    `UPDATE viz_events SET status = ?, attempts = ?, last_error = ? WHERE id = ?`,
  ).run(giveUp ? "failed" : "pending", attempts, error, row.id);
  if (giveUp)
    console.error(
      `[viz] 게시 포기 (${row.kind}): ${error}${error === "not_in_channel" ? " — 슬랙 앱을 채널에 초대해야 한다" : ""}`,
    );
};

/** 1분 틱. 게시할 것을 새로 쌓고, pending 행을 슬랙으로 내보낸다. */
export const runVizTick = async (): Promise<void> => {
  if (!vizEnabled()) return;
  try {
    enqueueMorningPlans();
  } catch (err) {
    console.error("[viz] 아침 각본 게시 준비 실패:", err);
  }
  const rows = db
    .prepare(
      `SELECT id, kind, parent_key, text, attempts
         FROM viz_events WHERE status = 'pending' ORDER BY id LIMIT ?`,
    )
    .all(BATCH) as VizRow[];
  for (const row of rows) {
    let threadTs: string | undefined;
    if (row.parent_key) {
      const parent = parentOf(row.parent_key);
      // 부모가 아직 안 나갔으면 다음 틱에 — 스레드 순서를 지킨다.
      if (!parent || parent.status === "pending") continue;
      if (parent.status !== "sent" || !parent.slack_ts) {
        db.prepare(
          `UPDATE viz_events SET status = 'skipped', last_error = '부모 게시 실패' WHERE id = ?`,
        ).run(row.id);
        continue;
      }
      threadTs = parent.slack_ts;
    }
    try {
      const res = await postToSlack(row.text, threadTs);
      if (res.ok && res.ts)
        db.prepare(
          `UPDATE viz_events
              SET status = 'sent', slack_ts = ?, attempts = attempts + 1, last_error = NULL
            WHERE id = ?`,
        ).run(res.ts, row.id);
      else {
        const error = res.error ?? "unknown_error";
        markFailure(row, error, PERMANENT_ERRORS.has(error));
      }
    } catch (err) {
      markFailure(row, String(err), false);
    }
  }
};

// ── 아침 각본 게시 ──────────────────────────────────────────────────────

// 새벽 정리(05:40)가 끝난 뒤인 이 시각(KST)부터, 오늘 각본이 보이면 게시한다.
const PLAN_POST_HOUR = 7;
// 평상 관계인데 이 시각까지 각본이 없으면 경고 한 줄을 올린다.
const PLAN_WARN_HOUR = 12;

// 슬랙 표기 규칙 — &·<·>는 링크·멘션 문법과 겹쳐 그대로 보내면 깨진다.
const esc = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"] as const;

const dateLabel = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${DAY_NAMES[d.getUTCDay()]})`;
};

// 답장 텀 표(reply-timing.ts)를 사람이 읽는 범위로 옮긴 것. 표의 값이 바뀌면 여기도 맞춘다.
const timingRange = (b: PlanBlock): string => {
  if (isSleeping(b)) return "자다 깨면 바로";
  const resp = toResponsiveness(b.responsiveness) ?? "instant";
  if (resp === "instant") return "0초~2분";
  if (resp === "unavailable") return `${b.end} 끝난 뒤 1분 안`;
  const cat = blockCategory(b);
  return cat === "personal"
    ? "20초~2분 30초"
    : cat === "social"
      ? "30초~4분"
      : "1~8분";
};

// 각본은 코드 블록 안에 올려 표처럼 읽는다. 한글은 고정폭 글꼴에서 두 칸을 차지하므로
// 태그 열을 맞추려면 글자 수가 아니라 이 폭으로 센다. 슬랙이 &amp;를 &로 되돌려 그리므로
// 자리는 이스케이프 전 글자로 계산한다.
const width = (s: string): number =>
  [...s].reduce((n, ch) => n + ((ch.codePointAt(0) ?? 0) > 0x10ff ? 2 : 1), 0);

const ACTIVITY_COLS = 22;

// 각본 한 줄: 시각 · 활동 · (활동 성격)[답장 여건] 답장 텀
const blockLine = (b: PlanBlock): string => {
  const resp = toResponsiveness(b.responsiveness) ?? "instant";
  const tags = `(${ACTIVITY_CATEGORY_NAME[blockCategory(b)]})[${RESPONSIVENESS_NAME[resp]}]`;
  // 당일에 닥치는 일은 별표 하나로 표시하고 각본 아래에 뜻을 한 줄 붙인다(열을 밀지 않게).
  const activity = `${b.activity}${b.advance_known ? "" : " *"}`;
  const pad = " ".repeat(Math.max(1, ACTIVITY_COLS - width(activity)));
  return `${b.start}~${b.end}  ${esc(activity)}${pad}${tags} ${timingRange(b)}`;
};

const seedText = (seed: DaySeed | undefined): string =>
  seed
    ? `기력 ${seed.energy} · 기상 ${seed.wake_hint} · 기분 ${seed.mood}${seed.reason ? ` (${seed.reason})` : ""}`
    : "없음";

// 슬랙 메시지 한 개 상한(4000자)보다 여유 있게 자른다. 프롬프트 전문이 대상이다.
const CHUNK = 3500;
const chunked = (s: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += CHUNK) out.push(s.slice(i, i + CHUNK));
  return out;
};

// 각본 생성 프롬프트는 고정 지시문 사이에 DB 값이 들어가는 한 장짜리 틀이라, 규칙이 시작하는
// 자리에서 잘라 그날 데이터와 매일 같은 규칙을 따로 올린다(day-plan.ts planPrompt와 짝).
const RULE_MARK = "[컨디션→기상→활동을 하나로 잇기]";

const promptSections = (prompt: string): { label: string; body: string }[] => {
  const at = prompt.indexOf(RULE_MARK);
  if (at < 0) return [{ label: "각본 생성 프롬프트", body: prompt }];
  return [
    {
      label:
        "각본 생성 프롬프트 1 — 시스템 문장과 오늘 데이터 (게시 시점에 같은 DB 데이터로 다시 조립한 것)",
      body: prompt.slice(0, at).trimEnd(),
    },
    {
      label: "각본 생성 프롬프트 2 — 고정 규칙 (매일 같음)",
      body: prompt.slice(at),
    },
  ];
};

const hasVizEvent = (dedupeKey: string): boolean =>
  Boolean(
    db.prepare(`SELECT 1 FROM viz_events WHERE dedupe_key = ?`).get(dedupeKey),
  );

const activeCharacters = (): CharacterRow[] =>
  db
    .prepare(`SELECT * FROM characters WHERE status = 'active'`)
    .all() as CharacterRow[];

const enqueuePlanPost = (c: CharacterRow, date: string, raw: string): void => {
  const madeBy = getDayPlanMadeBy(c.id, date) ?? "nightly";
  const dedupeKey = `day_plan:${c.id}:${date}:${madeBy}`;
  if (hasVizEvent(dedupeKey)) return;

  let plan: DayPlan;
  try {
    plan = JSON.parse(raw) as DayPlan;
  } catch {
    return;
  }

  // 임시 각본을 이미 올린 날 nightly가 다시 보이면 = 새벽 정리가 정식 각본으로 교체한 것
  const replaced =
    madeBy === "nightly" && hasVizEvent(`day_plan:${c.id}:${date}:ondemand`);
  const madeByLabel =
    madeBy === "ondemand"
      ? "대화 중 임시 생성"
      : replaced
        ? "새벽 정리 생성 (임시 각본 교체)"
        : "새벽 정리 생성";

  const seed = getDaySeed(c.id, date);
  const surprise = plan.blocks.some((b) => !b.advance_known);
  const head = [
    `:spiral_calendar_pad: *${dateLabel(date)} 하루 각본* — ${madeByLabel}`,
    `컨디션 시드: ${esc(seedText(seed))}`,
    "```",
    ...plan.blocks.map(blockLine),
    "```",
    ...(surprise ? ["`*` 당일에 닥치는 일"] : []),
  ].join("\n");

  // 생성 프롬프트는 지금 같은 DB 데이터로 다시 조립한다. 각본을 만든 뒤 게시할 때까지
  // 그 데이터(일기·아크·일정·시드)를 고치는 곳이 새벽 정리뿐이라 조립 결과가 같다.
  let prompt: string;
  try {
    prompt = `${PLAN_SYSTEM}\n\n${buildPlanPrompt(c.id, date)}`;
  } catch (err) {
    prompt = `(프롬프트 조립 실패: ${String(err)})`;
  }
  const sections = promptSections(prompt);

  db.transaction(() => {
    recordVizEvent({
      characterId: c.id,
      kind: "day_plan",
      text: head,
      dedupeKey,
      threadKey: dedupeKey,
    });
    for (const s of sections) {
      const parts = chunked(esc(s.body));
      parts.forEach((p, i) => {
        const label =
          parts.length > 1 ? `${s.label} (${i + 1}/${parts.length})` : s.label;
        recordVizEvent({
          characterId: c.id,
          kind: "day_plan_prompt",
          parentKey: dedupeKey,
          text: `${label}\n\`\`\`\n${p}\n\`\`\``,
        });
      });
    }
  })();
};

const enqueueNoPlanNote = (
  c: CharacterRow,
  date: string,
  hour: number,
): void => {
  const silence = silenceState(c.chat_id, c.id);
  if (silence.tier !== "normal") {
    const dedupeKey = `day_plan:${c.id}:${date}:quiet`;
    if (hasVizEvent(dedupeKey)) return;
    recordVizEvent({
      characterId: c.id,
      kind: "day_plan_quiet",
      dedupeKey,
      text: `:zzz: ${dateLabel(date)} 오늘 각본 없음 — 무응답 ${silence.days}일째라 새벽 정리가 일기·시드만 만들었다. 유저가 말을 걸면 임시 각본을 만든다.`,
    });
  } else if (hour >= PLAN_WARN_HOUR) {
    const dedupeKey = `day_plan:${c.id}:${date}:missing`;
    if (hasVizEvent(dedupeKey)) return;
    recordVizEvent({
      characterId: c.id,
      kind: "day_plan_missing",
      dedupeKey,
      text: `:warning: ${dateLabel(date)} 정오까지 오늘 각본이 없다 — 새벽 정리가 실행되지 않았을 수 있다. 유저가 말을 걸면 임시 각본으로 시작한다.`,
    });
  }
};

const enqueueMorningPlans = (): void => {
  const hour = getKstNow().getUTCHours();
  if (hour < PLAN_POST_HOUR) return;
  const date = kstDateString();
  for (const c of activeCharacters()) {
    const raw = getDayPlan(c.id, date);
    if (raw) enqueuePlanPost(c, date, raw);
    else enqueueNoPlanNote(c, date, hour);
  }
};
