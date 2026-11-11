import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { parseEnv } from "node:util";

const envFile = process.env.AURRAL_ENV_FILE || "backend/.env";
const backendEnv = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};

const isFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, () => probe.close(() => resolve(true)));
  });

// A port set in the environment or the env file is used as given. Otherwise the
// default steps up to the next free port, so two checkouts can run at once.
async function devPort(name: string, fallback: number, taken?: string) {
  const set = process.env[name] || backendEnv[name];
  if (set) return set;
  let port = fallback;
  while (String(port) === taken || !(await isFree(port))) port += 1;
  return String(port);
}

const apiPort = await devPort("AURRAL_DEV_API_PORT", 3001);
const webPort = await devPort("AURRAL_DEV_WEB_PORT", 3009, apiPort);
console.log(`Aurral dev: http://localhost:${webPort} (API on ${apiPort})`);

const children: ChildProcess[] = [];
let stopping = false;
let exitCode = 0;

function start(command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env,
  });
  children.push(child);
  child.once("exit", (code, signal) => {
    if (stopping) return;
    exitCode = 1;
    console.error(
      `${command} exited unexpectedly${signal ? ` with ${signal}` : ` with code ${code}`}`,
    );
    stop();
  });
  return child;
}

function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.pid) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {}
    }
  }
}

process.on("SIGINT", () => {
  exitCode = 130;
  stop();
});
process.on("SIGTERM", () => {
  exitCode = 143;
  stop();
});

start(process.execPath, ["--watch", `--env-file=${envFile}`, "backend/server.ts"], {
  ...process.env,
  PORT: apiPort,
});
start(
  "pnpm",
  [
    "--filter",
    "aurral-frontend",
    "run",
    "dev",
    "--host",
    "0.0.0.0",
    "--port",
    webPort,
    "--strictPort",
  ],
  { ...process.env, AURRAL_API_PROXY_TARGET: `http://localhost:${apiPort}` },
);

await Promise.all(
  children.map(
    (child) =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode) {
          resolve();
        } else {
          child.once("exit", resolve);
        }
      }),
  ),
);
stop();
process.exitCode = exitCode;
