import fs from "node:fs";
import { resolveLocalPath } from "./pathMappings.js";

let watcher;

function stop() {
  watcher?.close();
  if (process.connected) process.disconnect();
}

function send(message) {
  if (!process.connected) return;
  process.send(message, (error) => {
    if (error) stop();
  });
}

function fail(error) {
  send({ type: "error", message: error.message, code: error.code });
  stop();
}

process.on("disconnect", stop);

try {
  const root = resolveLocalPath(process.argv[2], JSON.parse(process.argv[3] || "[]"));
  watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
    send({ type: "change", root, eventType, filename: filename == null ? null : String(filename) });
  });
  watcher.on("error", fail);
  send({ type: "ready", root });
} catch (error) {
  fail(error);
}
