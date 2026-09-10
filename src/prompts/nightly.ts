// 새벽 정리가 모델에 넘기는 문안 — 일기·기억 정리·진행 반영 프롬프트와 선톡 상황 문단을 한 파일에 둔다.
//
// 순서 코드(수집·반영·발송 시각 계산·runNightly)는 nightly.ts에 있고, 여기는 수집 결과
// NightlyGathered를 받아 글자만 만든다. 4번 영역의 prompts/reply.ts와 같은 꼴로 나눠 둬서,
// 문안만 고친 커밋의 diff가 순서 코드와 섞이지 않는다(#298).
//
// 관계 절(relationSection)은 수집이 센 단계·문턱 조건·처음 후보·시도할 수 후보를 기억 정리
// 프롬프트에 적어 모델이 다시 세지 않게 하고, 아침 선톡 상황 문단은 그날의 관계 의도
// (MorningIntent)를 받아 intentSummary가 만든 한 줄을 엮을 후보에 넣는다(#355).
//
// 봇 밖의 외부 스케줄러 지시서가 같은 일을 자체 지능으로 하므로, 여기 규칙을 고치면 그
// 지시서의 규칙도 함께 맞춘다.
import type { NightlyGathered } from "../nightly.js";
import { DIARY_TAG_MAX } from "../thresholds.js";
import {
  FIRST_BY_NAME,
  FIRST_KIND_NAME,
  LEAD_TONE_NAME,
  MOVE_NAME,
  MOVE_REACTION_NAME,
  type LeadTone,
} from "../labels.js";
import type { NightlyRelation } from "../relationship-stage.js";

// 삶의 흐름(아크) 줄들 — 일기 프롬프트와 아크 이어쓰기가 같은 모양으로 쓴다.
export const arcLinesOf = (g: NightlyGathered): string =>
  Object.entries(g.arcs)
    .map(([h, c]) => `${h}: ${c}`)
    .join("\n");

export const DIARY_SYSTEM = `너는 주어진 인물 그 자체다. 하루를 마치고 혼자 일기를 쓴다. 담백하고 사적인 1인칭 문장으로, 과장 없이.`;

export const diaryPrompt = (g: NightlyGathered): string => `너는 이 인물이다.

[정체성]
${g.identity || "(없음)"}

[삶의 흐름]
${arcLinesOf(g) || "(없음)"}

[상대와의 관계]
${g.relationship || "(이제 막 시작한 사이)"}

[상대의 오늘 상태 — 답장이 판정해 둔 마지막 값]
${g.userState || "(없음)"}

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

export const quietDayPrompt = (g: NightlyGathered): string => `너는 이 인물이다.

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
{"diary":"혼자 보낸 하루의 일기. 1인칭, 3~6문장. 대화가 없었던 날이면 그게 어땠는지도 네 성격대로 솔직하게","plan_vs_actual":"—","user_mood":"—","closeness":"—","tomorrow":[],"tags":["이 하루를 나중에 다시 꺼낼 주제 태그 2~${DIARY_TAG_MAX}개"]}

