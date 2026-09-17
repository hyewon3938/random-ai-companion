# random-ai-companion — 작업 가이드

나와 같은 시간을 살고 먼저 물어봐주는 AI 대화 상대 (캐릭터는 유저가 /start에서 적은 입력으로 만든다). 컨셉·가설·설계 총론은 [README.md](README.md), 규모와 비용 검토는 [scaling.md](scaling.md), 실행 환경과 외부 서비스 구성은 [infra.md](infra.md)가 단일 소스다.

세부 설계 문서는 `docs/` 아래에 두고 커밋하지 않는다(gitignored). 타겟·어필 포인트는 `positioning.md`, 설계 논리·층은 `architecture.md`, 캐릭터 속성 체계는 `character-design.md`, 수집·생성 데이터 카탈로그는 `data-model.md`. 로컬 전용 맥락은 `LOCAL-CONTEXT.md`에 있고 필요한 절만 읽는다. 배포한 뒤 확인할 것은 `LOCAL-TRACK.md`에 모은다.

## 상태

남은 작업과 세션 대기열은 커밋하지 않는 `LOCAL-SESSIONS.md`에 있고, 세션은 `/next`나 `/build <세션 이름>`으로 연다. 설계 원본은 repo 루트에 커밋한 문서 3개로, 기억 구조와 V2는 `time-and-memory.md`, V3 관계는 `relationship.md`, 연락 경로는 `outgoing.md`에 있다.

## 실행

```bash
yarn            # 설치
cp .env.example .env   # TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY 채우기
yarn dev        # 로컬 기동 (long polling)
```

## 규칙

