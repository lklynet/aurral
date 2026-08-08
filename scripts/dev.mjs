import { spawn } from "node:child_process";

const children = [];
let stopping = false;

function start(command, args) {
  const child = spawn(command, args, {
    detached: true,
    stdio: "inherit",
  });
  children.push(child);
  return child;
}

function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }
  }
}

process.on("SIGINT", () => {
  stop();
  process.exit(130);
});
process.on("SIGTERM", () => {
  stop();
  process.exit(143);
});

const backend = start(process.execPath, [
  "--watch",
  "--env-file=backend/.env",
  "backend/server.js",
]);

while (!stopping) {
  try {
    const response = await fetch("http://localhost:3001/api/health");
    if (response.ok) break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 250));
}

if (!stopping) {
  start("npm", [
    "run",
    "dev",
    "--workspace",
    "frontend",
    "--",
    "--host",
    "0.0.0.0",
    "--port",
    "3009",
  ]);
}

await new Promise((resolve) => {
  backend.once("exit", resolve);
});
stop();
