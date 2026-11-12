import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import * as v from "valibot";
import { AurralApi, aurralEnv, withAurral, writeAurralEnv, writeAuthority } from "./aurral.ts";
import { loadCatalogue } from "./catalogue/catalogue.ts";
import { notCovered } from "./coverage.ts";
import { generateLibrary, generateWorld } from "./library/generate.ts";
import { seedAurral } from "./seed.ts";
import { isOwnKey } from "../lib/ownKey.ts";
import { isService, serviceNames, services, withNeeds } from "./services/index.ts";
import { until, type Service } from "./services/service.ts";
import { LISTENER, LOGIN, paths, PROJECT, REPO_ROOT, resolvePorts, STATE_DIR } from "./state.ts";
import type { Ports } from "./state.ts";

const COMPOSE_FILE = path.join(REPO_ROOT, "eden", "compose.yml");
const CORE_CONTAINERS = ["metadata", "outside"];
const AURRAL = "aurral";
const WORLD = "world";
// Made before Compose starts, so Docker does not create them as root.
const DOWNLOAD_FOLDERS = ["nzbget", "sabnzbd", "qbittorrent", "slskd/complete", "slskd/incomplete"];

function composeEnv(ports: Ports) {
  return {
    ...process.env,
    EDEN_REPO: REPO_ROOT,
    EDEN_LIBRARY: paths.library,
    EDEN_WORLD: paths.world,
    EDEN_OUTSIDE: paths.outside,
    EDEN_LIDARR: paths.lidarr,
    EDEN_DOWNLOADS: paths.downloads,
    EDEN_UID: String(process.getuid?.() ?? 1000),
    EDEN_GID: String(process.getgid?.() ?? 1000),
    ...Object.fromEntries(
      Object.entries(ports).map(([name, port]) => [
        `EDEN_PORT_${name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`,
        String(port),
      ]),
    ),
  };
}

