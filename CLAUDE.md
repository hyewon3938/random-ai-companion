# random-ai-companion — 작업 가이드

프로필 없이 만나, 같은 달력을 살고, 먼저 물어봐주는 AI 대화 상대 PoC. 컨셉·가설·설계 총론은 [README.md](README.md), 캐릭터 속성 체계는 [docs/character-design.md](docs/character-design.md)가 단일 소스. 이 저장소 밖의 기획 사료 위치는 `LOCAL-CONTEXT.md`(gitignored, 로컬 전용) 참조 — 새 세션은 그 파일부터 읽을 것.

## 상태 (갱신 의무 — 세션이 끝나기 전 여기와 LOCAL-CONTEXT.md를 최신화한다)

- [x] 설계 문서 (README, character-design)
- [x] 스캐폴딩 + 로컬 기동 확인 + **OCI VM 배포·가동** (07-06, 컨테이너 `random-ai-companion`. 재배포 = 로컬에서 rsync 후 `docker compose up -d --build`)
- [ ] 유저 프로필 + **카드 온보딩** (/start: 프로필 등록 → 카드 제시 → [대화 시작]/[다음 카드] 인라인 버튼, 패스=무비용 재생성 + card_reactions 기록)
- [ ] 밤 일기 크론 (23:30 KST — 일기 + 관계 상태 패치 + **발송 계획 생성**)
- [ ] 발송 스케줄러 디스패처 (15분 틱, scheduled_sends, 발송 창 08:00\~22:30, 무응답 시 익일 오전 랜덤 후속 1회)
- [ ] 교체 플로우 (비가역 확인 + "어떤 점이 아쉬웠어?" → user_preferences)
- [ ] 분할 발화·미러링 (대화 리듬) + 반말 전환 성향(`banmal_style` — 성격 따라 제안/수락/유지 다양)
- [ ] **케미 축 단계 값 재점검** (character-design §2 — 구현 들어갈 때 사용자와 함께)
- [ ] 프로브 플래그 (교체 제안 / 침묵일)
- [ ] 분석 스크립트 (신호 4축 집계 + LLM 태깅 배치)

## 실행

```bash
yarn            # 설치
cp .env.example .env   # TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY 채우기
yarn dev        # 로컬 기동 (long polling)
```

## 규칙

- **공개 톤**: 이 repo는 제출 전 public 전환 예정. 특정 서비스명 비교·개인 맥락(일정·지원 관련)·실제 대화 로그를 커밋하지 않는다. 사적 맥락은 전부 LOCAL-CONTEXT.md(gitignored)로.
- **보안**: `.env`, `*.db`, `logs/`, `data/` 커밋 금지 (gitignore 반영됨).
- **코드**: TypeScript strict + ESM(import에 `.js` 확장자), named export, kebab-case 파일명, any 금지. 커밋은 Conventional Commits 한글.
- **설계 일관성**: 캐릭터 stance(프레임 존중·안정형·아부 금지·무근거 핑 금지)는 character-design.md §5가 원본. 코드의 stance 문자열과 문서가 어긋나면 문서 기준으로 맞춘다.
- **모델**: 기본 `claude-sonnet-5` (환경변수 `MODEL`로 교체 가능).

## 아키텍처 요약

```
[Telegram] ←→ src/bot.ts (grammY long polling)
                ├─ /start → src/character.ts (케미 축 코드 랜덤 → 바이블 LLM 생성) → 첫 인사
                ├─ 메시지 → src/context.ts (바이블+관계+최근 일기+KST) → src/llm.ts → 응답
                └─ 크론 2개 (src/index.ts): 밤 일기 23:30 · 아침 안부 08:30~09:10 — 시스템의 심장
[SQLite] src/db.ts — characters(바이블 불변) / relationships(관계 상태) / user_preferences(매칭 전용, 캐릭터에 주입 금지) / diary_entries / messages(원시 로그 = 측정 재료)
```

핵심 설계 불변: 바이블은 매칭 순간 통생성 후 불변(대화는 공개만, 발명 금지) / 선호는 매칭 시스템만 읽고 캐릭터에게 비공개 / 선제 연락은 근거 있을 때만 하루 1통 / 이별은 비가역.
