import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const composeFile = path.join(repoRoot, "tests", "lab", "compose.yml");
const specDir = path.join(repoRoot, "tests", "e2e");
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
  "CI",
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
  return labFor(id);
}

function labFor(id, { resultsDir } = {}) {
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
    runnerImage: `${prefix}-runner:local`,
    stateDir,
    resultsDir: resultsDir || path.join(stateDir, "results"),
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
    AURRAL_LAB_RUNNER_IMAGE: lab.runnerImage,
    AURRAL_LAB_RESULTS_DIR: lab.resultsDir,
    AURRAL_LAB_CONFIG_DIR: lab.configDir,
    AURRAL_LAB_MEDIA_DIR: lab.mediaDir,
    AURRAL_LAB_SEED_DIR: lab.seedingDir,
    AURRAL_LAB_UID: String(process.getuid?.() ?? 1000),
    AURRAL_LAB_GID: String(process.getgid?.() ?? 1000),
  };
}

function execute(command, args, { env, output = "capture", cleanup = false } = {}) {
  const stdio = {
    capture: ["ignore", "pipe", "pipe"],
    stdout: ["ignore", "inherit", "inherit"],
    stderr: ["ignore", 2, 2],
  }[output];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, env, stdio });
    activeChild = child;
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      activeChild = null;
      reject(error);
    });
    child.on("close", (code) => {
      activeChild = null;
      try {
        if (!cleanup) checkInterrupted();
        resolve({ code: code ?? 1, stdout, stderr });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function docker(args, { lab, ...options } = {}) {
  try {
    return await execute("docker", args, { ...options, env: dockerEnv(lab) });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new LabError("Docker is not installed or not on PATH. Install Docker Engine with the Compose plugin, then retry.");
  }
}

function compose(lab, args, options = {}) {
  return docker(
    ["compose", "--project-name", lab.project, "--file", composeFile, ...args],
    { ...options, lab },
  );
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

function specArguments(args) {
  const specs = args.length
    ? args
    : fs
        .readdirSync(specDir)
        .filter((name) => name.endsWith(".spec.js"))
        .sort()
        .map((name) => `tests/e2e/${name}`);
  const normalized = specs.map((spec) => {
    const resolved = path.resolve(repoRoot, spec);
    if (path.dirname(resolved) !== specDir || !resolved.endsWith(".spec.js") || !fs.existsSync(resolved)) {
      throw new LabError(`"${spec}" is not a spec file in tests/e2e. Pass spec files such as tests/e2e/smoke.spec.js.`);
    }
    return `tests/e2e/${path.basename(resolved)}`;
  });
  return [...new Set(normalized)];
}

async function sourceInfo() {
  try {
    const head = await execute("git", ["rev-parse", "HEAD"], { env: process.env });
    if (head.code !== 0) return { commit: "unavailable" };
    const status = await execute("git", ["status", "--porcelain"], { env: process.env });
    return { commit: head.stdout.trim(), uncommittedChanges: status.stdout.trim() !== "" };
  } catch {
    return { commit: "unavailable" };
  }
}

async function imageIds(lab) {
  const ids = {};
  for (const [name, image] of [["aurral", lab.image], ["runner", lab.runnerImage]]) {
    const result = await docker(["image", "inspect", "--format", "{{.Id}}", image]);
    ids[name] = result.code === 0 ? result.stdout.trim() : "unavailable";
  }
  return ids;
}

async function removeStaleRuns() {
  const listed = await docker([
    "ps",
    "--all",
    "--filter",
    `label=org.aurral.lab.owner=${labFor("dev").owner}`,
    "--format",
    '{{.Label "org.aurral.lab.id"}}',
  ]);
  const ids = new Set(listed.stdout.split("\n").filter((id) => id.startsWith("run-")));
  if (fs.existsSync(labRoot)) {
    for (const name of fs.readdirSync(labRoot)) if (name.startsWith("run-")) ids.add(name);
  }
  for (const id of ids) {
    const lab = labFor(id);
    let release;
    try {
      release = acquireLock(lab);
    } catch (error) {
      if (error instanceof LabError) continue;
      throw error;
    }
    try {
      await stop(lab);
      fs.rmSync(lab.stateDir, { recursive: true, force: true });
      console.error(`Removed the stale test Lab "${id}" left by an interrupted run.`);
    } finally {
      release();
    }
  }
}

async function runScenario(lab, run) {
  fs.mkdirSync(lab.resultsDir, { recursive: true });
  const startedAt = new Date().toISOString();
  let exitCode = 1;
  try {
    await withLock(lab, async () => {
      try {
        claimState(lab);
        await ownedResources(lab);
        await seed(lab);
        const started = await compose(
          lab,
          ["up", "--detach", "--wait", "--wait-timeout", "300", "--no-build", "--pull", "never", "aurral"],
          { output: "stderr" },
        );
        if (started.code !== 0) {
          throw new LabError(`The test Lab for ${run.spec} did not start. Its logs are in ${relative(lab.resultsDir)}.`);
        }
        console.error(`Running ${run.spec} in Lab "${lab.id}"...`);
        const ran = await compose(lab, ["run", "--rm", "--no-deps", "-T", "runner", "--retries=0", run.spec], {
          output: "stdout",
        });
        exitCode = ran.code;
      } finally {
        const logs = await compose(lab, ["logs", "--no-color", "--timestamps", "aurral"], { cleanup: true });
        fs.writeFileSync(path.join(lab.resultsDir, "aurral.log"), logs.stdout + logs.stderr);
        const manifest = {
          runId: run.id,
          spec: run.spec,
          attempt: run.attempt,
          project: lab.project,
          ...run.source,
          images: run.images,
          startedAt,
          finishedAt: new Date().toISOString(),
          exitCode,
          interrupted: interruption || undefined,
        };
        fs.writeFileSync(path.join(lab.resultsDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
        await compose(lab, ["down", "--remove-orphans"], { output: "stderr", cleanup: true });
        fs.rmSync(lab.stateDir, { recursive: true, force: true });
      }
    });
  } catch (error) {
    if (interruption || !(error instanceof LabError)) throw error;
    console.error(error.message);
  }
  return exitCode;
}

async function runTests(args) {
  const specs = specArguments(args);
  await requireDocker();
  await removeStaleRuns();
  const token = randomBytes(3).toString("hex");
  const runId = `${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}-${token}`;
  const runDir = path.join(repoRoot, "test-results", "lab", runId);
  const labs = specs.map((spec, index) =>
    labFor(`run-${token}-${index + 1}`, { resultsDir: path.join(runDir, path.basename(spec, ".spec.js"), "1") }),
  );
  console.error("Building Aurral and the browser runner...");
  const built = await compose(labs[0], ["build", "aurral", "runner"], { output: "stderr" });
  if (built.code !== 0) throw new LabError("Building the test images failed. The build output is above.");
  const run = { id: runId, attempt: 1, source: await sourceInfo(), images: await imageIds(labs[0]) };

  const outcomes = [];
  for (const [index, spec] of specs.entries()) {
    outcomes.push({ spec, exitCode: await runScenario(labs[index], { ...run, spec }) });
  }
  console.error("");
  for (const { spec, exitCode } of outcomes) console.error(`${exitCode === 0 ? "passed" : "FAILED"}  ${spec}`);
  console.error(`Evidence: ${relative(runDir)}`);
  if (outcomes.some(({ exitCode }) => exitCode !== 0)) process.exitCode = 1;
}

const COMMANDS = { up, url, logs, down, reset };

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const handler = command === "test" ? runTests : COMMANDS[command];
  if (!handler) throw new LabError(`Usage: node scripts/lab.mjs <${[...Object.keys(COMMANDS), "test"].join("|")}>`);
  if (!["logs", "test"].includes(command) && args.length) throw new LabError(`lab:${command} does not accept arguments.`);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      interruption ??= signal;
      activeChild?.kill(signal);
    });
  }
  if (command === "test") return runTests(args);
  await handler(selectLab(process.env.AURRAL_LAB_ID), args);
}

main().catch((error) => {
  console.error(error instanceof LabError ? error.message : error);
  process.exitCode = error.exitCode || 1;
});
