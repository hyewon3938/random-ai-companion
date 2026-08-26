import { chatJson } from "./llm.js";
import { config } from "./config.js";
import {
  db,
  getRelationshipState,
  saveRelationshipState,
  saveUserProfile,
  getCaptureMark,
  setCaptureMark,
} from "./db.js";
import { kstDateString, kstClock } from "./kst.js";

// 세션 중 가벼운 사실 포착 — 밤 정리(하루 1회)를 기다리지 않고, 유저 메시지가 일정 수 쌓이면
// 최근 대화에서 '안정적 사실'(직업·나이·사는 곳·중요한 관계 등 잘 안 바뀌는 것)만 뽑아 기억에 넣는다.
// 왜: 긴 세션에서 앞부분이 실시간 창(40개) 밖으로 밀려도, 또 다음 날로 넘어가기 전에도 핵심 사실이 남게.
// 답장 경로에서 비동기로 fire-and-forget 호출한다(응답 지연 없음). sonnet, 세션당 소수 콜.

// 유저 '턴'(연속 발화 묶음) 이만큼마다 한 번. 밤 정리 추출과 이중 경로라 얇게 유지한다 —
// 이 경로의 몫은 "긴 세션에서 실시간 창(40개) 밖으로 밀리기 전에 핵심만 미리 줍기"뿐이다.
const CAPTURE_EVERY = 15;

interface Captured {
  user_facts?: string[];
  user_profile?: { gender?: string; age_band?: string } | null;
}

const CAPTURE_SYSTEM = `너는 대화에서 '상대(유저)에 대한 안정적인 사실'만 뽑는 추출기다. 확실한 것만, 없으면 빈 값을 준다. 지어내지 않는다.`;

const capturePrompt = (convo: string, known: string): string =>
  `아래는 최근 대화다('상대'=유저, '나'=캐릭터). 상대에 대해 새로 확실해진 '안정적 사실'만 뽑아라 — 직업·나이·사는 곳·중요한 관계·처한 상황처럼 잘 안 바뀌는 것. 취향·기분·오늘 일정 같은 일시적인 건 제외. 추측 금지, 애매하면 생략. 이미 아는 건 다시 넣지 마라.

[최근 대화]
${convo}

[이미 아는 상대 사실]
${known || "(없음)"}

JSON: {"user_facts":["새로 확실해진 안정적 사실 (짧게)"],"user_profile":{"gender":"여성|남성 — 대화로 확실할 때만","age_band":"예: 30대 초반 — 확실할 때만"}}`;

export const maybeCaptureFacts = async (
  characterId: number,
  chatId: string,
): Promise<void> => {
  const mark = getCaptureMark(chatId);
  const fresh = db
    .prepare(
      `SELECT id, role, text FROM messages WHERE chat_id = ? AND id > ? ORDER BY id`,
    )
    .all(chatId, mark) as { id: number; role: string; text: string }[];

  // 말풍선(전송) 개수가 아니라 유저 '턴' 수로 센다 — 분할 전송을 한 턴으로 묶어,
  // 몰아 보내든 한 개씩 보내든 같은 기준이 되게(char 발화 뒤 처음 오는 user = 새 턴).
  let userTurns = 0;
  let prevRole = "assistant";
  for (const m of fresh) {
    if (m.role === "user" && prevRole !== "user") userTurns++;
    prevRole = m.role;
  }
  if (userTurns < CAPTURE_EVERY) return; // 아직 덜 쌓임 — 값싼 조기 반환

  const lastId = fresh[fresh.length - 1]?.id ?? mark;
  const stamp = `${kstDateString()} ${kstClock()}:00`;

  try {
    const convo = fresh
      .slice(-40)
      .map(
        (m) =>
          `${m.role === "user" ? "상대" : "나"}: ${m.text.replace(/\n/g, " ")}`,
      )
      .join("\n");
    const state = getRelationshipState(characterId);
    const known = state.user_facts.map((f) => f.fact).join(" / ");

    const out = await chatJson<Captured>(
      CAPTURE_SYSTEM,
      capturePrompt(convo, known),
      400,
      config.model,
    );

    let added = 0;
    for (const f of out.user_facts ?? []) {
      const t = f.trim();
      if (t && !state.user_facts.some((x) => x.fact === t)) {
        state.user_facts.push({ fact: t, learned_at: kstDateString() });
        added++;
      }
    }
    if (added) saveRelationshipState(characterId, state, stamp);
    if (out.user_profile)
      saveUserProfile(
        chatId,
        {
          gender: out.user_profile.gender,
          ageBand: out.user_profile.age_band,
        },
        stamp,
      );
    if (added || out.user_profile)
      console.log(`[capture] ${chatId} +${added} facts`);
  } catch (e) {
    console.error("[capture] error:", e);
  } finally {
    // 성공이든 실패든 이 배치는 시도했다 — 워터마크를 올려 같은 구간을 반복 추출하지 않는다.
    // (실패로 놓친 사실은 밤 정리가 어차피 다시 뽑는다.)
    setCaptureMark(chatId, lastId);
  }
};
