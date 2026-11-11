import { createServer } from "node:http";

const KEPT = 500;
const received: { at: string; method: string; url: string; headers: unknown; body: string }[] = [];

// Keeps what Aurral sends to its webhooks, so a test can read it back from /requests.
createServer((request, response) => {
  if (request.method === "GET" && request.url === "/requests") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(received));
    return;
  }
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    received.push({
      at: new Date().toISOString(),
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    received.splice(0, Math.max(0, received.length - KEPT));
    response.writeHead(204).end();
  });
}).listen(Number(process.env.PORT || 8080));
