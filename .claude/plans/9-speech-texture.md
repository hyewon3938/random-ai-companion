# 캐릭터 말투 자연화: 문어체 표현·상담사식 공감 억제

## 이슈
- 번호: #9
- 브랜치: `fix/9-speech-texture`

## 개요
캐릭터 발화에 문어체·번역투 표현(직전 발화의 명사구 되받기, 상태 명사 주어 은유)과 상담사식 공감(감정 라벨링·재진술·매 턴 공감 뒤 질문)이 섞여 몰입을 깬다. 모델의 기본 버릇이라 캐릭터 개성층이 아닌 공통 규칙층에 말의 결 블록을 신설하고, 답장 경로와 선제 발화 경로 양쪽에 반영한다. 사색적인 대화 내용은 캐릭터 취향대로 두고 표현만 입말로 제한한다(내용/표현 분리).

## 변경 파일 목록
| 파일 | 변경 유형 | 설명 |
|------|----------|------|
| `src/context.ts` | 수정 | `SPEECH_TEXTURE` 블록 신설 + 불변층 조립에 배선 + `SPEECH_TEXTURE_COMPACT` export |
| `src/followup.ts` | 수정 | 굿나잇·근황 문안 프롬프트 2곳에 압축판 주입 |
| `src/presence.ts` | 수정 | 자리 비움 예고·복귀 문안 프롬프트 2곳에 압축판 주입 |
| `src/nightly.ts` | 수정 | 아침 안부·재연결 문안 프롬프트 2곳에 압축판 주입 |
| `docs/humanizing-log.md` | 수정(로컬 전용, gitignored) | 관찰/고침 형식 새 항목 추가 |
| `docs/character-design.md` | 수정(로컬 전용, gitignored) | §3에 말의 결 공통 규칙 존재를 한 줄 보강 |
| `CLAUDE.md` | 수정 | 상태 섹션에 이번 작업 반영 |

## 구현 상세

### 1. `src/context.ts` — SPEECH_TEXTURE 블록 신설 + 배선

`FACT_CARE` 아래에 새 상수를 추가한다.

**After (신규 블록):**
```typescript
// 말의 결 — 모델이 기본으로 쓰는 문어체·상담사식 화법을 입말로 교정한다. 전 캐릭터 공통:
// 캐릭터 개성이 아니라 "사람이 입으로 하는 말"의 최저선이다. 사색적인 내용을 나누는 것은
// 캐릭터 취향의 영역이고, 여기서는 표현만 다룬다(내용/표현 분리).
const SPEECH_TEXTURE = `[말의 결 — 사람이 입으로 하는 말만]
- 상대가 방금 한 말을 명사로 포장해 되받지 않는다("그 소식에", "그 얘기 듣고", "그 일 때문에"). 받아야 하면 뭉뚱그리거나("그럴 때", "그런 거 들으면") 그냥 내용으로 바로 반응한다.
- 글에서만 쓰는 은유를 입에 올리지 않는다. 하루·마음·공기 같은 명사를 주어로 세워 가라앉다·내려앉다·물들다·스며들다 하지 않는다. 예: "하루가 다 가라앉았을텐데" ✕ → "아무것도 못 하고 그랬을텐데" ○. 사색적인 생각을 나누는 건 네 취향이지만, 표현은 언제나 입말이다.
- 네 감정을 정돈된 문장으로 서술하지 않는다. 사람은 자기 마음을 매끈하게 요약하지 못한다 — 조금 흐리고 덜 정돈된 채로 말한다.
- 공감을 상담사처럼 하지 않는다: 상대 말 요약·되풀이 ✕("~해서 힘들었겠네요"), 감정 이름 붙이기 ✕("속상했겠다", "힘드셨겠어요"). 친구는 그 대신 짧은 리액션(헐, 아 진짜요?), 자기 생각("아니 그건 좀 심했는데"), 자기 경험, 장난, 구체적인 후속 질문으로 마음을 표현한다.
- 상대의 모든 말에 하나하나 반응하지 않는다. 여러 얘기가 와도 제일 반응이 가는 하나에만 반응하고 나머지는 흘린다. 가끔은 공감 없이 자기 얘기로 받는 게 더 사람답다.
- 매번 같은 짜임(공감 한 마디 → 질문)으로 답하지 않는다. 어떤 답은 리액션만, 어떤 답은 질문만, 어떤 답은 네 얘기만.
- 위 예시 문구를 그대로 베끼지 않는다. 결만 가져온다.
- 관심은 공감 문구가 아니라 구체성으로 보여준다 — 기억하고 있는 것, 디테일을 묻는 것. 무심해지라는 게 아니다.`;
```

**Before (조립부, `src/context.ts:334`):**
```typescript
    `${RULES}\n\n${FACT_CARE}`,
```

**After:**
```typescript
    `${RULES}\n\n${SPEECH_TEXTURE}\n\n${FACT_CARE}`,
```

