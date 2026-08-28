// 오늘 몫 트레이스를 지우고 다시 보낸다. 게시 형식을 고칠 때마다 dedupe_key가 재게시를 막아
// 손으로 행을 지워야 했던 자리를 대신한다.
//
// 사용: docker exec random-ai-companion npx tsx src/tools/retrace.ts [--date YYYY-MM-DD] [--yes] [--keep-slack] [--all]
//   기본은 세어만 본다 — --yes 없이는 슬랙도 DB도 건드리지 않는다.
//   --yes         슬랙에 올린 메시지를 지우고 게시 기록을 되돌린다(1분 틱이 다시 올린다)
//   --keep-slack  슬랙 메시지는 그대로 두고 DB 쪽만 되돌린다
//   --date        되돌릴 논리일(새벽 5시 기준). 기본은 오늘
//   --all         아침 각본 알림(구간 1)까지 함께 되돌린다
import { db } from "../db.js";
import { config } from "../config.js";
import { kstLogicalDate } from "../kst.js";

const argv = process.argv.slice(2);
const apply = argv.includes("--yes");
const keepSlack = argv.includes("--keep-slack");
const withDayPlan = argv.includes("--all");
const dateIdx = argv.indexOf("--date");
const date = dateIdx >= 0 ? (argv[dateIdx + 1] ?? "") : kstLogicalDate();
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error("--date 는 YYYY-MM-DD 형식이어야 한다");
  process.exit(1);
}

const nextDay = (d: string): string => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
};
// 하루는 새벽 5시에 바뀐다 — 게시 행의 created_at도 KST 벽시계라 그대로 견준다.
const start = `${date} 05:00:00`;
const end = `${nextDay(date)} 05:00:00`;

// 호출 기록에서 다시 만들 수 있는 것 — 지우면 1분 틱이 새 형식으로 다시 올린다.
const REGENERATED = [
  "call_%",
  "prompt_day",
  "prompt_day_body",
  "prompt_change",
  "prompt_change_body",
  ...(withDayPlan ? ["day_plan", "day_plan_prompt", "day_plan_quiet", "day_plan_missing"] : []),
];
// 그때 한 번 쌓고 마는 것 — 지우면 영영 사라지므로 다시 보낼 준비만 시킨다.
const RECORDED = ["reply_%", "proactive_send"];

const like = (pats: string[]): string =>
  pats.map(() => "kind LIKE ?").join(" OR ");

interface Row {
  id: number;
  kind: string;
  status: string;
  slack_ts: string | null;
}

const pick = (pats: string[]): Row[] =>
  db
    .prepare(
      `SELECT id, kind, status, slack_ts FROM trace_events
        WHERE created_at >= ? AND created_at < ? AND (${like(pats)})
        ORDER BY id`,
    )
    .all(start, end, ...pats) as Row[];

const regenerated = pick(REGENERATED);
const recorded = pick(RECORDED);
const all = [...regenerated, ...recorded];

const tally = (rows: Row[]): string => {
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.kind, (by.get(r.kind) ?? 0) + 1);
  return [...by].map(([k, n]) => `${k} ${n}`).join(", ") || "없음";
};

console.log(`논리일 ${date} (${start} ~ ${end})`);
console.log(`  다시 만들 것: ${tally(regenerated)}`);
console.log(`  다시 보낼 것: ${tally(recorded)}`);
const posted = all.filter((r) => r.slack_ts);
console.log(`  슬랙에 올라간 것: ${posted.length}건`);

if (!apply) {
  console.log("\n세어만 봤다. 실제로 되돌리려면 --yes 를 붙인다.");
  process.exit(0);
}

const deleteFromSlack = async (): Promise<void> => {
  if (keepSlack || !config.slackBotToken || !config.slackTraceChannel) {
    if (!keepSlack) console.log("슬랙 설정이 없어 메시지 삭제는 건너뛴다");
    return;
  }
  let gone = 0;
  for (const row of posted) {
    const res = await fetch("https://slack.com/api/chat.delete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${config.slackBotToken}`,
      },
      body: JSON.stringify({
        channel: config.slackTraceChannel,
        ts: row.slack_ts,
      }),
    });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (body.ok) gone++;
    else console.warn(`  #${row.id} ${row.kind} 삭제 실패: ${body.error}`);
    // chat.delete는 분당 한도가 있다 — 천천히 지운다
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log(`슬랙 메시지 ${gone}/${posted.length}건 삭제`);
};

await deleteFromSlack();

const rearm = db.prepare(
  // 다시 보낼 행은 만든 시각도 지금으로 당긴다 — 부모 행이 방금 지워졌으므로,
  // 옛 시각 그대로 두면 게시 틱이 '부모가 없는 오래된 자식'으로 보고 접는다.
  `UPDATE trace_events
      SET status = 'pending', slack_ts = NULL, attempts = 0, last_error = NULL,
          created_at = ?
    WHERE id = ?`,
);
const drop = db.prepare(`DELETE FROM trace_events WHERE id = ?`);
const untrace = db.prepare(`UPDATE llm_calls SET traced = 0 WHERE id = ?`);
const callsOfDay = db
  .prepare(
    `SELECT id FROM llm_calls WHERE created_at >= ? AND created_at < ? ORDER BY id`,
  )
  .all(start, end) as { id: number }[];

const stamp = new Date(Date.now() + 9 * 3600_000)
  .toISOString()
  .replace("T", " ")
  .slice(0, 19);

db.transaction(() => {
  for (const r of regenerated) drop.run(r.id);
  for (const r of recorded) rearm.run(stamp, r.id);
  for (const c of callsOfDay) untrace.run(c.id);
})();

console.log(
  `게시 행 ${regenerated.length}건 삭제, ${recorded.length}건 재무장, 호출 ${callsOfDay.length}건 다시 게시 대상`,
);
console.log("1분 틱이 돌면 새 형식으로 다시 올라간다.");
