import { readFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import path from "node:path";
import { text } from "node:stream/consumers";
import tls from "node:tls";
import { loadCatalogue } from "../catalogue/catalogue.ts";
import { hostIssuer } from "../outside/certificates.ts";
import { outsideByHost } from "../outside/index.ts";
import { indexMusic } from "../outside/music.ts";

// The stand-in for the internet. Aurral under Eden sends every outside request through
// this proxy, which answers for the services it knows and refuses the rest, so
// nothing a test does reaches a real service. HTTPS works because Aurral trusts
// Eden's certificate authority, which signs a certificate for whichever host is asked for.

const PORT = Number(process.env.PORT || 8080);
const AUTHORITY_DIR = process.env.EDEN_OUTSIDE || "/outside";
const KEPT_REQUESTS = 2000;

const issue = hostIssuer({
  certificate: readFileSync(path.join(AUTHORITY_DIR, "ca.pem"), "utf8"),
  key: readFileSync(path.join(AUTHORITY_DIR, "ca-key.pem"), "utf8"),
});
const contexts = new Map<string, tls.SecureContext>();
const music = indexMusic(loadCatalogue());
const requests: { host: string; method: string; path: string; body: string }[] = [];
const refused = new Set<string>();

const send = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
};

async function answer(url: URL, request: IncomingMessage, response: ServerResponse) {
  const method = request.method ?? "GET";
  const body = await text(request);
  requests.push({ host: url.hostname, method, path: `${url.pathname}${url.search}`, body });
  if (requests.length > KEPT_REQUESTS) requests.shift();
  const service = outsideByHost.get(url.hostname);
  const found = service?.respond({ url, method, body }, music);
  if (found !== undefined) return send(response, 200, found);
  const what = service ? `${url.hostname}${url.pathname}` : url.hostname;
  if (!refused.has(what)) console.log(`no stand-in for ${what}`);
  refused.add(what);
  send(response, service ? 404 : 502, { error: `Eden has no stand-in for ${what}` });
}

const guarded =
  (handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>) =>
  (request: IncomingMessage, response: ServerResponse) => {
    handler(request, response).catch((error: unknown) => {
      console.error(error);
      if (!response.headersSent) send(response, 500, { error: String(error) });
    });
  };

const secure = https.createServer(
  {
    SNICallback(host, done) {
      let context = contexts.get(host);
      if (!context) contexts.set(host, (context = tls.createSecureContext(issue(host))));
      done(null, context);
    },
  },
  guarded((request, response) =>
    answer(new URL(request.url ?? "/", `https://${request.headers.host}`), request, response),
  ),
);

const proxy = http.createServer(
  guarded(async (request, response) => {
    const target = request.url ?? "/";
    if (!target.startsWith("/")) return answer(new URL(target), request, response);
    if (target === "/health") return send(response, 200, { hosts: outsideByHost.size });
    if (target === "/requests") return send(response, 200, requests);
    send(response, 404, { error: "Not found" });
  }),
);

proxy.on("connect", (_request, socket, head) => {
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (head.length > 0) socket.unshift(head);
  secure.emit("connection", socket);
});

proxy.listen(PORT, () => console.log(`Eden outside: ${outsideByHost.size} hosts on :${PORT}`));
