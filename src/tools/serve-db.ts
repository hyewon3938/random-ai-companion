// 관리 대시보드를 요청마다 다시 그려 내보내는 읽기 전용 서버.
//
// 브라우저 새로고침이 곧 갱신이라 사본을 뜨는 단계가 없다. 화면을 만드는 코드는
// src/tools/db-view.ts에 있고 파일로 뽑는 쪽(src/tools/render-db.ts)과 같은 것을 쓴다.
//
// 화면에 대화 내용이 그대로 담기므로 접근 경로를 좁게 고정한다.
//  - 루프백에만 바인드한다. 주소는 여기 고정이고 환경변수로 바꾸지 못한다.
//  - Host 헤더를 검사해 브라우저를 거친 다른 출처의 요청을 받지 않는다.
//  - GET 하나만 받고 DB는 읽기 전용으로 연다. 쓰는 길은 두지 않는다.
//
// 원격 DB를 볼 때도 포트를 공개하지 않는다. 컨테이너 포트를 내보내는 대신
// DB 파일이 놓인 호스트에서 그대로 띄우고, 손에서는 SSH 터널로 잇는다.
//
//   원격:  DB_PATH=<db 경로> npx tsx src/tools/serve-db.ts
//   손앞:  ssh -L 8787:127.0.0.1:8787 <원격>   → http://127.0.0.1:8787
//
// 쓰는 중인 DB는 WAL이라 옆에 -shm 파일이 있어야 읽을 수 있다. 봇과 같은 계정으로
// 띄우면 그 조건이 채워진다.
//
// 사용: DB_PATH=data/prod-snapshot.db npx tsx src/tools/serve-db.ts

import { createServer } from "node:http";
import { renderDbHtml } from "./db-view.js";

/** 루프백 고정. 바깥에서 오는 연결은 커널이 아예 받지 않는다. */
const HOST = "127.0.0.1";

const port = Number(process.env.DASHBOARD_PORT ?? 8787);
const file = process.env.DB_PATH ?? "./data/companion.db";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * 루프백 이름으로 온 요청만 받는다. 다른 이름이 우리 주소를 가리키게 해 두고
 * 브라우저를 통해 화면을 읽어 가는 길을 막는다.
 */
const allowedHost = (host: string | undefined): boolean => {
  if (!host) return false;
  const name = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : host.split(":")[0];
  return LOOPBACK.has(name);
};

const plain = (
  res: import("node:http").ServerResponse,
  code: number,
  body: string,
  headers: Record<string, string> = {},
): void => {
  res.writeHead(code, {
    "content-type": "text/plain; charset=utf-8",
    ...headers,
  });
  res.end(`${body}\n`);
};

const server = createServer((req, res) => {
  if (!allowedHost(req.headers.host)) {
    plain(res, 403, "허용하지 않는 Host");
    return;
  }
  if (req.method !== "GET") {
    plain(res, 405, "GET만 받는다", { allow: "GET" });
    return;
  }

  const path = (req.url ?? "/").split("?")[0];

  // 파비콘까지 화면을 다시 그리면 새로고침 한 번에 DB를 두 번 읽는다.
  if (path === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (path !== "/") {
    plain(res, 404, "없는 주소");
    return;
  }

  const started = Date.now();
  try {
    const html = renderDbHtml(file);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      // 새로고침이 갱신이 되려면 이전 응답이 남아 있으면 안 된다.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    res.end(html);
    console.log(
      `그림 — ${html.length.toLocaleString("ko-KR")}자 · ${Date.now() - started}ms`,
    );
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    console.error(`그리지 못함 — ${why}`);
    plain(res, 500, `그리지 못했다: ${why}`);
  }
});

server.listen(port, HOST, () => {
  console.log(`http://${HOST}:${port} — ${file}`);
  console.log(`원격이면 ssh -L ${port}:${HOST}:${port} <원격> 으로 잇는다`);
});
