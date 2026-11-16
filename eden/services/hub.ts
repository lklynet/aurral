import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { paths, REPO_ROOT } from "../state.ts";
import { local, until, type Service } from "./service.ts";

const HUB_DIR = path.join(REPO_ROOT, "hub");
const WRANGLER = path.join(HUB_DIR, "node_modules", "wrangler", "bin", "wrangler.js");
const wranglerEnv = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" };

const isLive = async (port: number) => {
  const response = await fetch(`${local(port)}/v1/health`).catch(() => null);
  return response?.ok ?? false;
};

const runningPid = () => {
  if (!existsSync(paths.hubPid)) return null;
  const pid = Number(readFileSync(paths.hubPid, "utf8"));
  const { stdout } = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return Number.isInteger(pid) && stdout.includes("wrangler") ? pid : null;
};

// The real hub on wrangler's local Workers and D1 runtime. It runs on the host, not in
// a container, because workerd is a native binary built for the host's platform.
export const hub: Service = {
  containers: [],
  needs: ["sso"],
  env: (ports) => ({ AURRAL_SHARE_ORIGIN: local(ports.hub) }),
  about: (ports) =>
    `${local(ports.hub)}/account is aurral.org's hub, signing in through Eden's OIDC people`,
  async start(ports) {
    if (await isLive(ports.hub)) return;
    mkdirSync(paths.hub, { recursive: true });
    const migrated = spawnSync(
      process.execPath,
      [WRANGLER, "d1", "migrations", "apply", "DB", "--local", "--persist-to", paths.hub],
      { cwd: HUB_DIR, env: wranglerEnv, stdio: "inherit" },
    );
    if (migrated.status !== 0) throw new Error("The hub's migrations did not apply");
    const envFile = path.join(paths.hub, "hub.env");
    writeFileSync(
      envFile,
      [
        `HUB_ORIGIN=${local(ports.hub)}`,
        `AUTH_SECRET=${randomBytes(32).toString("hex")}`,
        `EDEN_OIDC_ISSUER=${local(ports.oidc)}`,
      ].join("\n"),
    );
    const log = openSync(path.join(paths.hub, "wrangler.log"), "a");
    const child = spawn(
      process.execPath,
      [
        WRANGLER,
        "dev",
        "--ip",
        "127.0.0.1",
        "--port",
        String(ports.hub),
        "--persist-to",
        paths.hub,
        "--env-file",
        envFile,
        "--local-upstream",
        `127.0.0.1:${ports.hub}`,
      ],
      { cwd: HUB_DIR, env: wranglerEnv, detached: true, stdio: ["ignore", log, log] },
    );
    child.unref();
    writeFileSync(paths.hubPid, String(child.pid));
    await until("the hub", () => isLive(ports.hub), 60_000);
  },
  async stop() {
    const pid = runningPid();
    if (pid) {
      process.kill(-pid, "SIGTERM");
      await until("the hub to stop", async () => runningPid() === null, 30_000);
    }
    rmSync(paths.hubPid, { force: true });
  },
  async setup() {},
};
