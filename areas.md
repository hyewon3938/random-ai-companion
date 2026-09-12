# 코드 영역 지도

코드를 고칠 때 어느 파일을 열어야 하고 그 변경이 어디까지 번지는지 답하는 문서다. 실행 시점 순서로 모듈을 훑는 그림은 [modules.md](modules.md)에, 표와 컬럼의 뜻은 [erd.md](erd.md)에 있고, 이 문서는 그 둘과 축이 다르다. `src/` 아래 파일을 같이 바뀌는 정도와 의존 방향을 기준으로 영역 7개로 묶고, 영역마다 어떤 변경이 여기로 오는지, 고치면 같이 봐야 할 자리가 어디인지, 지금 보이는 손볼 자리가 무엇인지 적는다.

영역을 나눈 근거는 세 가지다. 파일끼리 import하는 방향, 2026-08-01 이후 커밋에서 같이 바뀐 횟수, 그리고 파일 하나 안에서 책임이 갈리는 자리다. 영역은 폴더가 아니라 이 문서의 표로만 존재하며, 파일을 나누는 작업이 생길 때 나누는 파일의 이름으로 폴더를 만든다. src/db/·src/context/·src/trace/가 그렇게 생겼다. 영역을 이렇게 정한 판단은 [ADR-0013](docs/adr/0013-code-areas.md)에 있다.

## 영역 7개

파일 열에는 `src/` 아래 경로를 확장자 없이 적고, 폴더 전체는 `tools/*`처럼 적는다. 앞 영역에 이름으로 적은 파일이 우선이고, 남은 파일이 폴더 패턴으로 간다. `scripts/gen-modules.mjs`가 이 표를 읽으므로 열의 꼴을 지킨다.

