import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { spawn } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

export function getRepoRoot() {
  return repoRoot;
}

export async function createIsolatedStateDir(name = "test") {
  const baseDir = await mkdtemp(
    path.join(tmpdir(), `aurral-${String(name || "test")}-`),
  );
  const dataDir = path.join(baseDir, "data");
  const dbPath = path.join(dataDir, "aurral.test.db");
  return {
    baseDir,
    dataDir,
    dbPath,
  };
}

export function applyIsolatedBackendEnv(paths) {
  process.env.AURRAL_DATA_DIR = paths.dataDir;
  process.env.AURRAL_DB_PATH = paths.dbPath;
  process.env.WEEKLY_FLOW_FOLDER = path.join(paths.baseDir, "weekly-flow");
  process.env.DOWNLOAD_FOLDER = path.join(paths.baseDir, "downloads");
  process.env.NODE_ENV = "test";
  process.env.JSON_BODY_LIMIT = "2mb";
}

export async function cleanupIsolatedState(paths) {
  if (!paths?.baseDir) return;
  await rm(paths.baseDir, { recursive: true, force: true });
}

export async function importFromRepo(relativePath) {
  const moduleUrl = pathToFileURL(path.join(repoRoot, relativePath)).href;
  return import(moduleUrl);
}

export async function resetDatabase(db) {
  const tables = [
    "sessions",
    "weekly_flow_jobs",
    "users",
    "discovery_cache",
    "images_cache",
    "deezer_mbid_cache",
    "musicbrainz_artist_mbid_cache",
    "artist_overrides",
    "settings",
  ];
  for (const table of tables) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
}

export function buildApiUrl(port, pathname = "") {
  return `http://127.0.0.1:${port}${pathname}`;
}

async function waitForServer(port, child) {
  const deadline = Date.now() + 15000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(
        `Server exited before ready${lastError ? `: ${lastError}` : ""}`,
      );
    }
    try {
      const response = await fetch(buildApiUrl(port, "/api/health/live"));
      if (response.ok) {
        return;
      }
      lastError = `Unexpected status ${response.status}`;
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
  const child = spawn("node", ["server.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(chosenPort),
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
        child.once("exit", resolve);
        setTimeout(resolve, 5000);
      });
    },
  };
}
