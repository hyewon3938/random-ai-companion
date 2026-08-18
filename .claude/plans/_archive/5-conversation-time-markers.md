# fix: 대화 기록에 시간 마커 주입 — 지난 대화를 같은 날 일로 오인하는 문제

## 이슈
- 번호: #5
- 브랜치: `fix/5-conversation-time-markers`
- design-notebook: 해당 없음 (이 프로젝트는 `docs/` 전체가 gitignored — 아래 "설계 기록" 참조)

## 개요

모델에 넘기는 대화 기록에 시간 정보가 하나도 없어서, 며칠 전 대화를 방금 전 일처럼 지칭하는 일이 생긴다. 기록에 시간 마커를 넣고, 직전 대화 시점을 실시간 꼬리에 한 줄로 주고, 마커가 답장으로 새 나가지 않게 막는다.

마커 문자열은 전부 **코드가 계산한다**. `src/kst.ts:63`의 기존 원칙("모델에게 시각 산수를 시키지 않는다")을 그대로 따른다 — 모델에게 `2026-08-15 21:40`을 주고 며칠 전인지 세게 하지 않는다.

## 원인 (확인된 것)

1. `toTurns`(src/bot.ts:270)가 DB 행에서 `text`만 쓰고 `ts`를 버린다. `getRecentMessages`(src/db.ts:262)는 `ts`를 이미 SELECT 하므로 스키마 변경은 필요 없다.
2. 연속 동일 role 메시지를 `\n`으로 병합한다. 무응답으로 며칠에 걸쳐 쌓인 선톡이 한 덩어리가 되어 날짜 구분이 구조적으로 불가능하다.
3. 시스템 프롬프트가 전부 '지금·오늘' 기준(`daySection`·`nowSection`)이라, 날짜 없는 기록은 자연히 오늘로 수렴한다.
4. 일기에는 날짜가 있지만 원시 기록이 더 구체적이라 충돌하면 기록 쪽이 이긴다.

## 확인한 제약 (설계 근거)

- **프롬프트 캐시에 영향 없다.** 캐시는 프리픽스 매칭이고 렌더 순서는 tools → system → messages다. 이 프로젝트는 `cache_control`을 시스템 블록에만 건다(src/llm.ts:34-48). 마커는 `messages` 배열에 들어가므로 캐시 프리픽스를 건드리지 않는다 — 비용은 마커 토큰값(메시지당 10자 안팎)뿐이다.
- **병합을 유지한다.** 연속 동일 role 턴을 나눠 보내는 방식은 쓰지 않는다. 마커를 병합된 본문 **안에** 넣으면 role 교대 규약과 무관하게 같은 효과를 얻는다 — 불필요한 API 규약 의존을 만들지 않는다.
- **`[...]` 대괄호는 이미 시스템 채널이다.** `[즉시]`·`[잠시후]`·`[한참후]`(context.ts RESPONSE_TIMING)와 `[남음]`(CATEGORY_RULE)이 답장 맨 앞에 붙고 `parsePresence`가 떼어낸다. 캐릭터 메시지는 태그가 제거된 뒤 로그에 저장되므로(bot.ts:492 `sent.join`) 기록에는 대괄호가 없다. 마커도 같은 표기를 쓰되, 모델이 흉내 내 답장에 찍는 사고는 출력 가드로 막는다.

## 변경 파일 목록

| 파일 | 변경 유형 | 설명 |
|------|----------|------|
| `src/kst.ts` | 수정 | 마커·경과일 계산 헬퍼 4종 추가 |
| `src/bot.ts` | 수정 | `toTurns` 마커 주입, `parsePresence` 태그 길이 확장, 낡은 주석 정정 |
| `src/db.ts` | 수정 | `lastMessageBefore(chatId, ts)` 추가 |
| `src/context.ts` | 수정 | 실시간 꼬리에 '직전 대화' 한 줄, FACT_CARE에 마커 규칙 한 줄 |
| `docs/time-and-memory.md` | 수정 | 결정 기록 (gitignored) |
| `README.md` | 수정 | 설계 2에 한 줄 |

## 구현 상세

### 1. `src/kst.ts` — 시간 마커 계산