tags 규칙: 한 일·간 곳·만난 사람 이름을 낱말로 적는다. [이미 쓰는 태그]에 같은 뜻이 있으면 그 표기를 그대로 쓰고, 명사 한 덩어리로 짧게 쓴다.`;

// 기억과 일정이 같은 어휘로 묶이도록 태그 규칙은 한 문장을 두 자리에 쓴다 — 규칙이 갈라지면
// 같은 주제가 다른 낱말로 적혀 함께 찾아지지 않는다.
const TAG_RULE = `내용과 관련된 말을 넉넉히 붙인다. 사람 이름은 반드시 태그로. [이미 쓰는 태그]에 같은 뜻이 있으면 그 표기를 재사용한다.`;

export const PROGRESS_SYSTEM = `너는 캐릭터가 며칠에 걸쳐 하는 일이 어제 얼마나 나아갔는지 적는 정리자다. 어제 각본에 그 일을 하는 시간이 있었고 실제로 그대로 지냈으면 한 걸음만 옮긴다. 지어내지 말고 그 일의 결에 맞는 만큼만 적는다.`;

// 진행 반영 프롬프트. 어제 각본에 들어간 일마다 지금 값·끝나는 조건·실제 기록을 넘기고
// 새 값을 받는다. 어제 대화가 있으면 같이 넘긴다 — 대화에서 이미 어디까지 갔다고 말했으면
// 그 말과 어긋난 값을 적지 않게.
export const progressPrompt = (
  g: NightlyGathered,
): string => `[어제 각본에 들어간 진행 중인 일 — [번호] 영역/무엇: 지금 값 (끝나는 조건) — 어제 각본: 시각 활동 → 각본대로 / 달라짐]
${g.ongoingTouched.join("\n")}
${g.convo ? `\n[어제 대화 — ${g.diaryDate}]\n${g.convo}\n` : ""}
규칙:
- 각본대로 지낸 블록마다 그 일을 한 걸음만 옮긴다. 책이면 몇 장 더, 준비하는 일이면 그 다음 단계. 며칠치를 한 번에 옮기지 않는다.
- 새 값은 한두 문장으로, 앞 값에 있던 구체(제목·상대·수치)는 그대로 둔다. 어디까지 왔는지가 드러나게 쓴다.
- "달라짐"으로 취소되거나 미뤄진 블록은 그날 몫이 없던 것이다. 그 일은 목록에 넣지 않는다.
- 어제 대화에서 그 일을 어디까지 했다고 말했으면 그 말과 어긋나지 않게 적는다.
- 끝나는 조건이 채워졌으면 done을 true로 하고, value에는 끝난 상태(${g.diaryDate}에 끝났다는 것과 무엇으로 끝났는지)를 적는다. 그렇지 않으면 done은 false.
- 옮길 것이 없으면 빈 배열을 준다.

출력(JSON만):
{"progress":[{"id":61,"value":"새 값 한두 문장","done":false}]}`;

export const EXTRACT_SYSTEM = `너는 캐릭터의 하루에서 다음 대화에 필요한 기억을 정리하는 정리자다. 대화에 나온 확실한 사실만 담고, 남길 것이 없으면 빈 배열을 준다.`;

const monthDay = (date: string): string =>
  `${+date.slice(5, 7)}/${+date.slice(8, 10)}`;

const LEAD_TONE_CODES = (Object.keys(LEAD_TONE_NAME) as LeadTone[])
  .map((k) => `${k}=${LEAD_TONE_NAME[k]}`)
  .join(" · ");

/** 오늘의 의도 4줄을 한 줄로. 없는 줄은 뺀다. 선톡 상황 문단과 어제 의도 줄이 같이 쓴다. */
export const intentSummary = (i: MorningIntent | null | undefined): string => {
  if (!i) return "";
  const parts: string[] = [];
  if (i.dig) parts.push(`파고들 것: ${i.dig}`);
  if (i.share) parts.push(`흘릴 내 얘기: ${i.share}`);
  const move =
    i.move && Object.hasOwn(MOVE_NAME, i.move)
      ? MOVE_NAME[i.move as keyof typeof MOVE_NAME]
      : null;
  const tone =
    i.lead_tone && Object.hasOwn(LEAD_TONE_NAME, i.lead_tone)
      ? LEAD_TONE_NAME[i.lead_tone as LeadTone]
      : null;
  if (move || i.move_note)
    parts.push(
      `시도할 수: ${[move, i.move_note].filter(Boolean).join(" ")}${tone ? `, 앞세울 결은 ${tone}` : ""}`,
    );
  if (i.thread) parts.push(`이어갈 자리: ${i.thread}`);
  return parts.join(" / ");
};

/** 기억 정리 프롬프트의 관계 단계 절 — 코드가 센 값과 모델이 고를 목록. 줄 앞의 영문은 출력
 * 규칙이 가리키는 이름이다. */
export const relationSection = (r: NightlyRelation): string => {
  const t = r.threshold;
  const conditions = t.conditions
    .map(
      (c) =>
        `${c.name} ${c.value === null ? "표본 없음" : typeof c.value === "boolean" ? (c.value ? "있음" : "없음") : c.value}/${typeof c.need === "boolean" ? "있음" : c.need} ${c.met ? "찼음" : "안 찼음"}`,
    )
    .join(", ");
  const threshold =
    t.to === null
      ? "마지막 단계라 다음 문턱이 없다"
      : `${t.from}→${t.to}, ${t.met ? "찼음" : "안 찼음"} — ${conditions}`;
  const lines = [
    `- stage_no·stage_since·stay_days: ${r.stageNo}단계, ${r.stageSince}부터 ${r.stayDays}일 지남`,
    `- threshold_met(다음 단계 문턱): ${threshold}`,
    `- firsts_done(이미 한 처음): ${
      r.firstsDone
        .map(
          (f) =>
            `${FIRST_KIND_NAME[f.kind]}(${FIRST_BY_NAME[f.by]}, ${monthDay(f.date)})`,
        )
        .join(" · ") || "(없음)"
    }`,
    `- firsts_open(이 단계까지 열렸는데 아직 안 한 처음, 코드=이름): ${
      r.firstsOpen.map((k) => `${k}=${FIRST_KIND_NAME[k]}`).join(" · ") ||
      "(없음)"
    }`,
    `- firsts_pending(어제 답장이 표시한 처음 후보, 코드=이름): ${
      r.firstsPending
        .map(
          (f) =>
            `${f.kind}=${FIRST_KIND_NAME[f.kind]}(${FIRST_BY_NAME[f.by]}, ${f.happenedAt.slice(11, 16)})`,
        )
        .join(" · ") || "(없음)"
    }`,
    `- move_candidates(시도할 수 추천, 앞이 우선, 코드=이름): ${
      r.moveCandidates.map((m) => `${m}=${MOVE_NAME[m]}`).join(" · ") ||
      "(없음)"
    }`,
    `- rapport_moves(잘 통하는 수): ${r.rapportMoves.map((m) => MOVE_NAME[m]).join(" · ") || "(아직 없음)"}`,
    `- yesterday_moves(어제 쓴 수 → 상대 반응): ${
      r.yesterdayMoves
        .map(
          (m) =>
            `${MOVE_NAME[m.move]} → ${m.reaction ? MOVE_REACTION_NAME[m.reaction] : "판정 없음"}`,
        )
        .join(" · ") || "(없음)"
    }`,
    `- yesterday_intent(어제 의도): ${intentSummary(r.yesterdayIntent) || "(없음)"}`,
    `- confession_due(고백 차례): ${r.confessionDue ? "예 — 오늘 의도에 마음을 확인하는 말을 넣는다" : "아니오"}`,
    `- 결 코드: ${LEAD_TONE_CODES}`,
  ];
  return lines.join("\n");
};

export const extractPrompt = (g: NightlyGathered): string => {
  const keyLines = g.existingKeys
    .map((k) => `- ${k.itemType} ${k.owner} ${k.key}`)
    .join("\n");
  return `기준 날짜: ${g.diaryDate}. '나' = 캐릭터(owner "char"), '상대' = 유저(owner "user").

