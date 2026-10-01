import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const composeFile = path.join(repoRoot, "tests", "lab", "compose.yml");
const labRoot = path.join(repoRoot, "backend", "data", "lab");
const lockDir = path.join(labRoot, ".locks");
const LAB_ID = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;
const SEED_VERSION = 1;
const FORWARDED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  "BUILDKIT_PROGRESS",
];
const LOG_FLAGS = new Set(["--follow", "-f", "--timestamps", "-t"]);
const LOG_SERVICES = new Set(["aurral", "gateway"]);

class LabError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

let activeChild = null;
let interruption = null;

function checkInterrupted() {
  if (interruption) {
    throw new LabError(
      `Interrupted by ${interruption}. Run the command again, or stop the Lab with its lab:down command.`,
      interruption === "SIGINT" ? 130 : 143,
    );
  }
}

function relative(target) {
  return path.relative(repoRoot, target);
}

function labCommand(lab, command) {
  return `${lab.id === "dev" ? "" : `AURRAL_LAB_ID=${lab.id} `}npm run lab:${command}`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function selectLab(requestedId) {
  const id = requestedId || "dev";
  if (!LAB_ID.test(id) || id.startsWith("run-")) {
    throw new LabError(
      `AURRAL_LAB_ID "${id}" is invalid. Use up to 24 lowercase letters, digits, and dashes that do not start with "run-".`,
    );
  }
  const owner = createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);
  const slug =
    path
      .basename(repoRoot)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "aurral";
  const prefix = `aurral-lab-${slug}-${owner}`;
  const stateDir = path.join(labRoot, id);
  return {
    id,
    owner,
    project: `${prefix}-${id}`,
    image: `${prefix}:local`,
    stateDir,
    configDir: path.join(stateDir, "config"),
    mediaDir: path.join(stateDir, "media"),
    seedingDir: path.join(stateDir, ".seeding"),
    seedPath: path.join(stateDir, "seed.json"),
    recordPath: path.join(stateDir, "lab.json"),
    lockPath: path.join(lockDir, `${id}.lock`),
  };
}

function dockerEnv(lab) {
  const env = {};
  for (const key of FORWARDED_ENV) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (!lab) return env;
  return {
    ...env,
    AURRAL_LAB_ID: lab.id,
    AURRAL_LAB_OWNER: lab.owner,
    AURRAL_LAB_WORKTREE: repoRoot,
    AURRAL_LAB_IMAGE: lab.image,
    AURRAL_LAB_CONFIG_DIR: lab.configDir,
    AURRAL_LAB_MEDIA_DIR: lab.mediaDir,
    AURRAL_LAB_SEED_DIR: lab.seedingDir,
    AURRAL_LAB_UID: String(process.getuid?.() ?? 1000),
    AURRAL_LAB_GID: String(process.getgid?.() ?? 1000),
  };
}

