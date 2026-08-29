// 관리 대시보드를 파일 한 장으로 뽑는다. 화면을 만드는 코드는 src/tools/db-view.ts에 있다.
//
// 사본을 보거나 지금 화면을 남겨 둘 때 쓴다. 운영 DB를 그대로 보려면
// src/tools/serve-db.ts를 띄우는 쪽이 사본을 뜨는 단계가 없어 짧다.
//
// 사용: DB_PATH=data/prod-snapshot.db npx tsx src/tools/render-db.ts > docs/dashboard.html
//       DB_PATH=data/prod-snapshot.db npx tsx src/tools/render-db.ts docs/dashboard.html
// 주의: 출력물에 실제 대화가 담기므로 저장소·공개 영역에 커밋하지 않는다.

import { writeFileSync } from "node:fs";
import { renderDbHtml } from "./db-view.js";

const file = process.env.DB_PATH ?? "./data/companion.db";
const out = process.argv[2];

const html = renderDbHtml(file);

// 나갈 곳을 인자로 받으면 그 파일에 쓰고, 없으면 그대로 흘려보낸다.
if (out) {
  writeFileSync(out, html);
  console.error(`${out} — ${file}에서 ${html.length.toLocaleString("ko-KR")}자`);
} else {
  console.log(html);
}