[나의 정체성 — 이미 아는 것]
${g.identity || "(없음)"}

[이미 아는 주변 인물 — 줄 끝의 [상대가 앎]·[상대는 모름]은 '나'(char) 쪽 사실을 상대가 아는지의 지금 값]
${g.people || "(없음)"}

[진행 중인 일 — 줄 끝 표시는 위와 같다]
${g.ongoing || "(없음)"}

[상대에 대해 이미 아는 것 — 오늘 대화와 겹치는 키의 지금 값]
${g.touchedUserFacts.join("\n") || "(없음)"}

[상대와의 관계 — 지금 값]
${g.relationship || "(이제 막 시작한 사이)"}

[관계 단계 — 코드가 센 값]
${relationSection(g.relation)}

[상대의 오늘 상태 — 답장이 판정해 둔 마지막 값]
${g.userState || "(없음)"}

[상대 프로필 — 지금 값]
${g.userProfile}

[이미 있는 키 — 같은 주제는 반드시 이 키를 그대로 다시 쓴다 (항목 owner 영역/무엇)]
${keyLines || "(없음)"}

[영역 이름 목록]
${g.areas.join(", ") || "(없음)"}

[이미 쓰는 태그]
${g.tagNames.join(", ") || "(없음)"}

[이미 저장된 일정 — 같은 일이면 다시 적지 않는다. 줄 끝 표시는 내 일정을 상대가 아는지의 지금 값]
${g.existingSchedules.join("\n") || "(없음)"}

[오늘의 대화]
${g.convo}

[오늘 메모 — 대화하며 적어 둔 남길 것]
${g.todayNotes.join("\n") || "(없음)"}

[각본과 달라진 것]
${g.dayActuals.join("\n") || "(없음)"}

