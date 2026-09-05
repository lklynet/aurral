import { Worker } from "node:worker_threads";
import { invalidateCanonicalLibraryCache } from "./libraryQueryService.js";

const THREAD_URL = new URL("./libraryScanThread.js", import.meta.url);

let activeScan = null;

function spawnScan({ includeLidarr, musicRoot, artistIds, force }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(THREAD_URL, {
      workerData: {
        includeLidarr: includeLidarr === true,
        musicRoot: musicRoot || null,
        artistIds: Array.isArray(artistIds) && artistIds.length ? artistIds : null,
        force: force === true,
      },
    });
    let settled = false;
    const settle = (handler) => (value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };
    worker.once("message", settle((message) => {
      if (message?.type === "done") {
        resolve(message.result);
        return;
      }
      const error = new Error(message?.message || "library scan failed");
      if (message?.stack) error.stack = message.stack;
      reject(error);
    }));
    worker.once("error", settle(reject));
    worker.once("exit", (code) => {
      settle(() => reject(new Error(`library scan worker exited with code ${code}`)))();
    });
  });
}

// Runs scanConfiguredLibrary in a worker thread. The worker has its own module
// graph and caches, so the main-thread library caches are invalidated here once
// the scan reports changes. Scans are serialized: a second call while one is
// running waits for it and then runs.
export async function runLibraryScanInWorker({
  includeLidarr = true,
  musicRoot = null,
  artistIds = null,
  force = false,
} = {}) {
  while (activeScan) await activeScan.catch(() => {});
  activeScan = (async () => {
    const result = await spawnScan({ includeLidarr, musicRoot, artistIds, force });
    if (result?.local?.changed || result?.lidarr?.changed) invalidateCanonicalLibraryCache();
    return result;
  })();
  try {
    return await activeScan;
  } finally {
    activeScan = null;
  }
}

export function isLibraryScanRunning() {
  return Boolean(activeScan);
}