- **문체**: 설계 문서·README·이슈·PR 본문처럼 사람이 읽는 한국어 산문은 `writing` 스킬을 먼저 로드하고 쓴다. 채팅 답변은 output style을 따르고, 코드·주석은 대상이 아니다.
- **공개 톤**: 이 repo는 공개되어 있다. 특정 서비스명 비교·개인 맥락·실제 대화 로그를 커밋하지 않는다. 사적 맥락은 전부 LOCAL-CONTEXT.md(gitignored)로.
- **보안**: `.env`, `*.db`, `logs/`, `data/` 커밋 금지 (gitignore 반영됨).
- **코드**: TypeScript strict + ESM(import에 `.js` 확장자), named export, kebab-case 파일명, any 금지. 커밋은 Conventional Commits 한글. `src/*.ts`는 파일 맨 위 주석으로 시작한다 — 첫 줄이 한 문장 요약이고, 빈 주석 줄을 두고 그 아래에 자세한 설명을 적는다. 그 파일을 고치면 이 주석도 같은 커밋에서 고친다.
- **작업 단위**: `/build` 절차대로 이슈부터 만들어 PR 머지까지 한 세션에서 끝낸다. 머지 전에 사람이 확인해야 하는 세션은 `LOCAL-SESSIONS.md` 대기열의 머지 전 확인 칸에 적혀 있다. 머지 전에 PR 브랜치에서 `v3-readme.md`에 지금 동작과 V2와 다른 점, 이슈 번호를 한 줄 붙이고, 리드미에 안 갈 작업이면 「안 넣는 것」에 붙인다. 끝난 작업은 이 파일에 적지 않고 닫힌 이슈로 찾는다.
- **배포 뒤 확인 목록**: 머지를 마치면 `/build` 마무리 절차대로 커밋하지 않는 `LOCAL-TRACK.md`에 세션 묶음을 만든다. 작업이 끝난 뒤 대화하다가 볼 것이 더 생기면 그 묶음에 항목을 붙이고, 확인한 항목은 체크한 뒤 판단 근거를 묶음의 확인 결과에 한 줄 남긴다. 다 끝난 묶음을 지우는 정리는 사용자가 요청할 때만 한다.
- **이 파일 크기**: 세션마다 컨텍스트에 통째로 들어가는 지시서라 짧게 유지한다. 남은 작업은 `LOCAL-SESSIONS.md`에 두고, 무엇을 왜 그렇게 했는지는 이슈·PR 본문에 남긴다. 배포 기록은 서버 경로가 들어가서 공개 repo에 두지 않고 LOCAL-HISTORY.md에 적는다. 상한 14,000자는 `.githooks/pre-commit`이 강제하고 12,000자를 넘으면 경고한다. 새 작업 디렉터리에서는 `git config core.hooksPath .githooks`를 한 번 실행해 켠다. 막히면 끝난 내용이나 스킬에 이미 적힌 절차부터 지우고, 지울 것이 없으면 상한을 올린다.
- **자동 검사**: main 푸시와 PR마다 GitHub Actions가 `yarn typecheck`·`yarn test`를 돌린다(`.github/workflows/ci.yml`). 모델을 부르는 표기 규칙 평가(`yarn eval`)는 호출 비용이 붙고 통과율이 그날 응답에 따라 흔들려서 자동으로 돌리지 않는다. `src/prompts/reply.ts`·`src/eval/`·`src/reply-signal.ts`를 고친 PR에는 `eval` 라벨을 붙인다 — 라벨은 형식 레인만 돌린다(케이스 5개 × 3회, 호출 15건). 답이 객체로 오는지와 늘 넣는 칸이 오는지만 가르고, 표기·메모·플러팅 통과율은 그날 모델 답에 따라 흔들려서 합격 판정에 넣지 않는다. 케이스 29개 전체(`yarn eval`, 기본 5회면 호출 145건)는 말투 규칙을 크게 손본 뒤 Actions 탭에서 손으로 돌린다(`.github/workflows/eval.yml`). 테스트 파일은 `test/`에 둔다. `scripts/gen-modules.mjs`가 `src/` 아래 `.ts` 전부를 색인으로 훑는다.
- **설계 일관성**: 캐릭터 stance(프레임 존중·상대 자체를 좋아함·신경 쓰는 티)는 character-design.md §5가 원본. 코드의 stance 문자열과 문서가 어긋나면 문서 기준으로 맞춘다.
- **출력 규칙 단일 소스**: 캐릭터가 내보내는 모든 글에 공통으로 적용할 규칙(태도·대화 규칙·표기·말의 결)은 `src/prompts/reply.ts`의 고정 문안에서만 관리한다 — PERSON·SPEECH·EXEMPLARS·OUTPUT_FORMAT·FACT_CARE·NOTE_RULE. EXEMPLARS는 캐릭터 고유값이 없는 목표 말투 예시로, 금지 목록만으로는 안 잡히는 결(말풍선 끝 어미·추측형 말끝·반응어)을 보여준다. 캐릭터마다 다른 값으로 두면 생성 결과에 따라 규칙이 흔들리므로 정체성 항목에 넣지 않는다. 선톡 문안 프롬프트 9곳(nightly 아침·안부, followup 근황·굿나잇·달래기·살피기, presence 자리비움·복귀, glance 틈새 한 줄)도 전부 `buildSystemBlocks`(3층+상황 문단)를 타므로 같은 규칙이 자동으로 들어간다. 큰 결을 바꿀 일이 생기면 이 블록들을 고친다. 다만 답장이 내보내는 **형식**(JSON 객체)은 규칙층이 아니라 `src/reply-signal.ts`가 갖는다 — 선톡 문안 9곳은 같은 3층을 쓰되 자기 형식으로 답하므로, 규칙층에 넣으면 두 형식이 부딪힌다.
- **영역 표와 파일 색인**: 어느 파일이 어느 영역인지는 areas.md의 영역 표가 단일 소스다. `node scripts/gen-modules.mjs`가 그 표를 아키텍처 요약에 옮겨 적고, 각 파일 맨 위 주석의 첫 줄로 areas.md의 파일 색인을 다시 쓴다. 손으로 고치지 않고, 요약 주석을 고치거나 파일을 새로 만들면 표에 넣은 뒤 이 명령을 돌려 함께 커밋한다. 색인이 밀렸거나 요약 주석이 없거나 표에 없는 파일이 있으면 커밋 훅이 막는다.
- **모델**: 기본 `claude-sonnet-5` (환경변수 `MODEL`로 교체 가능).

## 아키텍처 요약

코드는 같이 바뀌는 정도와 의존 방향으로 묶은 영역 7개로 관리한다. 어떤 변경이 어느 영역으로 가는지, 고칠 때 같이 볼 곳과 리팩토링 순서는 areas.md에 있고, 파일마다 한 줄 요약도 그 문서의 파일 색인에 있다. 실행 단위로 묶어 본 그림과 답장 경로 흐름도는 modules.md, 표와 컬럼의 뜻은 erd.md에 있다.

