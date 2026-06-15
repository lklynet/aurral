import { mkdir, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { spawn } from "child_process";
import http from "http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

const RESET_TABLES = [
  "sessions",
  "slskd_transfer_history",
  "playlist_download_jobs",
  "weekly_flow_jobs",
  "users",
  "discovery_cache",
  "images_cache",
  "deezer_mbid_cache",
  "musicbrainz_artist_mbid_cache",
  "artist_overrides",
  "settings",
];

export function getRepoRoot() {
  return repoRoot;
}

export async function createIsolatedStateDir(name = "test") {
  const baseDir = await mkdtemp(
    path.join(tmpdir(), `aurral-${String(name || "test")}-`),
  );
  const dataDir = path.join(baseDir, "data");
  const dbPath = path.join(dataDir, "aurral.test.db");
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
  process.env.WEEKLY_FLOW_FOLDER = path.join(paths.baseDir, "weekly-flow");
  process.env.DOWNLOAD_FOLDER = path.join(paths.baseDir, "downloads");
  process.env.NODE_ENV = "test";
  process.env.JSON_BODY_LIMIT = "2mb";
}

export async function cleanupIsolatedState(paths) {
  if (!paths?.baseDir) return;
  try {
    const honkerDb = await importFromRepo("backend/services/honkerDb.js");
    honkerDb.closeHonkerDb();
  } catch {}
  await rm(paths.baseDir, { recursive: true, force: true });
}

export async function importFromRepo(relativePath) {
  const moduleUrl = pathToFileURL(path.join(repoRoot, relativePath)).href;
  return import(moduleUrl);
}

export function resetDatabase(db) {
  for (const table of RESET_TABLES) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
}

export function buildApiUrl(port, pathname = "") {
  return `http://127.0.0.1:${port}${pathname}`;
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
  let successStreak = 0;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(
        `Server exited before ready${lastError ? `: ${lastError}` : ""}`,
      );
    }
    try {
      if (await probeServerHealth(port)) {
        successStreak += 1;
        if (successStreak >= 2) {
          return;
        }
      } else {
        successStreak = 0;
        lastError = "Unexpected health status";
      }
    } catch (error) {
      successStreak = 0;
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

export async function ensureServerProcess(serverInstance) {
  if (
    serverInstance?.child?.exitCode == null &&
    serverInstance?.port &&
    (await probeServerHealth(serverInstance.port).catch(() => false))
  ) {
    return serverInstance;
  }
  await serverInstance?.stop?.().catch(() => {});
  return startServerProcess();
}

async function seedIntegrationDatabase(paths, {
  admin = false,
  onboardingComplete = true,
  settings = {},
} = {}) {
  const { default: Database } = await import("better-sqlite3");
  const { default: bcrypt } = await import("bcrypt");
  const conn = new Database(paths.dbPath);
  for (const table of RESET_TABLES) {
    conn.prepare(`DELETE FROM ${table}`).run();
  }
  const mergedSettings = {
    integrations: {},
    onboardingComplete,
    ...settings,
  };
  for (const [key, value] of Object.entries(mergedSettings)) {
    if (value === undefined) continue;
    if (key === "onboardingComplete") {
      conn
        .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
        .run(key, value ? "true" : "false");
      continue;
    }
    conn
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run(key, JSON.stringify(value));
  }
  if (admin) {
    conn
      .prepare(
        "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
      )
      .run("admin", bcrypt.hashSync("password123", 4), "admin");
  }
  conn.close();
}

export async function prepareIntegrationTestServer(
  paths,
  { admin = false, onboardingComplete = true, settings = {} } = {},
) {
  applyIsolatedBackendEnv(paths);
  try {
    const honkerDb = await importFromRepo("backend/services/honkerDb.js");
    honkerDb.closeHonkerDb();
  } catch {}

  const bootstrapServer = await startServerProcess();
  await bootstrapServer.stop();
  await seedIntegrationDatabase(paths, {
    admin,
    onboardingComplete,
    settings,
  });
  return startServerProcess();
}
