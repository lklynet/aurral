import fs from "node:fs";
import type { FSWatcher } from "node:fs";
import type { WatchMessage } from "./libraryWatchProcess.ts";
import { asAppError, type AppError } from "../../lib/errors.ts";
import { normalizePathMappings, resolveLocalPath } from "./pathMappings.ts";

let watcher: FSWatcher | undefined;

function stop() {
  watcher?.close();
  if (process.connected) process.disconnect!();
}

function send(message: WatchMessage) {
  if (!process.connected) return;
  process.send!(message, (error) => {
    if (error) stop();
  });
}

function fail(error: AppError) {
  send({ type: "error", message: error.message, code: error.code });
  stop();
}

process.on("disconnect", stop);
// Node's recursive watcher can throw outside its error event, as when a
// network mount drops a folder's handle. The parent then learns why instead
// of only an exit code.
process.on("uncaughtException", (error) => fail(asAppError(error) ?? new Error(String(error))));

try {
  const root = resolveLocalPath(
    process.argv[2],
    normalizePathMappings(JSON.parse(process.argv[3] || "[]")),
  );
  // Node.js 24+ can return an idle recursive watcher for a missing Linux root.
  fs.statSync(root);
  watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
    send({ type: "change", root, eventType, filename: filename == null ? null : String(filename) });
  });
  watcher.on("error", fail);
  send({ type: "ready", root });
} catch (error) {
  const failure = asAppError(error);
  if (!failure) throw error;
  fail(failure);
}
