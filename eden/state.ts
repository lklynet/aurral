import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import * as v from "valibot";
import { isOwnKey } from "../lib/ownKey.ts";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..");
export const STATE_DIR = path.join(REPO_ROOT, ".eden");

export const paths = {
  ports: path.join(STATE_DIR, "ports.json"),
  aurralEnv: path.join(STATE_DIR, "aurral.env"),
  aurralData: path.join(STATE_DIR, "aurral"),
  library: path.join(STATE_DIR, "library"),
  world: path.join(STATE_DIR, "world"),
  outside: path.join(STATE_DIR, "outside"),
  lidarr: path.join(STATE_DIR, "lidarr"),
  downloads: path.join(STATE_DIR, "downloads"),
  selected: path.join(STATE_DIR, "selected.json"),
  done: path.join(STATE_DIR, "done.json"),
  devPid: path.join(STATE_DIR, "dev.pid"),
};

export const LOGIN = { username: "test", password: "password" } as const;
export const LISTENER = { username: "listener", password: "password" } as const;

// One Compose project per checkout, so every worktree has its own Eden.
export const PROJECT = `eden-${createHash("sha256").update(REPO_ROOT).digest("hex").slice(0, 10)}`;

const UNASSIGNED_PORTS = {
  aurralApi: 0,
  aurralWeb: 0,
  metadata: 0,
  outside: 0,
  navidrome: 0,
  jellyfin: 0,
  koito: 0,
  gotify: 0,
  webhookSink: 0,
  feishin: 0,
  airsonic: 0,
  world: 0,
  prowlarr: 0,
  nzbget: 0,
  sabnzbd: 0,
  qbittorrent: 0,
  slskd: 0,
  lidarr: 0,
  oidc: 0,
};
export type Ports = typeof UNASSIGNED_PORTS;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("No free port")),
      );
    });
  });

const storedPorts = v.record(v.string(), v.number());

// Ports are picked once and kept, so links to a running Eden stay valid across restarts.
export async function resolvePorts() {
  const stored = existsSync(paths.ports)
    ? v.parse(storedPorts, JSON.parse(readFileSync(paths.ports, "utf8")))
    : {};
  const taken = new Set(Object.values(stored));
  const ports = { ...UNASSIGNED_PORTS };
  for (const name in ports) {
    if (!isOwnKey(ports, name)) continue;
    let port = stored[name] ?? 0;
    while (port === 0 || (stored[name] !== port && taken.has(port))) port = await freePort();
    taken.add(port);
    ports[name] = port;
  }
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(paths.ports, JSON.stringify(ports, null, 2) + "\n");
  return ports;
}
