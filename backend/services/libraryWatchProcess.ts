import { fork } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Serializable } from "node:child_process";
import type { PathMapping } from "./pathMappings.ts";

export type WatchMessage =
  | { type: "ready"; root: string }
  | { type: "change"; root: string; eventType: string; filename: string | null }
  | { type: "error"; message: string; code?: string };

// Recursive fs.watch setup can synchronously traverse a whole library. Keep all
// filesystem access in a child so even a stalled mount cannot block the API.
export function createIsolatedLibraryWatcher(
  root: string,
  { pathMappings = [] }: { recursive?: boolean; pathMappings?: PathMapping[] } = {},
  onChange: (eventType: string, filename: string | null, root: string) => void,
  { forkImpl = fork }: { forkImpl?: typeof fork } = {},
) {
  const watcher = new EventEmitter() as EventEmitter & { close: () => void };
  const child = forkImpl(
    new URL("./libraryWatchProcessChild.ts", import.meta.url),
    [root, JSON.stringify(pathMappings)],
    {
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    },
  );
  let closed = false;

  watcher.close = () => {
    if (closed) return;
    closed = true;
    // SIGTERM cannot interrupt a JS-blocked watcher setup on every platform.
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    watcher.emit("close");
  };

  function fail(error: Error) {
    if (closed) return;
    watcher.close();
    watcher.emit("error", error);
  }

  child.on("message", ((message: WatchMessage | null | undefined) => {
    if (closed) return;
    if (message?.type === "ready") {
      watcher.emit("ready", message.root);
    } else if (message?.type === "change") {
      onChange(message.eventType, message.filename, message.root);
    } else if (message?.type === "error") {
      fail(Object.assign(new Error(message.message), { code: message.code }));
    }
  }) as (message: Serializable) => void);
  child.on("error", fail);
  child.on("exit", (code, signal) => {
    fail(new Error(`Library watcher exited unexpectedly (${signal || code})`));
  });
  child.unref();
  child.channel?.unref();
  return watcher;
}
