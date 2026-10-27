import { mkdir, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { spawn, type ChildProcess } from "child_process";
import http from "http";
import net from "net";
import type Database from "better-sqlite3";
import assert from "node:assert/strict";
import { asAppError } from "../../lib/errors.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

const RESET_TABLES = [
  "sessions",
  "user_identities",
  "lastfm_link_states",
  "subsonic_stars",
  "subsonic_play_queues",
  "play_album_stats",
  "play_events",
  "honker_task_runs",
  "slskd_transfer_history",
  "playlist_download_jobs",
  "weekly_flow_download_job_cancellations",
  "weekly_flow_download_cancellations",
  "weekly_flow_download_provider_work",
  "share_links",
  "inbox_items",
  "news_articles",
  "users",
  "discovery_cache",
  "images_cache",
  "deezer_mbid_cache",
  "musicbrainz_artist_mbid_cache",
  "metadata_response_cache",
  "metadata_request_state",
  "artist_overrides",
  "lidarr_artist_id_map",
  "library_file_operation_items",
  "library_file_operations",
  "library_media_files",
  "library_album_tracks",
  "library_tracks",
  "library_albums",
  "library_artists",
  "custom_artwork",
  "library_scan_runs",
  "library_search_documents",
  "settings",
];

export async function createIsolatedStateDir(
  name: string = "test",
  { dataDirRelativePath = "data" }: { dataDirRelativePath?: string } = {},
) {
  const baseDir = await mkdtemp(join(tmpdir(), `aurral-${String(name || "test")}-`));
  const dataDir = join(baseDir, dataDirRelativePath);
  const dbPath = join(dataDir, "aurral.test.db");
  await mkdir(dataDir, { recursive: true });
  return {
    baseDir,
    dataDir,
    dbPath,
  };
}

type IsolatedStatePaths = Awaited<ReturnType<typeof createIsolatedStateDir>>;

export function applyIsolatedBackendEnv(paths: IsolatedStatePaths) {
  process.env.AURRAL_DATA_DIR = paths.dataDir;
  process.env.AURRAL_DB_PATH = paths.dbPath;
  process.env.WEEKLY_FLOW_FOLDER = join(paths.baseDir, "weekly-flow");
  process.env.DOWNLOAD_FOLDER = join(paths.baseDir, "downloads");
  process.env.NODE_ENV = "test";
  process.env.JSON_BODY_LIMIT = "2mb";
}

export async function cleanupIsolatedState(paths: IsolatedStatePaths) {
  if (!paths?.baseDir) return;
  try {
    const honkerRuntime = await import("../../backend/services/honkerWorkerRuntime.ts");
    await honkerRuntime.shutdownHonkerInfrastructure({ timeoutMs: 5000 });
  } catch {}
  try {
    const honkerDb = await import("../../backend/services/honkerDb.ts");
    honkerDb.closeHonkerDb();
  } catch {}
  try {
    const { db } = await import("../../backend/config/db-sqlite.ts");
    if (db.open) db.close();
  } catch {}
  await rm(paths.baseDir, { recursive: true, force: true });
}

export async function setupIsolatedBackend<Modules extends unknown[]>(
  name: string,
  ...loadModules: { [Index in keyof Modules]: () => Promise<Modules[Index]> }
) {
  const paths = await createIsolatedStateDir(name);
  applyIsolatedBackendEnv(paths);
  const modules = (await Promise.all(loadModules.map((load) => load()))) as Modules;
  return [paths, ...modules] as const;
}

export function resetDatabase(db: Database.Database) {
  for (const table of RESET_TABLES) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
}

export function listeningAddress(server: Pick<net.Server, "address">) {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address;
}

export async function createMockHttpServer(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = listeningAddress(server);
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function probeServerHealth(port: number) {
  const status = await new Promise<number>((resolve, reject) => {
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

async function waitForServer(port: number, child: ChildProcess) {
  const deadline = Date.now() + 30000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`Server exited before ready${lastError ? `: ${lastError}` : ""}`);
    }
    try {
      if (await probeServerHealth(port)) {
        return;
      }
      lastError = "Unexpected health status";
    } catch (error) {
      const failure = asAppError(error);
      lastError = failure?.message || String(error);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for server on port ${port}: ${lastError}`);
}

function findFreePort() {
  return new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

export async function startServerProcess({
  port,
  extraEnv = {},
}: { port?: number; extraEnv?: NodeJS.ProcessEnv } = {}) {
  const chosenPort = Number.isInteger(port) && port! > 0 ? port! : await findFreePort();
  const child = spawn("node", ["backend/server.ts"], {
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
    const failure = asAppError(error);
    child.kill("SIGTERM");
    throw new Error(`${failure?.message}\n${logs}`.trim());
  }
  return {
    child,
    port: chosenPort,
    logs: () => logs,
    async stop() {
      if (child.exitCode != null) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
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
