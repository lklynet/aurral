import { isRecord } from "../../../lib/isRecord.ts";
import { getAppBasePath } from "./basePath.ts";

export const HOSTED = import.meta.env.VITE_HOSTED;

export type SavedServer = { address: string; token: string; username: string };
type ServerList = { active: string | null; servers: SavedServer[] };

const SERVERS_KEY = "aurral.servers";

const isSavedServer = (value: unknown): value is SavedServer =>
  isRecord(value) &&
  typeof value.address === "string" &&
  typeof value.token === "string" &&
  typeof value.username === "string";

export const readServers = (): ServerList => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SERVERS_KEY) || "null");
    if (isRecord(parsed) && Array.isArray(parsed.servers)) {
      const servers = parsed.servers.filter(isSavedServer);
      const active = servers.find((server) => server.address === parsed.active)?.address ?? null;
      return { active, servers };
    }
  } catch {}
  return { active: null, servers: [] };
};

const writeServers = (list: ServerList) => {
  localStorage.setItem(SERVERS_KEY, JSON.stringify(list));
};

const resolveActiveServer = () => {
  const { active, servers } = readServers();
  return servers.find((server) => server.address === active) ?? null;
};

export const activeServer = HOSTED ? resolveActiveServer() : null;

export const normalizeAddress = (input: string) => {
  const trimmed = input.trim();
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    const allowed =
      url.protocol === "https:" || (url.protocol === "http:" && location.protocol === "http:");
    if (!allowed || url.username || url.password) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
};

export const hostOf = (address: string) => new URL(address).host;

export const saveServer = (server: SavedServer) => {
  const { servers } = readServers();
  const existing = servers.find((entry) => entry.address === server.address);
  const next = existing
    ? {
        ...server,
        token: server.token || existing.token,
        username: server.username || existing.username,
      }
    : server;
  writeServers({
    active: server.address,
    servers: [...servers.filter((entry) => entry !== existing), next],
  });
};

export const updateActiveServer = (patch: Partial<Omit<SavedServer, "address">>) => {
  if (!activeServer) return;
  Object.assign(activeServer, patch);
  const { active, servers } = readServers();
  writeServers({
    active,
    servers: servers.map((server) =>
      server.address === activeServer.address ? { ...server, ...patch } : server,
    ),
  });
};

export const switchServer = (address: string) => {
  writeServers({ ...readServers(), active: address });
  window.location.assign("/");
};

export const forgetActiveServer = () => {
  const servers = readServers().servers.filter(
    (server) => server.address !== activeServer?.address,
  );
  writeServers({ active: servers.find((server) => server.token)?.address ?? null, servers });
  window.location.assign("/");
};

export const reloadWhenServerChanges = () => {
  window.addEventListener("storage", (event) => {
    if (event.key === SERVERS_KEY && readServers().active !== activeServer?.address) {
      window.location.reload();
    }
  });
};

export const serverScoped = (key: string) => (HOSTED ? `${activeServer?.address}|${key}` : key);

export const continueOnServer = () => {
  window.location.assign(serverUrl(window.location.pathname + window.location.search));
};

export const serverUrl = (path: string) => {
  if (HOSTED) return `${activeServer?.address ?? ""}${path}`;
  const basePath = getAppBasePath();
  return `${window.location.origin}${basePath === "/" ? "" : basePath}${path}`;
};
