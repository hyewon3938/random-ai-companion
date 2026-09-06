# 코드 영역 지도

코드를 고칠 때 어느 파일을 열어야 하고 그 변경이 어디까지 번지는지 답하는 문서다. 실행 시점 순서로 모듈을 훑는 그림은 [modules.md](modules.md)에, 표와 컬럼의 뜻은 [erd.md](erd.md)에 있고, 이 문서는 그 둘과 축이 다르다. `src/` 아래 파일을 같이 바뀌는 정도와 의존 방향을 기준으로 영역 7개로 묶고, 영역마다 어떤 변경이 여기로 오는지, 고치면 같이 봐야 할 자리가 어디인지, 지금 보이는 손볼 자리가 무엇인지 적는다.

영역을 나눈 근거는 세 가지다. 파일끼리 import하는 방향, 2026-08-01 이후 커밋에서 같이 바뀐 횟수, 그리고 파일 하나 안에서 책임이 갈리는 자리다. 영역은 폴더가 아니라 이 문서의 표로만 존재하며, 파일을 나누는 작업이 생길 때 그 영역 이름의 폴더를 만든다. 영역을 이렇게 정한 판단은 [ADR-0013](docs/adr/0013-code-areas.md)에 있다.

## 영역 7개

파일 열에는 `src/` 아래 경로를 확장자 없이 적고, 폴더 전체는 `tools/*`처럼 적는다. 앞 영역에 이름으로 적은 파일이 우선이고, 남은 파일이 폴더 패턴으로 간다. `scripts/gen-modules.mjs`가 이 표를 읽으므로 열의 꼴을 지킨다.

