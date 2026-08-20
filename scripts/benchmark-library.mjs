import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const commit = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
})();

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

function readOption(args, name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
  return value;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function parseOptions(args) {
  if (args.includes("--help")) {
    console.log(`Usage: npm run perf:library -- [options]

Options:
  --tracks N                  Synthetic tracks, default 350000
  --tracks-per-album N        Synthetic tracks per album, default 10
  --repeats N                 Page samples per cold/warm group, default 3
  --indexer-albums N          Albums in the Lidarr call probe, default 1000
  --full-read-timeout-ms N    Timeout for full-read child probes, default 30000
  --child-heap-mb N           Child heap cap in megabytes, default 2048
  --output PATH               JSON result path, default perf-results/library-<timestamp>.json
  --check                     Exit nonzero when the regression gate fails
`);
    process.exit(0);
  }
  const tracks = positiveInteger(readOption(args, "tracks", 350000), "tracks");
  const tracksPerAlbum = positiveInteger(
    readOption(args, "tracks-per-album", 10),
    "tracks-per-album",
  );
  const repeats = positiveInteger(readOption(args, "repeats", 3), "repeats");
  const indexerAlbums = positiveInteger(
    readOption(args, "indexer-albums", 1000),
    "indexer-albums",
  );
  const fullReadTimeoutMs = positiveInteger(
    readOption(args, "full-read-timeout-ms", 30000),
    "full-read-timeout-ms",
  );
  const childHeapMb = positiveInteger(readOption(args, "child-heap-mb", 2048), "child-heap-mb");
  const output = readOption(
    args,
    "output",
    path.join(repoRoot, "perf-results", `library-${timestamp}-${commit}.json`),
  );
  return {
    tracks,
    tracksPerAlbum,
    repeats,
    indexerAlbums,
    fullReadTimeoutMs,
    childHeapMb,
    output: path.isAbsolute(output) ? output : path.join(repoRoot, output),
    check: args.includes("--check"),
  };
}

function memoryStats() {
  const memory = process.memoryUsage();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
  };
}

function summarizeSamples(samples) {
  const values = samples.map((sample) => sample.elapsedMs).sort((a, b) => a - b);
  const percentile = (fraction) => values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
  return {
    samples,
    minMs: values[0],
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: values[values.length - 1],
  };
}

function measure(operation) {
  const before = memoryStats();
  const started = performance.now();
  const value = operation();
  const elapsedMs = performance.now() - started;
  const after = memoryStats();
  return {
    elapsedMs: Number(elapsedMs.toFixed(3)),
    memoryBefore: before,
    memoryAfter: after,
    rssDeltaBytes: after.rssBytes - before.rssBytes,
    value,
  };
}

function pageSummary(page) {
  return {
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
    hasMore: page.hasMore,
    itemCount: Array.isArray(page.items) ? page.items.length : 0,
    genreCount: Array.isArray(page.genres) ? page.genres.length : 0,
  };
}