**After:**
```typescript
// messages.ts는 KST 벽시계 문자열("YYYY-MM-DD HH:MM:SS", bot.ts nowIso).
// UTC 필드가 KST 값을 갖는 Date로 되돌린다 — getKstNow()와 같은 좌표계라 이후 계산이 일관된다.
const kstDateOf = (ts: string): Date => new Date(`${ts.replace(" ", "T")}Z`);

// 임의 시각의 논리일(새벽 5시 경계). kstLogicalDate()의 '지금' 전용 버전을 일반화한 것.
export const logicalDateOf = (ts: string): string =>
  kstDateString(new Date(kstDateOf(ts).getTime() - 5 * 3600_000));

// 오늘(논리일)로부터 며칠 전인지. 자정이 아니라 새벽 5시가 경계라, 새벽 2시 대화는 아직 '오늘'이다.
export const logicalDaysAgo = (
  ts: string,
  todayLogical: string = kstLogicalDate(),
): number =>
  Math.round(
    (Date.parse(`${todayLogical}T00:00:00Z`) -
      Date.parse(`${logicalDateOf(ts)}T00:00:00Z`)) /
      86_400_000,
  );

// 대화 기록 턴 앞에 붙일 시간 표시. 앞 메시지와 시간이 벌어진 지점에만 준다(매 턴에 붙이면 노이즈).
// null이면 붙이지 않는다. 며칠 전인지는 코드가 세어 말로 준다 — 모델에게 날짜 뺄셈을 시키지 않는다.
const MARKER_GAP_MS = 60 * 60 * 1000;

export const timeMarkerFor = (
  ts: string,
  prevTs: string | null,
  todayLogical: string = kstLogicalDate(),
): string | null => {
  const newBlock =
    prevTs === null ||
    logicalDateOf(prevTs) !== logicalDateOf(ts) ||
    kstDateOf(ts).getTime() - kstDateOf(prevTs).getTime() >= MARKER_GAP_MS;
  if (!newBlock) return null;
  const clock = ts.slice(11, 16);
  const ago = logicalDaysAgo(ts, todayLogical);
  if (ago <= 0) return clock;
  if (ago === 1) return `어제 ${clock}`;
  if (ago === 2) return `그저께 ${clock}`;
  return `${ago}일 전(${DAYS[kstDateOf(ts).getUTCDay()]}) ${clock}`;
};

// 시스템 프롬프트용 — 마지막으로 대화한 날을 사람 말로. 마커와 달리 날짜를 함께 준다.
export const lastTalkedLabel = (
  ts: string,
  todayLogical: string = kstLogicalDate(),
): string => {
  const d = kstDateOf(ts);
  const date = `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${DAYS[d.getUTCDay()]}`;
  const ago = logicalDaysAgo(ts, todayLogical);
  const rel = ago <= 0 ? "오늘" : ago === 1 ? "어제" : ago === 2 ? "그저께" : `${ago}일 전`;
  return `${rel}(${date}) ${ts.slice(11, 16)}`;
};
```

**설명:** 마커를 붙일지 말지의 판단까지 `kst.ts`가 갖는다. `bot.ts`는 "받은 문자열이 있으면 붙인다"만 한다. 시각 표현이 한 파일에 모여 있는 기존 구조(`kstVerbalTime`·`dayLabel`)를 따르고, 검증도 이 함수 하나만 두드리면 된다.

경계 판단은 세 가지 OR: 창의 첫 메시지 / 논리일이 바뀜 / 앞 메시지와 60분 이상 벌어짐. 이어지는 대화 중간에는 마커가 안 붙어 노이즈가 없고, 세션이 갈리는 지점에는 반드시 붙는다.

### 2. `src/bot.ts` — 마커 주입

**Before:**
```typescript
// 연속 동일 role 메시지 병합 (API는 user/assistant 교대를 기대)
const toTurns = (rows: { role: string; text: string }[]): ChatTurn[] => {
  const turns: ChatTurn[] = [];
  for (const row of rows) {
    const role = row.role === "user" ? "user" : "assistant";
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += `\n${row.text}`;
    else turns.push({ role, content: row.text });
  }
  if (turns[0]?.role === "assistant")
    turns.unshift({ role: "user", content: "(대화 시작)" });
  return turns;
};
```

**After:**
```typescript
// 연속 동일 role 메시지 병합 + 시간이 벌어진 지점에 시간 마커.
// 기록 자체에 시간이 없으면 모델이 며칠 전 대화를 방금 일로 읽는다(프롬프트가 전부 '지금' 기준이라
// 날짜 없는 기록은 오늘로 수렴한다). 마커는 병합된 본문 안에 넣어 role 교대 규약을 건드리지 않는다.
const toTurns = (rows: MessageRow[]): ChatTurn[] => {
  const turns: ChatTurn[] = [];
  let prevTs: string | null = null;
  for (const row of rows) {
    const role = row.role === "user" ? "user" : "assistant";
    const marker = timeMarkerFor(row.ts, prevTs);
    const text = marker ? `[${marker}] ${row.text}` : row.text;
    prevTs = row.ts;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += `\n${text}`;
    else turns.push({ role, content: text });
  }
  if (turns[0]?.role === "assistant")
    turns.unshift({ role: "user", content: "(대화 시작)" });
  return turns;
};
```