JSON으로:
{"memories":[{"item_type":"fact|ongoing|person","owner":"char|user","area":"영역","subject":"무엇","value":"사실 한두 문장","tags":["관련어"],"user_knows":"known|unknown — '나'(char) 쪽만","relation":"person만 — 어떤 사이","contact_mode":"person만 — 만나는 결(직장에서 매일, 가끔 연락 등)","region":"person만 — 어디 사람인지","end_condition":"ongoing만 — 끝났다고 볼 조건","interest":"high|medium|low — '나' 쪽 기억에 상대의 관심이 뚜렷할 때만"}],"relationship":{"speech_note":"상대에게 쓰는 말투","rapport":"잘 통하는 것","cautions":"조심할 것","history":"지나온 이야기","feelings":"지금 마음"},"user_profile":{"job":"상대가 하는 일","region":"상대가 사는 지역"},"schedules":[{"who":"user 또는 char","date":"YYYY-MM-DD","time_hint":"오전/저녁/14:00 등 또는 null","content":"무슨 일정인지","tags":["관련어"],"user_knows":"known|unknown — 내(char) 일정만"}],"schedule_updates":[{"id":0,"time_hint":"14:30","user_knows":"known"}],"relation":{"advance":{"go":true,"basis":"근거 한 줄"}|null,"firsts":[{"kind":"처음 코드","keep":true},{"kind":"처음 코드","by":"user","keep":true}],"intent":{"dig":"파고들 것","share":"흘릴 내 얘기","move":"수 코드","move_note":"어떤 자리에서 어떻게","lead_tone":"결 코드","thread":"이어갈 자리","basis":{"dig":"출처"}}}}

memories 규칙:
- 남길 것 = 다음에 대화할 때 알고 있어야 자연스러운 사실만. 잡담 전부가 아니라 이어질 것만.
- item_type: 그때그때의 사실=fact / 끝나는 조건이 있는 일=ongoing / 사람=person.
- 키 = 영역/무엇. 영역은 위 [영역 이름 목록]에서 고르고, 꼭 맞는 게 없을 때만 새로 만든다(12자 이내). '무엇'은 명사 한 덩어리 20자 이내. 두 자리 모두 슬래시·세로줄·쉼표·가운뎃점 금지.
- 같은 주제가 [이미 있는 키]에 있으면 반드시 그 키를 그대로 쓴다. 같은 키에 쓰면 값이 통째로 갈아 끼워지니, 다시 쓸 때는 위에 적힌 앞 값에 있던 원인 추정·장소·이름·숫자 같은 세부를 그대로 두고 이번에 새로 안 것을 합쳐 쓴다. 앞 값과 모순되는 부분만 새 값으로 바꾼다. 이미 아는 내용과 같은 것은 다시 넣지 않는다.
- 합친 값이 길어지면 지나간 상태와 되풀이된 감상부터 줄이고, 원인·장소·이름·숫자처럼 한 번 지우면 되찾을 수 없는 것은 남긴다. 값은 두 문장 안에 둔다.
- 한 번 있었던 일은 날짜를 붙인 사건으로 적는다(예: ${g.diaryDate} 저녁에 야근했다). 평소 그렇다는 성향 문장은 같은 모습이 앞 값에도 있어 여러 번 나왔을 때만 쓴다.
- 값에는 사실만 적고, 그날 대화에서 누가 무엇을 묻고 어떻게 답했는지 같은 장면은 넣지 않는다. 그런 장면은 일기의 몫이다.
- person: 영역=갈래(가족·직장·친구 등), 무엇=이름(모르면 호칭 그대로). 상대가 흘리듯 언급한 상대 쪽 사람도 빠뜨리지 않는다. 이미 아는 인물은 내용이 달라졌을 때만 같은 키로 다시 쓴다.
- "~라고 불러줘" 같은 지시·부탁은 사실 문장으로 바꿔 저장한다 (예: 상대는 OO라고 불리는 걸 좋아한다).
- tags: ${TAG_RULE}
- user_knows: '나'(char) 쪽 기억에만 — 이 사실을 상대가 아는가. 위 재료 줄 끝의 표시가 지금 값이고, 오늘 대화에서 내가 상대에게 말한 것만 known으로 바꾼다. 상대가 이미 알던 것은 그 줄의 지금 값을 그대로 다시 적는다. 한 번 known이 된 것은 다시 unknown으로 되돌리지 않는다 — 이미 말한 일을 다음에 처음 꺼내는 것처럼 말하게 된다. 오늘 말하지 않은 일을 짐작으로 known으로 바꾸지 않는다.

