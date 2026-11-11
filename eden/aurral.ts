import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as v from "valibot";
import { createAuthority } from "./outside/certificates.ts";
import { paths, REPO_ROOT, type Ports } from "./state.ts";

const START_TIMEOUT_MS = 120_000;

// Everything outside goes through Eden's proxy, and the services Eden runs are local.
export const aurralEnv = (ports: Ports) => ({
  AURRAL_DATA_DIR: paths.aurralData,
  AURRAL_DEV_API_PORT: String(ports.aurralApi),
  AURRAL_DEV_WEB_PORT: String(ports.aurralWeb),
  LIBRARY_FOLDER: paths.library,
  BRAINZMASH_BASE_URL: `http://127.0.0.1:${ports.metadata}`,
  NODE_USE_ENV_PROXY: "1",
  HTTP_PROXY: `http://127.0.0.1:${ports.outside}`,
  HTTPS_PROXY: `http://127.0.0.1:${ports.outside}`,
  NO_PROXY: "127.0.0.1,localhost",
  NODE_EXTRA_CA_CERTS: path.join(paths.outside, AUTHORITY_CERTIFICATE),
  // Eden's own yt-dlp comes first, so the built-in download source stays inside Eden.
  PATH: `${path.join(REPO_ROOT, "eden", "standins", "bin")}${path.delimiter}${process.env.PATH}`,
  EDEN_WORLD: paths.world,
});

export function writeAurralEnv(env: Record<string, string>) {
  mkdirSync(paths.aurralData, { recursive: true });
  writeFileSync(
    paths.aurralEnv,
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}

export const AUTHORITY_CERTIFICATE = "ca.pem";
export const AUTHORITY_KEY = "ca-key.pem";

export function writeAuthority() {
  if (existsSync(path.join(paths.outside, AUTHORITY_CERTIFICATE))) return;
  const authority = createAuthority();
  mkdirSync(paths.outside, { recursive: true });
  writeFileSync(path.join(paths.outside, AUTHORITY_CERTIFICATE), authority.certificate);
  writeFileSync(path.join(paths.outside, AUTHORITY_KEY), authority.key);
}

export const apiUrl = (ports: Ports) => `http://127.0.0.1:${ports.aurralApi}`;

async function isLive(ports: Ports) {
  try {
    const response = await fetch(`${apiUrl(ports)}/api/health/live`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Runs the task against this checkout's Eden Aurral, starting the backend for the
// duration when the dev server is not already up.
export async function withAurral<Result>(
  ports: Ports,
  env: Record<string, string>,
  task: () => Promise<Result>,
) {
  if (await isLive(ports)) return task();
  const backend = spawn(process.execPath, [`--env-file=${paths.aurralEnv}`, "backend/server.ts"], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env, PORT: String(ports.aurralApi) },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const exited = once(backend, "exit");
  try {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (!(await isLive(ports))) {
      if (backend.exitCode !== null) throw new Error("Aurral exited while starting");
      if (Date.now() > deadline) throw new Error("Aurral did not start in time");
      await delay(250);
    }
    return await task();
  } finally {
    backend.kill("SIGTERM");
    await exited;
  }
}

export class AurralApi {
  readonly base: string;
  token: string | null = null;

  constructor(ports: Ports) {
    this.base = apiUrl(ports);
  }

  async request(method: string, path: string, body?: unknown) {
    const response = await fetch(`${this.base}/api${path}`, {
      method,
      headers: {
        ...(body !== undefined && { "content-type": "application/json" }),
        ...(this.token && { authorization: `Bearer ${this.token}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text}`);
    const parsed: unknown = text ? JSON.parse(text) : null;
    return parsed;
  }

  async login(user: { username: string; password: string }) {
    this.token = null;
    this.token = v.parse(
      v.object({ token: v.string() }),
      await this.post("/auth/login", user),
    ).token;
  }

  get = (path: string) => this.request("GET", path);
  post = (path: string, body: unknown = {}) => this.request("POST", path, body);
  put = (path: string, body: unknown = {}) => this.request("PUT", path, body);
}
