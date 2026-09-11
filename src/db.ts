// 저장 함수의 단일 입구. src/db/ 아래 표 묶음 파일을 전부 다시 내보낸다.
//
// 표 정의와 마이그레이션은 db/connection.ts, 표마다 행을 넣고 빼는 함수는 db/의 묶음 파일에
// 있다. 부르는 쪽은 이 파일 하나만 import한다 — 묶음이 늘거나 나뉘어도 임포터를 고치지 않는다.
// 묶음 파일끼리는 이 파일을 부르지 않는다(순환).
//
// 문화 스크립트 원본(db/culture-scripts.ts)만 표가 아니라 데이터인데, 그 표를 읽는 쪽이 원본의
// 별칭 목록도 같이 봐야 해서 여기서 함께 내보낸다.

export * from "./db/connection.js";
export * from "./db/characters.js";
export * from "./db/relationship.js";
export * from "./db/messages.js";
export * from "./db/life.js";
export * from "./db/sends.js";
export * from "./db/llm-calls.js";
export * from "./db/trace-events.js";
export * from "./db/feedback.js";
export * from "./db/memory-items.js";
export * from "./db/culture-scripts.js";