function compose(ports: Ports, args: string[], capture = false) {
  const result = spawnSync("docker", ["compose", "-p", PROJECT, "-f", COMPOSE_FILE, ...args], {
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: composeEnv(ports),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`Docker Compose did not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`docker compose ${args[0]} failed${capture ? `: ${result.stderr}` : ""}`);
  }
  return capture ? `${result.stdout}${result.stderr}` : "";
}

const readNames = (file: string) =>
  existsSync(file) ? v.parse(v.array(v.string()), JSON.parse(readFileSync(file, "utf8"))) : [];

const readDone = () => readNames(paths.done);

function markDone(name: string) {
  writeFileSync(paths.done, JSON.stringify([...new Set([...readDone(), name])]) + "\n");
}

function summary(ports: Ports) {
  const lines = readDone()
    .filter(isService)
    .map((name) => {
      const service: Service = services[name];
      return `  ${name.padEnd(12)}${service.about(ports)}`;
    });
  console.log(`
Eden is up for ${REPO_ROOT}
  App         http://127.0.0.1:${ports.aurralWeb} once "pnpm eden dev" runs (API ${ports.aurralApi})
  Admin       ${LOGIN.username} / ${LOGIN.password}
  User        ${LISTENER.username} / ${LISTENER.password}
  Metadata    http://127.0.0.1:${ports.metadata}
  Outside     http://127.0.0.1:${ports.outside}/requests lists what Aurral asked the internet
${lines.join("\n")}

Not in Eden
${notCovered.map((line) => `  ${line}`).join("\n")}
`);
}

function requestedServices(everything = false) {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: { with: { type: "string", multiple: true }, all: { type: "boolean" } },
  });
  const asked = (values.with ?? []).length > 0;
  if (values.all || (everything && !asked)) return serviceNames;
  const names = (values.with ?? []).flatMap((entry) => entry.split(",")).filter(Boolean);
  const unknown = names.filter((name) => !isService(name));
  if (unknown.length > 0) {
    throw new Error(`Unknown service: ${unknown.join(", ")}. Eden has ${serviceNames.join(", ")}.`);
  }
  return names.filter(isService);
}

async function up(everything = false) {
  const ports = await resolvePorts();
  const done = readDone();
  const selected = withNeeds([
    ...readNames(paths.selected).filter(isService),
    ...requestedServices(everything),
  ]);
  writeFileSync(paths.selected, JSON.stringify(selected) + "\n");
  const fresh = !done.includes(AURRAL);
  if (fresh) {
    const albums = generateLibrary(loadCatalogue(), paths.library);
    const tracks = albums.reduce((total, album) => total + album.length, 0);
    console.log(`Library: ${albums.length} albums, ${tracks} tracks`);
  }
  const chosen: Service[] = selected.map((name) => services[name]);
  if (!done.includes(WORLD)) {
    rmSync(paths.world, { recursive: true, force: true });
    const world = generateWorld(loadCatalogue(), paths.world);
    console.log(`World: ${world.length} releases to download`);
    markDone(WORLD);
  }
  mkdirSync(paths.lidarr, { recursive: true });
  for (const folder of DOWNLOAD_FOLDERS) {
    mkdirSync(path.join(paths.downloads, folder), { recursive: true });
  }
  writeAuthority();
  compose(ports, [
    "up",
    "--detach",
    "--wait",
    ...new Set([...CORE_CONTAINERS, ...chosen.flatMap((service) => service.containers)]),
  ]);
  const env = chosen.reduce(
    (merged, service) => ({ ...merged, ...service.env?.(ports) }),
    aurralEnv(ports),
  );
  writeAurralEnv(env);

  const pending = selected.filter((name) => !done.includes(name));
  if (fresh || pending.length > 0) {
    await withAurral(ports, env, async () => {
      const api = new AurralApi(ports);
      if (fresh) {
        const seeded = await seedAurral(api, ports);
        console.log(`History: ${seeded.plays} plays`);
        markDone(AURRAL);
      }
      await api.login(LOGIN);
      for (const name of pending) {
        const service: Service = services[name];
        await service.setup({
          ports,
          api,
          restart: (container) => void compose(ports, ["restart", container]),
          exec: (container, ...command) =>
            compose(ports, ["exec", "-T", container, ...command], true),
          logs: (container) => compose(ports, ["logs", "--no-color", container], true),
        });
        markDone(name);
        console.log(`Set up ${name}`);
      }
    });
  }
  summary(ports);
  return env;
}

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Stops the `eden dev` this checkout started, which stops Aurral with it. The command
// check guards against a stale file whose number now belongs to another process.
async function stopDev() {
  if (!existsSync(paths.devPid)) return;
  const pid = Number(readFileSync(paths.devPid, "utf8"));
  const { stdout } = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  if (!Number.isInteger(pid) || !stdout.includes("eden/cli.ts")) return;
  process.kill(pid, "SIGTERM");
  await until("Aurral to stop", async () => !isRunning(pid), 30_000);
}

async function down() {
  if (!existsSync(STATE_DIR)) {
    console.log("This checkout has no Eden.");
    return;
  }
  await stopDev();
  const ports = await resolvePorts();
  compose(ports, ["down", "--volumes", "--remove-orphans"]);
  rmSync(STATE_DIR, { recursive: true, force: true });
  console.log("Eden is gone. `pnpm eden up` builds a fresh one.");
}

async function dev() {
  const env = await up();
  writeFileSync(paths.devPid, String(process.pid));
  const child = spawn(process.execPath, ["scripts/dev.mts"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, ...env, AURRAL_ENV_FILE: paths.aurralEnv },
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.once("exit", (code) => {
    rmSync(paths.devPid, { force: true });
    process.exitCode = code ?? 1;
  });
}

// Journeys run against a new Eden with every service, so a run starts from the same
// state each time.
async function test() {
  await down();
  const env = await up(true);
  await withAurral(await resolvePorts(), env, async () => {
    const run = spawnSync("pnpm", ["exec", "vp", "test", "run", "--project", "eden"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    process.exitCode = run.status ?? 1;
  });
}

const commands = {
  up: () => up(),
  down,
  dev,
  test,
  status: async () => summary(await resolvePorts()),
};
const command = process.argv[2] ?? "";
if (!isOwnKey(commands, command)) {
  console.error(
    `Usage: pnpm eden <${Object.keys(commands).join("|")}> [--with ${serviceNames.join(",")}] [--all]`,
  );
  process.exit(1);
}
try {
  await commands[command]();
} catch (error) {
  console.error(error);
  console.error("\nEden setup stopped partway. Run `pnpm eden down`, then `pnpm eden up` again.");
  process.exit(1);
}
