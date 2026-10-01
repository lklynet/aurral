import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const FAKE_DOCKER = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const statePath = path.join(__dirname, "state.json");
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
const started = Date.now();
fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify({ args, env: process.env }) + "\n");
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const fail = (message) => {
  process.stderr.write(message + "\n");
  process.exit(1);
};
const option = (name) => args[args.indexOf(name) + 1];
const render = (format, item) =>
  format.replace(/\{\{\s*(?:\.Label\s+"([^"]+)"|\.(\w+))\s*\}\}/g, (_, label, field) =>
    label ? item.labels[label] || "" : item[field] || "");
const inProject = (project) => (item) => item.labels["com.docker.compose.project"] === project;

if (state.daemonDown) fail("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?");
if (args[0] === "version") {
  console.log("26.1.5");
} else if (args[0] === "ps" || (args[0] === "network" && args[1] === "ls")) {
  const [key, value] = option("--filter").replace("label=", "").split("=");
  const items = args[0] === "ps" ? state.containers : state.networks;
  for (const item of items.filter((entry) => entry.labels[key] === value)) console.log(render(option("--format"), item));
} else if (args[0] === "image" && args[1] === "inspect") {
  console.log("sha256:fake-" + args.at(-1));
} else if (args[0] === "compose" && args[1] === "version") {
  console.log("2.29.7");
} else if (args[0] === "compose") {
  const project = option("--project-name");
  const command = args[args.indexOf("--file") + 2];
  const labels = (service) => ({
    "com.docker.compose.project": project,
    "com.docker.compose.service": service,
    "org.aurral.lab.owner": process.env.AURRAL_LAB_OWNER,
    "org.aurral.lab.id": process.env.AURRAL_LAB_ID,
  });
  if (command === "build") {
    if (state.blockBuildUntil) {
      while (!fs.existsSync(state.blockBuildUntil) && Date.now() < started + 15000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  } else if (command === "up") {
    state.containers = state.containers.filter((item) => !inProject(project)(item));
    for (const service of ["aurral", "gateway"]) {
      state.containers.push({ ID: project + "-" + service, State: state.failUp && service === "aurral" ? "exited" : "running", labels: labels(service) });
    }
    state.networks.push({ ID: project + "-lab", labels: labels("") });
    save();
    if (state.failUp) fail("container " + project + "-aurral-1 is unhealthy");
  } else if (command === "run" && args.includes("runner")) {
    const app = state.containers.find((item) => inProject(project)(item) && item.labels["com.docker.compose.service"] === "aurral");
    if (!app || app.State !== "running") fail("service aurral is not running");
    if (state.blockRunnerUntil) {
      while (!fs.existsSync(state.blockRunnerUntil) && Date.now() < started + 15000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    fs.writeFileSync(path.join(process.env.AURRAL_LAB_RESULTS_DIR, "results.json"), "{}");
    console.log("ran " + args.at(-1));
    const exits = [].concat(state.runnerExit?.[args.at(-1)] ?? 0);
    const attempt = Number(path.basename(process.env.AURRAL_LAB_RESULTS_DIR));
    process.exit(exits[Math.min(attempt, exits.length) - 1]);
  } else if (command === "run") {
    if (state.failSeed) fail("seed failed");
    fs.writeFileSync(path.join(process.env.AURRAL_LAB_SEED_DIR, "aurral.db"), "seeded");
  } else if (command === "port") {
    const gateway = state.containers.find((item) => inProject(project)(item) && item.labels["com.docker.compose.service"] === "gateway");
    if (!gateway || gateway.State !== "running") fail("service gateway is not running");
    console.log(state.port);
  } else if (command === "logs") {
    console.log("logs for " + project);
  } else if (command === "down") {
    state.containers = state.containers.filter((item) => !inProject(project)(item));
    state.networks = state.networks.filter((item) => !inProject(project)(item));
    save();
  }
} else {
  fail("unsupported fake docker call: " + args.join(" "));
}
`;

function createWorktree(root, name) {
  const worktree = join(root, name);
  mkdirSync(join(worktree, "scripts"), { recursive: true });
  mkdirSync(join(worktree, "tests", "lab"), { recursive: true });
  copyFileSync(join(repoRoot, "scripts", "lab.mjs"), join(worktree, "scripts", "lab.mjs"));
  copyFileSync(join(repoRoot, "tests", "lab", "compose.yml"), join(worktree, "tests", "lab", "compose.yml"));
  copyFileSync(join(repoRoot, "tests", "lab", "lab.env"), join(worktree, "tests", "lab", "lab.env"));
  mkdirSync(join(worktree, "tests", "e2e"));
  for (const name of ["smoke", "settings"]) writeFileSync(join(worktree, "tests", "e2e", `${name}.spec.js`), "");
  return worktree;
}

async function createLabSandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "aurral-lab-cli-"));
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "docker"), FAKE_DOCKER);
  chmodSync(join(binDir, "docker"), 0o755);
  const server = http.createServer((request, response) => {
    response.statusCode = request.url === "/api/health/live" ? 200 : 404;
    response.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = `127.0.0.1:${server.address().port}`;
  const statePath = join(binDir, "state.json");
  const writeState = (state) => writeFileSync(statePath, JSON.stringify(state));
  writeState({ containers: [], networks: [], port });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });

  const sandbox = {
    root,
    port,
    worktree: (name) => createWorktree(root, name),
    readState: () => JSON.parse(readFileSync(statePath, "utf8")),
    updateState: (change) => writeState({ ...sandbox.readState(), ...change }),
    calls() {
      const logPath = join(binDir, "calls.jsonl");
      if (!existsSync(logPath)) return [];
      return readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    },
    composeCalls(command) {
      return sandbox.calls().filter(({ args }) => args[0] === "compose" && args[args.indexOf("--file") + 2] === command);
    },
    start(worktree, args, { env = {}, path = `${binDir}:${process.env.PATH}`, cwd = worktree } = {}) {
      const child = spawn(process.execPath, [join(worktree, "scripts", "lab.mjs"), ...args], {
        cwd,
        env: { HOME: process.env.HOME, PATH: path, ...env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.result = new Promise((resolve) => {
        child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
      });
      return child;
    },
    run(worktree, args, options) {
      return sandbox.start(worktree, args, options).result;
    },
  };
  return sandbox;
}

const projectOf = (call) => call.args[call.args.indexOf("--project-name") + 1];

async function waitFor(condition) {
  const deadline = Date.now() + 10000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the Lab command");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("each worktree and Lab ID gets its own stable Docker project and state", async (t) => {
  const lab = await createLabSandbox(t);
  const first = lab.worktree("aurral-a");
  const second = lab.worktree("aurral-b");

  for (const [worktree, env] of [[first, {}], [second, {}], [first, { AURRAL_LAB_ID: "second" }]]) {
    const result = await lab.run(worktree, ["up"], { env });
    assert.equal(result.code, 0, result.stderr);
  }
  const ups = lab.composeCalls("up");
  const projects = ups.map(projectOf);
  const configDirs = ups.map((call) => call.env.AURRAL_LAB_CONFIG_DIR);
  assert.equal(new Set(projects).size, 3);
  assert.equal(new Set(configDirs).size, 3);
  assert.ok(configDirs[0].startsWith(join(first, "backend", "data", "lab")));
  assert.ok(configDirs[1].startsWith(join(second, "backend", "data", "lab")));
  assert.ok(configDirs.every((dir) => existsSync(dir)));

  const again = await lab.run(first, ["up"], { cwd: lab.root });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(projectOf(lab.composeCalls("up").at(-1)), projects[0]);
});

test("url prints only the running Lab's loopback URL", async (t) => {
  const lab = await createLabSandbox(t);
  const worktree = lab.worktree("aurral");

  const stopped = await lab.run(worktree, ["url"]);
  assert.notEqual(stopped.code, 0);
  assert.equal(stopped.stdout, "");
  assert.match(stopped.stderr, /lab:up/);

  assert.equal((await lab.run(worktree, ["up"])).code, 0);
  const running = await lab.run(worktree, ["url"]);
  assert.equal(running.code, 0, running.stderr);
  assert.equal(running.stdout, `http://${lab.port}\n`);
});

test("down stops only the selected Lab and keeps its data", async (t) => {
  const lab = await createLabSandbox(t);
  const worktree = lab.worktree("aurral");
  assert.equal((await lab.run(worktree, ["up"])).code, 0);
  assert.equal((await lab.run(worktree, ["up"], { env: { AURRAL_LAB_ID: "second" } })).code, 0);
  const [devUp, secondUp] = lab.composeCalls("up");
  const sentinel = join(devUp.env.AURRAL_LAB_CONFIG_DIR, "sentinel.txt");
  writeFileSync(sentinel, "keep");

  const result = await lab.run(worktree, ["down"]);
  assert.equal(result.code, 0, result.stderr);

  const downs = lab.composeCalls("down");
  assert.deepEqual(downs.map(projectOf), [projectOf(devUp)]);
  assert.ok(!downs[0].args.some((arg) => ["-v", "--volumes", "--rmi"].includes(arg)));
  assert.equal(readFileSync(sentinel, "utf8"), "keep");
  const remaining = lab.readState().containers.map((item) => item.labels["com.docker.compose.project"]);
  assert.deepEqual([...new Set(remaining)], [projectOf(secondUp)]);
});

test("resources owned by another worktree are never changed", async (t) => {
  const lab = await createLabSandbox(t);
  const worktree = lab.worktree("aurral");
  assert.equal((await lab.run(worktree, ["up"])).code, 0);
  const state = lab.readState();
  for (const item of state.containers) item.labels["org.aurral.lab.owner"] = "another-worktree";
  lab.updateState({ containers: state.containers });

  const database = join(lab.composeCalls("up")[0].env.AURRAL_LAB_CONFIG_DIR, "aurral.db");

  for (const command of ["down", "up", "reset"]) {
    const result = await lab.run(worktree, [command]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /did not create/);
  }
  assert.equal(lab.composeCalls("down").length, 0);
  assert.equal(lab.composeCalls("up").length, 1);
  assert.equal(lab.readState().containers.length, 2);
  assert.ok(existsSync(database));
});

test("the first start seeds the Lab and later starts keep its data", async (t) => {
  const lab = await createLabSandbox(t);
  const worktree = lab.worktree("aurral");
  assert.equal((await lab.run(worktree, ["up"])).code, 0);
  const configDir = lab.composeCalls("up")[0].env.AURRAL_LAB_CONFIG_DIR;
  assert.equal(readFileSync(join(configDir, "aurral.db"), "utf8"), "seeded");
  writeFileSync(join(configDir, "user-record.txt"), "keep");

  assert.equal((await lab.run(worktree, ["down"])).code, 0);
  const restarted = await lab.run(worktree, ["up"]);
  assert.equal(restarted.code, 0, restarted.stderr);

  assert.equal(lab.composeCalls("run").length, 1);
  assert.equal(readFileSync(join(configDir, "user-record.txt"), "utf8"), "keep");
});

test("reset recreates only the selected Lab after stopping it", async (t) => {
  const lab = await createLabSandbox(t);
  const worktree = lab.worktree("aurral");
  assert.equal((await lab.run(worktree, ["up"])).code, 0);
  assert.equal((await lab.run(worktree, ["up"], { env: { AURRAL_LAB_ID: "second" } })).code, 0);
  const [dev, second] = lab.composeCalls("up").map(({ env }) => env);
  for (const env of [dev, second]) {
    writeFileSync(join(env.AURRAL_LAB_CONFIG_DIR, "user-record.txt"), "record");
    writeFileSync(join(env.AURRAL_LAB_MEDIA_DIR, "track.flac"), "media");
  }
  const before = lab.calls().length;

  const result = await lab.run(worktree, ["reset"]);
  assert.equal(result.code, 0, result.stderr);

  const commands = lab.calls().slice(before)
    .filter(({ args }) => args[0] === "compose" && args.includes("--file"))
    .map((call) => [projectOf(call), call.args[call.args.indexOf("--file") + 2]]);
  const devProject = commands[0][0];
  assert.deepEqual(commands.filter(([, command]) => ["down", "run", "up"].includes(command)), [
    [devProject, "down"],
    [devProject, "run"],
    [devProject, "up"],
  ]);
  assert.ok(!existsSync(join(dev.AURRAL_LAB_CONFIG_DIR, "user-record.txt")));
  assert.ok(!existsSync(join(dev.AURRAL_LAB_MEDIA_DIR, "track.flac")));
  assert.equal(readFileSync(join(dev.AURRAL_LAB_CONFIG_DIR, "aurral.db"), "utf8"), "seeded");
  assert.equal(readFileSync(join(second.AURRAL_LAB_CONFIG_DIR, "user-record.txt"), "utf8"), "record");
  assert.equal(readFileSync(join(second.AURRAL_LAB_MEDIA_DIR, "track.flac"), "utf8"), "media");
});

test("incomplete or incompatible Lab state is refused until reset", async (t) => {
  const lab = await createLabSandbox(t);
  const worktree = lab.worktree("aurral");
  lab.updateState({ failSeed: true });

  const failedSeed = await lab.run(worktree, ["up"]);
  assert.notEqual(failedSeed.code, 0);
  assert.equal(lab.composeCalls("up").length, 0);
  lab.updateState({ failSeed: false });
  assert.equal((await lab.run(worktree, ["up"])).code, 0);

  const stateDir = dirname(lab.composeCalls("up")[0].env.AURRAL_LAB_CONFIG_DIR);
  const markerPath = join(stateDir, "seed.json");
  writeFileSync(markerPath, JSON.stringify({ ...JSON.parse(readFileSync(markerPath, "utf8")), version: 0 }));
  const incompatible = await lab.run(worktree, ["up"]);
  assert.notEqual(incompatible.code, 0);
  assert.match(incompatible.stderr, /lab:reset/);

  rmSync(markerPath);
  const incomplete = await lab.run(worktree, ["up"]);
  assert.notEqual(incomplete.code, 0);
  assert.match(incomplete.stderr, /lab:reset/);
  assert.equal(lab.composeCalls("up").length, 1);

  const reset = await lab.run(worktree, ["reset"]);
  assert.equal(reset.code, 0, reset.stderr);
  assert.equal(lab.composeCalls("up").length, 2);
});

test("a concurrent operation is refused and a killed operation's lock is recovered", async (t) => {
  const lab = await createLabSandbox(t);
  const worktree = lab.worktree("aurral");
  const release = join(lab.root, "release-build");
  lab.updateState({ blockBuildUntil: release });

  const blocked = lab.start(worktree, ["up"]);
  await waitFor(() => lab.composeCalls("build").length > 0);

  const concurrent = await lab.run(worktree, ["down"]);
  assert.notEqual(concurrent.code, 0);
  assert.match(concurrent.stderr, /Another Lab operation/);
  const sibling = await lab.run(worktree, ["down"], { env: { AURRAL_LAB_ID: "second" } });
  assert.equal(sibling.code, 0, sibling.stderr);

  blocked.kill("SIGKILL");
  writeFileSync(release, "");
  await blocked.result;

  const recovered = await lab.run(worktree, ["up"]);
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.match(recovered.stderr, /stale/i);
});

test("a failed startup shows the Lab's logs and releases the Lab", async (t) => {
  const lab = await createLabSandbox(t);
  const worktree = lab.worktree("aurral");
  lab.updateState({ failUp: true });

  const failed = await lab.run(worktree, ["up"]);
  assert.notEqual(failed.code, 0);
  const project = projectOf(lab.composeCalls("up")[0]);
  assert.match(failed.stderr, new RegExp(`logs for ${project}`));
  assert.match(failed.stderr, /lab:down/);

  lab.updateState({ failUp: false });
  const retried = await lab.run(worktree, ["up"]);
  assert.equal(retried.code, 0, retried.stderr);
});

test("private host configuration never reaches Docker", async (t) => {
  const lab = await createLabSandbox(t);
  const worktree = lab.worktree("aurral");
  mkdirSync(join(worktree, "backend"), { recursive: true });
  writeFileSync(join(worktree, "backend", ".env"), "LIDARR_API_KEY=private-file-value\n");

  const result = await lab.run(worktree, ["up"], {
    env: {
      LIDARR_API_KEY: "private-env-value",
      AURRAL_DB_PATH: "/host-secret/aurral.db",
      COMPOSE_PROJECT_NAME: "hijacked",
      COMPOSE_FILE: "/host-secret/compose.yml",
    },
  });
  assert.equal(result.code, 0, result.stderr);

  const recorded = JSON.stringify(lab.calls());
  for (const value of ["private-file-value", "private-env-value", "/host-secret/", "hijacked"]) {
    assert.ok(!recorded.includes(value), `Docker received ${value}`);
  }
});

test("invalid Lab IDs and unavailable Docker fail before any change", async (t) => {
  const lab = await createLabSandbox(t);
  const worktree = lab.worktree("aurral");

  for (const id of ["../escape", "Upper", "run-1", "x".repeat(40)]) {
    const result = await lab.run(worktree, ["up"], { env: { AURRAL_LAB_ID: id } });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /AURRAL_LAB_ID/);
  }
  assert.equal(lab.calls().length, 0);
  assert.ok(!existsSync(join(worktree, "backend")));

  const missing = await lab.run(worktree, ["up"], { path: join(lab.root, "empty-path") });
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /Docker/);

  lab.updateState({ daemonDown: true });
  const down = await lab.run(worktree, ["up"]);
  assert.notEqual(down.code, 0);
  assert.match(down.stderr, /Docker daemon/);
  assert.equal(lab.calls().filter(({ args }) => args[0] === "compose" && args.includes("up")).length, 0);
});

test("logs forwards supported options and rejects others", async (t) => {
  const lab = await createLabSandbox(t);
  const worktree = lab.worktree("aurral");
  assert.equal((await lab.run(worktree, ["up"])).code, 0);

  const logs = await lab.run(worktree, ["logs", "--tail", "20", "aurral"]);
  assert.equal(logs.code, 0, logs.stderr);
  assert.match(logs.stdout, /logs for /);
  const call = lab.composeCalls("logs").at(-1);
  assert.deepEqual(call.args.slice(-3), ["--tail", "20", "aurral"]);

  const rejected = await lab.run(worktree, ["logs", "--volumes"]);
  assert.notEqual(rejected.code, 0);
  assert.equal(lab.composeCalls("logs").length, 1);
});

const runnerCalls = (lab) => lab.composeCalls("run").filter(({ args }) => args.includes("runner"));
const inProjectOf = (project) => (item) => item.labels["com.docker.compose.project"] === project;
const commandsFor = (lab, project) =>
  lab.calls()
    .filter((call) => call.args[0] === "compose" && projectOf(call) === project)
    .map(({ args }) => args.slice(args.indexOf("--file") + 2))
    .filter(([command]) => command !== "build")
    .map(([command, ...rest]) => (command === "run" ? rest.find((arg) => !arg.startsWith("-")) : command));
const runDirs = (worktree) =>
  existsSync(join(worktree, "backend", "data", "lab"))
    ? readdirSync(join(worktree, "backend", "data", "lab")).filter((name) => name.startsWith("run-"))
    : [];

test("test runs each spec in a fresh Lab, keeps evidence, and reports failures", async (t) => {
  const lab = await createLabSandbox(t);
  const worktree = lab.worktree("aurral");
  lab.updateState({ runnerExit: { "tests/e2e/settings.spec.js": 1 } });

  const result = await lab.run(worktree, ["test", "tests/e2e/smoke.spec.js", "tests/e2e/settings.spec.js"]);
  assert.equal(result.code, 1, result.stderr);

  const runs = runnerCalls(lab);
  assert.deepEqual(runs.map(({ args }) => args.slice(-2)), [
    ["--retries=0", "tests/e2e/smoke.spec.js"],
    ["--retries=0", "tests/e2e/settings.spec.js"],
  ]);
  const projects = runs.map(projectOf);
  assert.notEqual(projects[0], projects[1]);
  for (const [index, project] of projects.entries()) {
    assert.deepEqual(commandsFor(lab, project), ["seed", "up", "runner", "logs", "logs", "down"]);
    const evidence = runs[index].env.AURRAL_LAB_RESULTS_DIR;
    assert.ok(evidence.startsWith(join(worktree, "test-results", "lab")));
    assert.ok(existsSync(join(evidence, "results.json")));
    assert.match(readFileSync(join(evidence, "aurral.log"), "utf8"), new RegExp(`logs for ${project}`));
    assert.match(readFileSync(join(evidence, "fixtures.log"), "utf8"), new RegExp(`logs for ${project}`));
    assert.equal(JSON.parse(readFileSync(join(evidence, "manifest.json"), "utf8")).exitCode, index);
  }
  assert.deepEqual(runDirs(worktree), []);
  assert.deepEqual(lab.readState().containers, []);
});

test("a test run leaves the development Lab untouched", async (t) => {
  const lab = await createLabSandbox(t);
  const worktree = lab.worktree("aurral");
  assert.equal((await lab.run(worktree, ["up"])).code, 0);
  const dev = lab.composeCalls("up")[0];
  writeFileSync(join(dev.env.AURRAL_LAB_CONFIG_DIR, "user-record.txt"), "keep");
  const before = lab.calls().length;

  const result = await lab.run(worktree, ["test", "tests/e2e/smoke.spec.js"]);
  assert.equal(result.code, 0, result.stderr);

  assert.ok(!lab.calls().slice(before).some((call) => call.args[0] === "compose" && projectOf(call) === projectOf(dev)));
  assert.equal(readFileSync(join(dev.env.AURRAL_LAB_CONFIG_DIR, "user-record.txt"), "utf8"), "keep");
  assert.equal(lab.readState().containers.filter(inProjectOf(projectOf(dev))).length, 2);
});

test("a test Lab that fails to start keeps its logs and is removed", async (t) => {
  const lab = await createLabSandbox(t);
  const worktree = lab.worktree("aurral");
  lab.updateState({ failUp: true });

  const result = await lab.run(worktree, ["test", "tests/e2e/smoke.spec.js"]);
  assert.notEqual(result.code, 0);

  const [up] = lab.composeCalls("up");
  assert.deepEqual(commandsFor(lab, projectOf(up)), ["seed", "up", "logs", "logs", "down"]);
  assert.match(readFileSync(join(up.env.AURRAL_LAB_RESULTS_DIR, "aurral.log"), "utf8"), /logs for /);
  assert.deepEqual(runDirs(worktree), []);
});

test("an interrupted test run removes its Lab and reports the interruption", async (t) => {
  const lab = await createLabSandbox(t);
  const worktree = lab.worktree("aurral");
  const release = join(lab.root, "release-runner");
  lab.updateState({ blockRunnerUntil: release });

  const running = lab.start(worktree, ["test", "tests/e2e/smoke.spec.js", "tests/e2e/settings.spec.js"]);
  await waitFor(() => runnerCalls(lab).length > 0);
  running.kill("SIGINT");
  const result = await running.result;
  writeFileSync(release, "");

  assert.equal(result.code, 130);
  const [run] = runnerCalls(lab);
  assert.deepEqual(commandsFor(lab, projectOf(run)), ["seed", "up", "runner", "logs", "logs", "down"]);
  assert.equal(runnerCalls(lab).length, 1);
  assert.ok(existsSync(join(run.env.AURRAL_LAB_RESULTS_DIR, "aurral.log")));
  assert.deepEqual(runDirs(worktree), []);
});

test("the next test run removes Labs left by a killed run", async (t) => {
  const lab = await createLabSandbox(t);
  const worktree = lab.worktree("aurral");
  const release = join(lab.root, "release-runner");
  lab.updateState({ blockRunnerUntil: release });

  const killed = lab.start(worktree, ["test", "tests/e2e/smoke.spec.js"]);
  await waitFor(() => runnerCalls(lab).length > 0);
  killed.kill("SIGKILL");
  writeFileSync(release, "");
  await killed.result;
  const stale = projectOf(runnerCalls(lab)[0]);
  assert.equal(runDirs(worktree).length, 1);

  const result = await lab.run(worktree, ["test", "tests/e2e/smoke.spec.js"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /stale/i);
  assert.equal(commandsFor(lab, stale).at(-1), "down");
  assert.deepEqual(runDirs(worktree), []);
  assert.deepEqual(lab.readState().containers, []);
});

test("test rejects unsupported arguments before starting anything", async (t) => {
  const lab = await createLabSandbox(t);
  const worktree = lab.worktree("aurral");

  for (const args of [
    ["--update-snapshots"],
    ["../outside.spec.js"],
    ["tests/e2e/missing.spec.js"],
    ["backend/server.js"],
    ["--output", "/tmp/elsewhere"],
    ["--reporter=dot"],
    ["--workers", "4"],
    ["--grep"],
    ["--repeat-each", "many"],
    ["--retries", "5"],
  ]) {
    const result = await lab.run(worktree, ["test", ...args]);
    assert.notEqual(result.code, 0, args.join(" "));
  }
  assert.equal(lab.calls().length, 0);
});

test("supported Playwright options reach the runner without replacing Lab controls", async (t) => {
  const lab = await createLabSandbox(t);
  const worktree = lab.worktree("aurral");

  const result = await lab.run(worktree, [
    "test", "--grep", "sign in; rm -rf /", "--repeat-each=2", "tests/e2e/smoke.spec.js", "--timeout", "45000",
  ]);
  assert.equal(result.code, 0, result.stderr);
  const [run] = runnerCalls(lab);
  const forwarded = run.args.slice(run.args.indexOf("runner") + 1);
  assert.deepEqual(forwarded, [
    "--grep", "sign in; rm -rf /", "--repeat-each=2", "--timeout", "45000", "--retries=0", "tests/e2e/smoke.spec.js",
  ]);
});

test("a failed spec retries in a fresh Lab with separate evidence when retries are allowed", async (t) => {
  const lab = await createLabSandbox(t);
  const worktree = lab.worktree("aurral");
  lab.updateState({ runnerExit: { "tests/e2e/smoke.spec.js": [1, 0], "tests/e2e/settings.spec.js": 1 } });

  const local = await lab.run(worktree, ["test", "tests/e2e/smoke.spec.js"]);
  assert.equal(local.code, 1);
  assert.equal(runnerCalls(lab).length, 1);

  const ci = await lab.run(worktree, ["test", "tests/e2e/smoke.spec.js", "tests/e2e/settings.spec.js"], { env: { CI: "true" } });
  assert.equal(ci.code, 1);
  const runs = runnerCalls(lab).slice(1);
  const dirs = runs.map(({ env }) => env.AURRAL_LAB_RESULTS_DIR);
  assert.deepEqual(dirs.map((dir) => dir.split("/").slice(-2).join("/")), [
    "smoke/1",
    "smoke/2",
    "settings/1",
    "settings/2",
    "settings/3",
  ]);
  assert.equal(new Set(runs.map(projectOf)).size, 5);
  for (const run of runs) assert.deepEqual(commandsFor(lab, projectOf(run)), ["seed", "up", "runner", "logs", "logs", "down"]);
  assert.ok(dirs.every((dir) => existsSync(join(dir, "manifest.json"))));
  assert.match(ci.stderr, /smoke\.spec\.js.*attempt 2/);
  assert.match(ci.stderr, /settings\.spec\.js.*3 attempts/);

  const retried = await lab.run(worktree, ["test", "--retries", "1", "tests/e2e/smoke.spec.js"]);
  assert.equal(retried.code, 0, retried.stderr);
});