| 영역 | 여기로 오는 변경 | 파일 |
| --- | --- | --- |
| 1. 기반과 저장 | 기준값·이름표·시각 계산, 표와 컬럼, 모델 호출 방식 | config, kst, labels, thresholds, db, llm |
| 2. 기억 | 무엇을 저장하고 무엇을 꺼내 쓰는지 | memory, recall, tag-pick, user-profile |
| 3. 캐릭터의 삶 | 캐릭터 생성, 삶의 큰 흐름, 월 리듬, 하루 각본, 일정 | character, arcs, life-plan, day-plan, schedule-dedupe |
| 4. 대화 생성 | 무슨 말을 어떤 텀으로 하는지, 오늘 먼저 말을 걸어도 되는지 | context, prompts/reply, turns, reply-signal, reply-ask, relationship-update, reply-timing, proactive-policy |
| 5. 실행과 발송 | 텔레그램과 주고받기, 예약 발송, 선톡 틱 3개, 크론표 | index, bot, pending, presence, followup, dispatch |
| 6. 새벽 정리 | 하루를 닫는 배치 전부 | nightly, nightly-trace, tools/nightly-read, tools/nightly-write, tools/run-nightly |
| 7. 관측과 운영 | 슬랙 게시, 피드백 수집, 손으로 돌리는 도구, 평가, 테스트, CI | trace, reply-trace, feedback, tools/*, eval/* |

7번에는 `src/` 밖의 `test/`·`scripts/`·`.github/`도 들어간다. 4번에 reply-timing과 proactive-policy를 넣은 이유는 둘 다 보낼지와 언제 보낼지를 정하는 판단이고 실제로 보내는 코드가 아니어서다. 이렇게 두면 5번과 6번이 4번을 같이 쓰면서 서로는 import하지 않는다.

## 파일 색인

<!-- modules:start -->

> 이 색인은 `node scripts/gen-modules.mjs`가 위 영역 표와 각 파일 맨 위 주석의 첫 줄에서 만든다. 손으로 고치지 않는다. 줄 수는 영역에 든 파일의 합이다.

### 1. 기반과 저장 · 3,599줄

- `src/config.ts` — 환경변수를 한 번 읽어 두는 자리.
- `src/kst.ts` — 시각을 다루는 자리 — 한국 시간과 논리일 경계.
- `src/labels.ts` — 닫힌 목록의 값 이름표.
- `src/thresholds.ts` — 숫자로 관리하는 기준값.
- `src/db.ts` — SQLite 연결과 스키마.
- `src/llm.ts` — 모델을 부르는 자리.

### 2. 기억 · 766줄

- `src/memory.ts` — 기억을 저장하고 찾는 자리.
- `src/recall.ts` — 태그로 찾은 것 중 무엇을 프롬프트에 넣을지 고르고, 넣을 줄을 만드는 자리.
- `src/tag-pick.ts` — 이번 발화로 무엇을 검색할지 주제 태그를 고르는 자리.
- `src/user-profile.ts` — 유저 프로필을 프롬프트 한 덩이로 만드는 자리.

### 3. 캐릭터의 삶 · 1,370줄

- `src/character.ts` — 캐릭터를 만드는 자리.
- `src/arcs.ts` — 아크 — 캐릭터 삶의 큰 흐름(올해·계절·이달·이번 주)을 만들고 달력 경계에서 이어 쓴다.
- `src/life-plan.ts` — 월 리듬 — 한 달치 이벤트와 매일 컨디션 시드를 미리 만든다.
- `src/day-plan.ts` — 하루 각본 — 캐릭터가 그날 무엇을 하는지 블록으로 만든다.
- `src/schedule-dedupe.ts` — 같은 일정인지 가리는 자리 — 공백·기호를 지운 내용으로 견준다.

### 4. 대화 생성 · 2,034줄

- `src/context.ts` — 프롬프트를 조립하는 자리 — 안정도 순 3층.
- `src/prompts/reply.ts` — 답장 프롬프트의 고정 문안 — 캐릭터를 가리지 않고 매번 같은 글자가 들어가는 층이다.
- `src/turns.ts` — 대화 기록을 모델에 넘길 턴으로 옮기는 자리.
- `src/reply-signal.ts` — 답장 객체 — 모델이 코드에 신호를 넘기는 통로.
- `src/reply-ask.ts` — 답장 한 통을 받아 오는 자리.
- `src/relationship-update.ts` — 관계 항목을 답장 자리에서 갱신하는 한 자리.
- `src/reply-timing.ts` — 답장 텀을 정하는 자리 — 두 태그 표 한 장.
- `src/proactive-policy.ts` — 선제 발화 관제탑 — 오늘 먼저 연락해도 되는지, 무엇을 보낼지 한곳에서 정한다.

### 5. 실행과 발송 · 2,709줄

- `src/index.ts` — 봇 프로세스의 시작점.
- `src/bot.ts` — 텔레그램과 주고받는 자리 — 받은 말을 모아 답장 한 통으로 내보낸다.
- `src/pending.ts` — 만들어 둔 답장을 정한 시각에 내보내는 자리.
- `src/presence.ts` — 자리 비움 예고 — 오래 답을 못 하게 되기 전에 미리 알린다(10분 틱).
- `src/followup.ts` — 침묵 팔로업 — 답이 끊긴 자리에 한 통 보낸다(15분 틱).
- `src/dispatch.ts` — 아침·점심·안부 선톡을 창 안에 내보내는 자리(3분 틱).

### 6. 새벽 정리 · 2,206줄

- `src/nightly.ts` — 새벽 정리 — 하루를 닫고 다음 날에 필요한 것을 만든다.
- `src/nightly-trace.ts` — 새벽 정리 트레이스 — 하루를 닫은 새벽 정리가 무엇을 바꿨는지 게시함에 쌓는다.
- `src/tools/nightly-read.ts` — 새벽 정리 수집 도구: 활성 캐릭터의 새벽 정리 입력(어제 대화·기억·관계·각본·아크 등)을 JSON으로 출력한다.
- `src/tools/nightly-write.ts` — 새벽 정리 적용 도구: stdin으로 받은 생성 결과(JSON)를 DB에 반영한다.
- `src/tools/run-nightly.ts` — 운영 도구: 활성 캐릭터 전체에 밤 정리를 수동 실행한다 (누락분 소급 생성용).

### 7. 관측과 운영 · 6,741줄

- `src/trace.ts` — 슬랙 트레이스 채널 — 캐릭터 파이프라인이 안에서 내린 판단을 슬랙에 게시한다.
- `src/reply-trace.ts` — 답장 트레이스 — 답장 한 건이 무엇을 보고 나왔는지 슬랙 채널에 올린다.
- `src/feedback.ts` — 슬랙 트레이스 채널에 사람이 남긴 표시를 모은다.
- `src/tools/analyze.ts` — 애착 신호 분석: messages 원시 로그에서 행동 신호를 날짜별로 집계한다 (README의 신호 표 대응).
- `src/tools/archive/demo-send.ts` — 데모 발송 도구 (발표 시연용): 활성 캐릭터로 선톡 문안을 실제 발송 경로(sendProactive)로 보낸다.
- `src/tools/archive/demo-undo.ts` — 데모 원복 도구 (발표 시연용): demo-send.ts가 출력한 경계 id 이후의 메시지를 삭제해 데모 전 상태로 되돌린다.
- `src/tools/archive/migrate-v1-data.ts` — v1 데이터 이관 도구 (이슈 #22).
- `src/tools/archive/migrate-v2-data.ts` — V2 데이터 이관 도구 (#50) — 운영 중인 캐릭터를 새 기억 구조로 옮긴다.
- `src/tools/backfill-attitude.ts` — 태도 두 칸(상대를 대하는 방식·애착 성향)을 이미 만들어 둔 캐릭터에 채운다.
- `src/tools/backup-db.ts` — 운영 DB의 일관 스냅샷을 파일 하나로 뜬다.
- `src/tools/check-writes.ts` — 쓰기 전환 관찰 도구: 새 저장 구조에 무엇이 쌓였는지 한 번에 본다.
- `src/tools/create-character.ts` — 유저 입력 캐릭터 생성 도구 — 봇 연결 전까지 생성 두 콜을 돌려 보는 자리.
- `src/tools/db-tag-search.ts` — 관리 대시보드의 태그 검색 — 답장을 만들 때 도는 검색을 그대로 한 번 돌려 결과를 보여준다.
- `src/tools/db-view.ts` — 관리 대시보드 화면을 만드는 곳 — DB에 저장된 데이터를 표 단위로 보는 화면.
- `src/tools/dedupe-schedules.ts` — 정리 도구: 같은 일정이 여러 줄로 쌓인 것을 한 줄로 줄인다 (이슈 #267).
- `src/tools/gen-day-plan.ts` — 운영 도구: 활성 캐릭터의 오늘 하루 각본을 생성(없을 때)하고 출력한다.
- `src/tools/gen-rhythm.ts` — 월 리듬(이벤트 + 매일 컨디션 시드) 생성·확인 도구.
- `src/tools/measure-prompt.ts` — 운영 도구: 시스템 프롬프트 3층(불변/일간/실시간) 크기를 측정하고, --live를 주면 같은 프롬프트로 2회 실호출해 캐시 히트(cr>0)를 검증한다.
- `src/tools/render-db.ts` — 관리 대시보드를 파일 한 장으로 뽑는다.
- `src/tools/retrace.ts` — 오늘 몫 트레이스를 지우고 다시 보낸다.
- `src/tools/serve-db.ts` — 관리 대시보드를 요청마다 다시 그려 내보내는 읽기 전용 서버.
- `src/eval/fixture-character.ts` — 평가 전용 고정 캐릭터 — 모델을 부르지 않고 만드는 생성 결과 한 벌.
- `src/eval/guard-db.ts` — 평가가 운영 DB를 열지 못하게 막는다.
- `src/eval/history.ts` — 지난 실행 기록을 표로 본다 — 모델도 DB도 부르지 않는다.
- `src/eval/log.ts` — 실행 결과를 파일에 한 줄씩 쌓는다 — 기준선을 두고 비교하려면 지난 숫자가 남아 있어야 한다.
- `src/eval/output-rules.ts` — 표기 규칙 평가 — 골든셋과 채점기.
- `src/eval/run.ts` — 표기 규칙 평가 실행기 — 골든셋을 실제 모델에 태우고 규칙 위반을 센다.

<!-- modules:end -->

## 의존 방향

번호가 큰 영역이 작은 영역을 쓴다. 반대 방향 import는 만들지 않는다. 예외는 둘이다.

- 7번 관측과 운영은 모든 영역에 걸친다. 어느 영역이든 결과를 남기려고 관측 함수를 부를 수 있고, 관측은 슬랙에 그리려고 아래 영역의 값을 읽을 수 있다. 다만 관측이 남긴 값을 다른 영역이 판단에 쓰면 안 된다.
- index.ts는 시작점이라 모든 영역을 잇는다. 5번에 두지만 방향 규칙 밖이다.

지금 코드에서 규칙에 어긋난 선은 없다. character.ts가 아크를 만들려고 nightly.ts를 가져오던 선이 하나 있었는데, 아크 코드를 arcs.ts로 옮기면서 없앴다(#294).

같은 영역 안의 순환도 1개다. nightly.ts와 nightly-trace.ts가 서로 import하는데, nightly-trace 쪽은 타입 4개만 가져가서 실행 순환은 아니다. 길이 5까지 확인한 순환은 이것뿐이다.

## 한 파일이 두 영역에 걸친 자리

영역은 파일 단위로 나눴지만 파일 4개는 안에서 책임이 갈린다. 같이 바뀐 횟수가 높은 쌍은 대부분 이 자리에서 나온다. 줄 번호는 2026-09-06 기준이다.

- **bot.ts** 1,238줄. 전송 인프라 133-328, 온보딩 330-503, 수신 디바운스 505-550과 1131-1197은 5번이다. 답장 파이프라인 respond 675-900과 몰아 답장 942-1128은 4번의 진입점이고, context.ts와 같이 바뀐 횟수가 20회로 모든 쌍 중 가장 많다.
- **nightly.ts** 1,464줄. 수집 450-562와 반영 568-860, runNightly 1317-1464는 6번이다. 프롬프트 문안 8종 892-1131은 4번의 결이다.
- **trace.ts** 400줄. 게시함 적재와 슬랙 발송 틱은 7번의 기반인데, 아침 각본 게시 enqueueMorningPlans 391-400이 같은 파일에 있어서 관측이 3번과 4번을 읽는 이유가 된다.
- **db.ts** 2,558줄. 정책 함수 4개가 저장 함수 사이에 있다. currentSpeechLevel 1196-1226, recentUserGaps 1175-1191, TRACE_EVENT_KEEP 1721-1728, 선제 발화 카운터의 LIKE 패턴 1784-1833은 4번이나 7번의 판단이다.

## 영역별 안내

### 1. 기반과 저장

config는 환경변수, kst는 한국 시간과 논리일 경계, labels는 닫힌 목록의 이름표, thresholds는 숫자 기준값이다. db.ts는 스키마·마이그레이션 39-947과 표 묶음 6개의 저장 함수를 갖고, llm.ts는 chat·chatJson 둘만 내보내는 얇은 게이트웨이다.

kst는 파일 25개, config 18개, thresholds 14개, labels 14개, llm 11개, db는 24개가 읽어서 고칠 때 같이 보는 곳이 넓다. 컬럼을 더하면 erd.md와 tools/check-writes·tools/db-view가 따라온다.

검사는 schema-fresh·schema-v6-upgrade·schema-v7-upgrade·contact-gap·kst 5개다. 설계 원본은 erd.md와 ADR 0001·0005·0006·0007이다.

손볼 자리
- db.ts를 표 묶음으로 나눈다. 호출 기록 1541-1749, 발송 큐 1468-1539와 2405-2558, 기억 2037-2404, 캐릭터·관계 950-1108과 1841-1922, 대화·선제 발화 카운터 1109-1226과 1750-1974, 일정·각본·일기·리듬 1229-1467과 1975-2035 순서로 떼면 임포터가 적은 것부터 간다. db.ts를 재내보내기 파일로 남기면 임포터 24개를 안 건드린다.
- db.ts 밖 raw SQL을 되가져온다. trace.ts 7건, nightly.ts 7건, reply-trace.ts 4건, feedback.ts 3건, nightly-trace.ts 2건, proactive-policy.ts 51-79의 lastUserTs 1건이다. 일기 INSERT와 call_feedback 함수는 db.ts에 아예 없다.
- 위에 적은 정책 함수 4개를 4번으로 옮긴다.
- thresholds로 안 옮긴 값이 남아 있다. bot.ts:154, reply-signal.ts:52·92, character.ts:136·360-362다.
- 마이그레이션 v2와 v3 주석이 520-583에서 섞여 있고, 버전 번호 없는 후속 마이그레이션 4종이 786-945에 있다.

### 2. 기억

memory.ts가 저장하고 찾고, recall.ts가 찾은 것 중 무엇을 넣을지 고르고 줄을 만든다. recall.ts는 DB를 열지 않고, memory.ts는 SQL을 직접 쓰지 않는다. tag-pick.ts는 발화마다 검색 태그를 고르는 sonnet 호출이고, user-profile.ts는 유저 절 한 덩이를 만든다.

고칠 때 같이 보는 곳은 6번의 추출 프롬프트, 4번 context.ts의 검색 절, 3번 day-plan.ts의 진행 중인 일 블록, tools/db-tag-search, erd.md의 memory_items·tags·relationships다.

검사는 nightly-extract·day-plan-ongoing 2개다. recall·tag-pick·user-profile은 테스트가 없다. 설계 원본은 time-and-memory.md와 ADR 0003·0004·0005·0010이다.

경계가 깨끗해서 손볼 자리가 작고, 다른 영역을 정리한 뒤에 봐도 된다.

### 3. 캐릭터의 삶

character.ts는 캐릭터를 두 번 호출로 만들고, arcs.ts는 삶의 큰 흐름 네 칸을 만들어 달력 경계에서 이어 쓰고, life-plan.ts는 한 달치 이벤트와 컨디션 시드를, day-plan.ts는 하루 각본을 블록으로 만든다. schedule-dedupe.ts는 같은 일정인지 가린다. 전부 opus 호출이다.

고칠 때 같이 보는 곳은 6번의 진행 중인 일 반영과 runNightly의 아크 호출, 4번 context.ts의 각본 절과 reply-timing.ts의 두 태그 표, 7번 trace.ts의 아침 각본 게시다. 도구는 tools/gen-day-plan·gen-rhythm·create-character·backfill-attitude다.

검사는 arcs·day-plan-ongoing·schedule-dedupe·schedule-time-update·eval-fixture-character 5개다. life-plan은 테스트가 없다. 설계 원본은 ADR 0002·0010과 time-and-memory.md의 V2 절이다.

손볼 자리
- 프롬프트 문안이 조립 함수와 얽혀 있다. life-plan 65-99, day-plan 116과 162-235와 305-342, character 67-89와 285와 306-357이다. 4번의 prompts/ 방식으로 떼려면 인자를 다시 짜야 해서 급하지 않다.

### 4. 대화 생성

context.ts가 안정도 순 3층을 조립하고, prompts/reply.ts가 캐릭터가 내보내는 모든 글의 규칙층 단일 소스다. 어느 층에 어느 순서로 넣을지는 context.ts가 정한다. turns.ts는 대화 기록을 턴으로 옮기고, reply-signal.ts는 답장 객체의 형식과 파서를 한 파일에 갖는다. reply-ask.ts는 한 통을 받아 오고 relationship-update.ts는 그 신호를 관계 컬럼에 반영한다. reply-timing.ts는 두 태그 표와 붙잡기 판정이고, proactive-policy.ts는 오늘 먼저 연락해도 되는지와 무엇을 보낼지를 정한다.

고칠 때 같이 보는 곳은 5번 bot.ts의 respond가 buildSystemBlocks에 넘기는 옵션이다. 선톡 문안 7곳도 같은 3층을 쓴다. presence 1곳, followup 3곳, nightly 2곳, bot 복귀 인사 1곳이다. 7번의 eval/output-rules는 이 영역을 고친 PR에 eval 라벨을 붙여 돌리고, reply-trace.ts의 렌더도 답장 형식이 바뀌면 따라온다.

검사는 reply-signal·reply-ask·output-rules·turns·held-draft 5개다. context·reply-timing·relationship-update는 테스트가 없다. 설계 원본은 ADR 0011·0012와 time-and-memory.md다.

손볼 자리
- context.ts가 조립만 하지 않는다. 21-37에서 db 함수 12개를 직접 불러 읽고, 각본을 시간대로 나누는 dayProgress·sleepGap 96-146도 여기 있다. 읽기와 조립을 나누면 조립 쪽에 테스트를 붙일 수 있다.
- 답장 밖 발화 표면 6곳의 문안이 각자 파일에 있다. 옮기기 쉬운 것은 followup 97-133, bot 630-673, tag-pick 32-38, reply-timing의 붙잡기 지시문이다.

### 5. 실행과 발송

bot.ts가 텔레그램과 주고받고, pending.ts가 만들어 둔 답장을 정한 시각에 내보낸다. presence 10분, followup 15분, dispatch 3분 틱이 선톡을 내고, index.ts가 크론 7개를 건다. 텔레그램 발송은 bot.ts:224 한 곳이고 틱 3개는 sendProactive만 부른다.

고칠 때 같이 보는 곳은 4번, 7번 reply-trace.ts의 결과 후기록 함수 5개, 그리고 6번이 만들어 둔 예약 발송 행이다. dispatch가 그 행을 내보낸다.

검사는 pending-recovery·pending-retry·presence-situation·catchup-silence 4개다. bot·dispatch·index는 테스트가 없다.

손볼 자리
- respond 764-896과 몰아 답장 분기 966-1084가 같은 파이프라인을 2벌 갖고 있어서 이 영역에서 첫 번째로 손댈 자리다. 하나로 합쳐 bot.ts 밖 파일로 빼면 bot.ts는 전송·온보딩·수신만 남고, 4번과의 경계가 파일 경계가 된다.
- followup 3종 190-237·260-301·323-367과 presence 294-388이 같은 뼈대를 4번 반복한다. 선톡 한 통을 보내는 공통 함수로 모으고, running 가드 3곳 dispatch:71·presence:153·followup:133도 같이 정리한다.
- 정책과 실행이 한 함수에 있다. respond, 몰아 답장 핸들러, presenceTickBody 204-390, followupTickBody 145-370, runDispatchTick 73-152다.
- bot.ts의 acquireProactive는 락이고 proactive-policy.ts의 proactiveAllowed는 정책인데 이름이 비슷해 헷갈린다.

### 6. 새벽 정리

nightly.ts가 하루를 닫는다. 수집 gatherNightlyInput 450-562, 반영 applyNightlyTxn 568-860, 프롬프트 4종 892-1056, 선톡 상황 4종 1062-1131, 발송 시각 계산 1133-1315, runNightly 1317-1464다. 봇 안의 05:40 크론과 봇 밖의 외부 스케줄러 경로가 수집·반영 함수를 공유하므로 쓰기 코드는 한 벌이다. nightly-trace.ts가 무엇을 바꿨는지 게시함에 쌓는다.

고칠 때 같이 보는 곳은 네 군데로, 추출 결과가 memory_items로 가므로 2번, 진행 중인 일과 일정 시각을 옮기고 아크를 이어 쓰라고 부르므로 3번, 선톡 문안이 buildSystemBlocks를 쓰므로 4번, 만들어 둔 예약 발송 행을 내보내는 5번 dispatch다. 여기에 repo 밖의 외부 스케줄러 지시서가 더해진다. 지시서의 프롬프트 규칙은 이 영역의 문안과 맞춰야 한다.

검사는 nightly-extract·nightly-progress·schedule-time-update·schedule-dedupe 4개다. nightly-trace는 테스트가 없다. 설계 원본은 time-and-memory.md와 ADR 0006이다.

손볼 자리
- nightly.ts 1,464줄에서 문안 8종 892-1131을 prompts/nightly.ts로 떼면 오케스트레이션만 남는다.
- 외부 지시서와 코드 안 프롬프트가 두 벌이 될 수 있어서 어느 쪽이 원본인지 정한다.

### 7. 관측과 운영

trace.ts는 게시함 trace_events에 쌓고 1분 틱으로 슬랙에 보낸다. reply-trace.ts는 24-894에서 답장 호출의 게시 재료를 조립하고 896-1003에서 발송·실패·접은 결과를 스레드에 덧붙인다. feedback.ts는 슬랙 채널의 리액션과 답글을 폴링해 call_feedback에 쌓는다. 도구 17개, 더 돌리지 않는 도구 4개를 둔 tools/archive/, 평가 6개, 테스트 23개, scripts 3개, 워크플로 2개, 커밋 훅이 여기다.

고칠 때 같이 보는 곳은 슬랙 채널의 글 형식과 호출부 전부다. 검사는 proactive-fail-trace 하나뿐이고, trace·feedback은 테스트가 없다. 설계 원본은 ADR 0008·0009다.

손볼 자리
- trace.ts에서 아침 각본 게시를 떼면 관측이 3·4번을 읽는 선이 줄어든다.
- reply-trace.ts의 두 역할을 나눈다. 게시 재료 조립은 렌더 함수 renderReply·timingLines·lineDiff가 무검증이라 나누면서 테스트를 붙인다.
- backfill-attitude는 일회성이라 tools/archive/로 옮길지 그때 정한다.
- 테스트 공백이 가장 큰 파일은 bot·context·reply-trace다.

## 리팩토링 원칙

- 동작을 바꾸지 않는다. 같은 입력에 같은 프롬프트·같은 저장·같은 발송이 나와야 하고, 그래야 배포 뒤 확인하던 관측 항목이 그대로 유효하다. 동작을 바꿀 일이 생기면 기능 이슈로 따로 뗀다.
- 테스트가 없는 파일은 손대기 전에 지금 동작을 붙잡는 검사를 먼저 붙인다. 프롬프트 조립은 같은 입력에서 같은 문자열이 나오는지, 발송 경로는 어느 함수가 어떤 인자로 불리는지를 고정한다.
- 이슈 하나가 영역 하나의 단계 하나다. 여러 영역을 한 PR에서 손대지 않는다.
- 같은 영역의 기능 작업과 리팩토링을 한 시점에 열지 않는다. 하나를 머지한 뒤 다음 브랜치를 판다. src를 건드리는 첫 단계는 진행 중인 기능 브랜치가 모두 머지된 뒤 시작한다.
- 각 단계에서 함께 하는 정리는 중복 코드 제거, 반복되는 뼈대의 공통 함수화, 정책과 실행의 분리, 파일 분해, 헷갈리는 이름 바로잡기다. 읽는 사람이 파일 이름과 함수 이름만으로 무엇을 하는지 알 수 있는 상태가 목표다.
- 파일을 나누면 원래 파일을 재내보내기 자리로 남겨 임포터를 안 건드리고, 임포터 정리는 다음 단계로 미룬다.

## 리팩토링 순서

작은 것부터 시작해 영역 경계가 파일 경계가 되게 만든 뒤 큰 분해로 가며, 줄 하나가 이슈 하나·PR 하나다.

1. 아크를 3번으로 옮기고 WAIT 상수 중복을 지우고 도구 4개를 보관 폴더로 옮긴다. 9/6에 끝났다(#294).
2. bot.ts의 답장 파이프라인 2벌을 1벌로 합쳐 밖으로 뺀다. 4번과 5번의 경계가 확정된다.
3. nightly.ts에서 문안을 뗀다.
4. 선톡 한 통을 보내는 공통 함수를 만들어 followup·presence를 줄인다.
5. db.ts를 표 묶음으로 나누고 밖의 raw SQL과 안의 정책 함수를 제자리로 보낸다. 임포터가 24개라 가장 넓지만, 재내보내기 파일을 남기면 임포터는 안 건드린다.
6. trace.ts와 reply-trace.ts를 나누고 context.ts의 읽기와 조립을 나눈다. 테스트를 붙이며 한다.

## 이 문서를 관리하는 방법

- 새 파일을 만들면 영역 표에 넣는다. `node scripts/gen-modules.mjs`가 이 표와 각 파일 맨 위 주석의 첫 줄로 위 파일 색인을 다시 쓰고, 같은 표를 CLAUDE.md 아키텍처 요약에도 옮겨 적는다. 표에 없는 src 파일이 있거나 색인이 밀리면 커밋 훅이 막는다.
- 파일을 폴더로 옮기지 않는다. 분해 작업으로 새 파일이 생길 때 그 영역 이름의 폴더를 만든다. 예외는 `src/tools/archive/`로, 더 돌리지 않는 도구를 두는 자리다.
- 손볼 자리는 착수할 때 이슈 번호를 달고 끝나면 여기서 지운다. 무엇을 왜 그렇게 했는지는 이슈와 PR 본문에 남긴다. 줄 번호는 적은 날짜 기준이라 착수할 때 다시 잰다.
- 영역의 이름이나 경계를 바꾸는 판단은 ADR로 남긴다.
