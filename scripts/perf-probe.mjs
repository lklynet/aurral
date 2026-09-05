// Seeds a synthetic canonical library and times the hot read/write paths.
// Usage: AURRAL_DATA_DIR=<dir> AURRAL_DB_PATH=<dir>/aurral.db node scripts/perf-probe.mjs <tracks>
import { performance } from "node:perf_hooks";

const TRACKS = Number(process.argv[2] || 80000);
const TRACKS_PER_ALBUM = 10;
const ALBUMS_PER_ARTIST = 10;

const { db } = await import("../backend/config/db-sqlite.js");
const q = await import("../backend/services/libraryQueryService.js");
const store = await import("../backend/services/libraryMediaStore.js");
const search = await import("../backend/services/librarySearchIndex.js");
const sidx = await import("../backend/config/library-search-index.js");
const subsonic = await import("../backend/services/subsonicLibraryService.js");

const GENRES = ["Rock", "Pop", "Jazz", "Electronic", "Hip Hop", "Metal", "Folk", "Indie"];
const pad = (n, w) => String(n).padStart(w, "0");
const pick = (i) => [GENRES[i % GENRES.length], GENRES[(i * 7) % GENRES.length]];
const filler = "x".repeat(1800);

function artistMeta(i) {
  return JSON.stringify({
    id: i + 1,
    foreignArtistId: `00000000-0000-4000-8000-${pad(i, 12)}`,
    artistName: `Benchmark Artist ${pad(i, 5)}`,
    monitored: true,
    monitor: "all",
    path: `/music/Benchmark Artist ${pad(i, 5)}`,
    qualityProfile: { id: 1, name: "Lossless" },
    genres: pick(i),
    images: [{ coverType: "poster", url: "/x.jpg", remoteUrl: "https://img/" + i }],
    links: [{ url: "https://x", name: "a" }],
    ratings: { votes: 10, value: 3.5 },
    statistics: { albumCount: 10, trackCount: 100, sizeOnDisk: 1000000 },
    overview: filler,
    librarySource: "lidarr",
  });
}
function albumMeta(i, artistIndex) {
  return JSON.stringify({
    id: i + 1,
    artistId: artistIndex + 1,
    foreignAlbumId: `10000000-0000-4000-8000-${pad(i, 12)}`,
    title: `Benchmark Album ${pad(i, 6)}`,
    monitored: true,
    genres: pick(i),
    images: [{ coverType: "cover", remoteUrl: "https://img/a" + i }],
    releases: [{ id: 1, title: "r", mediumCount: 1 }],
    statistics: { trackCount: 10, trackFileCount: 10, sizeOnDisk: 100000 },
    overview: filler,
    librarySource: "lidarr",
  });
}
function trackMeta(i) {
  return JSON.stringify({
    id: i + 1,
    foreignRecordingId: `30000000-0000-4000-8000-${pad(i, 12)}`,
    title: `Benchmark Track ${pad(i, 7)}`,
    duration: 180000,
    trackNumber: String((i % TRACKS_PER_ALBUM) + 1),
    hasFile: true,
    ratings: { votes: 0, value: 0 },
  });
}