function docker(args, { lab, output = "capture" } = {}) {
  const stdio = {
    capture: ["ignore", "pipe", "pipe"],
    stdout: ["ignore", "inherit", "inherit"],
    stderr: ["ignore", 2, 2],
  }[output];
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { cwd: repoRoot, env: dockerEnv(lab), stdio });
    activeChild = child;
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      activeChild = null;
      reject(
        error.code === "ENOENT"
          ? new LabError("Docker is not installed or not on PATH. Install Docker Engine with the Compose plugin, then retry.")
          : error,
      );
    });
    child.on("close", (code) => {
      activeChild = null;
      try {
        checkInterrupted();
        resolve({ code: code ?? 1, stdout, stderr });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function compose(lab, args, options = {}) {
  return docker(["compose", "--project-name", lab.project, "--file", composeFile, ...args], { ...options, lab });
}

function firstLine(text) {
  return String(text || "").trim().split("\n")[0];
}

async function requireDocker() {
  const engine = await docker(["version", "--format", "{{.Server.Version}}"]);
  if (engine.code !== 0) {
    throw new LabError(
      `The Docker daemon is not reachable: ${firstLine(engine.stderr) || "docker version failed"}. Start Docker, then retry.`,
    );
  }
  const plugin = await docker(["compose", "version", "--short"]);
  if (plugin.code !== 0) {
    throw new LabError("Docker Compose v2 is required. Install the Docker Compose plugin, then retry.");
  }
}

async function listResources(lab, args, fields) {
  const result = await docker([
    ...args,
    "--filter",
    `label=com.docker.compose.project=${lab.project}`,
    "--format",
    fields.map(([, template]) => template).join("\t"),
  ]);
  if (result.code !== 0) {
    throw new LabError(`Could not list Docker resources for Lab "${lab.id}": ${firstLine(result.stderr)}`);
  }
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const values = line.split("\t");
      return Object.fromEntries(fields.map(([name], index) => [name, values[index] || ""]));
    });
}

async function ownedResources(lab) {
  const owner = ["owner", '{{.Label "org.aurral.lab.owner"}}'];
  const containers = await listResources(lab, ["ps", "--all"], [
    ["id", "{{.ID}}"],
    ["state", "{{.State}}"],
    ["service", '{{.Label "com.docker.compose.service"}}'],
    owner,
  ]);
  const networks = await listResources(lab, ["network", "ls"], [["id", "{{.ID}}"], owner]);
  if ([...containers, ...networks].some((resource) => resource.owner !== lab.owner)) {
    throw new LabError(
      `Docker project ${lab.project} has resources this worktree did not create. Aurral Lab will not change them. ` +
        `Inspect them with: docker ps --all --filter label=com.docker.compose.project=${lab.project}`,
    );
  }
  return { containers, networks };
}

function checkRecord(lab) {
  const record = readJson(lab.recordPath);
  if (record && (record.project !== lab.project || record.worktree !== repoRoot)) {
    throw new LabError(
      `${relative(lab.stateDir)} belongs to ${record.worktree || "another worktree"}. ` +
        "Remove that directory only if you know it is a stale copy.",
    );
  }
  return record;
}

function claimState(lab) {
  const record = checkRecord(lab);
  fs.mkdirSync(lab.mediaDir, { recursive: true });
  if (!record) {
    fs.writeFileSync(
      lab.recordPath,
      `${JSON.stringify({ project: lab.project, labId: lab.id, worktree: repoRoot, createdAt: new Date().toISOString() }, null, 2)}\n`,
    );
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function acquireLock(lab) {
  fs.mkdirSync(lockDir, { recursive: true });
  const holder = { pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() };
  const temp = `${lab.lockPath}.${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(holder));
  try {
    for (;;) {
      try {
        fs.linkSync(temp, lab.lockPath);
        return () => {
          if (readJson(lab.lockPath)?.pid === process.pid) fs.rmSync(lab.lockPath, { force: true });
        };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const current = readJson(lab.lockPath);
      if (current && (current.host !== holder.host || isRunning(current.pid))) {
        throw new LabError(
          `Another Lab operation (pid ${current.pid} on ${current.host}) is already changing Lab "${lab.id}". ` +
            `Wait for it to finish. If no operation is running, delete ${relative(lab.lockPath)}.`,
        );
      }
      fs.rmSync(lab.lockPath, { force: true });
      console.error(`Recovered a stale lock for Lab "${lab.id}"${current ? ` left by pid ${current.pid}` : ""}.`);
    }
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

async function withLock(lab, operation) {
  const release = acquireLock(lab);
  try {
    return await operation();
  } finally {
    release();
  }
}

async function labUrl(lab) {
  const result = await compose(lab, ["port", "gateway", "3001"]);
  const address = result.stdout.trim();
  if (result.code !== 0 || !/^127\.0\.0\.1:\d+$/.test(address)) {
    throw new LabError(`Lab "${lab.id}" is not running. Start it with ${labCommand(lab, "up")}.`);
  }
  return `http://${address}`;
}

async function waitForHost(lab, url) {
  const deadline = Date.now() + 15000;
  for (;;) {
    checkInterrupted();
    try {
      const response = await fetch(`${url}/api/health/live`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {}
    if (Date.now() > deadline) {
      throw new LabError(
        `Lab "${lab.id}" started, but ${url} is not reachable from this host. ` +
          `Check ${labCommand(lab, "logs")}, then stop it with ${labCommand(lab, "down")}.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function needsSeed(lab) {
  const marker = readJson(lab.seedPath);
  const hasConfig = fs.existsSync(lab.configDir);
  if (marker?.version === SEED_VERSION && hasConfig) return false;
  if (!marker && !hasConfig) return true;
  const problem =
    marker && marker.version !== SEED_VERSION
      ? `was seeded with version ${marker.version}, but this checkout needs version ${SEED_VERSION}`
      : "has incomplete data";
  throw new LabError(
    `Lab "${lab.id}" ${problem}. Run ${labCommand(lab, "reset")} to recreate it. Reset deletes this Lab's data.`,
  );
}

async function seed(lab) {
  fs.rmSync(lab.seedingDir, { recursive: true, force: true });
  fs.mkdirSync(lab.seedingDir);
  console.error(`Seeding Lab "${lab.id}"...`);
  const seeded = await compose(lab, ["run", "--rm", "--no-deps", "-T", "seed"], { output: "stderr" });
  if (seeded.code !== 0) {
    throw new LabError(`Seeding Lab "${lab.id}" failed. The output is above. Run ${labCommand(lab, "up")} to try again.`);
  }
  fs.renameSync(lab.seedingDir, lab.configDir);
  fs.writeFileSync(lab.seedPath, `${JSON.stringify({ version: SEED_VERSION, seededAt: new Date().toISOString() }, null, 2)}\n`);
}

async function start(lab) {
  claimState(lab);
  await ownedResources(lab);
  const seedRequired = needsSeed(lab);
  console.error(`Building Aurral for Lab "${lab.id}"...`);
  const built = await compose(lab, ["build", "aurral"], { output: "stderr" });
  if (built.code !== 0) throw new LabError(`Building Aurral for Lab "${lab.id}" failed. The build output is above.`);
  if (seedRequired) await seed(lab);
  console.error(`Starting Lab "${lab.id}"...`);
  const started = await compose(
    lab,
    ["up", "--detach", "--wait", "--wait-timeout", "300", "--no-build", "--pull", "never", "--remove-orphans"],
    { output: "stderr" },
  );
  if (started.code !== 0) {
    await compose(lab, ["logs", "--no-color", "--tail", "200"], { output: "stderr" });
    throw new LabError(
      `Lab "${lab.id}" did not start. Its logs are above. Fix the cause and run ${labCommand(lab, "up")} again, ` +
        `or stop it with ${labCommand(lab, "down")}.`,
    );
  }
  const url = await labUrl(lab);
  await waitForHost(lab, url);
  console.error(`Lab "${lab.id}" is ready at ${url}`);
  process.stdout.write(`${url}\n`);
}

async function up(lab) {
  await requireDocker();
  await withLock(lab, () => start(lab));
}

async function url(lab) {
  await requireDocker();
  const { containers } = await ownedResources(lab);
  if (!containers.some((container) => container.service === "gateway" && container.state === "running")) {
    throw new LabError(`Lab "${lab.id}" is not running. Start it with ${labCommand(lab, "up")}.`);
  }
  process.stdout.write(`${await labUrl(lab)}\n`);
}

function logArguments(args) {
  const forwarded = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (LOG_FLAGS.has(arg) || LOG_SERVICES.has(arg)) {
      forwarded.push(arg);
    } else if (arg === "--tail" && /^(\d+|all)$/.test(args[index + 1] || "")) {
      forwarded.push(arg, args[++index]);
    } else {
      throw new LabError(
        `Unsupported lab:logs argument "${arg}". Use --follow, --timestamps, --tail <lines>, or a service name (${[...LOG_SERVICES].join(", ")}).`,
      );
    }
  }
  return forwarded;
}

async function logs(lab, args) {
  const forwarded = logArguments(args);
  await requireDocker();
  const { containers } = await ownedResources(lab);
  if (!containers.length) throw new LabError(`Lab "${lab.id}" has no containers. Start it with ${labCommand(lab, "up")}.`);
  const result = await compose(lab, ["logs", "--no-color", ...forwarded], { output: "stdout" });
  process.exitCode = result.code;
}

async function stop(lab) {
  const stopped = await compose(lab, ["down", "--remove-orphans"], { output: "stderr" });
  if (stopped.code !== 0) throw new LabError(`Stopping Lab "${lab.id}" failed. The Docker output is above.`);
}

async function down(lab) {
  await requireDocker();
  await withLock(lab, async () => {
    checkRecord(lab);
    const { containers, networks } = await ownedResources(lab);
    if (!containers.length && !networks.length) {
      console.error(`Lab "${lab.id}" is not running.`);
      return;
    }
    await stop(lab);
    console.error(`Stopped Lab "${lab.id}". Its data is kept in ${relative(lab.stateDir)}.`);
  });
}

async function reset(lab) {
  await requireDocker();
  await withLock(lab, async () => {
    checkRecord(lab);
    await ownedResources(lab);
    await stop(lab);
    if ((await ownedResources(lab)).containers.length) {
      throw new LabError(`Lab "${lab.id}" still has containers, so its data was kept. Run ${labCommand(lab, "down")}, then retry.`);
    }
    for (const target of [lab.configDir, lab.mediaDir, lab.seedingDir, lab.seedPath]) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    console.error(`Deleted the data for Lab "${lab.id}".`);
    await start(lab);
  });
}

const COMMANDS = { up, url, logs, down, reset };

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const handler = COMMANDS[command];
  if (!handler) throw new LabError(`Usage: node scripts/lab.mjs <${Object.keys(COMMANDS).join("|")}>`);
  if (command !== "logs" && args.length) throw new LabError(`lab:${command} does not accept arguments.`);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      interruption ??= signal;
      activeChild?.kill(signal);
    });
  }
  await handler(selectLab(process.env.AURRAL_LAB_ID), args);
}

main().catch((error) => {
  console.error(error instanceof LabError ? error.message : error);
  process.exitCode = error.exitCode || 1;
});
