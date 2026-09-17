// 새벽 정리 수집 도구: 활성 캐릭터의 새벽 정리 입력(어제 대화·기억·관계·관계 단계·각본·아크 등)을 JSON으로 출력한다.
// 외부 scheduled task가 ssh로 호출해 이 출력을 읽고, 자체 지능으로 일기·추출·각본·선톡 문안을
// 생성한 뒤 nightly-write.ts로 반영한다. relation에는 코드가 센 단계 문턱 값과 처음, 시도할 플러팅
// 추천, 어제 의도가 들어 있다(relationship-stage.ts). 문턱은 relationForModel을 거쳐 반응 점수 평균
// 조건의 값과 기준을 빼고 sampled·met만 남긴다 — 봇 안 기억 정리 프롬프트와 같이 점수 숫자를 모델에
// 보이지 않는다.
// 사용: docker exec random-ai-companion npx tsx src/tools/nightly-read.ts
import { getActiveCharacters } from "../db.js";
import { gatherNightlyInput } from "../nightly.js";
import { relationForModel } from "../relationship-stage.js";

console.log(
  JSON.stringify(
    getActiveCharacters().map((c) => {
      const g = gatherNightlyInput(c);
      return { ...g, relation: relationForModel(g.relation) };
    }),
  ),
);