**설명:** 불변층이라 배포 직후 한 번 캐시가 무효화되고 이후 다시 캐시된다(수용 가능). 대화 방식(RULES)과 붙여 한 덩어리로 읽히게 배치한다. 기존 규칙 블록은 건드리지 않는다 — 특히 DEVOTION(안정형 헌신)은 태도의 영역이라 이번 범위 밖.

### 2. `src/context.ts` — 압축판 export

선제 발화 문안 프롬프트는 `buildSystemBlocks`를 타지 않으므로 같은 결을 압축한 한 줄을 별도로 export한다. `speechGuard`처럼 앞에 공백을 둔 이어붙임 형태.

**After (신규 export):**
```typescript
// 선제 발화 문안 프롬프트용 압축판 — followup·presence·nightly는 buildSystemBlocks를
// 타지 않아서 말의 결 규칙이 닿지 않는다. 문안은 짧으니 핵심만 압축해 주입한다.
export const SPEECH_TEXTURE_COMPACT = ` [말의 결: 글에서만 쓰는 은유·정돈된 감정 서술 금지, 입말로. 상대 말을 "그 소식/그 얘기"처럼 명사로 되받지 않기. 상담사식 공감("힘들었겠다"류 감정 라벨링) 금지 — 친구처럼 리액션·자기 얘기로.]`;
```

### 3. 선제 발화 프롬프트 6곳 주입

`speechGuard(chatId)` 바로 뒤에 이어붙인다. 대상:

- `src/followup.ts:61` (goodnightPrompt), `src/followup.ts:74` (followupPrompt) — `currentBlock`을 이미 context.js에서 import 중이라 import 문에 추가만
- `src/presence.ts:80`, `src/presence.ts:109` — import 추가
- `src/nightly.ts:477`, `src/nightly.ts:509` — import 추가

**Before (패턴, 6곳 공통):**
```typescript
... ${bible.voice.ending}${speechGuard(chatId)}
```

**After:**
```typescript
... ${bible.voice.ending}${speechGuard(chatId)}${SPEECH_TEXTURE_COMPACT}
```

**설명:** context.ts는 followup/presence/nightly를 import하지 않으므로 순환 참조 없음(followup.ts가 이미 context.js를 import하는 선례 있음). nightly.ts 2곳은 `bible.voice.ending`이 없는 형태(`${JSON.stringify(g.bible.identity)}${speechGuard(g.chatId)}`)이니 그 뒤에 동일하게 붙인다.

### 4. 문서 갱신 (로컬 전용 + CLAUDE.md)

- `docs/humanizing-log.md`: 새 항목(관찰: 문어체 은유·명사구 되받기·상담사식 공감 / 고침: 말의 결 공통 블록 + 선톡 압축판). 항목 #12(담백함이 무심함으로 넘어간 사례)와의 관계 — 이번 가드 마지막 줄이 그 회귀를 막는다는 메모 포함.
- `docs/character-design.md` §3: 말의 결 공통 규칙이 캐릭터 개성과 별개 층으로 존재한다는 한 줄.
- `CLAUDE.md` 상태 섹션: 이번 작업 한 줄 추가.

## ADR 작성

**대상 여부**: no — 프롬프트 텍스트 수정이라 되돌리기 쉽고, 장기 구조 영향이 없다(5조건 중 "대안이 있었다" 하나만 해당).

## 커밋 계획
1. `fix(bot): 말의 결 규칙 신설 — 문어체 표현·상담사식 공감 억제` — src/context.ts, src/followup.ts, src/presence.ts, src/nightly.ts
2. `docs: 말투 자연화 상태 반영` — CLAUDE.md (docs/ 밑 두 파일은 gitignored라 커밋 없음)

## 테스트 계획
- [ ] `yarn typecheck` 통과
- [ ] `grep -c "SPEECH_TEXTURE_COMPACT" src/followup.ts src/presence.ts src/nightly.ts` — 각각 import 1 + 사용 2 = 3
- [ ] `grep -n "SPEECH_TEXTURE" src/context.ts` — 블록 정의·조립 배선·compact export 확인

## 완료 게이트 (DoD)

- **끝 상태**: 구현 상세 1~4 전부 반영, `yarn typecheck` 통과, PR 생성(base main, `Closes #9` 포함)
- **증명 방법**: typecheck 실행 출력·grep 확인 출력·PR 번호를 대화에 표시
- **제약**: 계획서에 없는 파일 변경 금지. 기존 규칙 블록(STANCE·RULES·DEVOTION 등) 내용 수정 금지 — 신설과 배선만. 커밋·PR 본문에 실제 대화 인용 금지(언어 패턴 조각만 허용)
- **턴 상한**: 20턴 초과 시 중단하고 상황 보고

## 배포 메모
머지 후 VM 재배포(`docker compose up -d --build`)가 있어야 실제 반영된다. 배포 실행은 사용자 확인 후.

## 체크리스트
- [ ] 프로젝트 컨벤션 규칙 준수 (TS strict·ESM `.js` import·named export)
- [ ] 민감 정보 하드코딩 없음
- [ ] 타입 안전성 확인
- [ ] 에러 핸들링 포함 (해당 없음 — 상수·문자열 주입만)
- [x] ADR 작성 필요 여부 판단 완료 (no)
