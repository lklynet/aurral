import { appendFileSync, readFileSync } from "node:fs";
import http from "node:http";
import { createBrainzmash } from "./brainzmash.mjs";
import { createLidarr } from "./lidarr.mjs";
import { createSlskd } from "./slskd.mjs";

const env = process.env;
const catalog = JSON.parse(readFileSync(new URL("../fixtures/catalog.json", import.meta.url), "utf8"));
const ports = {
  brainzmash: 8601,
  lidarr: 8686,
  slskd: 5030,
  control: 9000,
  ...JSON.parse(env.AURRAL_LAB_PORTS || "{}"),
};
const context = {
  catalog,
  mediaRoot: env.AURRAL_LAB_MEDIA_ROOT || "/data",
};
const journal = [];
const faults = [];

const services = [
  { name: "brainzmash", handle: createBrainzmash(catalog) },
  { name: "lidarr", handle: createLidarr(catalog, { ...context, apiKey: env.AURRAL_LAB_LIDARR_API_KEY }) },
  { name: "slskd", handle: createSlskd(catalog, { ...context, apiKey: env.AURRAL_LAB_SLSKD_API_KEY }) },
];
const serviceNames = new Set(services.map((service) => service.name));

function record(entry) {
  journal.push(entry);
  if (journal.length > 5000) journal.shift();
  if (env.AURRAL_LAB_JOURNAL) appendFileSync(env.AURRAL_LAB_JOURNAL, `${JSON.stringify(entry)}\n`);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  if (!buffer.length) return undefined;
  const type = String(request.headers["content-type"] || "");
  if (type.includes("json")) {
    try {
      return JSON.parse(buffer.toString("utf8"));
    } catch {
      return buffer.toString("utf8");
    }
  }
  if (type.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(buffer.toString("utf8")));
  if (type.startsWith("text/") || type.includes("xml")) return buffer.toString("utf8");
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return buffer;
  }
}

function send(response, { status, body, headers = {}, raw }) {
  if (status === 204 || status === 304) {
    response.writeHead(status, headers);
    return response.end();
  }
  if (raw !== undefined) {
    response.writeHead(status, { "content-type": "application/octet-stream", ...headers });
    return response.end(raw);
  }
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body ?? null));
}

function takeFault(name, method, pathname) {
  const fault = faults.find(
    (entry) => entry.provider === name && (!entry.method || entry.method === method) && pathname.startsWith(entry.path),
  );
  if (!fault) return null;
  if (--fault.remaining === 0) faults.splice(faults.indexOf(fault), 1);
  return fault;
}

function serve(resolve) {
  return async (request, response) => {
    const host = String(request.headers.host || "fixtures").replace(/:\d+$/, "").toLowerCase();
    const url = new URL(request.url, `http://${host}`);
    const service = resolve(host);
    const name = service?.name || host;
    const body = await readBody(request);
    const fault = service && takeFault(name, request.method, url.pathname);
    let result = null;
    try {
      result = fault
        ? { status: fault.status, body: { error: `Injected Lab fault for ${name}` } }
        : service && (await service.handle({ method: request.method, url, headers: request.headers, body, host }));
    } catch (error) {
      console.error(`${name} fixture failed on ${request.method} ${url.pathname}:`, error);
      result = { status: 500, body: { error: `The Lab ${name} fixture failed: ${error.message}` } };
    }
    const unsupported = !result;
    if (unsupported) {
      result = { status: 501, body: { error: `The Lab ${name} fixture does not implement ${request.method} ${url.pathname}` } };
      console.error(`unsupported ${name} request: ${request.method} ${url.pathname}${url.search}`);
    }
    record({
      at: new Date().toISOString(),
      provider: name,
      method: request.method,
      path: `${url.pathname}${url.search}`,
      status: result.status,
      ...(unsupported ? { unsupported: true } : {}),
      ...(fault ? { fault: true } : {}),
    });
    send(response, result);
  };
}

for (const service of services) http.createServer(serve(() => service)).listen(ports[service.name]);

http
  .createServer(async (request, response) => {
    const url = new URL(request.url, "http://fixtures");
    if (request.method === "GET" && url.pathname === "/health") return send(response, { status: 200, body: { ok: true } });
    if (request.method === "GET" && url.pathname === "/journal") return send(response, { status: 200, body: journal });
    if (request.method === "DELETE" && url.pathname === "/faults") {
      faults.length = 0;
      return send(response, { status: 200, body: { faults } });
    }
    if (request.method === "POST" && url.pathname === "/faults") {
      const fault = await readBody(request);
      const valid =
        serviceNames.has(fault?.provider) &&
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
          body: { error: "A fault needs a known provider, a path starting with /, a 4xx or 5xx status, and a count from 1 to 10." },
        });
      }
      faults.push({ provider: fault.provider, method: fault.method, path: fault.path, status: fault.status, remaining: fault.count });
      return send(response, { status: 201, body: { faults } });
    }
    return send(response, { status: 404, body: { error: "Unknown Lab control endpoint" } });
  })
  .listen(ports.control);

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
