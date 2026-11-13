import { blockedHosts } from "../offline-guard.ts";
import { performance } from "node:perf_hooks";
import type { Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import {
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  createIsolatedStateDir,
  createMockHttpServer,
  listeningAddress,
} from "../helpers/backendTestHarness.ts";
import { seedPerfLibrary, seedPerfListening, seedPerfPlaylistJobs } from "./seed.ts";
import type { PerfContext, Scenario } from "./scenarios.ts";

const SUBSONIC_AUTH = { u: "test", p: "password", v: "1.16.1", c: "perf", f: "json" };

const LARGE_TABLES = new Set([
  "library_artists",
  "library_albums",
  "library_tracks",
  "library_album_tracks",
  "library_media_files",
  "library_entity_genres",
  "library_search_documents",
  "play_events",
  "play_album_stats",
  "subsonic_stars",
  "download_jobs",
]);

function recordStatements(db: Database.Database) {
  const executed = new Map<string, unknown[]>();
  let count = 0;
  const prototype = Reflect.getPrototypeOf(db.prepare("SELECT 1"));
  if (!prototype) throw new Error("better-sqlite3 statements have no prototype to wrap");
  for (const method of ["run", "get", "all", "iterate"]) {
    const original: unknown = Reflect.get(prototype, method);
    if (typeof original !== "function") throw new Error(`Statement.${method} is missing`);
    Reflect.set(
      prototype,
      method,
      function (this: Database.Statement<unknown[], unknown>, ...args: unknown[]) {
        count += 1;
        if (!executed.has(this.source)) executed.set(this.source, args);
        const result: unknown = Reflect.apply(original, this, args);
        return result;
      },
    );
  }
  return {
    take() {
      const result = { count, executed: new Map(executed) };
      count = 0;
      executed.clear();
      return result;
    },
  };
}

function scannedTables(db: Database.Database, executed: Map<string, unknown[]>) {
  const tables = new Set<string>();
  for (const [source, args] of executed) {
    if (!/^\s*(WITH|SELECT)/i.test(source)) continue;
    const plan = db
      .prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${source}`)
      .all(...args);
    for (const { detail } of plan) {
      const match = /^SCAN (\w+)(?: AS \w+)?$/.exec(detail);
      if (match && LARGE_TABLES.has(match[1]!)) tables.add(match[1]!);
    }
  }
  return [...tables].sort();
}

export type ScenarioResult = {
  queries: number;
  bytes: number;
  scans: string[];
  calls: Record<string, number>;
  ms: number;
};

async function startFakeMetadata() {
  let calls = 0;
  const server = await createMockHttpServer((request, response) => {
    calls += 1;
    const [kind, id] = new URL(request.url ?? "/", "http://metadata").pathname.split("/").slice(1);
    const body =
      kind === "search"
        ? []
        : kind === "artist" && id
          ? { id, artistname: "Perf Metadata Artist", Albums: [] }
          : kind === "album" && id
            ? { id, title: "Perf Metadata Album", releases: [] }
            : null;
    response.statusCode = body ? 200 : 404;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body ?? { error: "Not found" }));
  });
  return {
    url: server.url,
    close: server.close,
    take() {
      const taken = calls;
      calls = 0;
      return taken;
    },
  };
}

const LISTENBRAINZ_ANSWERS = new Map<string, unknown>([
  ["/similar-artists/json", []],
  ["/1/metadata/artist", []],
]);

function fakeListenbrainz() {
  const calls = new Map<string, number>();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (!url.hostname.endsWith("listenbrainz.org")) return realFetch(input, init);
    calls.set(url.host, (calls.get(url.host) ?? 0) + 1);
    const answer = LISTENBRAINZ_ANSWERS.get(url.pathname.replace(/\/$/, ""));
    return Response.json(answer ?? { error: "Not found" }, { status: answer ? 200 : 404 });
  };
  return {
    take() {
      const taken = Object.fromEntries(calls);
      calls.clear();
      return taken;
    },
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}

function takeCalls(metadata: { take(): number }, listenbrainz: { take(): Record<string, number> }) {
  const calls: Record<string, number> = {
    ...Object.fromEntries(blockedHosts),
    ...listenbrainz.take(),
  };
  blockedHosts.clear();
  const brainzmash = metadata.take();
  if (brainzmash) calls.brainzmash = brainzmash;
  return calls;
}

export type PerfApp = Awaited<ReturnType<typeof startPerfApp>>;

export async function startPerfApp({ artists }: { artists: number }) {
  const paths = await createIsolatedStateDir("perf");
  applyIsolatedBackendEnv(paths);
  process.env.AURRAL_LIVE_DOWNLOAD_READS = "1";
  const { db } = await import("../../backend/config/db-sqlite.ts");
  await import("../../backend/services/jobs/queues.ts");
  const { listQueues } = await import("../../backend/services/jobs/queue.ts");
  for (const queue of listQueues()) queue.start = () => Promise.resolve();
  const { dbOps, userOps } = await import("../../backend/db/helpers/index.ts");
  const { hashPassword } = await import("../../backend/services/passwordHash.ts");
  const { createSession } = await import("../../backend/config/session-helpers.ts");
  const { rebuildLibrarySearchIndex } =
    await import("../../backend/services/librarySearchIndex.ts");
  const { rebuildStoredLibraryGenreStats } =
    await import("../../backend/config/library-search-index.ts");

  const seedStarted = performance.now();
  const metadata = await startFakeMetadata();
  const listenbrainz = fakeListenbrainz();
  dbOps.updateSettings({
    onboardingComplete: true,
    integrations: {
      general: { authUser: "test", authPassword: "password" },
      metadata: { provider: "brainzmash", baseUrl: metadata.url },
    },
    security: { localNetworkBypass: { enabled: false } },
  });
  const user = userOps.createUser(
    "test",
    hashPassword("password"),
    "admin",
    null,
    true,
    false,
    "password",
  );
  if (!user) throw new Error("Couldn't create the perf user");
  const { token } = createSession(user.id);
  const library = seedPerfLibrary(db, { artists, musicRoot: join(paths.baseDir, "music") });
  seedPerfListening(db, user.id, library);
  rebuildLibrarySearchIndex();
  rebuildStoredLibraryGenreStats(db);
  const { playlists: playlistTracks, editSongs } = seedPerfPlaylistJobs(db, library);
  const { flowPlaylistConfig } =
    await import("../../backend/services/playlists/flowPlaylistConfig.ts");
  let playlistId = "";
  for (const [index, tracks] of playlistTracks.entries()) {
    for (const { path } of tracks) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "perf");
    }
    const playlist = flowPlaylistConfig.createStaticPlaylist({
      name: `Perf Playlist ${index}`,
      ownerUserId: user.id,
      tracks: tracks.map(({ path: _path, ...track }) => track),
    });
    playlistId = `shared:${playlist.id}`;
  }
  for (const { path } of editSongs.flat()) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "perf");
  }
  const editPlaylist = flowPlaylistConfig.createStaticPlaylist({
    name: "Perf Edited Playlist",
    ownerUserId: user.id,
    tracks: [],
  });
  db.pragma("wal_checkpoint(TRUNCATE)");
  const seedMs = performance.now() - seedStarted;

  const { app } = await import("../../backend/app.ts");
  const { listen } = await import("../helpers/honoApp.ts");
  const server: Server = await listen(app);
  const baseUrl = `http://127.0.0.1:${listeningAddress(server).port}`;
  const statements = recordStatements(db);
  const context: PerfContext = {
    artistId: Math.floor(artists / 2) + 1,
    albumId: library.albumIds[Math.floor(library.albumIds.length / 2)]!,
    trackId: library.trackRows
      .slice(Math.floor(library.trackRows.length / 2))
      .find((track) => track.path)!.id,
    lastAlbumPage: Math.floor(library.albums / 100),
    playlistId,
    editPlaylist: {
      id: `shared:${editPlaylist.id}`,
      songIds: editSongs.map((songs) => songs.map((song) => song.id)),
    },
  };

  async function request(path: string) {
    const url = new URL(path, baseUrl);
    const headers: Record<string, string> = { "accept-encoding": "gzip" };
    if (url.pathname.startsWith("/rest/")) {
      for (const [key, value] of Object.entries(SUBSONIC_AUTH)) url.searchParams.set(key, value);
    } else {
      headers.authorization = `Bearer ${token}`;
    }
    const response = await fetch(url, { headers });
    const body = await response.text();
    if (!response.ok || body.includes('"status":"failed"')) {
      throw new Error(`${path} returned ${response.status}: ${body.slice(0, 300)}`);
    }
    return Buffer.byteLength(body);
  }

  async function run(scenario: Scenario): Promise<ScenarioResult> {
    statements.take();
    takeCalls(metadata, listenbrainz);
    const started = performance.now();
    const sizes = await Promise.all(scenario.requests(context).map(request));
    const ms = performance.now() - started;
    const { count, executed } = statements.take();
    return {
      queries: count,
      bytes: sizes.reduce((total, size) => total + size, 0),
      scans: scannedTables(db, executed),
      calls: takeCalls(metadata, listenbrainz),
      ms,
    };
  }

  return {
    seed: { artists, albums: library.albums, tracks: library.tracks, seedMs },
    run,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await metadata.close();
      listenbrainz.restore();
      await cleanupIsolatedState(paths);
    },
  };
}