| 영역 | 여기로 오는 변경 | 파일 |
| --- | --- | --- |
| 1. 기반과 저장 | 기준값·이름표·시각 계산, 표와 컬럼, 모델 호출 방식 | config, kst, labels, thresholds, db, db/*, llm |
| 2. 기억 | 무엇을 저장하고 무엇을 꺼내 쓰는지 | memory, recall, tag-pick, user-profile |
| 3. 캐릭터의 삶 | 캐릭터 생성, 삶의 큰 흐름, 월 리듬, 하루 각본, 일정 | character, arcs, life-plan, day-plan, schedule-dedupe |
| 4. 대화 생성 | 무슨 말을 어떤 텀으로 하는지, 오늘 먼저 말을 걸어도 되는지 | context, context/*, prompts/reply, prompts/relationship, turns, reply-signal, reply-ask, reply-compose, reply-promise, user-state, relationship-update, speech-level, reply-timing, proactive-policy |
| 5. 실행과 발송 | 텔레그램과 주고받기, 예약 발송, 선톡 틱 4개, 크론표 | index, bot, pending, presence, glance, followup, dispatch, proactive-send |
| 6. 새벽 정리 | 하루를 닫는 배치 전부 | nightly, relationship-stage, prompts/nightly, nightly-trace, tools/nightly-read, tools/nightly-write, tools/run-nightly |
| 7. 관측과 운영 | 슬랙 게시, 피드백 수집, 손으로 돌리는 도구, 평가, 테스트, CI | trace, trace/*, reply-trace, feedback, tools/*, eval/* |

7번에는 `src/` 밖의 `test/`·`scripts/`·`.github/`도 들어간다. 4번에 reply-timing과 proactive-policy를 넣은 이유는 둘 다 보낼지와 언제 보낼지를 정하는 판단이고 실제로 보내는 코드가 아니어서다. 이렇게 두면 5번과 6번이 4번을 같이 쓰면서 서로는 import하지 않는다.

## 파일 색인

<!-- modules:start -->

> 이 색인은 `node scripts/gen-modules.mjs`가 위 영역 표와 각 파일 맨 위 주석의 첫 줄에서 만든다. 손으로 고치지 않는다. 줄 수는 영역에 든 파일의 합이다.

### 1. 기반과 저장 · 6,399줄

- `src/config.ts` — 환경변수를 한 번 읽어 두는 자리.
- `src/kst.ts` — 시각을 다루는 자리 — 한국 시간, 논리일 경계, 공휴일 달력.
- `src/labels.ts` — 닫힌 목록의 값 이름표.
- `src/thresholds.ts` — 숫자로 관리하는 기준값.
- `src/db.ts` — 저장 함수의 단일 입구.
- `src/llm.ts` — 모델을 부르는 자리.
- `src/db/characters.ts` — 캐릭터·관계·유저 프로필 표의 저장 함수.
- `src/db/connection.ts` — SQLite 연결과 스키마.
- `src/db/culture-scripts.ts` — 문화 스크립트 원본 — 한국 일상 이벤트를 단계로 풀어 적어 둔 공통 자산.
- `src/db/feedback.ts` — 슬랙에서 사람이 남긴 표시를 모아 두는 call_feedback 표의 저장 함수.
- `src/db/life.ts` — 아크·월 리듬·일정·하루 각본·일기·작품 사실 카드·문화 스크립트 표의 저장 함수.
- `src/db/llm-calls.ts` — 모델 호출 기록·사용량·본문 보관 표의 저장 함수와 보관 기간.
- `src/db/memory-items.ts` — 기억·태그·영역·오늘 메모·오늘 실제 표의 저장 함수.
- `src/db/messages.ts` — 대화 기록 표의 저장·조회 함수와 답장 복구 표시.
- `src/db/relationship.ts` — 관계가 쌓이면서 늘어나는 표 넷의 저장 함수.
- `src/db/sends.ts` — 예약 발송과 대기 중인 답장 표의 저장 함수.
- `src/db/trace-events.ts` — 게시함 표의 저장 함수와 보관 기간.

### 2. 기억 · 857줄

- `src/memory.ts` — 기억을 저장하고 찾는 자리.
- `src/recall.ts` — 태그로 찾은 것 중 무엇을 프롬프트에 넣을지 고르고, 넣을 줄을 만드는 자리.
- `src/tag-pick.ts` — 이번 발화로 무엇을 검색할지 주제 태그를 고르는 자리.
- `src/user-profile.ts` — 유저 프로필을 프롬프트 한 덩이로 만드는 자리.

### 3. 캐릭터의 삶 · 1,986줄

- `src/character.ts` — 캐릭터를 만드는 자리.
- `src/arcs.ts` — 아크 — 캐릭터 삶의 큰 흐름(올해·계절·이달·이번 주)을 만들고 달력 경계에서 이어 쓴다.
- `src/life-plan.ts` — 월 리듬 — 한 달치 이벤트와 매일 컨디션 시드를 미리 만든다.
- `src/day-plan.ts` — 하루 각본 — 캐릭터가 그날 무엇을 하는지 블록으로 만든다.
- `src/schedule-dedupe.ts` — 같은 일정인지 가리는 자리 — 공백·기호를 지운 내용으로 견준다.

### 4. 대화 생성 · 4,331줄

- `src/context.ts` — 프롬프트를 조립하는 자리 — 읽기와 조립을 잇는 앞문.
- `src/prompts/reply.ts` — 답장 프롬프트의 고정 문안 — 캐릭터를 가리지 않고 매번 같은 글자가 들어가는 층이다.
- `src/prompts/relationship.ts` — 관계 단계의 고정 문안 — 공통 틀 하나와 단계 블록 4개를 상수로 둔다.
- `src/turns.ts` — 대화 기록을 모델에 넘길 턴으로 옮기는 자리.
- `src/reply-signal.ts` — 답장 객체 — 모델이 코드에 신호를 넘기는 통로.
- `src/reply-ask.ts` — 답장 한 통을 받아 오는 자리.
- `src/reply-compose.ts` — 답장 한 통을 만드는 순서 — 말투 굳히기, 검색 태그와 상대 상태 판정, 프롬프트 조립, 호출, 신호 반영, 폐기 판정.
- `src/reply-promise.ts` — 답장에서 한 연락 약속을 코드가 지킬 시각으로 바꾼다.
- `src/user-state.ts` — 답장마다 상대의 지금 상태를 판정하는 작은 호출.
- `src/relationship-update.ts` — 관계 항목을 답장 자리에서 갱신하는 한 자리.
- `src/speech-level.ts` — 지금 이 관계가 반말인지 존댓말인지 — 최근 캐릭터 답장의 종결어미로 판정한다.
- `src/reply-timing.ts` — 답장 텀을 정하는 자리 — 두 태그 표 한 장.
- `src/proactive-policy.ts` — 선제 발화 관제탑 — 오늘 먼저 연락해도 되는지, 무엇을 보낼지 한곳에서 정한다.
- `src/context/assemble.ts` — 프롬프트 조립 — 읽어 둔 값 묶음을 안정도 순 3층의 시스템 블록으로 만든다.
- `src/context/day-progress.ts` — 각본 위의 지금 — 지금 시각이 각본의 어느 블록인지, 지나온 블록, 빈자리를 메우는 잠.
- `src/context/input.ts` — 프롬프트 재료 읽기 — 조립에 필요한 것을 DB와 시계에서 한 번에 읽어 값 묶음으로 만든다.
- `src/context/relationship.ts` — 「지금 관계」 채우기 — 단계와 처음, 오늘 쓴 플러팅, 오늘 말한 일정, 오늘의 관계 의도를 읽어 답장 프롬프트의 관계 절을 만든다.

### 5. 실행과 발송 · 3,829줄

- `src/index.ts` — 봇 프로세스의 시작점.
- `src/bot.ts` — 텔레그램과 주고받는 자리 — 받은 말을 모아 답장 한 통으로 내보낸다.
- `src/pending.ts` — 만들어 둔 답장을 정한 시각에 내보내는 자리.
- `src/presence.ts` — 자리 비움 예고 — 오래 답을 못 하게 되기 전에 미리 알린다(10분 틱).
- `src/glance.ts` — 틈새 한 줄 — 불가 구간에 온 확인 말에 지금 하는 일과 끝나는 시각을 짧게 알린다(5분 틱).
- `src/followup.ts` — 침묵 팔로업 — 답이 끊긴 자리에 한 통 보낸다(15분 틱).
- `src/dispatch.ts` — 아침·안부 선톡을 창 안에 내보내는 자리(3분 틱).
- `src/proactive-send.ts` — 선톡 한 통을 만들어 보내는 공통 자리 — 잠금·보관 문안·발송 직전 재확인·실패 보관을 한 벌로 둔다.

### 6. 새벽 정리 · 3,392줄

- `src/nightly.ts` — 새벽 정리 — 하루를 닫고 다음 날에 필요한 것을 만든다.
- `src/relationship-stage.ts` — 관계 단계 전이 — 어제까지의 값을 세어 문턱을 재고, 모델의 결정을 받아 단계·처음·의도를 저장한다.
- `src/prompts/nightly.ts` — 새벽 정리가 모델에 넘기는 문안 — 일기·기억 정리·진행 반영 프롬프트와 선톡 상황 문단을 한 파일에 둔다.
- `src/nightly-trace.ts` — 새벽 정리 트레이스 — 하루를 닫은 새벽 정리가 무엇을 바꿨는지 게시함에 쌓는다.
- `src/tools/nightly-read.ts` — 새벽 정리 수집 도구: 활성 캐릭터의 새벽 정리 입력(어제 대화·기억·관계·관계 단계·각본·아크 등)을 JSON으로 출력한다.
- `src/tools/nightly-write.ts` — 새벽 정리 적용 도구: stdin으로 받은 생성 결과(JSON)를 DB에 반영한다.
- `src/tools/run-nightly.ts` — 운영 도구: 활성 캐릭터 전체에 밤 정리를 수동 실행한다 (누락분 소급 생성용).

### 7. 관측과 운영 · 8,215줄

- `src/trace.ts` — 슬랙 트레이스 게시함 — 보여줄 내용을 trace_events 행으로 쌓고 1분 틱이 슬랙으로 내보낸다.
- `src/reply-trace.ts` — 답장 후기록 — 발송·폐기 결과, 선톡 발송, 접은 자리 비움 예고와 틈새 한 줄, 연락 약속의 단계를 게시함에 쌓는다.
- `src/feedback.ts` — 슬랙 트레이스 채널에 사람이 남긴 표시를 모은다.
- `src/trace/diff.ts` — 슬랙 게시용 비교 — 두 글에서 달라진 자리만 표시하는 줄 단위·낱말 단위 비교.
- `src/trace/format.ts` — 슬랙 게시 문안이 공통으로 쓰는 표기 도우미 — 이스케이프·날짜·자르기·인용·토큰 줄.
- `src/trace/morning-plan.ts` — 아침 각본 게시 — 새벽 정리가 만든 오늘 각본을 아침에 슬랙 스레드로 올린다.
- `src/trace/reply-post.ts` — 답장 게시 준비 — 아직 안 올린 모델 호출을 번호 순서대로 게시함(trace_events)에 쌓는다.
- `src/trace/reply-render.ts` — 답장 게시 문안 그리기 — 호출 행과 판단 근거를 슬랙 본문 한 장으로 옮긴다.
- `src/tools/analyze.ts` — 애착 신호 분석: messages 원시 로그에서 행동 신호를 날짜별로 집계한다 (README의 신호 표 대응).
- `src/tools/archive/demo-send.ts` — 데모 발송 도구 (발표 시연용): 활성 캐릭터로 선톡 문안을 실제 발송 경로(sendProactive)로 보낸다.
- `src/tools/archive/demo-undo.ts` — 데모 원복 도구 (발표 시연용): demo-send.ts가 출력한 경계 id 이후의 메시지를 삭제해 데모 전 상태로 되돌린다.
- `src/tools/archive/migrate-v1-data.ts` — v1 데이터 이관 도구 (이슈 #22).
- `src/tools/archive/migrate-v2-data.ts` — V2 데이터 이관 도구 (#50) — 운영 중인 캐릭터를 새 기억 구조로 옮긴다.
- `src/tools/backfill-attitude.ts` — 태도 두 칸(상대를 대하는 방식·애착 성향)을 이미 만들어 둔 캐릭터에 채운다.
- `src/tools/backup-db.ts` — 운영 DB의 일관 스냅샷을 파일 하나로 뜬다.
- `src/tools/check-writes.ts` — 쓰기 전환 관찰 도구: 새 저장 구조에 무엇이 쌓였는지 한 번에 본다.
- `src/tools/create-character.ts` — 유저 입력 캐릭터 생성 도구 — 생성 두 콜을 파일 입력으로 돌려 보는 자리.
- `src/tools/db-tag-search.ts` — 관리 대시보드의 태그 검색 — 답장을 만들 때 도는 검색을 그대로 한 번 돌려 결과를 보여준다.
- `src/tools/db-view.ts` — 관리 대시보드 화면을 만드는 곳 — DB에 저장된 데이터를 표 단위로 보는 화면.
- `src/tools/dedupe-schedules.ts` — 정리 도구: 같은 일정이 여러 줄로 쌓인 것을 한 줄로 줄인다 (이슈 #267).
- `src/tools/end-character.ts` — 캐릭터를 끝내는 도구 — 활성 캐릭터를 ended로 바꾸고 걸린 발송을 거두고 종료 게시를 쌓는다.
- `src/tools/feedback.ts` — 슬랙에서 모은 표시를 처리 여부와 함께 보는 도구 — 안 끝난 것을 보여주고 처리 표시를 찍는다.
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

같은 영역 안의 순환은 2개다. nightly.ts와 nightly-trace.ts, nightly.ts와 prompts/nightly.ts가 서로 import하는데, nightly-trace는 타입 4개만, prompts/nightly는 NightlyGathered 타입 하나만 가져가서 실행 순환은 아니다. 길이 5까지 확인한 순환은 이 둘뿐이다.

## 한 파일이 두 영역에 걸친 자리

영역은 파일 단위로 나눴지만 파일 하나는 안에서 책임이 갈린다. 같이 바뀐 횟수가 높은 쌍은 대부분 이 자리에서 나온다. 줄 번호는 2026-09-06 기준이다.

- **bot.ts** 1,001줄. 전송 인프라 96-303, 온보딩 305-467, 수신 디바운스 477-520과 891-953, 답장 텀과 예약·깨우기 588-889는 5번이다. 답장을 만드는 순서는 4번 reply-compose.ts로 나갔고(#296), 상황 문단 3종 527-586만 4번의 결로 남아 있다. context.ts와 같이 바뀐 횟수가 20회로 모든 쌍 중 가장 많았던 파일인데, 이제 그 변경은 reply-compose.ts로 간다.

## 영역별 안내

### 1. 기반과 저장

config는 환경변수, kst는 한국 시간과 논리일 경계, labels는 닫힌 목록의 이름표, thresholds는 숫자 기준값이다. db.ts는 `src/db/` 아래 표 묶음 9개를 다시 내보내는 입구라 부르는 쪽은 이 파일 하나만 import한다. 연결과 스키마·마이그레이션은 db/connection.ts에 있고, 캐릭터·관계·유저 프로필은 characters, 대화 기록은 messages, 아크·월 리듬·일정·각본·일기는 life, 예약 발송과 대기 중인 답장은 sends, 호출 기록과 본문 보관은 llm-calls, 게시함은 trace-events, 슬랙에서 모은 표시는 feedback, 기억·태그·오늘 메모·오늘 실제는 memory-items가 갖는다. 묶음 파일끼리는 connection과 형제만 부르고 db.ts를 부르지 않는다. SQL 문장은 이 폴더와 손으로 돌리는 도구·평가에만 있고, 그 밖의 파일은 저장 함수를 부르거나 여러 저장을 하나로 묶는 `db.transaction`만 쓴다. 저장 함수 사이에 있던 판단 4개 중 셋은 4번으로 갔고(말투 높낮이는 speech-level.ts, 유저가 이어 보내는 텀은 reply-timing.ts, 선제 발화를 가르는 meta_json 패턴은 proactive-policy.ts), 게시함 행의 보관 기한은 저장 규칙이라 db/trace-events.ts에 남겼다. llm.ts는 chat·chatJson 둘만 내보내는 얇은 게이트웨이다.

kst는 파일 25개, config 18개, thresholds 14개, labels 14개, llm 11개, db는 24개가 읽어서 고칠 때 같이 보는 곳이 넓다. 컬럼을 더하면 erd.md와 tools/check-writes·tools/db-view가 따라온다.

검사는 schema-fresh·schema-v6-upgrade·schema-v7-upgrade·contact-gap·kst 5개다. 설계 원본은 erd.md와 ADR 0001·0005·0006·0007이다.

손볼 자리
- thresholds로 안 옮긴 값이 남아 있다. bot.ts:129, reply-signal.ts:52·92, character.ts:136·360-362다.
- db/connection.ts에서 마이그레이션 v2와 v3 주석이 섞여 있고, 버전 번호 없는 후속 마이그레이션 4종이 그 뒤에 있다.

### 2. 기억

memory.ts가 저장하고 찾고, recall.ts가 찾은 것 중 무엇을 넣을지 고르고 줄을 만든다. recall.ts는 DB를 열지 않고, memory.ts는 SQL을 직접 쓰지 않는다. tag-pick.ts는 발화마다 검색 태그를 고르는 sonnet 호출이고, user-profile.ts는 유저 절 한 덩이를 만든다.

고칠 때 같이 보는 곳은 6번의 추출 프롬프트, 4번 context/assemble.ts의 검색 절, 3번 day-plan.ts의 진행 중인 일 블록, tools/db-tag-search, erd.md의 memory_items·tags·relationships다.

검사는 nightly-extract·day-plan-ongoing·recall·tag-pick·user-profile 5개다. 설계 원본은 time-and-memory.md와 ADR 0003·0004·0005·0010이다.

경계가 깨끗해서 손볼 자리가 작고, 다른 영역을 정리한 뒤에 봐도 된다.

### 3. 캐릭터의 삶

character.ts는 캐릭터를 두 번 호출로 만들고, arcs.ts는 삶의 큰 흐름 네 칸을 만들어 달력 경계에서 이어 쓰고, life-plan.ts는 한 달치 이벤트와 컨디션 시드를, day-plan.ts는 하루 각본을 블록으로 만든다. schedule-dedupe.ts는 같은 일정인지 가린다. 전부 opus 호출이다.

고칠 때 같이 보는 곳은 6번의 진행 중인 일 반영과 runNightly의 아크 호출, 4번 context/day-progress.ts의 각본 위의 지금 계산과 reply-timing.ts의 두 태그 표, 7번 trace/morning-plan.ts의 아침 각본 게시다. 도구는 tools/gen-day-plan·gen-rhythm·create-character·backfill-attitude다.

검사는 arcs·day-plan-ongoing·schedule-dedupe·schedule-time-update·eval-fixture-character·life-plan 6개다. 설계 원본은 ADR 0002·0010과 time-and-memory.md의 V2 절이다.

손볼 자리
- 프롬프트 문안이 조립 함수와 얽혀 있다. life-plan 65-99, day-plan 116과 162-235와 305-342, character 67-89와 285와 306-357이다. 4번의 prompts/ 방식으로 떼려면 인자를 다시 짜야 해서 급하지 않다.

### 4. 대화 생성

context.ts는 앞문이다. context/input.ts가 DB에서 값을 읽어 한 묶음으로 넘기면 context/assemble.ts가 안정도 순 3층을 쌓고, 각본 위의 지금(지나온 블록·지금 블록·빈자리의 잠)은 context/day-progress.ts가 DB 없이 계산한다. prompts/reply.ts가 캐릭터가 내보내는 모든 글의 규칙층 단일 소스고, 어느 층에 어느 순서로 넣을지는 assemble.ts가 정한다. turns.ts는 대화 기록을 턴으로 옮기고, reply-signal.ts는 답장 객체의 형식과 파서를 한 파일에 갖는다. reply-ask.ts는 한 통을 받아 오고 relationship-update.ts는 그 신호를 관계 컬럼에 반영한다. reply-compose.ts는 답장 한 통을 만드는 순서(말투 굳히기·검색 태그·조립·호출·신호 반영·폐기 판정)를 갖고, 5번의 즉답과 몰아 답장이 상황 문단과 시간 표시 기준만 다르게 주고 둘 다 이 함수를 부른다. speech-level.ts는 최근 답장의 어미로 지금 반말인지 존댓말인지 가늠한다. reply-timing.ts는 두 태그 표와 붙잡기 판정에 유저가 이어 보내는 텀 계산까지 갖고, proactive-policy.ts는 오늘 먼저 연락해도 되는지와 무엇을 보낼지를 정하며 선톡을 종류별로 세는 meta_json 패턴도 여기서만 정한다.

고칠 때 같이 보는 곳은 5번 bot.ts가 composeReply에 넘기는 상황 문단과 호출 근거다. 선톡 문안 7곳도 같은 3층을 쓴다. presence 1곳, followup 3곳, nightly 2곳, bot 복귀 인사 1곳이다. 7번의 eval/output-rules는 이 영역을 고친 PR에 eval 라벨을 붙여 돌리고, trace/reply-render.ts의 렌더도 답장 형식이 바뀌면 따라온다.

검사는 reply-signal·reply-ask·reply-compose·reply-promise·output-rules·turns·held-draft·speech-level·proactive-counters·context-assemble·relationship-update 11개다. reply-timing은 이어 보내는 텀만 있다. 설계 원본은 ADR 0011·0012와 time-and-memory.md다.

손볼 자리
- 답장 밖 발화 표면 6곳의 문안이 각자 파일에 있다. 옮기기 쉬운 것은 followup 87-121, bot 527-586, tag-pick 32-38, reply-timing의 붙잡기 지시문이다.

### 5. 실행과 발송

bot.ts가 텔레그램과 주고받고, pending.ts가 만들어 둔 답장을 정한 시각에 내보낸다. presence 10분, glance 5분, followup 15분, dispatch 3분 틱이 선톡을 내고, index.ts가 크론 9개를 건다. 텔레그램 발송은 bot.ts:196 한 곳이고 틱 4개는 sendProactive만 부른다. followup·presence·glance가 선톡 한 통을 만들어 보내는 순서(잠금, 앞 틱에서 못 나간 문안, 모델 호출, 발송 직전 재확인, 실패 보관)는 proactive-send.ts의 sendProactiveDraft 하나에 있고, 틱 재진입을 막는 noOverlap도 거기 있어 dispatch·followup·presence·glance가 같이 쓴다.

고칠 때 같이 보는 곳은 4번, 7번 reply-trace.ts의 결과 후기록 함수 5개, 그리고 6번이 만들어 둔 예약 발송 행이다. dispatch가 그 행을 내보낸다.

검사는 pending-recovery·pending-retry·pending-promise·presence-situation·glance·catchup-silence·proactive-send·dispatch 8개다. bot·index는 테스트가 없다.

손볼 자리
- 정책과 실행이 한 함수에 있다. respond 597-730(텀 결정과 깨우기 행·예약 저장), 몰아 답장 핸들러 778-889, presenceTickBody 176-315, followupTickBody 123-240, runDispatchTick 72-145다.
- bot.ts의 acquireProactive는 락이고 proactive-policy.ts의 proactiveAllowed는 정책인데 이름이 비슷해 헷갈린다.

### 6. 새벽 정리

nightly.ts가 하루를 닫는다. 수집 gatherNightlyInput 461-571, 반영 applyNightlyTxn 579-867, 발송 시각 계산 903-1085, runNightly 1087-1234다. 모델에 넘기는 문안은 prompts/nightly.ts에 있다. 일기·대화 없던 날 일기·진행 반영·기억 정리 프롬프트 4종과 선톡 상황 문단 4종이 수집 결과를 받아 글자만 만든다. 4번의 prompts/reply.ts와 같은 꼴이지만 새벽 정리 규칙과 함께 바뀌어서 6번이다. 봇 안의 05:40 크론과 봇 밖의 외부 스케줄러 경로가 수집·반영 함수를 공유하므로 쓰기 코드는 한 벌이다. nightly-trace.ts가 무엇을 바꿨는지 게시함에 쌓는다.

고칠 때 같이 보는 곳은 네 군데로, 추출 결과가 memory_items로 가므로 2번, 진행 중인 일과 일정 시각을 옮기고 아크를 이어 쓰라고 부르므로 3번, 선톡 문안이 buildSystemBlocks를 쓰므로 4번, 만들어 둔 예약 발송 행을 내보내는 5번 dispatch다. 여기에 repo 밖의 외부 스케줄러 지시서가 더해진다. 지시서의 프롬프트 규칙은 이 영역의 문안과 맞춰야 한다.

검사는 nightly-extract·nightly-progress·nightly-prompts·schedule-time-update·schedule-dedupe·nightly-trace 6개다. 설계 원본은 time-and-memory.md와 ADR 0006이다.

손볼 자리
- 외부 지시서와 코드 안 프롬프트가 두 벌이 될 수 있어서 어느 쪽이 원본인지 정한다.

### 7. 관측과 운영

trace.ts는 게시함 trace_events에 쌓고 1분 틱으로 슬랙에 보낸다. trace/format.ts가 문안 조각 함수를 모으고, trace/reply-render.ts가 답장 호출 행을 슬랙 문안으로 그리고, trace/reply-post.ts가 그 문안을 호출 행에서 뒤늦게 읽어 올리며, trace/morning-plan.ts가 아침 각본을 게시한다. reply-trace.ts에는 발송·실패·접은 결과를 스레드에 덧붙이는 후기록만 남았다. feedback.ts는 슬랙 채널의 리액션과 답글을 폴링해 call_feedback에 쌓는다. 도구 16개, 더 돌리지 않는 도구 4개를 둔 tools/archive/, 평가 6개, 테스트 87개, scripts 5개, 워크플로 2개, 커밋 훅이 여기다.

고칠 때 같이 보는 곳은 슬랙 채널의 글 형식과 호출부 전부다. 검사는 proactive-fail-trace·reply-render·morning-plan·feedback 4개고, trace는 테스트가 없다. 설계 원본은 ADR 0008·0009다.

손볼 자리
- backfill-attitude는 일회성이라 tools/archive/로 옮길지 그때 정한다.
- 테스트 공백이 가장 큰 파일은 bot이다. trace·index도 테스트가 없다.

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
2. bot.ts의 답장 파이프라인 2벌을 1벌로 합쳐 밖으로 뺀다. 4번과 5번의 경계가 확정된다. 9/6에 끝났다(#296).
3. nightly.ts에서 문안을 뗀다. 9/6에 끝났다(#298).
4. 선톡 한 통을 보내는 공통 함수를 만들어 followup·presence를 줄인다. 9/6에 끝났다(#300).
5. db.ts를 표 묶음으로 나누고 밖의 raw SQL과 안의 정책 함수를 제자리로 보낸다. 임포터가 24개라 가장 넓지만, 재내보내기 파일을 남기면 임포터는 안 건드린다. 9/6에 끝났다(#302).
6. trace.ts와 reply-trace.ts를 나누고 context.ts의 읽기와 조립을 나눈다. 테스트를 붙이며 한다. 9/6에 끝났다(#304).

## 이 문서를 관리하는 방법

- 새 파일을 만들면 영역 표에 넣는다. `node scripts/gen-modules.mjs`가 이 표와 각 파일 맨 위 주석의 첫 줄로 위 파일 색인을 다시 쓰고, 같은 표를 CLAUDE.md 아키텍처 요약에도 옮겨 적는다. 표에 없는 src 파일이 있거나 색인이 밀리면 커밋 훅이 막는다.
- 파일을 폴더로 옮기지 않는다. 분해 작업으로 새 파일이 생길 때 나누는 파일의 이름으로 폴더를 만들고, 원본 파일은 앞문으로 남겨 임포터가 그대로 쓰게 한다. 예외는 `src/tools/archive/`로, 더 돌리지 않는 도구를 두는 자리다.
- 손볼 자리는 착수할 때 이슈 번호를 달고 끝나면 여기서 지운다. 무엇을 왜 그렇게 했는지는 이슈와 PR 본문에 남긴다. 줄 번호는 적은 날짜 기준이라 착수할 때 다시 잰다.
- 영역의 이름이나 경계를 바꾸는 판단은 ADR로 남긴다.

## V3에서 바뀌는 것

V3(관계를 쌓는 캐릭터, 이슈 #326)의 새 파일과 고치는 파일이 들어갈 영역이다. 설계 원본은 relationship.md이고 흐름은 modules.md 「V3에서 바뀌는 흐름」에 있다. 파일을 실제로 만들 때 위 영역 표에 넣고 `node scripts/gen-modules.mjs`를 돌리며, 다 옮기면 이 절을 지운다.

| 영역 | 새 파일 | 고치는 파일 |
| --- | --- | --- |
| 1. 기반과 저장 | | thresholds.ts에 자리 비움 하루 2 |
| 2. 기억 | reaction-score.ts (표본 계산, 갱신) | |
| 3. 캐릭터의 삶 | | |
| 4. 대화 생성 | | proactive-policy.ts 근거 종류와 단계별 상한 |
| 5. 실행과 발송 | glance.ts (틈새 한 줄, 이슈 #339로 먼저 만듦) | followup.ts 의도 선톡, presence.ts 복귀 문안 |
| 6. 새벽 정리 | | relationship-stage.ts 반응 점수 저장, nightly-trace.ts 관계 절에 점수 줄 |
| 7. 관측과 운영 | tools/relationship-view.ts (단계·처음·점수 확인) | |

db/relationship.ts는 저장 함수만 갖고 정책은 갖지 않는다. 단계를 줄이는 저장을 거부하는 검사는 origin=creation 행의 수정 거부와 같은 자리이므로 저장 함수 안에 둔다. 반응 점수의 계산은 2번 영역이 맡고, 6번의 새벽 정리가 그 함수를 불러 쓴다. 시도할 플러팅 추천 목록과 잘 통하는 플러팅 목록은 단계마다 열리는 플러팅의 표를 읽어야 해서 6번의 relationship-stage.ts에 두었다.
