import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { getRequestListener } from "@hono/node-server";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { serveFrontend } from "../backend/routes/frontend.ts";
import { createMockHttpServer } from "./helpers/backendTestHarness.ts";

const dist = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-frontend-dist-"));
let server: Awaited<ReturnType<typeof createMockHttpServer>>;

beforeAll(async () => {
  await fs.mkdir(path.join(dist, "assets"));
  await Promise.all(
    Object.entries({
      "index.html": "html",
      "index.html.br": "html-br",
      "index.html.gz": "html-gz",
      "assets/app.js": "js",
      "assets/app.js.gz": "js-gz",
      "assets/plain.js": "plain",
    }).map(([file, body]) => fs.writeFile(path.join(dist, file), body)),
  );
  server = await createMockHttpServer(getRequestListener(serveFrontend(dist).fetch));
});

afterAll(async () => {
  await server?.close();
  await fs.rm(dist, { recursive: true, force: true });
});

const get = (pathname: string, acceptEncoding?: string) =>
  new Promise<{ body: string; encoding?: string; type?: string; vary?: string }>(
    (resolve, reject) => {
      const headers = acceptEncoding === undefined ? {} : { "Accept-Encoding": acceptEncoding };
      http
        .get(`${server.url}${pathname}`, { headers }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (body += chunk));
          res.on("end", () =>
            resolve({
              body,
              encoding: res.headers["content-encoding"],
              type: res.headers["content-type"],
              vary: res.headers.vary,
            }),
          );
        })
        .on("error", reject);
    },
  );

test("serves the best precompressed file the client accepts", async () => {
  const cases = [
    ["/assets/app.js", "gzip, deflate, br", "js-gz", "gzip"],
    ["/assets/app.js", "br", "js", undefined],
    ["/assets/app.js", undefined, "js", undefined],
    ["/assets/plain.js", "gzip, br", "plain", undefined],
    ["/library", "gzip, deflate, br", "html-br", "br"],
    ["/library", "br;q=0, gzip", "html-gz", "gzip"],
    ["/library", "identity", "html", undefined],
  ] as const;
  for (const [pathname, acceptEncoding, body, encoding] of cases) {
    const res = await get(pathname, acceptEncoding);
    const label = `${pathname} with ${acceptEncoding}`;
    assert.equal(res.body, body, label);
    assert.equal(res.encoding, encoding, label);
    assert.equal(res.vary, "Accept-Encoding", label);
    assert.match(res.type ?? "", pathname.endsWith(".js") ? /javascript/ : /html/, label);
  }
});