**설명:** 유저 턴과 캐릭터 턴 양쪽에 같은 규칙으로 붙인다. 캐릭터 턴을 빼면 무응답으로 며칠에 걸쳐 쌓인 선톡 덩어리(침묵 백오프 아래서도 최대 3~4통)의 날짜 구분이 그대로 남는다 — 이번 버그와 같은 형태다. 흉내 위험은 4번 가드로 막는다.

`{ role, text }` 구조 리터럴 대신 `MessageRow`(src/db.ts:148)를 받는다. 호출부는 `bot.ts:458` 하나뿐이라 시그니처 변경 영향이 없다.

### 3. `src/context.ts` — 직전 대화 한 줄

`src/db.ts`에 헬퍼를 먼저 추가한다:

```typescript
// 특정 시각 이전의 마지막 메시지 — '직전에 대화한 날'을 세는 데 쓴다.
export const lastMessageBefore = (chatId: string, ts: string): MessageRow | undefined =>
  db
    .prepare(
      `SELECT id, role, text, ts FROM messages WHERE chat_id = ? AND role IN ('user','char') AND ts < ? ORDER BY id DESC LIMIT 1`,
    )
    .get(chatId, ts) as MessageRow | undefined;
```

`buildSystemBlocks`의 **실시간 꼬리**(캐시 경계 뒤)에 넣는다. 오늘 논리일 시작 이전의 마지막 메시지를 찾아, 있으면 한 줄:

```typescript
// 직전에 대화한 날 — 오늘 기록만 보면 모델이 공백 자체를 인지하지 못한다.
// 실시간 꼬리에 둔다(매일 바뀌는 값이라 캐시 경계 앞에 두면 캐시를 깬다).
const prev = lastMessageBefore(chatId, logicalDayStartTs());
const lastTalkSection = prev
  ? `[직전 대화]\n마지막으로 대화한 날은 ${lastTalkedLabel(prev.ts)}다. 그 뒤로는 오늘 다시 연락이 닿았다.`
  : "";
```

삽입 위치는 `buildSystemBlocks`의 `live` 배열(src/context.ts:350) — `daySection` 앞에 넣는다. 배열이 `.filter(Boolean)`을 거치므로 빈 문자열이면 자동으로 빠진다. `kst.js` import에 `logicalDayStartTs`·`lastTalkedLabel`, `db.js` import에 `lastMessageBefore`를 추가한다.

**설명:** 마커가 개별 발화의 시점을 주는 것과 별개로, "얼마 만에 온 연락인가"는 한 줄로 못 박아 준다. 마커를 흘려 읽어도 공백 자체는 놓치지 않게 하는 이중 방어다. 오늘 이전 기록이 없으면(첫 대화) 줄을 넣지 않는다.

### 4. 가드 — 마커가 답장으로 새 나가지 않게

**Before (src/bot.ts:259):**
```typescript
  while ((m = text.match(/^\s*\[([^\]\n]{1,8})\]\s*/))) {
```

**After:**
```typescript
  // 길이 상한 20 — 응답 속도 태그(4자)뿐 아니라 모델이 흉내 낸 시간 마커("3일 전(금) 21:40")까지
  // 떼어내기 위한 값. 앞머리 대괄호는 어떤 형태든 시스템 채널이라 노출시키지 않는다.
  while ((m = text.match(/^\s*\[([^\]\n]{1,20})\]\s*/))) {
```

**설명:** 기존 주석이 이미 "앞머리 대괄호는 어떤 형태든 태그로 보고 전부 떼어낸다"고 선언한 의도를 길이만 맞춘다. 실제 마커 최대 길이는 `14일 전(월) 20:00` = 14자.

`src/context.ts`의 `FACT_CARE` 블록(불변층, 캐시됨)에 규칙 한 줄:

```
- 대화 기록에서 말 앞에 붙은 [어제 22:10] 같은 표시는 그 말을 언제 했는지 시스템이 붙여준 것이다. 며칠 전 이야기를 오늘 일처럼(아까·방금) 말하지 않는 데 쓰고, 네 답장에는 절대 쓰지 않는다.
```

### 5. 문서

- `docs/time-and-memory.md`에 "## 대화 기록의 시간 마커" 절 추가 — 두 시간축 문서의 연장선. 마커 경계를 왜 논리일(새벽 5시)로 잡았는지, 왜 코드가 계산하는지, 캐시에 영향이 없는 이유.
- `README.md` 설계 2의 "지시해도 안 지켜지는 건 코드가 값으로 만들어 넣는다" 항목에 시간 마커 사례를 한 문장 붙인다 (말투 판정·시각 말풀이와 같은 계열의 사례).

## 설계 기록 (ADR 대체)