function seed() {
  const albumCount = Math.ceil(TRACKS / TRACKS_PER_ALBUM);
  const artistCount = Math.ceil(albumCount / ALBUMS_PER_ARTIST);
  const now = Date.now();
  const insArtist = db.prepare(`INSERT INTO library_artists (identity_key, mbid, name, sort_name, metadata_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`);
  const insAlbum = db.prepare(`INSERT INTO library_albums (identity_key, mbid, release_group_mbid, artist_id, title, album_artist, release_date, metadata_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insTrack = db.prepare(`INSERT INTO library_tracks (identity_key, mbid, title, artist_name, metadata_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`);
  const insRel = db.prepare(`INSERT INTO library_album_tracks (album_id, track_id, disc_number, track_number, created_at) VALUES (?,?,1,?,?)`);
  const insFile = db.prepare(`INSERT INTO library_media_files (track_id, album_id, source, path, format, size, mtime_ms, duration_ms, quality_json, available, created_at, updated_at) VALUES (?,?,'lidarr',?,'flac',1000,?,180000,?,1,?,?)`);
  const artistIds = [];
  const albumIds = [];
  db.pragma("synchronous = OFF");
  db.transaction(() => {
    for (let a = 0; a < artistCount; a += 1) {
      const name = `Benchmark Artist ${pad(a, 5)}`;
      artistIds.push(Number(insArtist.run(`mbid:00000000-0000-4000-8000-${pad(a, 12)}`, `00000000-0000-4000-8000-${pad(a, 12)}`, name, name, artistMeta(a), now, now).lastInsertRowid));
    }
    for (let b = 0; b < albumCount; b += 1) {
      const artistIndex = Math.floor(b / ALBUMS_PER_ARTIST);
      albumIds.push(Number(insAlbum.run(`release-group:10000000-0000-4000-8000-${pad(b, 12)}`, `10000000-0000-4000-8000-${pad(b, 12)}`, `10000000-0000-4000-8000-${pad(b, 12)}`, artistIds[artistIndex], `Benchmark Album ${pad(b, 6)}`, `Benchmark Artist ${pad(artistIndex, 5)}`, `20${pad(b % 24, 2)}-01-01`, albumMeta(b, artistIndex), now, now).lastInsertRowid));
    }
    for (let t = 0; t < TRACKS; t += 1) {
      const b = Math.floor(t / TRACKS_PER_ALBUM);
      const artistIndex = Math.floor(b / ALBUMS_PER_ARTIST);
      const trackId = Number(insTrack.run(`recording:30000000-0000-4000-8000-${pad(t, 12)}`, `30000000-0000-4000-8000-${pad(t, 12)}`, `Benchmark Track ${pad(t, 7)}`, `Benchmark Artist ${pad(artistIndex, 5)}`, trackMeta(t), now, now).lastInsertRowid);
      insRel.run(albumIds[b], trackId, (t % TRACKS_PER_ALBUM) + 1, now);
      insFile.run(trackId, albumIds[b], `/music/A${artistIndex}/B${b}/${pad((t % TRACKS_PER_ALBUM) + 1, 2)}.flac`, now + t, '{"format":"FLAC"}', now + t, now + t);
    }
  })();
  return { artists: artistCount, albums: albumCount, tracks: TRACKS };
}

function time(label, fn, { runs = 1 } = {}) {
  const samples = [];
  let value;
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    value = fn();
    samples.push(performance.now() - t0);
  }
  const ms = samples.sort((a, b) => a - b)[0];
  const size = Array.isArray(value) ? value.length : value?.total ?? value?.items?.length ?? "";
  console.log(`${label.padEnd(58)} ${ms.toFixed(0).padStart(8)} ms  ${size !== "" ? `(n=${size})` : ""}`);
  return value;
}

const t0 = performance.now();
const shape = seed();
console.log(`seeded ${JSON.stringify(shape)} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
const bytes = Number(db.pragma("page_count", { simple: true })) * Number(db.pragma("page_size", { simple: true }));
console.log(`db size ${(bytes / 1024 / 1024).toFixed(0)} MB`);
db.pragma("synchronous = NORMAL");

console.log("\n--- full rebuilds (no longer run after scans; kept for reference) ---");
time("rebuildLibrarySearchIndex() [FTS trigram full rebuild]", () => search.rebuildLibrarySearchIndex());
time("rebuildStoredLibraryGenreStats() [json_each full scans, now off-thread]", () => sidx.rebuildStoredLibraryGenreStats(db));

console.log("\n--- per-request paths ---");
time("GET /api/discovery: getCanonicalArtistKeys (cold)", () => q.getCanonicalArtistKeys());
time("GET /api/discovery: getCanonicalArtistKeys (warm)", () => q.getCanonicalArtistKeys(), { runs: 3 });
time("libraryManager.getAllArtists: [...iterateCanonicalArtistProjection]", () => [...q.iterateCanonicalArtistProjection({ pageSize: 100 })]);
time("GET /api/discovery/filtered: getCanonicalArtistKeyProjection", () => q.getCanonicalArtistKeyProjection(), { runs: 3 });
time("GET /library/artists (limit 10000 default)", () => q.getCanonicalArtistProjection({ pageSize: 10000, offset: 0 }));
time("Subsonic getArtists: listArtists() [no limit]", () => subsonic.listArtists());
time("artist details lookup by name (reference)", () => q.getCanonicalArtistProjection({ reference: "benchmark artist 00042" }), { runs: 3 });
q.invalidateCanonicalLibraryCache({ persistedGenres: false });
time("Library page artists p1 (cold genre cache)", () => q.getCanonicalLibraryPage({ kind: "artists", page: 1, pageSize: 100 }));
time("Library page artists p1 (warm)", () => q.getCanonicalLibraryPage({ kind: "artists", page: 1, pageSize: 100 }), { runs: 3 });
time("Library page artists last page (deep offset)", () => q.getCanonicalLibraryPage({ kind: "artists", page: Math.ceil(shape.artists / 100), pageSize: 100 }), { runs: 3 });
time("Library page artists query='ar' (2 chars, LIKE path)", () => q.getCanonicalLibraryPage({ kind: "artists", page: 1, pageSize: 100, query: "ar" }), { runs: 3 });
time("Library page artists query='artist 0004' (FTS path)", () => q.getCanonicalLibraryPage({ kind: "artists", page: 1, pageSize: 100, query: "artist 0004" }), { runs: 3 });
time("Library home albums sort=newest p1", () => q.getCanonicalLibraryPage({ kind: "albums", page: 1, pageSize: 100, sort: "newest" }), { runs: 3 });
time("Library home tracks sort=newest availableOnly pageSize=12", () => q.getCanonicalLibraryPage({ kind: "tracks", page: 1, pageSize: 12, sort: "newest", availableOnly: true }), { runs: 3 });
time("Library albums p1 (default sort)", () => q.getCanonicalLibraryPage({ kind: "albums", page: 1, pageSize: 100 }), { runs: 3 });
time("Library tracks p1 availableOnly", () => q.getCanonicalLibraryPage({ kind: "tracks", page: 1, pageSize: 100, availableOnly: true }), { runs: 3 });
time("Library albums genre=Rock p1", () => q.getCanonicalLibraryPage({ kind: "albums", page: 1, pageSize: 100, genre: "Rock" }), { runs: 3 });
time("getCanonicalGenres() [subsonic getGenres, snapshot]", () => q.getCanonicalGenres({ source: "all" }), { runs: 3 });

console.log("\n--- scan write path (unchanged data, i.e. the no-op re-index cost) ---");
const artistsRows = db.prepare("SELECT identity_key, mbid, name, sort_name, metadata_json FROM library_artists").all();
time(`upsertLibraryArtist x${artistsRows.length} unchanged (syncSearch=false)`, () => {
  db.transaction(() => {
    for (const r of artistsRows) store.upsertLibraryArtist({ identityKey: r.identity_key, mbid: r.mbid, name: r.name, sortName: r.sort_name, metadata: JSON.parse(r.metadata_json), syncSearch: false });
  })();
});
const trackRows = db.prepare("SELECT identity_key, mbid, title, artist_name, metadata_json FROM library_tracks LIMIT 20000").all();
time("upsertLibraryTrack x20000 unchanged (syncSearch=false)", () => {
  db.transaction(() => {
    for (const r of trackRows) store.upsertLibraryTrack({ identityKey: r.identity_key, mbid: r.mbid, title: r.title, artistName: r.artist_name, metadata: JSON.parse(r.metadata_json), syncSearch: false });
  })();
});
time("upsertLibraryTrack x20000 unchanged (syncSearch=true, per-album path)", () => {
  db.transaction(() => {
    for (const r of trackRows) store.upsertLibraryTrack({ identityKey: r.identity_key, mbid: r.mbid, title: r.title, artistName: r.artist_name, metadata: JSON.parse(r.metadata_json), syncSearch: true });
  })();
});
time("upsertLibraryArtist x1000 with changed statistics (write path)", () => {
  db.transaction(() => {
    for (const r of artistsRows.slice(0, 1000)) {
      const m = JSON.parse(r.metadata_json); m.statistics.sizeOnDisk += 1;
      store.upsertLibraryArtist({ identityKey: r.identity_key, mbid: r.mbid, name: r.name, sortName: r.sort_name, metadata: m, syncSearch: false });
    }
  })();
});
