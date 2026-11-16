import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { paths, REPO_ROOT } from "../state.ts";
import { local, until, type Service } from "./service.ts";

const HUB_DIR = path.join(REPO_ROOT, "hub");
const WRANGLER = path.join(HUB_DIR, "node_modules", ".bin", "wrangler");
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
  about: (ports) => `${local(ports.hub)}/v1 is aurral.org's hub, with its own local D1`,
  async start(ports) {
    if (await isLive(ports.hub)) return;
    mkdirSync(paths.hub, { recursive: true });
    spawnSync(WRANGLER, ["d1", "migrations", "apply", "DB", "--local", "--persist-to", paths.hub], {
      cwd: HUB_DIR,
      env: wranglerEnv,
      stdio: "inherit",
    });
    const log = openSync(path.join(paths.hub, "wrangler.log"), "a");
    const child = spawn(
      WRANGLER,
      ["dev", "--ip", "127.0.0.1", "--port", String(ports.hub), "--persist-to", paths.hub],
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
