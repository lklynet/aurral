import { fork } from "node:child_process";
import { EventEmitter } from "node:events";

const WATCHER_STARTUP_TIMEOUT_MS = 10_000;

// Recursive fs.watch setup can synchronously traverse a whole library. Keep all
// filesystem access in a child so even a stalled mount cannot block the API.
export function createIsolatedLibraryWatcher(root, { pathMappings = [] } = {}, onChange, {
  startupTimeoutMs = WATCHER_STARTUP_TIMEOUT_MS,
  forkImpl = fork,
} = {}) {
  const watcher = new EventEmitter();
  const child = forkImpl(new URL("./libraryWatchProcessChild.js", import.meta.url), [root, JSON.stringify(pathMappings)], {
    execArgv: [],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  let closed = false;
  const timer = setTimeout(() => {
    fail(Object.assign(new Error(`Recursive watcher did not start within ${startupTimeoutMs}ms`), {
      code: "LIBRARY_WATCH_STARTUP_TIMEOUT",
    }));
  }, startupTimeoutMs);
  timer.unref?.();

  watcher.close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    // SIGTERM cannot interrupt a JS-blocked watcher setup on every platform.
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  };

  function fail(error) {
    if (closed) return;
    watcher.close();
    watcher.emit("error", error);
  }

  child.on("message", (message) => {
    if (closed) return;
    if (message?.type === "ready") {
      clearTimeout(timer);
      watcher.emit("ready");
    } else if (message?.type === "change") {
      onChange(message.eventType, message.filename, message.root);
    } else if (message?.type === "error") {
      fail(Object.assign(new Error(message.message), { code: message.code }));
    }
  });
  child.on("error", fail);
  child.on("exit", (code, signal) => {
    fail(new Error(`Library watcher exited unexpectedly (${signal || code})`));
  });
  child.unref();
  child.channel?.unref();
  return watcher;
}
