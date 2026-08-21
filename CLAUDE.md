# random-ai-companion — 작업 가이드

나와 같은 시간을 살고 먼저 물어봐주는 AI 대화 상대 (만남은 카드 한 장으로 시작). 컨셉·가설·설계 총론은 [README.md](README.md), 규모와 비용 검토는 [scaling.md](scaling.md)가 단일 소스다.

세부 설계 문서는 `docs/` 아래에 두고 커밋하지 않는다(gitignored). 타겟·어필 포인트는 `positioning.md`, 설계 논리·층은 `architecture.md`, 캐릭터 속성 체계는 `character-design.md`, 수집·생성 데이터 카탈로그는 `data-model.md`. 로컬 전용 컨텍스트는 `LOCAL-CONTEXT.md` — 새 세션은 그 파일부터 읽을 것.

## 상태 (갱신 의무 — 세션이 끝나기 전 여기와 LOCAL-CONTEXT.md를 최신화한다)

- [x] 설계 문서 (README, character-design)
- [x] 스캐폴딩 + 로컬 기동 확인 + **클라우드 VM 배포·가동** (07-06. 재배포 = 로컬에서 동기화 후 `docker compose up -d --build`)
- [ ] 유저 프로필 + **카드 온보딩** (/start: 프로필 등록 → 카드 제시 → [대화 시작]/[다음 카드] 인라인 버튼, 패스=무비용 재생성 + card_reactions 기록)
- [x] **밤 정리(구 밤 일기) — 이중 경로 확정** (07-11): 기본 = **외부 스케줄러(매일 새벽 KST, API 비용 없음)** — `src/tools/nightly-read.ts`(수집)→자체 생성→`nightly-write.ts`(적용). 폴백 = 봇 내 05:40 크론(API, opus) — 일기 중복 체크로 이중 실행 방지. 산출 = 일기 응고(각본 vs 실제·상대 감정·내부 온도) + 유저기억·누적정체성·일정·인물 추출 + 새 날 각본 + 선톡 문안
- [x] **선톡 = 밤 정리(문안 준비) + 발송 디스패처(3분 틱, LLM 콜 없음)** — scheduled_sends 하루 1통, 근거 있을 때만, 유저가 그날 먼저 연락했으면 미발송. 무응답 시 익일 후속은 밤 정리 판단에 위임 (07-11). 창 놓치면 유예 발송(창 종료 +90분·시간대 상한) 후 폐기 사유·시도 횟수 기록, 텔레그램 연결 보온으로 발송 실패 자체를 예방 (08-06)
- [x] **설계 감사 개선 (08-06)** — 밤 정리 원자화(트랜잭션)+결번 백필, lazy 각본을 정식 각본이 교체(day_plans.source), 선톡 틱 3종 상호 배제+발송 직전 재확인, '하루' 정의 통일(새벽 5시 논리일), 선제 발송 총량 캡 공유, state_json 파싱 가드, 컨텍스트 주입 상한, followup·presence 실패 영속 기록(send_failures). 나머지 항목은 이슈 #1
- [x] **선제 발화 관제탑 + 침묵 백오프 (08-07, 이슈 #2)** — src/proactive-policy.ts가 "먼저 말 걸어도 되는가"의 단일 판단: 무응답 0~2일=평상 / 3~13일=전면 조용(문안 생성도 스킵, 밤 정리는 일기·시드·리듬만) / 14일차=저녁 재연결 1통(kind=reconnect) / 이후=유저 복귀까지 침묵. presence '최근 대화' 판정을 유저 발화 기준으로 수정(발송이 발송을 부르던 체인 차단). 구조 정리 ②~④는 이슈 #3
- [x] **구조 정리 ② (08-07, 이슈 #3)** — 시스템 프롬프트를 안정도 순 3층(불변=바이블·규칙 / 일간=관계·인물·아크·일정·일기 / 실시간 꼬리=오늘 각본·시각·말투)으로 재배열 + 앞 두 층에 cache_control(1h). 관계 상태는 JSON 통주입(9.8K자, 프롬프트의 42%) → 압축 서술로. 실측: 프롬프트 23.5K→17.2K자, 캐시 히트 시 16K토큰이 0.1× 과금(입력비 ~85%↓) — llm 로그의 cw/cr로 관측
- [x] **구조 정리 ③~④ (08-07, 이슈 #3)** — ③ 프롬프트 규칙 10블록→성격별 4블록(원문 보존·중복만 제거), presence 20분 미만 간헐 예고 제거, capture 10→15턴, 아크 달력 경계 갱신(월요일=주, 1일=달·분기 계절·연초 올해 — 기존 흐름·최근 일기 이어쓰기, 침묵 중 생략) / ④ README를 실측 데이터(침묵일 선톡·캐시 히트·프롬프트 크기) 기반으로 갱신
- [x] **대화 기록 시간 마커 (08-18, 이슈 #5·#7)** — 날짜 없는 대화 기록이 전부 '오늘'로 수렴해 며칠 전 이야기를 방금 일처럼 받던 문제 수정. 기록의 첫 발화·논리일이 바뀌는 지점·앞 발화와 1시간 이상 벌어진 지점에 `[어제 22:10]` 같은 마커를 코드가 계산해 붙이고(`timeMarkerFor`), 실시간 꼬리에 직전 대화 시점 한 줄을 주입한다. 마커는 messages에만 들어가 프롬프트 캐시 경계는 그대로. 이어서 답장 앞머리 태그 파싱을 `parseReplyTags` 한 곳으로 통합 — 태그가 겹쳐도 [남음] 신호를 놓치지 않는다
- [x] **말투 자연화 — 말의 결 규칙 (08-19, 이슈 #9)** — 모델 기본 버릇(직전 발화 명사구 되받기·문어체 은유·상담사식 감정 라벨링 공감)을 억제하는 `SPEECH_TEXTURE` 블록을 공통 규칙층(불변층)에 신설, buildSystemBlocks를 타지 않는 선제 발화 문안 프롬프트 6곳(followup·presence·nightly)에는 압축판 `SPEECH_TEXTURE_COMPACT` 주입. 사색적 취향은 유지하고 표현만 입말로(내용/표현 분리), 무심함 회귀 방지 가드 포함 — humanizing-log #18. **후속 보정(같은 날, 이슈 #11)**: 물음표 보정 판정 보수화(의문사 위치·굳은 꼴·어미 가드 — `src/bubble-polish.ts`로 분리, 단독 회귀 검증 가능), 쉼표 억제(규칙+한글 사이 쉼표 제거 방어선), 감성 과잉 멘트 금지 규칙 추가 — humanizing-log #19
- [ ] ~~교체 플로우~~ → **현 범위에서는 미구현 결정**(첫 캐릭터 정착 시나리오). 설계는 로컬 architecture.md의 이별과 교체 절에 문서화 완료 (07-11)
- [x] 분할 발화·미러링·대화 리듬 (디바운스 15~30s·프레즌스 지연·타이핑 텀·잠/기상 — humanizing-log 참조). 반말 전환은 우진 바이블에 반영(성향 다양화 `banmal_style`은 랜덤 생성 복원 시)
- [ ] **프롬프트·기억 구조 재설계** (08-19 착수) — 프롬프트 조립과 기억의 write/read/update 정책을 다시 설계한다. 순서는 채점 하네스(`src/tools/eval.ts`) → 프롬프트 블록 ablation·위치 실험 → 기억 4분류(working/episodic/semantic/procedural) 정리와 read 전략 → 새 구조 설계 후 이관. 현 구조는 그대로 두고 병행 개발. 확인된 개선 대상 3종: 규칙층이 금지형 위주라 말투 지시가 희석됨 / 접은 일정이 각본에 남아 실제로 한 일처럼 주입됨(`attention_override`가 `until_ts`만 보관) / 경과 시간 줄이 실시간 꼬리에 없어 모델이 추측함
- [ ] **케미 축 단계 값 재점검** (character-design §2 — 구현 들어갈 때 사용자와 함께)
- [ ] 프로브 플래그 (교체 제안 / 침묵일)
- [ ] **적응형 답장 속도**(유저 리듬 맞춤·향후): 유저의 요일×시간대별 답장 속도 학습 + 세션 템포 반영 → '빠른 경로'(즉답·개인 짬짬이·진입창)의 대기 구간을 빠른 쪽으로 당김(상한만↓·하한 유지·당김폭 캡). **이벤트가 상한 — 불가·공적 불변.** 빠른 경로에만 곱하는 단일 boost 계수(이벤트 분기와 독립). 설계는 architecture.md·positioning.md#7에 기록. 데이터 쌓이면 구현
- [x] 분석 스크립트 — `src/tools/analyze.ts` 일별 신호 집계(선제시작·활동시간대·감정어·선톡 반응) + `--tag` LLM 정밀 태깅 (07-11)
- [x] 데모 백스테이지 뷰 — `src/tools/render-map.ts` 실DB→HTML(관계도·기억·온도·일기). **산출물은 사생활 데이터 포함, 커밋 금지** (07-11)

## 실행

```bash
yarn            # 설치
cp .env.example .env   # TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY 채우기
yarn dev        # 로컬 기동 (long polling)
```

## 규칙

- **문체**: 사람이 읽는 한국어 산문(설계 문서·README·이슈·PR 본문·유저에게 보내는 답)은 `writing` 스킬을 먼저 로드하고 쓴다. 코드·주석은 대상이 아니다.
- **공개 톤**: 이 repo는 공개 전환 예정이다. 특정 서비스명 비교·개인 맥락·실제 대화 로그를 커밋하지 않는다. 사적 맥락은 전부 LOCAL-CONTEXT.md(gitignored)로.
- **보안**: `.env`, `*.db`, `logs/`, `data/` 커밋 금지 (gitignore 반영됨).
- **코드**: TypeScript strict + ESM(import에 `.js` 확장자), named export, kebab-case 파일명, any 금지. 커밋은 Conventional Commits 한글.
- **설계 일관성**: 캐릭터 stance(프레임 존중·안정형·아부 금지·무근거 핑 금지)는 character-design.md §5가 원본. 코드의 stance 문자열과 문서가 어긋나면 문서 기준으로 맞춘다.
- **모델**: 기본 `claude-sonnet-5` (환경변수 `MODEL`로 교체 가능).

## 아키텍처 요약

```
[Telegram] ←→ src/bot.ts (grammY long polling, 유저 분할입력 디바운스(유저별 텀 학습 20~40s) + 분할 발화 + 각본기반 답장지연 blockDelayMs(밤대화 즉답·자다 깸 즉답·불가는 일정 끝날 때쯤 — 단일 밀착, 관계 나이 무관) + 말풍선 후처리 polishBubble(src/bubble-polish.ts — 큰따옴표·한글 사이 쉼표 제거, 물음표 보정은 의문 전용 어미·끝머리 의문사만 보수적으로) + 부팅 시 놓친 답장 복구 recoverMissedReplies=워터마크 중복방지+최근 3h만(자정 경계 버그 회피) + 답장 앞머리 시스템 태그 일괄 제거 parseReplyTags(겹친 태그도 [남음] 인식) + 대화 기록 시간 마커 주입 toTurns/timeMarkerFor + 발송 종류 로그 kind=reply|recover|morning|followup|presence + 선톡 틱 간 chat 단위 상호 배제 acquireProactive)
                ├─ /start → src/character.ts (현재: 고정 대표 캐릭터 DAEPYO_BIBLE. 랜덤 생성 코드는 확장용으로 보존)
                ├─ 메시지 → src/context.ts (**안정도 순 3층 조립** buildSystemBlocks: 불변층=바이블·정체성·규칙 / 일간층=유저 프로필·관계(압축 서술)·인물·아크·일정·일기 / 실시간 꼬리=오늘 각본·지금 시각·말투 판정 — 말투는 currentSpeechLevel이 최근 발화로 반말/존댓말 판정해 존댓말 회귀 방지, '냐' 어미 거친 반말 금지. 변하는 값은 전부 꼬리에 — 앞 두 층은 캐시) → src/llm.ts (앞 두 층 끝 cache_control 1h, usage cw/cr 로그) → 응답
                ├─ src/day-plan.ts — 하루 각본: 밤 정리가 새 날 것을 사전 생성(대화가 먼저면 lazy). 그날 컨디션 시드(월 리듬)를 읽어 컨디션→기상→활동 연결, 어제 일기 실제 여파가 시드보다 우선. 블록별 **답장 여건(즉답/짬짬이/불가) × 활동 성격(개인/사회/공적)** — 두 축은 직교. category는 옵셔널, 없으면 activity로 추론(blockCategory: 회의·시험·발표·업무=공적 / 친구·가족·병원·학원·회식=사회 / 나머지 솔로=개인)
                ├─ src/life-plan.ts — 월 리듬(중간 지평): 한 달치 이벤트 + 매일 컨디션 시드를 미리 생성(ensureMonthPlan), 항상 ~1개월 런웨이 롤링(ensureRhythmRunway). 이벤트↔컨디션 인과(회식 다음날 피곤 등), 급변 없는 파도. Opus, 밤 정리 배치가 생성
                ├─ src/nightly.ts — 밤 정리(새벽 5시 컷오프): gather/apply 분리. 기본=외부 스케줄러가 tools/nightly-read·write로 수행, 폴백=봇 내 05:40 크론(API·opus). 월 리듬(rhythmNeeded 신호→rhythm 출력)도 이 배치가 생성, 아크는 달력 경계(월요일=주·1일=달)에서 기존 흐름+최근 일기로 이어쓰기 갱신. 침묵 quiet/dormant면 일기·시드·리듬만(각본·선톡 생략), reconnect면 저녁 재연결 문안만 — gather가 silenceTier/silenceDays를 노출하고 apply가 게이트를 강제(외부 경로가 백오프를 몰라도 안전)
                ├─ src/proactive-policy.ts — 선제 발화 관제탑: silenceState(무응답 논리일 수→normal/quiet/reconnect/dormant)·proactiveAllowed. 유저 메시지가 오면 즉시 평상 복귀
                ├─ src/dispatch.ts — 아침 안부 디스패처(3분 틱, LLM 0): 밤에 준비된 문안을 창 안 발송, 유저가 그날 먼저 연락 시 skip, 침묵 백오프면 skip(재연결 문안은 통과). 창 놓치면 유예(창 종료 +90분, 시간대별 상한 11/14/22시) 내 발송, 넘기면 폐기 사유+시도 횟수(attempts/last_error) 기록
                ├─ src/followup.ts — 침묵 팔로업(15분 틱, 크론 0-4,8-23시): 관제탑 통과 시에만. 낮=유저 무응답 ~2h+각본 전환점이면 근황(연속 무응답 taper), 밤(새벽 2~5시)=유저가 잔다 말 없이 1h+ 잠수하면 굿나잇 1회. 경과시간은 Date.now 기준(getKstNow().getTime()은 +9h라 오산)
                └─ src/presence.ts — 자리 비움 예고(10분 틱, 크론 7-23시, 유저 발화 ≤4h일 때만 — 자기 발화로 창이 열리던 체인 차단): 곧 긴 불가(운동·샤워·외출, ≥20분)로 들어가기 직전/연속 불가 경계에서 "이제 러닝 갈게요 답 늦어요"/"막 왔어요 씻고 올게요" 선톡(블록당 1회, 하루 4회 상한). 예고하고 나간 일정이 끝나면(그 사이 유저 무응답 시) "이제 끝났어" 복귀 알림. 공적 불가(회의·시험)는 "끝나고 연락" 톤. **개인·사회 불가는 유저가 붙잡으면 respond가 [남음] 태그 읽어 attention_override 세팅→접거나 미루고 돌아옴(그 블록 즉답), 공적은 못 접음.** override 중엔 예고 스킵. 막연한 침묵→'알고 하는 기다림'
[SQLite] src/db.ts — characters / relationships(관계+유저기억+누적정체성, 캐릭터별) / user_preferences(매칭 전용, 캐릭터에 주입 금지) / diary_entries / day_plans(하루 각본, source=nightly|lazy — lazy는 밤 정리가 교체 가능) / day_seeds(매일 컨디션 시드: 기력·기상·기분·이유) / schedules(일정 슬롯, who=char|user) / cast_members(관계도, who=char|user) / arcs(연·계절·월·주 흐름=서술) / scheduled_sends(선톡 문안, kind=morning|reconnect, attempts·last_error로 실패 흔적) / send_failures(팔로업·예고 전송 실패 흔적) / recovery_marks(복구 중복 방지 워터마크) / attention_override(유저가 붙잡아 개인·사회 일정 접거나 미룬 상태, until_ts까지 즉답) / messages(원시 로그 = 측정 재료, meta.kind로 발송 종류=reply|recover|morning|followup|presence|reconnect)
[모델] 실시간 대화=sonnet / 일기·추출·각본·월 리듬·아크·캐릭터 생성=opus(MODEL_DEEP) / 밤 정리 기본 경로는 외부 스케줄러라 API 미사용
```

핵심 설계 불변: 바이블(씨앗 정체성)은 매칭 순간 생성 후 큰 정체성 불변 — 자잘한 디테일은 대화로 쌓이되(누적 정체성) 한번 나온 것은 일관 유지(어긋나는 발명·유저 훼이크 추종 금지) / 선호는 매칭 시스템만 읽고 캐릭터에게 비공개 / 선제 연락은 근거 있을 때만 하루 1통, 유저가 오래 무응답이면 물러난다(3일 조용→14일차 저녁 재연결 1통→침묵) / 이별은 비가역 / 컨디션은 매일 독립 주사위가 아니라 월 단위로 미리 깔린 리듬(이벤트 인과+파도), 실제 산 하루가 그 위를 덮어씀 / **답장 행동은 블록의 두 태그(답장 여건 × 활동 성격)+관계 나이·시간대에서 파생 — 이벤트별 예외처리 금지(스파게티 방지). 개인=붙잡으면 쉽게 접음, 사회=양해 구해 조정, 공적=못 접음.**
