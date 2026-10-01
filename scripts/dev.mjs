import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const backendEnv = existsSync("backend/.env") ? parseEnv(readFileSync("backend/.env", "utf8")) : {};
const apiPort = process.env.AURRAL_DEV_API_PORT || backendEnv.AURRAL_DEV_API_PORT || "3001";
const webPort = process.env.AURRAL_DEV_WEB_PORT || backendEnv.AURRAL_DEV_WEB_PORT || "3009";

const children = [];
let stopping = false;
let exitCode = 0;

function start(command, args, env = process.env) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env,
  });
  children.push(child);
  child.once("exit", (code, signal) => {
    if (stopping) return;
    exitCode = 1;
    console.error(`${command} exited unexpectedly${signal ? ` with ${signal}` : ` with code ${code}`}`);
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

start(process.execPath, [
  "--watch",
  "--env-file=backend/.env",
  "backend/server.js",
], { ...process.env, PORT: apiPort });
start("npm", [
  "run",
  "dev",
  "--workspace",
  "frontend",
  "--",
  "--host",
  "0.0.0.0",
  "--port",
  webPort,
  "--strictPort",
], { ...process.env, AURRAL_API_PROXY_TARGET: `http://localhost:${apiPort}` });

while (!stopping) {
  try {
    const response = await fetch(`http://localhost:${apiPort}/api/health`);
    if (response.ok) break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 250));
}

await Promise.all(
  children.map(
    (child) =>
      new Promise((resolve) => {
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
