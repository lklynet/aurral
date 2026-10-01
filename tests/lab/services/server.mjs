import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { createBrainzmash } from "./brainzmash.mjs";
import { createLidarr } from "./lidarr.mjs";
import { createCertificates, createDownloads, createTrackFiles } from "./runtime.mjs";
import { createSlskd } from "./slskd.mjs";
import { createUsenet } from "./usenet.mjs";
import { createDeemix } from "./deemix.mjs";
import { createJellyfin } from "./jellyfin.mjs";
import { createKoito } from "./koito.mjs";
import { createMediaIndex } from "./media.mjs";
import { createNavidrome } from "./navidrome.mjs";
import { createNotify } from "./notify.mjs";
import { createPlex } from "./plex.mjs";
import { createConcerts } from "./public/concerts.mjs";
import { createDeezer } from "./public/deezer.mjs";
import { createLastfm } from "./public/lastfm.mjs";
import { createListenbrainz } from "./public/listenbrainz.mjs";
import { createMusicBrainz } from "./public/musicbrainz.mjs";
import { createNews } from "./public/news.mjs";
import { createOidc } from "./public/oidc.mjs";
import { createPicsum } from "./public/picsum.mjs";
import { createPlexTv, plexAccounts } from "./public/plextv.mjs";
import { createSpotify } from "./public/spotify.mjs";

const env = process.env;
const catalog = JSON.parse(readFileSync(new URL("../fixtures/catalog.json", import.meta.url), "utf8"));
const publicHosts = JSON.parse(readFileSync(new URL("./public-hosts.json", import.meta.url), "utf8"));
const ports = {
  brainzmash: 8601,
  lidarr: 8686,
  slskd: 5030,
  prowlarr: 9696,
  sabnzbd: 8080,
  nzbget: 6789,
  deemix: 6595,
  navidrome: 4533,
  plex: 32400,
  jellyfin: 8096,
  koito: 4110,
  notify: 8070,
  "public-http": 8079,
  "public-tls": 8443,
  control: 9000,
  ...JSON.parse(env.AURRAL_LAB_PORTS || "{}"),
};
const context = {
  catalog,
  mediaRoot: env.AURRAL_LAB_MEDIA_ROOT || "/data",
  downloads: createDownloads(env.AURRAL_LAB_DOWNLOADS),
  tracks: createTrackFiles(path.join(os.tmpdir(), `aurral-lab-tracks-${process.pid}`)),
  media: createMediaIndex(env.AURRAL_LAB_MEDIA_ROOT || "/data"),
};
const journal = [];
const faults = [];

const services = [
  { name: "brainzmash", handle: createBrainzmash(catalog) },
  {
    name: "lidarr",
    handle: createLidarr(catalog, {
      ...context,
      apiKey: env.AURRAL_LAB_LIDARR_API_KEY,
      webhook: { url: env.AURRAL_LAB_APP_URL || "http://aurral:3001", apiKey: env.AURRAL_LAB_API_KEY },
    }),
  },
  { name: "slskd", handle: createSlskd(catalog, { ...context, apiKey: env.AURRAL_LAB_SLSKD_API_KEY }) },
  { name: "deemix", handle: createDeemix(catalog, context) },
  {
    name: "navidrome",
    handle: createNavidrome({ ...context, username: env.AURRAL_LAB_NAVIDROME_USERNAME, password: env.AURRAL_LAB_NAVIDROME_PASSWORD }),
  },
  {
    name: "plex",
    handle: createPlex({
      ...context,
      tokens: plexAccounts(env.AURRAL_LAB_PLEX_TOKEN).flatMap((account) => [account.accountToken, account.serverToken]),
      machineIdentifier: env.AURRAL_LAB_PLEX_MACHINE_IDENTIFIER,
    }),
  },
  {
    name: "jellyfin",
    handle: createJellyfin({ ...context, apiKey: env.AURRAL_LAB_JELLYFIN_API_KEY, username: env.AUTH_USER }),
  },
  { name: "koito", handle: createKoito(catalog, { token: env.AURRAL_LAB_KOITO_TOKEN }) },
  { name: "notify", handle: createNotify({ gotifyToken: env.AURRAL_LAB_GOTIFY_TOKEN }) },
];
const usenet = createUsenet(catalog, {
  ...context,
  prowlarrApiKey: env.AURRAL_LAB_PROWLARR_API_KEY,
  sabnzbdApiKey: env.AURRAL_LAB_SABNZBD_API_KEY,
  nzbgetUsername: env.AURRAL_LAB_NZBGET_USERNAME,
  nzbgetPassword: env.AURRAL_LAB_NZBGET_PASSWORD,
});
services.push(
  { name: "prowlarr", handle: usenet.prowlarr },
  { name: "sabnzbd", handle: usenet.sabnzbd },
  { name: "nzbget", handle: usenet.nzbget },
);
const publicServices = [
  createMusicBrainz(catalog),
  createDeezer(catalog, context),
  createLastfm(catalog, {
    apiKey: env.AURRAL_LAB_LASTFM_API_KEY,
    apiSecret: env.AURRAL_LAB_LASTFM_API_SECRET,
    sessionKey: env.AURRAL_LAB_LASTFM_SESSION_KEY,
  }),
  createListenbrainz(catalog, { token: env.AURRAL_LAB_LISTENBRAINZ_TOKEN, username: "lab-listener" }),
  createSpotify(catalog, {
    clientId: "848082790c32436d8a0405fddca0aa18",
    redirectUri: "https://spotify.lidarr.audio/auth",
    refreshToken: env.AURRAL_LAB_SPOTIFY_REFRESH_TOKEN,
  }),
  createConcerts(catalog, { ticketmasterApiKey: env.AURRAL_LAB_TICKETMASTER_API_KEY }),
  createNews(catalog),
  createPicsum(),
  createPlexTv({ serverToken: env.AURRAL_LAB_PLEX_TOKEN, machineIdentifier: env.AURRAL_LAB_PLEX_MACHINE_IDENTIFIER, serverUrl: env.AURRAL_LAB_PLEX_URL }),
  createOidc({
    google: { clientId: env.AURRAL_LAB_GOOGLE_CLIENT_ID, clientSecret: env.AURRAL_LAB_GOOGLE_CLIENT_SECRET },
    sso: { issuer: env.AURRAL_LAB_OIDC_ISSUER, clientId: env.AURRAL_LAB_OIDC_CLIENT_ID, clientSecret: env.AURRAL_LAB_OIDC_CLIENT_SECRET },
  }),
];
const allServices = [...services, ...publicServices];