function seedDatabase(database, { tracks, tracksPerAlbum }) {
  const albumCount = Math.ceil(tracks / tracksPerAlbum);
  const artistCount = Math.ceil(albumCount / 10);
  const metadata = JSON.stringify({ genres: ["Rock"], tags: ["benchmark"] });
  const now = Date.now();
  const insertArtist = database.prepare(
    `INSERT INTO library_artists
      (identity_key, mbid, name, sort_name, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertAlbum = database.prepare(
    `INSERT INTO library_albums
      (identity_key, mbid, release_group_mbid, artist_id, title, album_artist, release_date, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertTrack = database.prepare(
    `INSERT INTO library_tracks
      (identity_key, mbid, title, artist_name, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertRelation = database.prepare(
    `INSERT INTO library_album_tracks
      (album_id, track_id, disc_number, track_number, created_at)
     VALUES (?, ?, 1, ?, ?)`,
  );
  const insertFile = database.prepare(
    `INSERT INTO library_media_files
      (track_id, album_id, source, path, format, size, mtime_ms, duration_ms, quality_json, available, created_at, updated_at)
     VALUES (?, ?, 'lidarr', ?, 'flac', 1000, ?, 180000, ?, 1, ?, ?)`,
  );
  const artistIds = [];
  const albumIds = [];
  const transaction = database.transaction(() => {
    for (let artistIndex = 0; artistIndex < artistCount; artistIndex += 1) {
      const name = `Benchmark Artist ${String(artistIndex).padStart(5, "0")}`;
      artistIds.push(
        Number(
          insertArtist.run(
            `benchmark:artist:${artistIndex}`,
            `00000000-0000-4000-8000-${String(artistIndex).padStart(12, "0")}`,
            name,
            name,
            metadata,
            now,
            now,
          ).lastInsertRowid,
        ),
      );
    }
    for (let albumIndex = 0; albumIndex < albumCount; albumIndex += 1) {
      const artistId = artistIds[Math.floor(albumIndex / 10)];
      const title = `Benchmark Album ${String(albumIndex).padStart(6, "0")}`;
      albumIds.push(
        Number(
          insertAlbum.run(
            `benchmark:album:${albumIndex}`,
            `10000000-0000-4000-8000-${String(albumIndex).padStart(12, "0")}`,
            `20000000-0000-4000-8000-${String(albumIndex).padStart(12, "0")}`,
            artistId,
            title,
            `Benchmark Artist ${String(Math.floor(albumIndex / 10)).padStart(5, "0")}`,
            "2020-01-01",
            metadata,
            now,
            now,
          ).lastInsertRowid,
        ),
      );
    }
    for (let trackIndex = 0; trackIndex < tracks; trackIndex += 1) {
      const albumIndex = Math.floor(trackIndex / tracksPerAlbum);
      const albumId = albumIds[albumIndex];
      const artistIndex = Math.floor(albumIndex / 10);
      const artistName = `Benchmark Artist ${String(artistIndex).padStart(5, "0")}`;
      const trackId = Number(
        insertTrack.run(
          `benchmark:track:${trackIndex}`,
          `30000000-0000-4000-8000-${String(trackIndex).padStart(12, "0")}`,
          `Benchmark Track ${String(trackIndex).padStart(7, "0")}`,
          artistName,
          metadata,
          now,
          now,
        ).lastInsertRowid,
      );
      insertRelation.run(albumId, trackId, (trackIndex % tracksPerAlbum) + 1, now);
      insertFile.run(
        trackId,
        albumId,
        `/synthetic/Benchmark Artist ${String(artistIndex).padStart(5, "0")}/${
          `Benchmark Album ${String(albumIndex).padStart(6, "0")}`
        }/${String((trackIndex % tracksPerAlbum) + 1).padStart(2, "0")}.flac`,
        now,
        JSON.stringify({ format: "FLAC", bitrate: 1000 }),
        now,
        now,
      );
    }
  });
  database.pragma("synchronous = OFF");
  transaction();
  const pageCount = Number(database.pragma("page_count", { simple: true }));
  const pageSize = Number(database.pragma("page_size", { simple: true }));
  return {
    artists: artistCount,
    albums: albumCount,
    tracks,
    mediaFiles: tracks,
    databaseBytes: pageCount * pageSize,
  };
}

function collectPageSamples(getPage, invalidate, repeats) {
  const coldSamples = [];
  const warmSamples = [];
  let shape;
  for (let index = 0; index < repeats; index += 1) {
    invalidate();
    const result = measure(() => getPage());
    shape ||= pageSummary(result.value);
    coldSamples.push(result);
  }
  for (let index = 0; index < repeats; index += 1) {
    const result = measure(() => getPage());
    warmSamples.push(result);
  }
  const strip = ({ value: _value, ...sample }) => sample;
  return {
    shape,
    cold: summarizeSamples(coldSamples.map(strip)),
    warm: summarizeSamples(warmSamples.map(strip)),
  };
}

function runChild({ dataDir, dbPath, code, timeoutMs, heapMb, env = {} }) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(
      process.execPath,
      [`--max-old-space-size=${heapMb}`, "--input-type=module", "-e", code],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          AURRAL_DATA_DIR: dataDir,
          AURRAL_DB_PATH: dbPath,
          ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: "failed",
        elapsedMs: Number((performance.now() - started).toFixed(3)),
        error: error.message,
      });
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (codeValue, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const elapsedMs = Number((performance.now() - started).toFixed(3));
      if (timedOut) {
        resolve({ status: "timeout", elapsedMs, timeoutMs });
        return;
      }
      const lines = stdout.trim().split("\n").filter(Boolean);
      let value = null;
      try {
        value = JSON.parse(lines.at(-1) || "null");
      } catch {
        value = null;
      }
      if (codeValue !== 0 || !value) {
        resolve({
          status: "failed",
          elapsedMs,
          exitCode: codeValue,
          signal,
          error: stderr.trim().split("\n").at(-1) || "child produced no JSON result",
        });
        return;
      }
      resolve({ status: "completed", elapsedMs, ...value });
    });
  });
}

const fullReadCode = `
import { performance } from "node:perf_hooks";
import { getCanonicalLibrary } from "./backend/services/libraryQueryService.js";
import { getCanonicalLibraryReadModel } from "./backend/services/canonicalLibraryReadAdapter.js";
import { toPublicLibrary } from "./backend/routes/library/handlers/canonical.js";

const mode = process.env.AURRAL_BENCHMARK_MODE;
let value;
let rawReadMs = 0;
let transformMs = 0;
if (mode === "legacy-adapter") {
  const started = performance.now();
  value = getCanonicalLibraryReadModel({ source: "lidarr", availableOnly: true });
  rawReadMs = performance.now() - started;
} else {
  const rawStarted = performance.now();
  const raw = getCanonicalLibrary({ source: "lidarr", availableOnly: true });
  rawReadMs = performance.now() - rawStarted;
  const transformStarted = performance.now();
  value = toPublicLibrary(raw);
  transformMs = performance.now() - transformStarted;
}
const readMs = rawReadMs + transformMs;
const serializeStarted = performance.now();
const jsonBytes = Buffer.byteLength(JSON.stringify(value));
const serializeMs = performance.now() - serializeStarted;
const memory = process.memoryUsage();
const counts = {
  artists: Array.isArray(value.artists) ? value.artists.length : 0,
  albums: Array.isArray(value.albums) ? value.albums.length : 0,
  tracks: Array.isArray(value.tracks) ? value.tracks.length : 0,
};
console.log(JSON.stringify({
  rawReadMs: Number(rawReadMs.toFixed(3)),
  transformMs: Number(transformMs.toFixed(3)),
  readMs: Number(readMs.toFixed(3)),
  serializeMs: Number(serializeMs.toFixed(3)),
  jsonBytes,
  counts,
  rssBytes: memory.rss,
  heapUsedBytes: memory.heapUsed,
}));
`;

const indexerProbeCode = `
import { performance } from "node:perf_hooks";
import { indexLidarrLibrary } from "./backend/services/libraryLidarrIndexer.js";

const albumCount = Number(process.env.AURRAL_BENCHMARK_INDEXER_ALBUMS);
const mode = process.env.AURRAL_BENCHMARK_INDEXER_MODE;
const calls = [];
const activeAlbums = new Set();
let maxActiveAlbums = 0;
const albums = Array.from({ length: albumCount }, (_, index) => ({
  id: index + 1,
  artistId: 1,
  title: \`Benchmark Album \${index}\`,
  statistics: { sizeOnDisk: 1 },
}));
const artists = [{ id: 1, artistName: "Benchmark Artist", foreignArtistId: "lidarr-artist-1" }];
const albumCall = async (albumId, kind) => {
  if (kind === "tracks") activeAlbums.add(String(albumId));
  maxActiveAlbums = Math.max(maxActiveAlbums, activeAlbums.size);
  await Promise.resolve();
  if (kind === "files") activeAlbums.delete(String(albumId));
  return [];
};
const client = {
  isConfigured: () => true,
  request: async (...args) => {
    calls.push({ method: "request", path: args[0] });
    return artists;
  },
  getAllAlbums: async () => {
    calls.push({ method: "getAllAlbums" });
    return albums;
  },
  getRootFolders: async () => {
    calls.push({ method: "getRootFolders" });
    return [];
  },
};
if (mode === "bulk") {
  client.getAllTracks = async () => {
    calls.push({ method: "getAllTracks" });
    return [];
  };
  client.getAllTrackFiles = async () => {
    calls.push({ method: "getAllTrackFiles" });
    return [];
  };
} else {
  client.getTracksByAlbumId = async (albumId) => {
    calls.push({ method: "getTracksByAlbumId", albumId });
    return albumCall(albumId, "tracks");
  };
  client.getTrackFilesByAlbumId = async (albumId) => {
    calls.push({ method: "getTrackFilesByAlbumId", albumId });
    return albumCall(albumId, "files");
  };
}
const started = performance.now();
const result = await indexLidarrLibrary({ client });
console.log(JSON.stringify({
  elapsedMs: Number((performance.now() - started).toFixed(3)),
  calls,
  callCount: calls.length,
  maxActiveAlbums,
  result,
}));
`;

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const dataDir = await mkdtemp(path.join(tmpdir(), "aurral-library-perf-"));
  const indexerDataDir = await mkdtemp(path.join(tmpdir(), "aurral-indexer-perf-"));
  const fallbackIndexerDataDir = await mkdtemp(path.join(tmpdir(), "aurral-indexer-fallback-perf-"));
  const dbPath = path.join(dataDir, "aurral.db");
  const started = performance.now();
  let database;
  let output;
  try {
    process.env.AURRAL_DATA_DIR = dataDir;
    process.env.AURRAL_DB_PATH = dbPath;
    const imported = await import("../backend/config/db-sqlite.js");
    database = imported.db;
    const queryService = await import("../backend/services/libraryQueryService.js");
    const seedStarted = performance.now();
    const seed = seedDatabase(database, options);
    const seedElapsedMs = Number((performance.now() - seedStarted).toFixed(3));
    const pageCases = [
      ["artists", { kind: "artists", page: 1, pageSize: 100 }],
      ["albums", { kind: "albums", page: 1, pageSize: 100, sort: "newest" }],
      ["tracks", { kind: "tracks", page: 1, pageSize: 100 }],
      ["tracks-search", { kind: "tracks", page: 1, pageSize: 100, query: String(options.tracks - 1) }],
      ["genres", { kind: "genres", page: 1, pageSize: 100 }],
    ];
    const pages = {};
    for (const [name, pageOptions] of pageCases) {
      pages[name] = collectPageSamples(
        () => queryService.getCanonicalLibraryPage(pageOptions),
        queryService.invalidateCanonicalLibraryCache,
        options.repeats,
      );
    }
    database.close();
    database = null;
    const fullReads = {};
    for (const mode of ["full-endpoint", "legacy-adapter"]) {
      fullReads[mode] = await runChild({
        dataDir,
        dbPath,
        timeoutMs: options.fullReadTimeoutMs,
        heapMb: options.childHeapMb,
        code: fullReadCode,
        env: { AURRAL_BENCHMARK_MODE: mode },
      });
    }
    const indexerProbes = {};
    for (const [mode, probeDir] of [
      ["bulk", indexerDataDir],
      ["fallback", fallbackIndexerDataDir],
    ]) {
      indexerProbes[mode] = await runChild({
        dataDir: probeDir,
        dbPath: path.join(probeDir, "aurral.db"),
        timeoutMs: options.fullReadTimeoutMs,
        heapMb: options.childHeapMb,
        code: indexerProbeCode,
        env: {
          AURRAL_BENCHMARK_INDEXER_ALBUMS: String(options.indexerAlbums),
          AURRAL_BENCHMARK_INDEXER_MODE: mode,
        },
      });
    }
    const expectedBulkIndexerCalls = 5;
    const expectedFallbackIndexerCalls = 3 + options.indexerAlbums * 2;
    const adapter = fullReads["legacy-adapter"];
    const pageP95 = Object.fromEntries(
      Object.entries(pages).map(([name, value]) => [name, value.warm.p95Ms]),
    );
    const checks = {
      fullEndpointReadCompleted: fullReads["full-endpoint"].status === "completed",
      legacyReadCompleted: adapter.status === "completed",
      bulkIndexerCallCount: indexerProbes.bulk.status === "completed"
        && indexerProbes.bulk.callCount === expectedBulkIndexerCalls,
      fallbackIndexerCallCount: indexerProbes.fallback.status === "completed"
        && indexerProbes.fallback.callCount === expectedFallbackIndexerCalls,
      fallbackIndexerConcurrency: indexerProbes.fallback.status === "completed"
        && indexerProbes.fallback.maxActiveAlbums <= 4,
      pageWarmP95Under5s: Object.values(pageP95).every((value) => value < 5000),
    };
    output = {
      benchmark: "aurral-library",
      version: 1,
      timestamp: new Date().toISOString(),
      commit,
      node: process.version,
      options,
      elapsedMs: Number((performance.now() - started).toFixed(3)),
      seed: { ...seed, elapsedMs: seedElapsedMs },
      pages,
      fullReads,
      indexer: {
        requestedAlbums: options.indexerAlbums,
        expectedBulkCalls: expectedBulkIndexerCalls,
        expectedFallbackCalls: expectedFallbackIndexerCalls,
        bulkProbe: indexerProbes.bulk,
        fallbackProbe: indexerProbes.fallback,
      },
      checks,
      verdict: Object.values(checks).every(Boolean) ? "pass" : "fail",
    };
  } finally {
    if (database) database.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(indexerDataDir, { recursive: true, force: true });
    await rm(fallbackIndexerDataDir, { recursive: true, force: true });
  }
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({ output: options.output, verdict: output.verdict, checks: output.checks }, null, 2));
  if (options.check && output.verdict !== "pass") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