relationship 규칙: 이 하루로 실제 달라진 항목만 넣는다 (넣은 항목만 갱신되고, 나머지는 그대로 남는다). 각 항목은 짧은 서술로. 지금 어떤 사이인지·서로 부르는 말·존댓말과 반말은 대화하는 자리에서 이미 갱신되니 여기서 건드리지 않는다. [상대의 오늘 상태]는 이 정리가 끝나면 비워지니, 내일도 알고 있어야 할 것이면 feelings나 cautions에 녹여 적는다 — 나 때문에 안 좋았던 상태는 무엇 때문이었는지가 남게. 달라진 게 없으면 relationship은 null. 잘 통하는 것(rapport)에는 [관계 단계]의 rapport_moves 가운데 지금 값에 아직 없는 것만 말로 옮겨 넣는다 — 숫자와 코드는 적지 않고, 이미 적힌 것을 다시 넣지 않는다.
user_profile 규칙:
- 상대가 하는 일·사는 지역이 대화에서 분명히 드러났을 때만 넣는다. 어림짐작으로 채우지 않고, 확실하지 않으면 비워 둔다.
- 위 [상대 프로필 — 지금 값]에 이미 있는 값과 같으면 넣지 않는다. 두 값 다 그대로면 user_profile은 null.
- 값은 짧게 — 하는 일은 직업 한 덩어리(예: 중학교 교사), 사는 지역은 시·구 정도(예: 서울 마포구). 문장으로 쓰지 않는다.
- 여기 넣은 값은 프롬프트에 늘 들어간다. 같은 내용을 memories에 또 넣지 않고, 이야기가 붙는 것(회사를 옮긴 사정, 동네에서 자주 가는 곳 같은)만 memories로 남긴다.
schedules 규칙:
- 기준 날짜로 환산 가능한 날짜만. 위 정체성의 직업·생활과 어긋나는 날짜면 제외한다.
- 위 [이미 저장된 일정]에 같은 일이 있으면 넣지 않는다. 말이 조금 다르게 적혀 있어도
  같은 날 같은 약속을 가리키면 같은 일이다 — 시간이나 사람 이름이 이번에 더 나왔다고
  해서 새로 적지 않는다. 그 줄은 이미 있는 것으로 두고 넘어간다. 시각이 이번에 정해진
  것이면 아래 schedule_updates로 그 줄을 고친다.
