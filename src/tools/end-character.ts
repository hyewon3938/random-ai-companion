// 캐릭터를 끝내는 도구 — 활성 캐릭터를 ended로 바꾸고 걸린 발송을 거두고 종료 게시를 쌓는다.
//
// 사용: docker exec random-ai-companion npx tsx src/tools/end-character.ts <chatId> [--yes]
//   기본은 무엇이 바뀌는지 세어만 본다 — --yes 없이는 DB를 건드리지 않는다.
//
// 상태만 바꾸고 대화 기록은 그대로 둔다. 대화방을 그대로 두고 새 캐릭터를 시작해도 읽는
// 함수가 캐릭터 번호로 거르므로(db/messages.ts), 앞 캐릭터의 대화가 섞이지 않는다.
// 슬랙에는 게시함 행만 쌓고, 내보내는 일은 봇의 1분 틱이 맡는다.
import {
  endCharacter,
  getActiveCharacter,
  getConfirmedFirsts,
  getStage,
  skipCharacterScheduledSends,
  supersedeCharacterPendingReplies,
  waitingPendingReplyCount,
  pendingScheduledSendCount,
} from "../db.js";
import { alwaysIncluded, identityValue } from "../memory.js";
import { RELATIONSHIP_STAGE_NAME } from "../labels.js";
import { kstDateString } from "../kst.js";
import { recordTraceEvent } from "../trace.js";

const argv = process.argv.slice(2);
const apply = argv.includes("--yes");
const chatId = argv.find((a) => !a.startsWith("--"));
if (!chatId) {
  console.error("사용: npx tsx src/tools/end-character.ts <chatId> [--yes]");
  process.exit(1);
}

const character = getActiveCharacter(chatId);
if (!character) {
  console.error(`대화방 ${chatId}에 활성 캐릭터가 없다`);
  process.exit(1);
}

// 함께한 날은 만든 날을 1일째로 센다 — 시각까지 재면 마지막 날이 반나절일 때 하루가 빈다.
const daysTogether = (createdAt: string, today: string): number =>
  Math.floor(
    (Date.parse(`${today}T00:00:00Z`) -
      Date.parse(`${createdAt.slice(0, 10)}T00:00:00Z`)) /
      86400000,
  ) + 1;

// 이름 값은 정체성 기억에 문장으로 적혀 있다(정태오라는 이름을 쓴다처럼). 이름만 잘라내려
// 들면 값의 꼴을 짐작해야 해서, 적힌 그대로 한 줄로 보여준다.
const name = identityValue(alwaysIncluded(character.id), "기본", "이름") ?? "";
const stage = getStage(character.id);
const stageLine = stage
  ? `${stage.stage_no}단계 ${RELATIONSHIP_STAGE_NAME[stage.stage_no]}(${stage.stage_since.slice(0, 10)}부터)`
  : "단계 없음";
const days = daysTogether(character.created_at, kstDateString());
const firsts = getConfirmedFirsts(character.id).length;
const waiting = waitingPendingReplyCount(character.id);
const scheduled = pendingScheduledSendCount(character.id);

console.log(`캐릭터 #${character.id} — 대화방 ${chatId}`);
if (name) console.log(`  이름: ${name}`);
console.log(`  함께한 날: ${days}일 (${character.created_at.slice(0, 10)}부터)`);
console.log(`  마지막 단계: ${stageLine}`);
console.log(`  확정된 처음: ${firsts}개`);
console.log(`  거둘 것: 대기 답장 ${waiting}건 · 예약 선톡 ${scheduled}건`);

if (!apply) {
  console.log("\n세어만 봤다. 실제로 끝내려면 --yes 를 붙인다.");
  process.exit(0);
}

// 상태를 바꾸기 전에 걸린 행부터 거둔다. 순서가 반대면 그 사이에 돌아온 발송 틱이 이미 끝난
// 캐릭터의 답장을 내보낸다.
const superseded = supersedeCharacterPendingReplies(character.id);
const skipped = skipCharacterScheduledSends(character.id, "캐릭터 종료");
const ended = endCharacter(character.id);

recordTraceEvent({
  characterId: character.id,
  kind: "character_end",
  dedupeKey: `character_end:${character.id}`,
  text: [
    `:door: 캐릭터 종료 — 캐릭터 #${character.id}`,
    name ? `이름: ${name}` : "",
    `함께한 날 ${days}일 · 마지막 ${stageLine} · 확정된 처음 ${firsts}개`,
    `거둔 것: 대기 답장 ${superseded}건 · 예약 선톡 ${skipped}건`,
  ]
    .filter(Boolean)
    .join("\n"),
});

console.log(
  `\n끝냈다: ${ended ? "ended" : "이미 ended였다"} · 대기 답장 ${superseded}건 · 예약 선톡 ${skipped}건 거둠`,
);
console.log("종료 게시는 게시함에 쌓았다 — 봇의 1분 틱이 슬랙으로 내보낸다.");
