import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { logger } from "../logger.ts";
import { PLUGIN_MAIN, pluginDataFolder, pluginFolder } from "./pluginManifest.ts";
import { disablePlugin, recordPluginError, type InstalledPlugin } from "./pluginStore.ts";

const RUNNER = fileURLToPath(new URL("./pluginRunner.ts", import.meta.url));
const START_TIMEOUT_MS = 30_000;
const IDLE_MS = 5 * 60_000;
const HEAP_MB = 256;
const MAX_BROKEN_IN_A_ROW = 3;
const MAX_LOG_LINE = 2000;
const ENV_KEYS = ["PATH", "HOME", "TZ", "LANG", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS"];

export type PluginRequest = { path: string; input: unknown };

export class PluginError extends Error {}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: BrokenPlugin | PluginError) => void;
  timer: NodeJS.Timeout;
};
type Exports = string[];
type Running = {
  child: ChildProcess;
  ready: Promise<Exports>;
  pending: Map<number, Pending>;
  idle: NodeJS.Timeout | null;
  stopped: boolean;
};

class BrokenPlugin extends Error {}

const childMessage = v.variant("type", [
  v.object({ type: v.literal("ready"), exports: v.array(v.string()) }),
  v.object({ type: v.literal("result"), id: v.number(), value: v.unknown() }),
  v.object({ type: v.literal("error"), id: v.number(), message: v.string() }),
  v.object({ type: v.literal("fatal"), message: v.string() }),
  v.object({ type: v.literal("log"), level: v.picklist(["info", "warn"]), message: v.string() }),
]);

const running = new Map<string, Running>();
const brokenInARow = new Map<string, number>();
let nextCallId = 1;

const logCategory = (id: string) => `plugin:${id}`;

function pluginEnv() {
  return Object.fromEntries(
    ENV_KEYS.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
  );
}

type PluginLogLine = { level: "info" | "warn"; message: string };
const logWatchers = new Map<string, Set<(line: PluginLogLine) => void>>();

function pluginLog(id: string, level: PluginLogLine["level"], text: string) {
  if (!text.trim()) return;
  const message = text.slice(0, MAX_LOG_LINE);
  logger[level](logCategory(id), message);
  for (const watcher of logWatchers.get(id) ?? []) watcher({ level, message });
}

export function watchPluginLogs(id: string, watcher: (line: PluginLogLine) => void) {
  const watchers = logWatchers.get(id) ?? new Set();
  logWatchers.set(id, watchers.add(watcher));
  return () => {
    watchers.delete(watcher);
    if (!watchers.size) logWatchers.delete(id);
  };
}

function forwardLines(id: string, stream: Readable | null, level: PluginLogLine["level"]) {
  if (!stream) return;
  readline.createInterface({ input: stream }).on("line", (line) => pluginLog(id, level, line));
}

function failAll(state: Running, error: BrokenPlugin | PluginError) {
  for (const call of state.pending.values()) {
    clearTimeout(call.timer);
    call.reject(error);
  }
  state.pending.clear();
}

function start(plugin: InstalledPlugin): Running {
  mkdirSync(pluginDataFolder(plugin.id), { recursive: true });
  const child = fork(RUNNER, [path.join(pluginFolder(plugin.id), PLUGIN_MAIN)], {
    cwd: pluginFolder(plugin.id),
    env: pluginEnv(),
    execArgv: [`--max-old-space-size=${HEAP_MB}`],
    silent: true,
  });
  forwardLines(plugin.id, child.stdout, "info");
  forwardLines(plugin.id, child.stderr, "warn");
  const settle = Promise.withResolvers<Exports>();
  settle.promise.catch(() => {});
  const state: Running = {
    child,
    ready: settle.promise,
    pending: new Map(),
    idle: null,
    stopped: false,
  };
  const startTimer = setTimeout(() => {
    settle.reject(new BrokenPlugin(`didn't start within ${START_TIMEOUT_MS / 1000} seconds`));
    stopPlugin(plugin.id);
  }, START_TIMEOUT_MS);

  child.on("message", (raw) => {
    const parsed = v.safeParse(childMessage, raw);
    if (!parsed.success) return;
    const message = parsed.output;
    if (message.type === "log") {
      pluginLog(plugin.id, message.level, message.message);
      return;
    }
    if (message.type === "ready") {
      clearTimeout(startTimer);
      settle.resolve(message.exports);
      return;
    }
    if (message.type === "fatal") {
      clearTimeout(startTimer);
      settle.reject(new BrokenPlugin(message.message));
      return;
    }
    const call = state.pending.get(message.id);
    if (!call) return;
    state.pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.type === "result") call.resolve(message.value);
    else call.reject(new PluginError(message.message));
  });
  child.on("error", (error) => {
    logger.warn(logCategory(plugin.id), "Plugin process error", { message: error.message });
  });
  child.on("exit", (code, signal) => {
    clearTimeout(startTimer);
    if (state.idle) clearTimeout(state.idle);
    if (running.get(plugin.id) === state) running.delete(plugin.id);
    const reason = signal ? `stopped by ${signal}` : `stopped with exit code ${code}`;
    settle.reject(new BrokenPlugin(`${PLUGIN_MAIN} ${reason} before it was ready`));
    if (!state.stopped) failAll(state, new BrokenPlugin(`its process ${reason}`));
  });
  return state;
}

