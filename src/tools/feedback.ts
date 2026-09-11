// 슬랙에서 모은 표시를 처리 여부와 함께 보는 도구 — 안 끝난 것을 보여주고 처리 표시를 찍는다.
//
// 사용: docker exec random-ai-companion npx tsx src/tools/feedback.ts
//       ... src/tools/feedback.ts --mark 12,13 --issue 400 [--resolution wontfix] [--no-slack]
//       ... src/tools/feedback.ts --undo 12,13
//
// 인자 없이 돌리면 아직 처리 표시를 찍지 않은 표시를 쌓인 순서로 보여준다. 세션을 열 때 이것을
// 먼저 돌리면 채널을 처음부터 다시 읽지 않고 남은 것만 본다.
//
// --mark로 찍은 행이 가리키는 슬랙 글에는 흰 동그라미 체크를 단다. 채널을 눈으로 읽을 때
// 어디까지 봤는지 보이고, 분류로 받는 이모지는 4개뿐이라(labels.ts) 이 표시가 새 피드백으로
// 되돌아오지 않는다. 반대로 사람이 채널에 단 체크를 읽어 처리로 보지는 않는다 — 수집이 최근
// 3일치만 다시 읽어서(feedback.ts) 며칠 뒤에 다는 표시는 대부분 들어오지 않는다.
//
// 슬랙에 다는 일은 여기서 직접 부른다. src/feedback.ts는 채널을 읽기만 하고 src/trace.ts는
// 게시함에 쌓인 글을 내보내는 자리라, 어느 쪽도 사람이 손으로 찍는 표시를 맡을 자리가 아니다.

import { config } from "../config.js";
import {
  feedbackByIds,
  openFeedback,
  resolveFeedback,
  unresolveFeedback,
  type FeedbackResolution,
  type FeedbackRow,
} from "../db.js";
import { kstStamp } from "../kst.js";
import { FEEDBACK_KIND_NAME, type FeedbackKind } from "../labels.js";

const USAGE = `사용: npx tsx src/tools/feedback.ts
      npx tsx src/tools/feedback.ts --mark <번호,번호> [--issue <이슈번호>] [--resolution fixed|wontfix|dup] [--no-slack]
      npx tsx src/tools/feedback.ts --undo <번호,번호>`;

const RESOLUTIONS: FeedbackResolution[] = ["fixed", "wontfix", "dup"];
const RESOLUTION_NAME: Record<FeedbackResolution, string> = {
  fixed: "고침",
  wontfix: "안 고침",
  dup: "겹침",
};
// 슬랙이 이모지를 이름으로 받는다. 처리했다는 표시로 채널에서 눈에 띄는 것을 쓴다.
const DONE_EMOJI = "white_check_mark";

const argv = process.argv.slice(2);
// 값을 안 준 플래그는 undefined가 아니라 빈 문자열로 돌려준다 — 오타를 기본값으로 삼키지 않게.
const valueOf = (flag: string): string | undefined => {
  const at = argv.indexOf(flag);
  if (at === -1) return undefined;
  const next = argv[at + 1];
  return next === undefined || next.startsWith("--") ? "" : next;
};

// 번호 목록은 12,13 과 12 13 을 둘 다 받는다 — 손으로 치는 자리라 구분자를 따지지 않는다.
const idsAfter = (flag: string): number[] => {
  const at = argv.indexOf(flag);
  if (at === -1) return [];
  const out: number[] = [];
  for (const token of argv.slice(at + 1)) {
    if (token.startsWith("--")) break;
    for (const part of token.split(",")) {
      const n = Number(part.trim());
      if (Number.isInteger(n) && n > 0) out.push(n);
    }
  }
  return out;
};

// ── 보여주기 ───────────────────────────────────────────────────────────

const kindLabel = (row: FeedbackRow): string =>
  row.kind
    ? FEEDBACK_KIND_NAME[row.kind as FeedbackKind]
    : row.source === "reply"
      ? "이유만"
      : "분류 없음";