**ADR 대상 여부**: 조건 2개 충족(대안이 있었다 / 판단 근거가 비자명하다). 다만 **이 프로젝트에는 `docs/adr/`·`docs/design-notebook/`·`docs/domains/`가 없고 `docs/` 전체가 gitignored**다(프로젝트 CLAUDE.md 규칙: 세부 설계 문서는 커밋하지 않는다). 그래서 ADR 파일 대신 기존 단일 소스인 `docs/time-and-memory.md`에 결정을 기록하고, 공개 요약은 README 한 줄로 남긴다.

**검토한 대안:**

- **A. 오늘 대화만 따로 묶어 준다** — 자정(또는 새벽 5시)을 넘겨 이어지는 대화가 중간에서 잘린다. 며칠 만에 온 연락일 때 직전 맥락이 통째로 사라져 "지난 이야기가 이어진다"는 설계 2의 결과를 깨뜨린다. 기각.
- **B. 기록을 날짜별 요약으로 대체** — 정보 손실이 크고 밤 정리(일기·관계 상태)와 역할이 겹친다. 원문 40개는 밤 정리가 못 잡는 결·뉘앙스를 담는 자리라 요약으로 바꾸면 남는 게 없다. 기각.
- **C. 턴에 시간 마커 주입 (채택)** — 정보 손실 0, 비용 거의 0(캐시 프리픽스 무관), 기존 원칙("코드가 시간 값을 만들어 넘긴다")과 같은 계열. 대가는 마커 흉내 위험 하나뿐이고 이미 있는 출력 가드로 막힌다.

**미룬 것:** `src/capture.ts`의 대화 포맷에는 시간이 없다(`src/nightly.ts:189`는 이미 `[HH:MM]`을 붙인다). capture는 한 세션 안의 지속적 사실만 뽑는 용도라 급하지 않다. 마커 도입 후 추출 품질을 보고 판단한다.

## 커밋 계획

1. `feat(kst): 대화 기록용 시간 마커 계산 추가` — `src/kst.ts`
2. `fix(bot): 대화 기록 턴에 시간 마커 주입` — `src/bot.ts`, `src/db.ts`
3. `feat(context): 직전 대화 시점 주입 + 마커 규칙` — `src/context.ts`
4. `docs: 대화 기록 시간 마커 설계 기록` — `docs/time-and-memory.md`, `README.md`

## 테스트 계획

프로젝트에 테스트 프레임워크가 없다(`package.json` scripts: dev/start/typecheck). 검증은 `yarn typecheck` + `tsx`로 순수 함수를 두드리는 방식으로 한다. **합성 데이터만 쓴다 — 실제 대화 로그·개인 맥락을 검증 출력에 넣지 않는다.**

- [ ] `yarn typecheck` 통과
- [ ] `timeMarkerFor`: 같은 논리일 5분 간격 → `null`
- [ ] `timeMarkerFor`: 같은 논리일 90분 간격 → `21:40` (날짜 라벨 없음)
- [ ] `timeMarkerFor`: 하루 전 → `어제 22:10` / 이틀 전 → `그저께 …` / 사흘 전 → `3일 전(금) …`
- [ ] `timeMarkerFor`: 새벽 3시 메시지가 전날 논리일로 묶여 "오늘"로 나오는지 (자정 경계가 아님을 확인)
- [ ] `toTurns`: 합성 행 8개(오늘 3 + 3일 전 3 + 캐릭터 연속 2)로 마커가 경계에만 붙는지, 병합이 깨지지 않는지 육안 확인
- [ ] `parsePresence`: `[3일 전(금) 21:40] 안녕` → 마커 제거 후 `안녕`
- [ ] `parsePresence`: 기존 `[한참후]` 지연 판정이 그대로인지 (회귀 확인)

## 완료 게이트 (DoD)

- **끝 상태**: 구현 상세 1~5 전부 반영 + `yarn typecheck` 통과 + 위 테스트 계획 8항목 전부 실행 + PR 생성
- **증명 방법**: `yarn typecheck` 출력과 `tsx` 검증 스크립트 출력(입력→기대값→실제값)을 대화에 표시, PR 링크 제시
- **제약**: 계획서에 없는 파일 변경 없음 / 검증에 실제 대화 로그·개인 맥락 사용 금지(합성 데이터만) / DB 스키마 변경 없음 / 프롬프트 캐시 경계(`cache_control` 위치) 변경 없음
- **턴 상한**: 25턴 초과 시 중단하고 상황 보고

## 체크리스트
- [ ] TypeScript strict + ESM(`.js` 확장자) + named export + `any` 금지
- [ ] 커밋은 Conventional Commits 한글
- [ ] 민감 정보 하드코딩 없음 / 공개 텍스트(이슈·PR·커밋)에 개인 맥락·실제 로그 없음
- [ ] `docs/`·`*.db`·`logs/` 커밋 안 됨
- [ ] 캐시 경제성 회귀 없음 — 배포 후 `[llm]` 로그의 `cr`(캐시 읽기)이 종전과 같은 수준인지 확인
