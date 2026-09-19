// 관계 확인 도구 — 지금 캐릭터의 단계·다음 단계 조건·처음·반응 점수 위아래·오늘의 대화 계획을 한 화면에 찍는다.
//
// 읽기만 하고 모델은 부르지 않는다. 다음 단계 조건은 오늘 새벽 정리가 읽은 값과 같게
// gatherRelation(어제 일기 날짜, 오늘)로 다시 센다 — 단계 창이 오늘 05:00에서 끝나므로 오늘
// 나눈 대화는 내일 새벽 정리에 들어간다. 게시 줄의 꼴(처음 한 건, 점수, 조건, 계획 근거)은
// nightly-trace.ts의 도우미를 그대로 써서 슬랙 게시와 같은 모양으로 읽힌다.
//
// 사용: docker exec random-ai-companion npx tsx src/tools/relationship-status.ts
import {
  db,
  getConfirmedFirsts,
  getReactionScores,
  getRelationshipIntent,
  getUnconfirmedFirsts,
  type CharacterRow,
  type ReactionScoreRow,
} from "../db.js";
import { gatherRelation } from "../relationship-stage.js";
import { intentLines } from "../prompts/nightly.js";
import {
  conditionLines,
  firstLabel,
  planBasis,
  signed,
} from "../nightly-trace.js";
import {
  FIRST_KIND_NAME,
  MOVE_NAME,
  PLAN_LINE_NAME,
  RELATIONSHIP_STAGE_NAME,
} from "../labels.js";
import { kstLogicalDate, kstStamp, shiftDate } from "../kst.js";
import { dateLabel } from "../trace/format.js";

const c = db
  .prepare(
    `SELECT * FROM characters WHERE status = 'active' ORDER BY id DESC LIMIT 1`,
  )
  .get() as CharacterRow | undefined;
if (!c) {
  console.log("no active character");
  process.exit(0);
}

const today = kstLogicalDate();
const rel = gatherRelation(c.id, c.chat_id, shiftDate(today, -1), today);
const th = rel.threshold;

const scoreText = (r: ReactionScoreRow): string =>
  `${MOVE_NAME[r.move]} ${signed(r.score)} (표본 ${r.sample_count})`;

// 점수는 높은 순으로 온다. 위 3개와 아래 3개가 겹치면 아래에서 뺀다.
const scores = getReactionScores(c.chat_id);
const top = scores.slice(0, 3);
const bottom = scores.slice(Math.max(3, scores.length - 3)).reverse();

const confirmed = getConfirmedFirsts(c.id);
const pending = getUnconfirmedFirsts(c.id);
const intent = getRelationshipIntent(c.id, today);
const plan = intentLines(intent);
const basis = planBasis(intent?.basis_json);

const out: string[] = [
  `관계 확인 · 캐릭터 #${c.id} · ${kstStamp().slice(0, 16)} 기준`,
  "",
  `단계: ${rel.stageNo}단계 ${RELATIONSHIP_STAGE_NAME[rel.stageNo]} · ${dateLabel(rel.stageSince)}부터 · 머문 날 ${rel.stayDays}일`,
  th.to === null
    ? "다음 단계: 없음(마지막 단계)"
    : `다음 단계: ${th.to}단계 ${RELATIONSHIP_STAGE_NAME[th.to]} · 오늘 새벽 정리 기준 ${th.met ? "조건 다 찼음" : "아직"}`,
  ...conditionLines(th.conditions).map((l) => `  - ${l}`),
  "",
  `처음: 확정 ${confirmed.length}/${Object.keys(FIRST_KIND_NAME).length}`,
  ...confirmed.map((r) => `  - ${firstLabel(r)}`),
  ...(pending.length
    ? [`확인 전 ${pending.length}개`, ...pending.map((r) => `  - ${firstLabel(r)}`)]
    : []),
  "",
  scores.length ? `반응 점수: 플러팅 ${scores.length}개` : "반응 점수: 아직 없음",
  ...(top.length ? [`  위: ${top.map(scoreText).join(" · ")}`] : []),
  ...(bottom.length ? [`  아래: ${bottom.map(scoreText).join(" · ")}`] : []),
  "",
  plan.length
    ? `오늘의 대화 계획 · ${dateLabel(today)}`
    : `오늘의 대화 계획 · ${dateLabel(today)} · 저장된 계획 없음`,
  ...plan.flatMap(([k, v]) => [
    `  ${PLAN_LINE_NAME[k]}: ${v}`,
    ...(basis[k] ? [`    근거: ${basis[k]}`] : []),
  ]),
];

console.log(out.join("\n"));
