import { appendFileSync, readFileSync } from "node:fs";
import http from "node:http";
import { createBrainzmash } from "./brainzmash.mjs";
import { createLidarr } from "./lidarr.mjs";
import { createSlskd } from "./slskd.mjs";

const catalog = JSON.parse(readFileSync(new URL("../fixtures/catalog.json", import.meta.url), "utf8"));
const journalPath = process.env.AURRAL_LAB_JOURNAL;
const journal = [];
const faults = [];

const providers = [
  { name: "brainzmash", port: 8601, handle: createBrainzmash(catalog) },
  { name: "lidarr", port: 8686, handle: createLidarr(catalog, { apiKey: process.env.AURRAL_LAB_LIDARR_API_KEY }) },
  { name: "slskd", port: 5030, handle: createSlskd(catalog, { apiKey: process.env.AURRAL_LAB_SLSKD_API_KEY }) },
];

function record(entry) {
  journal.push(entry);
  if (journal.length > 5000) journal.shift();
  if (journalPath) appendFileSync(journalPath, `${JSON.stringify(entry)}\n`);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function send(response, { status, body, headers }) {
  if (status === 204) {
    response.writeHead(204, headers);
    return response.end();
  }
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body ?? null));
}

function takeFault(provider, method, pathname) {
  const fault = faults.find(
    (entry) => entry.provider === provider && (!entry.method || entry.method === method) && pathname.startsWith(entry.path),
  );
  if (!fault) return null;
  if (--fault.remaining === 0) faults.splice(faults.indexOf(fault), 1);
  return fault;
}

for (const provider of providers) {
  http
    .createServer(async (request, response) => {
      const url = new URL(request.url, `http://fixtures:${provider.port}`);
      const body = await readBody(request);
      const fault = takeFault(provider.name, request.method, url.pathname);
      let result = fault
        ? { status: fault.status, body: { error: `Injected Lab fault for ${provider.name}` } }
        : await provider.handle({ method: request.method, url, headers: request.headers, body });
      const unsupported = !result;
      if (unsupported) {
        result = {
          status: 501,
          body: { error: `The Lab ${provider.name} fixture does not implement ${request.method} ${url.pathname}` },
        };
        console.error(`unsupported ${provider.name} request: ${request.method} ${url.pathname}${url.search}`);
      }
      record({
        at: new Date().toISOString(),
        provider: provider.name,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        status: result.status,
        ...(unsupported ? { unsupported: true } : {}),
        ...(fault ? { fault: true } : {}),
      });
      send(response, result);
    })
    .listen(provider.port);
}

http
  .createServer(async (request, response) => {
    const url = new URL(request.url, "http://fixtures:9000");
    if (request.method === "GET" && url.pathname === "/health") return send(response, { status: 200, body: { ok: true } });
    if (request.method === "GET" && url.pathname === "/journal") return send(response, { status: 200, body: journal });
    if (request.method === "DELETE" && url.pathname === "/faults") {
      faults.length = 0;
      return send(response, { status: 200, body: { faults } });
    }
    if (request.method === "POST" && url.pathname === "/faults") {
      const fault = await readBody(request);
      const valid =
        providers.some((provider) => provider.name === fault?.provider) &&
        typeof fault.path === "string" &&
        fault.path.startsWith("/") &&
        Number.isInteger(fault.status) &&
        fault.status >= 400 &&
        fault.status <= 599 &&
        Number.isInteger(fault.count) &&
        fault.count >= 1 &&
        fault.count <= 10;
      if (!valid) {
        return send(response, {
          status: 400,
          body: { error: "A fault needs a provider, a path starting with /, a 4xx or 5xx status, and a count from 1 to 10." },
        });
      }
      faults.push({ provider: fault.provider, method: fault.method, path: fault.path, status: fault.status, remaining: fault.count });
      return send(response, { status: 201, body: { faults } });
    }
    return send(response, { status: 404, body: { error: "Unknown Lab control endpoint" } });
  })
  .listen(9000);

process.on("SIGTERM", () => process.exit(0));