모델은 실시간 대화에 sonnet, 일기·추출·각본·월 리듬·아크·캐릭터 생성에 opus(`MODEL_DEEP`)를 쓴다. 새벽 정리의 기본 경로는 외부 스케줄러가 맡아서 문안을 만드는 호출은 봇 밖에서 나가고, 반영할 때 태그 이름 판정으로 opus를 한 번 부른다.

<!-- modules:start -->

> 이 표는 `node scripts/gen-modules.mjs`가 areas.md의 영역 표에서 옮겨 쓴다. 손으로 고치지 않는다. 파일마다 한 줄 요약은 areas.md의 파일 색인에 있다.

| 영역 | 여기로 오는 변경 | 파일 |
| --- | --- | --- |
| 1. 기반과 저장 | 기준값·이름표·시각 계산, 표와 컬럼, 모델 호출 방식 | config, kst, labels, thresholds, db, db/*, llm |
| 2. 기억 | 무엇을 저장하고 무엇을 꺼내 쓰는지 | memory, recall, tag-canon, tag-pick, user-profile, reaction-score |
| 3. 캐릭터의 삶 | 캐릭터 생성, 삶의 큰 흐름, 월 리듬, 하루 각본, 일정 | character, arcs, life-plan, day-plan, schedule-dedupe |
| 4. 대화 생성 | 무슨 말을 어떤 텀으로 하는지, 오늘 먼저 말을 걸어도 되는지 | context, context/*, prompts/reply, prompts/relationship, turns, reply-signal, reply-ask, reply-compose, reply-promise, user-state, relationship-update, speech-level, reply-timing, proactive-policy |
| 5. 실행과 발송 | 텔레그램과 주고받기, 예약 발송, 선톡 틱 4개, 크론표 | index, bot, pending, pending-handlers, presence, glance, followup, dispatch, proactive-send |
| 6. 새벽 정리 | 하루를 닫는 배치 전부 | nightly, relationship-stage, prompts/nightly, nightly-trace, tools/nightly-read, tools/nightly-write, tools/run-nightly |
| 7. 관측과 운영 | 슬랙 게시, 피드백 수집, 손으로 돌리는 도구, 평가, 테스트, CI | trace, trace/*, reply-trace, feedback, tools/*, eval/* |

<!-- modules:end -->

핵심 설계 불변: 캐릭터는 유저 입력으로 생성(V2)하고 생성 때 정한 큰 정체성은 불변(origin=creation 행은 저장 함수가 수정 거부) — 자잘한 디테일은 대화로 쌓이되(누적 정체성) 한번 나온 것은 일관 유지(어긋나는 발명·유저 훼이크 추종 금지) / 잘 통하는 것은 관계 컬럼(rapport)으로 캐릭터에게 공개하고, user_preferences는 유저 단위 선호 자리 / 선제 연락은 근거 종류 넷(의도·일정·달래기·약속) 가운데 하나를 반드시 갖고 관계 단계가 정한 하루 상한(1단계 4통~4단계 6통, 의도 근거는 따로 1~3통) 안에서 나가며, 유저가 오래 무응답이면 물러난다(3일 조용→14일차 저녁 재연결 1통→침묵) / 이별은 비가역 / 컨디션은 매일 독립 주사위가 아니라 월 단위로 미리 깔린 리듬(이벤트 인과+파도), 실제 산 하루가 그 위를 덮어씀 / **답장 텀은 블록의 두 태그(답장 여건 × 활동 성격) 표 한 장에서만 나온다 — 이벤트별 예외처리 금지(스파게티 방지). 개인=붙잡으면 취소, 사회=양해 구해 미룸, 공적=못 접음.** / 답장은 즉답·틈틈이면 텀을 정한 뒤 바로 만들어 정한 시각에 내보내고, 불가 구간이면 만들지 않고 구간 끝에 깨어나 쌓인 메시지를 한 번에 읽고 몰아 답한다(몰아 답장은 만드는 시점=보내는 시점이라 일정을 막 끝내고 이제 봤다는 전제가 사실이 된다)