const servedHosts = publicServices.flatMap((service) => service.hosts);
const unserved = publicHosts.filter((host) => !servedHosts.includes(host));
const unlisted = servedHosts.filter((host) => !publicHosts.includes(host));
if (unserved.length || unlisted.length) {
  throw new Error(`public-hosts.json and the public services disagree: ${[...unserved, ...unlisted].join(", ")}`);
}
if (env.AURRAL_LAB_FIXTURE_STATE && existsSync(env.AURRAL_LAB_FIXTURE_STATE)) {
  const saved = JSON.parse(readFileSync(env.AURRAL_LAB_FIXTURE_STATE, "utf8"));
  for (const service of allServices) if (saved[service.name] && service.handle.restore) service.handle.restore(saved[service.name]);
}
const serviceNames = new Set(allServices.map((service) => service.name));

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
  if (type.includes("application/x-www-form-urlencoded")) {
    const form = {};
    for (const [key, value] of new URLSearchParams(buffer.toString("utf8"))) form[key] = key in form ? [].concat(form[key], value) : value;
    return form;
  }
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

const publicByHost = new Map(publicServices.flatMap((service) => service.hosts.map((host) => [host, service])));
http.createServer(serve((host) => publicByHost.get(host))).listen(ports["public-http"]);
if (!env.AURRAL_LAB_TLS_DIR) throw new Error("AURRAL_LAB_TLS_DIR is required for the public service listener.");
https.createServer(createCertificates(env.AURRAL_LAB_TLS_DIR, publicHosts), serve((host) => publicByHost.get(host)))
  .listen(ports["public-tls"]);

http
  .createServer(async (request, response) => {
    const url = new URL(request.url, "http://fixtures");
    if (request.method === "GET" && url.pathname === "/health") return send(response, { status: 200, body: { ok: true } });
    if (request.method === "GET" && url.pathname === "/journal") return send(response, { status: 200, body: journal });
    if (request.method === "GET" && url.pathname.startsWith("/state/")) {
      const service = allServices.find((entry) => entry.name === url.pathname.slice("/state/".length));
      if (!service?.handle.state) return send(response, { status: 404, body: { error: "That service has no inspectable state" } });
      const body = JSON.parse(JSON.stringify(service.handle.state, (_key, value) => (value instanceof Map ? Object.fromEntries(value) : value)));
      return send(response, { status: 200, body });
    }
    if (url.pathname === "/downloads" && request.method === "POST") {
      const { mode } = (await readBody(request)) || {};
      if (!["hold", "complete"].includes(mode)) return send(response, { status: 400, body: { error: "mode must be hold or complete" } });
      context.downloads.setMode(mode);
    }
    if (url.pathname === "/downloads") return send(response, { status: 200, body: { mode: context.downloads.mode } });
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

function saveState() {
  if (!env.AURRAL_LAB_FIXTURE_STATE) return;
  const snapshot = Object.fromEntries(
    allServices.filter((service) => service.handle.restore).map((service) => [service.name, service.handle.state]),
  );
  const temporary = `${env.AURRAL_LAB_FIXTURE_STATE}.tmp`;
  writeFileSync(temporary, JSON.stringify(snapshot));
  renameSync(temporary, env.AURRAL_LAB_FIXTURE_STATE);
}

setInterval(() => context.downloads.tick(), 500).unref();
setInterval(saveState, 2000).unref();
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    saveState();
    process.exit(0);
  });
}
