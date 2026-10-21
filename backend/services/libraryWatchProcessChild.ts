import fs from "node:fs";
import type { FSWatcher } from "node:fs";
import { resolveLocalPath } from "./pathMappings.ts";

type ChildMessage =
  | { type: "ready"; root: string }
  | { type: "change"; root: string; eventType: string; filename: string | null }
  | { type: "error"; message: string; code?: string };

let watcher: FSWatcher | undefined;

function stop() {
  watcher?.close();
  if (process.connected) process.disconnect!();
}

function send(message: ChildMessage) {
  if (!process.connected) return;
  process.send!(message, (error) => {
    if (error) stop();
  });
}

function fail(error: Error & { code?: string }) {
  send({ type: "error", message: error.message, code: error.code });
  stop();
}

process.on("disconnect", stop);

try {
  const root = resolveLocalPath(process.argv[2], JSON.parse(process.argv[3] || "[]"));
  // Node.js 24+ can return an idle recursive watcher for a missing Linux root.
  fs.statSync(root);
  watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
    send({ type: "change", root, eventType, filename: filename == null ? null : String(filename) });
  });
  watcher.on("error", fail);
  send({ type: "ready", root });
} catch (error) {
  fail(error);
}
