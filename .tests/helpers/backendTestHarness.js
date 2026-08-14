import { mkdir, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { spawn } from "child_process";
import http from "http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

const RESET_TABLES = [
  "sessions",
  "user_identities",
  "honker_task_runs",
  "slskd_transfer_history",
  "playlist_download_jobs",
  "inbox_items",
  "users",
  "discovery_cache",
  "images_cache",
  "deezer_mbid_cache",
  "musicbrainz_artist_mbid_cache",
  "artist_overrides",
  "lidarr_artist_id_map",
  "settings",
];

export async function createIsolatedStateDir(name = "test") {
  const baseDir = await mkdtemp(
    join(tmpdir(), `aurral-${String(name || "test")}-`),
  );
  const dataDir = join(baseDir, "data");
  const dbPath = join(dataDir, "aurral.test.db");
  await mkdir(dataDir, { recursive: true });
  return {
    baseDir,
    dataDir,
    dbPath,
  };
}

export function applyIsolatedBackendEnv(paths) {
  process.env.AURRAL_DATA_DIR = paths.dataDir;
  process.env.AURRAL_DB_PATH = paths.dbPath;
  process.env.WEEKLY_FLOW_FOLDER = join(paths.baseDir, "weekly-flow");
  process.env.DOWNLOAD_FOLDER = join(paths.baseDir, "downloads");
  process.env.NODE_ENV = "test";
  process.env.JSON_BODY_LIMIT = "2mb";
}

export async function cleanupIsolatedState(paths) {
  if (!paths?.baseDir) return;
  try {
    const honkerRuntime = await importFromRepo(
      "backend/services/honkerWorkerRuntime.js",
    );
    await honkerRuntime.shutdownHonkerInfrastructure({ timeoutMs: 5000 });
  } catch {}
  try {
    const honkerDb = await importFromRepo("backend/services/honkerDb.js");
    honkerDb.closeHonkerDb();
  } catch {}
  await rm(paths.baseDir, { recursive: true, force: true });
}

export async function importFromRepo(relativePath) {
  const moduleUrl = pathToFileURL(join(repoRoot, relativePath)).href;
  return import(moduleUrl);
}

export async function setupIsolatedBackend(name, ...modulePaths) {
  const paths = await createIsolatedStateDir(name);
  applyIsolatedBackendEnv(paths);
  const modules = await Promise.all(modulePaths.map(importFromRepo));
  return [paths, ...modules];
}

export function resetDatabase(db) {
  for (const table of RESET_TABLES) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
}

export function createMockHttpServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function probeServerHealth(port) {
  const status = await new Promise((resolve, reject) => {
    const request = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/api/health/live",
        timeout: 1000,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode || 0);
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error("Health probe timed out"));
    });
    request.on("error", reject);
  });
  return status >= 200 && status < 300;
}

async function waitForServer(port, child) {
  const deadline = Date.now() + 30000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(
        `Server exited before ready${lastError ? `: ${lastError}` : ""}`,
      );
    }
    try {
      if (await probeServerHealth(port)) {
        return;
      }
      lastError = "Unexpected health status";
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for server on port ${port}: ${lastError}`);
}

export async function startServerProcess({
  port,
  extraEnv = {},
} = {}) {
  const chosenPort =
    Number.isInteger(port) && port > 0
      ? port
      : 4100 + Math.floor(Math.random() * 1000);
  const child = spawn("node", ["backend/server.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(chosenPort),
      AURRAL_TEST_SERVER: "1",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    logs += chunk.toString();
  });
  try {
    await waitForServer(chosenPort, child);
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(`${error.message}\n${logs}`.trim());
  }
  return {
    child,
    port: chosenPort,
    logs: () => logs,
    async stop() {
      if (child.exitCode != null) return;
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
        }, 5000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },
  };
}
