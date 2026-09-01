// CLAUDE.md 크기 검사 — 세션마다 컨텍스트에 통째로 들어가는 지시서라 상한을 둔다.
//
// 커밋될 내용(인덱스)을 읽는다. 작업 트리 파일을 읽으면 아직 스테이지하지 않은 편집까지 세어
// 커밋되는 것과 다른 숫자가 나온다. 글자 수는 node로 센다 — `wc -m`은 한글에서 부정확하다.
import { execFileSync } from "node:child_process";

const FILE = "CLAUDE.md";
const LIMIT = 20000;

const staged = () => {
  try {
    return execFileSync("git", ["show", `:${FILE}`], { encoding: "utf8" });
  } catch {
    // 인덱스에 없는 경우(파일을 지우는 커밋, 첫 커밋)는 검사할 것이 없다.
    return null;
  }
};

const text = staged();
if (text !== null) {
  const chars = [...text].length;
  if (chars > LIMIT) {
    console.error(
      `[check-claude-md] ${FILE}가 ${chars.toLocaleString()}자로 상한 ${LIMIT.toLocaleString()}자를 넘었습니다.`,
    );
    console.error(
      `[check-claude-md] 상한을 올리지 말고 상태 절에서 끝난 항목부터 줄이세요(CLAUDE.md 규칙 절).`,
    );
    process.exit(1);
  }
}
