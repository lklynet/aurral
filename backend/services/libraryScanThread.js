// Worker-thread entry for library scans. Runs the full scan pipeline on its own
// SQLite connection so the main thread keeps serving requests while the scan
// walks the filesystem, talks to Lidarr, and writes library rows.
import { parentPort, workerData } from "node:worker_threads";

const toPlain = (value) => JSON.parse(JSON.stringify(value ?? null));

try {
  const { lidarrClient } = await import("./lidarrClient.js");
  const { scanConfiguredLibrary } = await import("./libraryIndexService.js");
  const result = await scanConfiguredLibrary({
    ...(workerData?.musicRoot ? { musicRoot: String(workerData.musicRoot) } : {}),
    lidarrClient,
    includeLidarr: workerData?.includeLidarr === true,
    artistIds: Array.isArray(workerData?.artistIds) ? workerData.artistIds : null,
    force: workerData?.force === true,
  });
  parentPort.postMessage({ type: "done", result: toPlain(result) });
} catch (error) {
  parentPort.postMessage({
    type: "error",
    message: error?.message || String(error),
    stack: error?.stack || null,
  });
}