export function stopPlugin(id: string) {
  const state = running.get(id);
  if (!state) return;
  running.delete(id);
  state.stopped = true;
  if (state.idle) clearTimeout(state.idle);
  failAll(state, new PluginError("was turned off or restarted"));
  state.child.kill();
}

export function stopAllPlugins() {
  for (const id of [...running.keys()]) stopPlugin(id);
}

function scheduleIdleStop(id: string, state: Running) {
  if (state.idle) clearTimeout(state.idle);
  state.idle = null;
  if (state.pending.size > 0) return;
  state.idle = setTimeout(() => {
    if (running.get(id) === state && state.pending.size === 0) stopPlugin(id);
  }, IDLE_MS);
  state.idle.unref();
}

async function send(plugin: InstalledPlugin, request: PluginRequest, timeoutMs: number) {
  const state = running.get(plugin.id) ?? start(plugin);
  running.set(plugin.id, state);
  if (state.idle) clearTimeout(state.idle);
  const exports = await state.ready;
  if (!exports.includes(request.path))
    throw new BrokenPlugin(`${PLUGIN_MAIN} doesn't export ${request.path}`);
  const id = nextCallId++;
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        reject(new BrokenPlugin(`didn't answer within ${Math.round(timeoutMs / 1000)} seconds`));
        stopPlugin(plugin.id);
      }, timeoutMs);
      state.pending.set(id, { resolve, reject, timer });
      state.child.send({ type: "call", id, ...request }, (error) => {
        if (!error) return;
        state.pending.delete(id);
        clearTimeout(timer);
        reject(new BrokenPlugin(`couldn't receive the request: ${error.message}`));
      });
    });
  } finally {
    if (running.get(plugin.id) === state) scheduleIdleStop(plugin.id, state);
  }
}

function recordFailure(plugin: InstalledPlugin, error: unknown, countFailures: boolean) {
  const broken = error instanceof BrokenPlugin;
  const message =
    error instanceof Error ? error.message : `failed: ${String(error ?? "unknown error")}`;
  logger.warn(logCategory(plugin.id), `${plugin.manifest.name} ${message}`, {
    version: plugin.manifest.version,
  });
  recordPluginError(plugin.id, message);
  if (!broken || !countFailures) return new PluginError(message);
  const count = (brokenInARow.get(plugin.id) ?? 0) + 1;
  brokenInARow.set(plugin.id, count);
  if (count >= MAX_BROKEN_IN_A_ROW) {
    brokenInARow.delete(plugin.id);
    stopPlugin(plugin.id);
    disablePlugin(plugin.id, `${message}. Turned off after ${count} failures in a row.`);
    logger.error(logCategory(plugin.id), `${plugin.manifest.name} was turned off`, {
      reason: message,
    });
  }
  return new PluginError(message);
}

// Everything a plugin returns is checked here, so a failure before this
// point is the plugin's and a failure after it is Aurral's.
export async function callPlugin<Schema extends v.GenericSchema>(
  plugin: InstalledPlugin,
  request: PluginRequest,
  output: Schema,
  timeoutMs: number,
  { countFailures = true } = {},
): Promise<v.InferOutput<Schema>> {
  try {
    const value = await send(plugin, request, timeoutMs);
    const parsed = v.safeParse(output, value);
    if (!parsed.success) {
      const [issue] = parsed.issues;
      const at = v.getDotPath(issue);
      throw new BrokenPlugin(
        `returned something Aurral can't read${at ? ` at ${at}` : ""}: ${issue.message}`,
      );
    }
    brokenInARow.delete(plugin.id);
    if (plugin.lastError) recordPluginError(plugin.id, null);
    return parsed.output;
  } catch (error) {
    throw recordFailure(plugin, error, countFailures);
  }
}
