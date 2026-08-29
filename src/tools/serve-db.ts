// 관리 대시보드를 요청마다 다시 그려 내보내는 읽기 전용 서버.
//
// 브라우저 새로고침이 곧 갱신이라 사본을 뜨는 단계가 없다. 화면을 만드는 코드는
// src/tools/db-view.ts에 있고 파일로 뽑는 쪽(src/tools/render-db.ts)과 같은 것을 쓴다.
//
// 화면에 대화 내용이 그대로 담기므로 접근 경로를 좁게 고정한다.
//  - 기본은 루프백 바인드다. 바꾸려면 DASHBOARD_HOST를 명시해야 하고, 그 값은
//    컨테이너 안에서 띄울 때만 쓴다. 밖에서 닿는 길은 호스트 루프백 공개 하나뿐이다.
//  - Host 헤더를 검사해 브라우저를 거친 다른 출처의 요청을 받지 않는다.
//  - GET 하나만 받고 DB는 읽기 전용으로 연다. 쓰는 길은 두지 않는다.
//
// 원격 DB는 봇과 같은 컨테이너 안에서 띄우고 포트는 호스트 루프백에만 공개한다.
// 의존성과 DB 접근 권한이 컨테이너 쪽에 있어서 호스트에서는 그대로 뜨지 않는다.
// 쓰는 중인 DB는 WAL이라 읽기 전용으로 열 때도 옆의 -shm 파일에 쓸 수 있어야 하는데,
// 그 조건은 봇과 같은 계정에서만 채워진다.
//
//   원격:  docker compose run --rm -p 127.0.0.1:8787:8787 \
//            -e DASHBOARD_HOST=0.0.0.0 app npx tsx src/tools/serve-db.ts
//   손앞:  ssh -L 8787:127.0.0.1:8787 <원격>   → http://127.0.0.1:8787
//
// 볼 때만 일회성 컨테이너로 띄우고 끄므로 상시 공개하는 포트를 만들지 않는다.
//
// 사용: DB_PATH=data/prod-snapshot.db npx tsx src/tools/serve-db.ts

import { createServer } from "node:http";
import { renderDbHtml } from "./db-view.js";

/**
 * 기본은 루프백이라 바깥에서 오는 연결을 커널이 아예 받지 않는다. 컨테이너 안에서
 * 띄울 때만 값을 준다 — 공개한 포트는 컨테이너의 루프백이 아니라 컨테이너 주소로
 * 들어오므로, 루프백에 묶어 두면 터널로도 닿지 않는다.
 */
const HOST = process.env.DASHBOARD_HOST ?? "127.0.0.1";

const port = Number(process.env.DASHBOARD_PORT ?? 8787);
const file = process.env.DB_PATH ?? "./data/companion.db";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** 바인드 주소 쪽 판정. Host 헤더와 달리 IPv6가 대괄호 없이 온다. */
const boundToLoopback = (host: string): boolean =>
  host === "127.0.0.1" || host === "::1" || host === "localhost";

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
  if (boundToLoopback(HOST)) {
    console.log(`원격이면 ssh -L ${port}:${HOST}:${port} <원격> 으로 잇는다`);
    return;
  }
  // 루프백 밖에 묶었으면 어디까지 닿는지는 포트를 어떻게 공개했느냐가 정한다.
  console.log(
    `루프백이 아닌 ${HOST}에 묶었다 — 포트는 127.0.0.1:${port}:${port} 로만 공개할 것`,
  );
});
