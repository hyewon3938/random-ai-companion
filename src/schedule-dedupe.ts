// 같은 일정인지 가리는 자리 — 공백·기호를 지운 내용으로 견준다.
//
// 쓰는 곳이 둘이다. 새벽 정리가 대화에서 뽑은 일정을 넣기 전에 이미 저장된 행과 견주는 자리
// (nightly.ts)와, 이미 쌓인 중복을 지우는 도구(tools/dedupe-schedules.ts)다. 두 자리가 서로
// 다른 기준으로 견주면 쓰는 쪽이 남긴 행을 지우는 쪽이 지운다.
//
// 견주는 것은 글자뿐이다. 뜻이 비슷한지는 보지 않는다 — 같은 일을 다르게 적은 줄은 여기서
// 다른 일정이고, 그 판단은 프롬프트에 실린 [이미 저장된 일정] 목록을 보는 모델 몫이다.

// 견줄 모양으로 만든다: 전각·반각을 하나로 모으고(NFKC), 글자와 숫자만 남긴다.
// 공백·가운뎃점·괄호·물결표 같은 표기 차이가 여기서 지워진다.
export const normalizeScheduleContent = (content: string): string =>
  content
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

// 글자와 숫자가 하나도 없는 내용(기호뿐인 줄)은 같다고 보지 않는다 — 서로 다른 일정이
// 빈 문자열 하나로 뭉쳐 한 줄만 남는 것을 막는다.
export const isSameScheduleContent = (a: string, b: string): boolean => {
  const na = normalizeScheduleContent(a);
  return na.length > 0 && na === normalizeScheduleContent(b);
};