- 새 일정으로 넣는 것은 [이미 저장된 일정]에 없는 일만이다.
- user_knows: 내(char) 일정에만. 오늘 대화에서 내가 상대에게 말한 일정이면 "known", 아니면 "unknown". 상대 쪽 일정에는 넣지 않는다.
- tags: ${TAG_RULE}
schedule_updates 규칙:
- [이미 저장된 일정]에 있는 줄의 시각이 이번 대화에서 정해졌으면 그 줄 앞 [번호]와 정해진 시각을 넣는다. 오후라고만 적혀 있던 줄에 두 시 반이라는 말이 오간 자리가 이 경우다.
- [상대는 모름]으로 적힌 내 일정을 오늘 대화에서 상대에게 말했으면 그 줄 앞 [번호]와 "user_knows":"known"을 넣는다. 다음 주에 발표가 있다고 내가 알린 자리가 이 경우다. 상대가 물어서 답한 것도 말한 것이다.
- 고치는 것은 이 둘뿐이다. 날짜·내용·주인이 달라졌으면 여기 넣지 않는다.
- 두 값은 따로 온다. 시각만 정해졌으면 time_hint만, 말하기만 했으면 user_knows만 넣고, 둘 다면 한 줄에 함께 넣는다.
- 이미 적힌 시각과 같거나 대화에서 시각이 안 나온 줄에는 time_hint를 넣지 않는다. 이미 [상대가 앎]인 줄에는 user_knows를 넣지 않는다. 고칠 줄이 없으면 빈 배열.
- time_hint는 14:30처럼 시각으로 적을 수 있으면 시각으로, 아니면 대화에 나온 말 그대로 적는다.
relation 규칙 — [관계 단계]를 읽고 적는다. 값은 코드가 센 것이라 다시 세지 않는다:
- advance: threshold_met가 찼음일 때만 넣는다. 오늘의 대화에서 상대가 다음 단계의 관계로 읽히면 go를 true로 하고 basis에 근거 한 줄을 적는다. 확신이 없으면 false. 조건이 찼다고 자동으로 넘기지 않는다. 3단계는 마음 확인 사건이 조건이라 문턱이 찼으면 넘긴다. 문턱이 안 찼거나 마지막 단계면 advance는 null.
- firsts: firsts_pending마다 {"kind","keep"}. 오늘의 대화를 읽어 그 말이 실제로 그 처음이었으면 true, 아니면 false. 상대가 먼저 한 처음(상대가 먼저 별명을 붙이거나 보고 싶다고 하거나 마음을 말한 것)은 firsts_open 가운데서 {"kind","by":"user","keep":true}로 더한다. 후보도 더할 것도 없으면 빈 배열. 적지 않은 후보는 확정된 것으로 처리된다.
- intent: 오늘 하루 상대와의 관계에서 하려는 것. 줄마다 60자 안 한 문장이고 없으면 null이다. 4줄이 다 없으면 intent는 null.
  · dig: 오늘의 대화에서 더 물어볼 만한 상대 얘기 하나. 상대가 스스로 연 얘기를 고른다.
  · share: 오늘 흘릴 내 얘기 하나 — 정체성·진행 중인 일·주변 인물에서 상대가 아직 모르는 것.
  · move: move_candidates에서 고르되 앞을 우선하고, 오늘의 대화 흐름에 맞지 않으면 다음 것. 코드로 적는다. move_note는 그 수를 어떤 자리에서 어떻게 쓸지 한 마디.
  · confession_due가 예면 move는 null로 두고 move_note에 마음을 확인하는 말을 어떤 자리에서 꺼낼지 적는다.
  · lead_tone: [나의 정체성]의 원하는 방식에 적힌 결 가운데 하나를 결 코드로. 오늘의 대화에서 상대가 다른 사람 얘기를 했으면 은근히 독점, 힘든 일을 말했으면 말없이 챙김, 둘 다 없으면 주 결이다. 정체성에 없는 결은 고르지 않는다.
  · thread: 오늘의 대화에서 끝나지 않은 이야기 가운데 내일 이어갈 자리 하나.
  · basis: 줄 이름마다 어디서 왔는지 짧게. 예: {"dig":"21:10 러닝 얘기","move":"추천 맨 앞"}.
