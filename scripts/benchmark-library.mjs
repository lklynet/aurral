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
  --child-probe-timeout-ms N  Timeout for child probes, default 30000
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
  const childProbeTimeoutMs = positiveInteger(
    readOption(args, "child-probe-timeout-ms", 30000),
    "child-probe-timeout-ms",
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
    childProbeTimeoutMs,
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
    jsonBytes: Buffer.byteLength(JSON.stringify(value)),
    memoryBefore: before,
    memoryAfter: after,
    rssDeltaBytes: after.rssBytes - before.rssBytes,
    heapDeltaBytes: after.heapUsedBytes - before.heapUsedBytes,
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

function artistProjectionSummary(artists) {
  return { itemCount: artists.length };
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

function seedSubsonicFavorite(database) {
  const now = Date.now();
  const userId = Number(database.prepare(
    `INSERT INTO users (username, password_hash, role, permissions)
     VALUES ('benchmark', 'benchmark', 'user', '{"accessFlow":true}')`,
  ).run().lastInsertRowid);
  database.prepare(
    `INSERT INTO subsonic_stars (user_id, entity_kind, entity_key, created_at)
     VALUES (?, 'song', 'benchmark:track:0', ?)`,
  ).run(userId, now);
  return { id: userId, username: "benchmark", permissions: { accessFlow: true } };
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

const boundedReadCode = `
import { groupArtists } from "./backend/routes/subsonic.js";
import {
  getAlbum,
  getFlowPlaylists,
  getStarred,
  getArtist,
  listArtists,
  searchLibrary,
} from "./backend/services/subsonicLibraryService.js";
import { getCanonicalTrackPage } from "./backend/services/libraryQueryService.js";

const user = {
  id: Number(process.env.AURRAL_BENCHMARK_USER_ID),
  username: "benchmark",
  permissions: { accessFlow: true },
};
const encodedId = (kind, key) => kind + ":" + encodeURIComponent(key);
const operation = process.env.AURRAL_BENCHMARK_OPERATION;
const read = {
  getIndexes: () => ({ index: groupArtists(listArtists()) }),
  getArtist: () => getArtist(encodedId("artist", "benchmark:artist:0")),
  getAlbum: () => getAlbum(encodedId("album", "benchmark:album:0")),
  search3: () => searchLibrary("Benchmark Track", {
    artistCount: "20",
    albumCount: "20",
    songCount: "20",
  }),
  randomSongs: () => getCanonicalTrackPage({
    source: "lidarr",
    availableOnly: true,
    random: true,
    limit: 20,
  }).tracks,
  starred: () => getStarred(user),
  playlists: () => getFlowPlaylists(user),
};
const before = process.memoryUsage();
const started = performance.now();
const value = read[operation]();
const elapsedMs = performance.now() - started;
const after = process.memoryUsage();
const counts = Array.isArray(value)
  ? { items: value.length }
  : {
      artists: Array.isArray(value?.artist) ? value.artist.length : undefined,
      albums: Array.isArray(value?.album) ? value.album.length : undefined,
      songs: Array.isArray(value?.song) ? value.song.length : undefined,
    };
console.log(JSON.stringify({
  elapsedMs: Number(elapsedMs.toFixed(3)),
  jsonBytes: Buffer.byteLength(JSON.stringify(value)),
  rssDeltaBytes: after.rss - before.rss,
  heapDeltaBytes: after.heapUsed - before.heapUsed,
  rssBytes: after.rss,
  heapUsedBytes: after.heapUsed,
  counts,
}));
`;

function summarizeReadSamples(samples) {
  const completed = samples.filter((sample) => sample.status === "completed");
  const values = completed.map((sample) => sample.elapsedMs).sort((a, b) => a - b);
  const percentile = (fraction) => values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
  return {
    samples,
    sampleCount: samples.length,
    completedCount: completed.length,
    nonVacuous: samples.length > 0
      && completed.length === samples.length
      && completed.every((sample) => Number(sample.jsonBytes) > 0),
    responseBytes: [...new Set(completed.map((sample) => sample.jsonBytes))],
    medianMs: completed.length ? percentile(0.5) : null,
    p95Ms: completed.length ? percentile(0.95) : null,
    maxRssDeltaBytes: completed.length ? Math.max(...completed.map((sample) => sample.rssDeltaBytes)) : null,
    maxHeapDeltaBytes: completed.length ? Math.max(...completed.map((sample) => sample.heapDeltaBytes)) : null,
  };
}

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
  client.getAllTracks = async () => {
    calls.push({ method: "getAllTracks" });
    return [{ id: 1, albumId: 1 }];
  };
  client.getAllTrackFiles = async () => {
    calls.push({ method: "getAllTrackFiles" });
    throw new Error("bulk track-file read failed");
  };
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
let result = null;
let error = null;
try {
  result = await indexLidarrLibrary({ client });
} catch (caught) {
  error = caught?.message || String(caught);
}
console.log(JSON.stringify({
  elapsedMs: Number((performance.now() - started).toFixed(3)),
  calls,
  callCount: calls.length,
  maxActiveAlbums,
  result,
  error,
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
    const { rebuildLibrarySearchIndex } = await import("../backend/services/librarySearchIndex.js");
    const { flowPlaylistConfig } = await import(
      "../backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js"
    );
    const seedStarted = performance.now();
    const seed = seedDatabase(database, options);
    rebuildLibrarySearchIndex();
    queryService.rebuildCanonicalGenreStats();
    const benchmarkUser = seedSubsonicFavorite(database);
    flowPlaylistConfig.createSharedPlaylist({
      name: "Benchmark Playlist",
      ownerUserId: benchmarkUser.id,
      tracks: [],
    });
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
        () => queryService.invalidateCanonicalLibraryCache({ persistedGenres: false }),
        options.repeats,
      );
    }
    const artistProjectionCold = measure(
      () => queryService.getCanonicalArtistProjection({ page: 1, pageSize: 100 }),
    );
    const artistProjectionSamples = [];
    for (let index = 0; index < options.repeats; index += 1) {
      artistProjectionSamples.push(
        measure(() => queryService.getCanonicalArtistProjection({ page: 1, pageSize: 100 })),
      );
    }
    const stripProjection = ({ value: _value, ...sample }) => sample;
    pages["artist-projection"] = {
      shape: artistProjectionSummary(artistProjectionCold.value),
      cold: summarizeSamples([stripProjection(artistProjectionCold)]),
      warm: summarizeSamples(artistProjectionSamples.map(stripProjection)),
    };
    const artistProjectionPlan = queryService.getCanonicalArtistProjectionQueryPlan({
      page: 1,
      pageSize: 100,
    });
    const artistProjectionPlanDetails = artistProjectionPlan.map((row) => String(row.detail || ""));
    database.close();
    database = null;
    const subsonicReads = {};
    for (const operation of [
      "getIndexes",
      "getArtist",
      "getAlbum",
      "search3",
      "randomSongs",
      "starred",
      "playlists",
    ]) {
      const samples = [];
      for (let index = 0; index < options.repeats; index += 1) {
        samples.push(await runChild({
          dataDir,
          dbPath,
          timeoutMs: options.childProbeTimeoutMs,
          heapMb: options.childHeapMb,
          code: boundedReadCode,
          env: {
            AURRAL_BENCHMARK_OPERATION: operation,
            AURRAL_BENCHMARK_USER_ID: String(benchmarkUser.id),
          },
        }));
      }
      subsonicReads[operation] = summarizeReadSamples(samples);
    }
    const indexerProbes = {};
    for (const [mode, probeDir] of [
      ["bulk", indexerDataDir],
      ["fallback", fallbackIndexerDataDir],
    ]) {
      indexerProbes[mode] = await runChild({
        dataDir: probeDir,
        dbPath: path.join(probeDir, "aurral.db"),
        timeoutMs: options.childProbeTimeoutMs,
        heapMb: options.childHeapMb,
        code: indexerProbeCode,
        env: {
          AURRAL_BENCHMARK_INDEXER_ALBUMS: String(options.indexerAlbums),
          AURRAL_BENCHMARK_INDEXER_MODE: mode,
        },
      });
    }
    const expectedBulkIndexerCalls = 5;
    const expectedFallbackIndexerCalls = 5;
    const measuredReadNames = ["search3", "randomSongs"];
    const measuredReads = measuredReadNames.map((name) => subsonicReads[name]);
    const measuredQueryChecks = {
      nonVacuousCompletedSamples: measuredReads.every((read) => read.nonVacuous),
      coldP95Under750ms: measuredReads.every((read) => read.p95Ms < 750),
      responseUnder2MiB: measuredReads.every((read) =>
        read.responseBytes.length > 0
        && read.responseBytes.every((bytes) => bytes < 2 * 1024 * 1024)),
      maxRssDeltaUnder64MiB: measuredReads.every((read) =>
        read.maxRssDeltaBytes < 64 * 1024 * 1024),
    };
    const pageBudgetChecks = {
      warmP95Under250ms: Object.values(pages).every((page) => page.warm.p95Ms < 250),
      coldP95Under750ms: Object.values(pages).every((page) => page.cold.p95Ms < 750),
      responseUnder2MiB: Object.values(pages).every((page) =>
        [...page.cold.samples, ...page.warm.samples]
          .every((sample) => sample.jsonBytes < 2 * 1024 * 1024)),
      maxRssDeltaUnder64MiB: Object.values(pages).every((page) =>
        [...page.cold.samples, ...page.warm.samples]
          .every((sample) => sample.rssDeltaBytes < 64 * 1024 * 1024)),
    };
    const compatibilityReadChecks = {
      responseUnder2MiB: Object.values(subsonicReads).every((read) =>
        read.responseBytes.length > 0
        && read.responseBytes.every((bytes) => bytes < 2 * 1024 * 1024)),
      maxRssDeltaUnder64MiB: Object.values(subsonicReads).every((read) =>
        read.maxRssDeltaBytes < 64 * 1024 * 1024),
    };
    const boundedReadCompleted = Object.values(subsonicReads).every((read) =>
      read.nonVacuous);
    const checks = {
      boundedReadCompleted,
      measuredQueryBudgets: Object.values(measuredQueryChecks).every(Boolean),
      pageBudgets: Object.values(pageBudgetChecks).every(Boolean),
      compatibilityReadBudgets: Object.values(compatibilityReadChecks).every(Boolean),
      bulkIndexerCallCount: indexerProbes.bulk.status === "completed"
        && indexerProbes.bulk.callCount === expectedBulkIndexerCalls,
      fallbackIndexerCallCount: indexerProbes.fallback.status === "completed"
        && indexerProbes.fallback.callCount === expectedFallbackIndexerCalls,
      fallbackIndexerStopsAtBulkFailure: indexerProbes.fallback.status === "completed"
        && indexerProbes.fallback.error === "bulk track-file read failed"
        && indexerProbes.fallback.maxActiveAlbums === 0,
      artistProjectionPageBounded:
        artistProjectionPlanDetails.some((detail) => detail.includes("MATERIALIZE artist_page"))
        && artistProjectionPlanDetails.some((detail) =>
          /SEARCH album USING (?:COVERING )?INDEX .*artist_id/.test(detail),
        )
        && !artistProjectionPlanDetails.some((detail) => detail === "SCAN album"),
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
      subsonicReads,
      pages,
      artistProjectionPlan,
      budgets: {
        targets: {
          warmPageP95Ms: 250,
          coldPageP95Ms: 750,
          responseBytes: 2 * 1024 * 1024,
          requestRssDeltaBytes: 64 * 1024 * 1024,
        },
        measuredQueryChecks,
        pageBudgetChecks,
        compatibilityReadChecks,
        deferredIntegrationChecks: [
          "stableReadProviderCalls",
          "readStartedJobs",
          "restartMigrationRepeats",
        ],
      },
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