const show = (rows: FeedbackRow[]): void => {
  if (!rows.length) {
    console.log("처리 안 한 표시가 없다.");
    return;
  }
  const counts = new Map<string, number>();
  for (const row of rows)
    counts.set(kindLabel(row), (counts.get(kindLabel(row)) ?? 0) + 1);
  const summary = [...counts.entries()]
    .map(([name, n]) => `${name} ${n}`)
    .join(" · ");
  console.log(`처리 안 한 표시 ${rows.length}건 (${summary})\n`);

  let day = "";
  for (const row of rows) {
    const rowDay = row.created_at.slice(0, 10);
    if (rowDay !== day) {
      day = rowDay;
      console.log(`── ${day}`);
    }
    const at = row.created_at.slice(11, 16);
    const call = row.call_id ? ` 호출 #${row.call_id}` : "";
    const where = row.trace_kind ? ` ${row.trace_kind}` : "";
    console.log(`  #${row.id} ${at} ${kindLabel(row)}${where}${call}`);
    if (row.text)
      for (const line of row.text.split("\n")) console.log(`      ${line}`);
  }
  console.log(
    `\n처리 표시: npx tsx src/tools/feedback.ts --mark <번호> --issue <이슈번호>`,
  );
};

// ── 슬랙에 되비추기 ────────────────────────────────────────────────────

interface SlackResult {
  ok: boolean;
  error?: string;
}

/** 그 글에 체크를 단다. 이미 달려 있으면 성공으로 본다. */
const addCheck = async (slackTs: string): Promise<string | null> => {
  const res = await fetch("https://slack.com/api/reactions.add", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${config.slackBotToken}`,
    },
    body: JSON.stringify({
      channel: config.slackTraceChannel,
      timestamp: slackTs,
      name: DONE_EMOJI,
    }),
  });
  const json = (await res.json()) as SlackResult;
  if (json.ok || json.error === "already_reacted") return null;
  // 권한이 없으면 무엇을 고쳐야 하는지까지 적는다 — 체크만 안 달릴 뿐 표시는 이미 찍혔다.
  if (json.error === "missing_scope")
    return "reactions:write 권한이 없다 — 슬랙 앱에 넣고 다시 설치해야 한다";
  return json.error ?? "unknown";
};

const mirrorToSlack = async (rows: FeedbackRow[]): Promise<void> => {
  if (!config.slackBotToken || !config.slackTraceChannel) {
    console.log("슬랙 설정이 없어 체크는 달지 않았다.");
    return;
  }
  // 한 글에 표시가 여러 개 달렸으면 체크는 한 번만 단다.
  const targets = [...new Set(rows.map((r) => r.slack_ts))];
  let done = 0;
  for (const ts of targets) {
    const error = await addCheck(ts);
    if (error) console.error(`  슬랙 ${ts}: ${error}`);
    else done += 1;
  }
  console.log(`슬랙 글 ${done}/${targets.length}개에 체크를 달았다.`);
};

// ── 실행 ───────────────────────────────────────────────────────────────

const undoIds = idsAfter("--undo");
if (undoIds.length) {
  const changed = unresolveFeedback(undoIds);
  console.log(`처리 표시 ${changed}건을 되돌렸다. 슬랙 체크는 손으로 뗀다.`);
  process.exit(0);
}

const markIds = idsAfter("--mark");
if (!markIds.length) {
  if (argv.some((a) => a.startsWith("--"))) {
    console.error(USAGE);
    process.exit(1);
  }
  show(openFeedback());
  process.exit(0);
}

const resolutionArg = valueOf("--resolution") ?? "fixed";
if (!RESOLUTIONS.includes(resolutionArg as FeedbackResolution)) {
  console.error(`--resolution은 ${RESOLUTIONS.join("·")} 중 하나여야 한다`);
  process.exit(1);
}
const resolution = resolutionArg as FeedbackResolution;

const issueArg = valueOf("--issue");
const issueNo =
  issueArg === undefined ? null : Number(issueArg.replace("#", ""));
if (issueNo !== null && (!Number.isInteger(issueNo) || issueNo <= 0)) {
  console.error(`--issue는 이슈 번호여야 한다`);
  process.exit(1);
}

const found = feedbackByIds(markIds);
const missing = markIds.filter((id) => !found.some((r) => r.id === id));
if (missing.length) console.error(`없는 번호: ${missing.join(", ")}`);
const already = found.filter((r) => r.resolved_at);
if (already.length)
  console.log(
    `이미 찍힌 표시 ${already.length}건은 그대로 둔다: ${already.map((r) => `#${r.id}`).join(", ")}`,
  );

const fresh = found.filter((r) => !r.resolved_at);
const changed = resolveFeedback(
  fresh.map((r) => r.id),
  resolution,
  issueNo,
  kstStamp(),
);
const issueLine = issueNo ? ` 이슈 #${issueNo}` : " 이슈 없이";
console.log(
  `표시 ${changed}건에 ${RESOLUTION_NAME[resolution]}${issueLine}로 적었다.`,
);

if (fresh.length && !argv.includes("--no-slack")) await mirrorToSlack(fresh);