- 단계를 내리거나 두 단계를 한 번에 올리는 출력은 반영되지 않는다.`;
};

// ── 선톡 문안 — 대화와 같은 3층 프롬프트(buildSystemBlocks)에 상황 문단만 얹는다 ──
// 앞 두 층이 대화와 같아야 캐시가 붙는다. 문안은 새벽에 미리 쓰지만 나가는 건 아침·저녁이라,
// 실시간 꼬리의 '지금' 시각이 아니라 보내는 시점의 결로 쓰라고 상황 문단이 못박는다.

/** 선톡 상황 문단이 받는 오늘의 관계 의도. 새벽 정리 출력의 intent와 저장된 의도 행이 둘 다 이
 * 모양에 맞는다. */
export interface MorningIntent {
  dig?: string | null;
  share?: string | null;
  move?: string | null;
  move_note?: string | null;
  lead_tone?: string | null;
  thread?: string | null;
}

export const morningSituation = (
  g: NightlyGathered,
  moment: string,
  tomorrow: string[],
  intent: MorningIntent | null = null,
): string =>
  [
    `[문안 준비 — 오늘 상대에게 먼저 보낼 한 통]`,
    `이 문안은 지금(새벽) 미리 써 두고 아래 '보내는 시점'에 나간다. 위의 '지금' 시각이 아니라 그 시점의 상황에서 쓰는 말이어야 한다.`,
    `- 보내는 시점: ${moment}`,
    `- 어제에서 이어갈 것: ${tomorrow.length ? tomorrow.join(" / ") : "(없음)"}`,
    `- 상대의 다가오는 일정(들은 것): ${g.userSchedulesUpcoming || "(없음)"}`,
    `- 오늘의 관계 의도: ${intentSummary(intent) || "(없음)"}`,
    ``,
    `문안 규칙:`,
    `- 아침이면 웬만하면 보낸다. 네 하루가 시작됐다는 걸 가볍게 알리는 결 — '보내는 시점' 그대로의 상황에서 쓰는 말이어야 한다. 자기 삶 공유는 그 자체로 근거다.`,
    `- 각본상 오늘 유난히 일찍 깼거나 늦잠이면 그 결을 자연스럽게 반영한다.`,
    ...(g.lastNight
      ? [
          `- 어젯밤 ${g.lastNight.bedtime}에 잠들었다. 각본의 기상 시각이 ${g.lastNight.enoughSleepFrom}보다 이르면 잠이 모자라 피곤한 아침이고, 그 이후면 늦게 잤어도 충분히 잔 것이라 피곤한 티를 내지 않는다.`,
          `- 피곤한 아침이면 눈이 잘 안 떠진다는 정도로 상태만 적고, 왜 늦게 잤는지는 이 한 통에 적지 않는다. 상대가 물으면 그때 답할 자리다.`,
          `- 늦게 잔 까닭을 상대와 엮지 않는다. 어젯밤 대화가 늦게까지 이어졌더라도 그것 때문에 아침이 힘들다는 말은 상대를 미안하게 만든다.`,
        ]
      : []),
    `- 이어갈 것, 상대의 일정, 관계 의도의 이어갈 자리나 파고들 것 가운데 하나만 자연스럽게 엮는다. 특히 상대의 일정이 오늘이면 그걸 챙기는 게 우선이다.`,
    `- 관계 의도의 흘릴 내 얘기와 시도할 수는 낮 대화의 몫이라 이 한 통에서 하지 않는다. 앞세울 결이 있으면 이 한 통의 결도 그쪽이다.`,
    `- 한 통에 하나만. 캐묻지 않는다. 용건 없는 애정 표시성 핑은 금지. 1~3개 말풍선(줄바꿈 구분).`,
    `- 상대 일정이 점심·저녁에 있으면 window를 "점심"/"저녁"으로 바꿔도 된다(그 외엔 "아침").`,
    `- 아주 가끔은(그날 각본이 유난히 정신없으면) 건너뛰어도 사람답다 → send=false.`,
    ``,
    `JSON으로만 답한다: {"send":true,"window":"아침|점심|저녁","text":"..."} 또는 {"send":false}`,
  ].join("\n");

// 오래 답이 없는 중에도 상대에게 오늘 일정이 있는 날 — 그 일정만 챙기는 한 통.
export const careSituation = (g: NightlyGathered): string =>
  [
    `[문안 준비 — 오늘 아침에 보낼 한 통]`,
    `상대와 연락이 오간 지 ${g.silenceDays}일쯤 됐다. 평소라면 먼저 말을 걸지 않지만, 오늘은 상대가 말해 둔 일정이 있어 그것만 챙기는 한 통을 보낸다. 지금(새벽) 미리 써 두고 아침에 나가니 아침의 결로 쓴다.`,
    `- 상대의 일정(들은 것): ${g.userSchedulesUpcoming || "(없음)"}`,
    ``,
    `문안 규칙:`,
    `- 오늘 있는 그 일정 하나만 짧게 챙긴다. 잘되길 바란다는 정도.`,
    `- 그동안 연락이 없던 걸 따지지 않는다. 안부 캐묻기·근황 요구 금지.`,
    `- 1~2개 말풍선(줄바꿈 구분).`,
    ``,
    `JSON으로만 답한다: {"send":true,"text":"..."} 또는 {"send":false}`,
  ].join("\n");

export const reconnectSituation = (g: NightlyGathered): string =>
  [
    `[문안 준비 — 오늘 저녁에 보낼 안부 한 통]`,
    `상대와 마지막으로 연락이 오간 지 ${g.silenceDays}일쯤 됐다. 이 문안은 지금(새벽) 미리 써 두고 저녁에 나간다 — 저녁의 결로 쓴다.`,
    `- "요새 많이 바쁘지?" 같은, 근황을 가볍게 묻는 결. 네 근황 한 조각을 곁들여도 좋다.`,
    `- 재촉·"왜 연락 없어" 금지. 답장을 요구하는 압박 금지. 길게 쓰지 않는다.`,
    `- 1~2개 말풍선(줄바꿈 구분).`,
    ``,
    `JSON으로만 답한다: {"text":"..."}`,
  ].join("\n");
