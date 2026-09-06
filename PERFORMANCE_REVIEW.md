# Performance Review

Date: 2026-09-05. Commit: `7a42f9a6`.

Scope: full read of the backend library pipeline (Lidarr indexer, canonical library store and queries, scan scheduling,
discovery/news/inbox consumers, Subsonic service), the Lidarr client, and the frontend Library page. Findings were
confirmed with timing probes on synthetic databases seeded with Lidarr-shaped metadata blobs
(`scripts/benchmark-library.mjs` schema, 2 KB artist/album blobs, 600 B track blobs).

## Root cause

All database work runs through synchronous `better-sqlite3` on the main Node thread, and the honker job workers run in
the same process. Every hotspot below therefore freezes HTTP, websockets, and the Subsonic API for its full duration.
Costs scale linearly with library size; the measurements below are for 800k tracks / 80k albums / 8k artists and should
be multiplied by roughly 5-10x for a library with 80k artists or albums.

## Measurements

Probe: `perf-probe.mjs` (seeded 80k and 800k track libraries, one warm run per query unless noted).

| Path                                                | 80k tracks | 800k tracks |
|-----------------------------------------------------|-----------:|------------:|
| `GET /api/discovery` full artist projection         |     238 ms |    2 501 ms |
| FTS trigram full rebuild (after every changed scan) |     470 ms |    5 699 ms |
| Genre stats rebuild (after every changed scan)      |     181 ms |    1 932 ms |
| Subsonic `getGenres` (`getCanonicalGenres`)         |   2 382 ms |   24 732 ms |
| Library home `sort=newest` albums page              |      43 ms |      429 ms |
| Library home `sort=newest` tracks (pageSize 12)     |      52 ms |      545 ms |
| Library albums `genre=Rock` page                    |      75 ms |      721 ms |
| `GET /library/artists` (default limit 10000)        |     219 ms |    2 762 ms |
| `/discovery/filtered` key projection                |       1 ms |       17 ms |
| Library artists page 1 (paged, warm)                |       3 ms |       28 ms |
| No-op re-index, 20k tracks (`syncSearch=false`)     |     227 ms |      208 ms |
| No-op re-index, 20k tracks (`syncSearch=true`)      |     614 ms |      606 ms |
| Database size                                       |      97 MB |      974 MB |

Paged library queries are fine. The damage comes from whole-library paths on hot routes and from the scan pipeline.

## Status

- Finding 1 and finding 9: fixed. `getCanonicalArtistKeys()` in
  `backend/services/libraryQueryService.js` returns an identity-only view
  (no joins, JSON fields extracted in SQL, cached until the library changes).
  Discovery, filtered/tags routes, news, inbox, shows, discover playlists,
  recent releases, flow sources, and `/library/recent` now use it. Measured on
  the 800k-track probe: 2 195 ms per call before, 22 ms cold and under 1 ms
  warm after.
- Finding 2 and finding 5: fixed. Scans no longer rebuild the FTS index or
  recompute genre stats on the main thread. `withLibraryScan` in
  `backend/services/libraryMediaStore.js` records which artists, albums, and
  tracks a scan wrote and syncs only their search documents in batches of 500
  when the scan ends (artist renames cascade). Genre stats and the Subsonic
  genre list live in a persisted snapshot (`libraryGenreStats:*` and
  `libraryGenreList:*` settings) that library changes no longer delete; a
  debounced (15 s) refresh recomputes it in a `worker_threads` worker on its own
  SQLite connection (`backend/services/libraryGenreCache.js`). Measured on the
  800k-track probe: refresh 23.3 s off-thread with 2 ms peak event-loop lag,
  `getCanonicalGenres` 1 ms from the snapshot (24 732 ms before), and the
  5.7 s FTS rebuild plus 1.9 s genre recompute removed from every changed scan.
  Readers see the previous snapshot until the refresh lands. A scan that fails
  part-way runs a document gap repair (358 ms at 800k tracks) instead of a
  rebuild.
- Fix-order item 3: done. The library-scan honker job now runs
  `scanConfiguredLibrary` in a `worker_threads` worker
  (`backend/services/libraryScanThread.js`, driven by
  `backend/services/libraryScanRunner.js`) with its own SQLite connection,
  Lidarr client, and request slots. The main thread invalidates its library
  caches when the worker reports changes; the Flow playlist rescan and the
  websocket broadcast stay on the main thread. Scans are serialized in the
  runner. Measured with a 3 000-file Aurral root: first scan 1.2 s, no-op rescan
  0.7 s including worker start-up, main-thread event-loop lag 1-2 ms throughout
  (the same scan used to block for its full duration). Finding 4's shared
  Lidarr slot queue is also relieved, because the worker has its own client.
- Fix-order item 4 (finding 3): done. The file watcher debounce is 2 minutes
  (`LIBRARY_WATCH_DEBOUNCE_MS` overrides it) and non-audio writes (artwork,
  nfo, dotfiles, temp names) no longer schedule scans; directory events still
  do. The Lidarr webhook now schedules an artist-scoped re-index for
  Download, Rename, and Retag events and a full scan only for deletes.
  `indexLidarrLibrary({ artistIds })` fetches one artist's albums, tracks, and
  files and can only mark that artist's media unavailable; the run is recorded
  under source `lidarr-artist` so it never counts as a completed full scan.
  Library mutations that touch one artist (add, monitoring changes, album
  add/update, track file delete) schedule scoped scans; scoped requests merge
  into one pending job and any unscoped request upgrades it to a full scan.
- Fix-order item 5 (finding 4, partial): done. Full Lidarr scans skip
  `/track?artistId=`, track-file reads, `fs.stat`, and all track and file
  upserts for artists whose `statistics`, `lastInfoSync`, and `path` match the
  stored resource (`findUnchangedLidarrArtists` in
  `backend/services/libraryLidarrIndexer.js`). The skip is only trusted after
  a completed full Lidarr run, never for resources without statistics, and
  never on a forced scan (manual refresh sets `force`, which now reaches the
  indexer). Skipped artists' media is excluded from unavailability marking.
  Remaining `fs.stat` calls run 16 at a time instead of sequentially, and the
  media store prepares its static SQL once per process. Measured on the
  800k-track database with every artist unchanged: 2.6 s for the whole
  re-index, zero track reads, zero stat calls (before: 8 000 `/track` reads,
  800 000 stats, and about 25 s of upserts). Artist and album row upserts
  still run for skipped artists so monitoring changes are picked up.
- Fix-order item 6 (finding 7): done, with one deliberate change of plan.
  `backend/services/libraryMetadataProjection.js` drops the embedded related
  objects before a Lidarr resource is stored: artists lose `nextAlbum`,
  `lastAlbum`, `members`, `links`, `overview`; albums lose `artist`,
  `releases`, `links`, `overview`; tracks lose `artist` and `album`. Every
  field the backend, Subsonic, or frontend reads (ids, mbids, names,
  monitoring, path, added, statistics, ratings, images, genres, release
  data) is kept. On Lidarr-shaped samples this shrinks an artist blob from
  10.4 KB to 0.6 KB and an album with 18 releases from 17.4 KB to 0.5 KB.
  The Aurral folder scanner stored the full `music-metadata` tag set,
  including embedded artwork buffers, three times per file; `slimFileTags`
  now strips `picture` and any binary values. `statistics` stays in change
  detection on purpose: item 5 uses it as the signal that an artist needs
  re-reading, the row rewrite is cheap, and it no longer triggers a rebuild.
  Existing rows are slimmed as their artists change; a forced scan
  (Library refresh) rewrites everything.
- Fix-order item 7 (finding 8): done. `backend/config/library-derived-data.js`
  adds `latest_media_at` and `latest_available_media_at` columns to
  `library_albums` and `library_tracks`, each indexed with the title so a
  `sort=newest` page is one index walk, and a `library_genres` membership
  table (`entity_kind`, `entity_id`, `genre`, indexed by genre `COLLATE
  NOCASE`). Triggers on `library_media_files`, `library_album_tracks`, and the
  three entity tables keep both in sync on every insert, update, and delete;
  a one-time backfill runs at startup when the `libraryDerivedDataVersion`
  setting is missing or stale (7.6 s on the 800k-track probe, 154 000 genre
  rows). `recentMediaOrder` reads the columns directly; genre filters are now
  `<entity>.id IN (<id set from library_genres>)` so SQLite drives the page
  from the genre index instead of scanning every row with three `EXISTS`
  clauses; the genre snapshot queries in
  `backend/config/library-search-index.js` read `library_genres` instead of
  `json_each` over every blob. Measured on the 800k-track probe: albums
  `sort=newest` 429 ms to 120 ms, of which the sort itself is under 1 ms and
  the rest is the unfiltered pagination `COUNT` (unchanged, not part of this
  item); tracks `sort=newest` 545 ms to 16 ms; albums by genre (`Pop`, 25 %
  of the library) 721 ms to 134 ms; tracks by genre 1 166 ms to 370 ms;
  artists by genre 5 ms; Subsonic `getAlbumList byGenre` 72 ms; genre stats
  recompute 137 ms. A `source=` filter (API only; the UI always sends `all`)
  still uses the per-row `MAX()` subquery and takes 3.3 s for a newest page,
  as before.
- Fix-order item 8 (finding 6): done, with one deliberate change of plan.
  `getArtistByMbid` in `backend/services/lidarrClient.js` now asks Lidarr for
  a single artist with `GET /artist?mbId=<uuid>` (each MusicBrainz-shaped
  candidate id in turn: the requested mbid, then any stored provider
  mapping). Lidarr binds `mbId` as a GUID, so a provider id such as
  `705@deezer` still fetches the full list, and a Lidarr build that ignores
  the filter and answers with every artist is indexed as before. The new
  endpoint shares the in-flight request dedupe and the stale-list circuit
  fallback. `forceRefresh: true` in `backend/routes/library/handlers/misc.js`
  is kept on purpose: the cost that motivated dropping it is gone, and the
  lookup page wants the current monitoring state. Measured against a mock
  Lidarr serving 8 000 artists: 12.8 MB downloaded and parsed per lookup
  before, 1.7 KB after (36 ms to 3 ms on loopback; the real cost was the
  transfer over the network).
- Fix-order item 9: done. `backend/config/sqlite-tuning.js` applies one
  tuning to every connection: a 64 MB page cache on the main connection (a
  quarter of that on the scan and genre-refresh worker connections), a 256 MB
  memory map over the database file, and `temp_store = MEMORY` so sort and
  group scratch b-trees never spill to temp files. The first cut shipped
  256 MB and 1 GB; both budgets are counted in the process RSS (mapped file
  pages included, even though the OS can reclaim them), which pushed a
  production instance to 1.4 GB, so the defaults were lowered in the review
  pass and the measurements below were retaken with them. `PRAGMA optimize` runs
  after startup and after every completed scan to keep planner statistics
  current. `AURRAL_SQLITE_CACHE_MB` and `AURRAL_SQLITE_MMAP_MB` override the
  defaults (documented in `docs/src/content/docs/admin/environment.mdx`).
  Measured on the 800k-track probe with a warm OS file cache (so this is the
  SQLite-side gain only; a host whose RAM cannot hold the file in the OS
  cache gains more): unfiltered album page 118 ms to 60 ms, track page 18 ms
  to 9 ms, tracks by genre 372 ms to 303 ms, search 605 ms to 560 ms, genre
  stats 137 ms to 94 ms, genre list 1 160 ms to 1 105 ms.

### Adversarial review of the fix pass

Three independent reviewers (queries and derived data, scan pipeline, Lidarr
client and routes) went over commit `823ed6d8`. Everything rated medium or
higher was fixed; the low findings are listed at the end.

Fixed:

- Fingerprint skip could lose data (scan, high). The skip compared against
  a hash stored in the run table, so an artist whose files failed to stat or
  whose run was interrupted could still be skipped next time. The
  fingerprint now lives in `library_artists.lidarr_fingerprint`, is cleared
  when the artist changes, and is stamped only after every album batch of
  that artist committed with no failure.
- Scoped scan merged into a running job was dropped (Lidarr, medium-high).
  `scheduleLibraryScan` now merges only into a queued job; a request that
  arrives while a scan is processing enqueues a fresh job, and a finished job
  no longer wipes a registry that already points at a newer job.
- Interrupted scans left stale search documents (scan, medium). A run left
  `running` by a killed worker is closed as `failed` (`interrupted`) at
  startup and before every scan, and `findLibrarySearchDocumentGaps`
  compares document text against the expected text so the repair also
  catches documents whose rows changed under them (1.0 s on 800k tracks).
- Source-filtered genre stats were recomputed per request (queries, high).
  The snapshot only covers the unfiltered variants; a filtered read used to
  schedule a refresh whose completion evicted the memo, so a Subsonic client
  filtering by source paid the full computation on every call. Filtered
  variants are memoized until the next snapshot lands, the snapshot is loaded
  into memory when it lands, and a failed refresh is retried after 60 s
  instead of being dropped.
- Insert triggers re-aggregated the whole track and album (queries, medium).
  The insert triggers now raise `latest_media_at` in place
  (`MAX(current, NEW.created_at)`); updates and deletes still re-aggregate.
  Derived-data version bumped to 2 so the triggers are recreated on upgrade.
  200k media inserts: 2.90 s to 2.35 s.
- Deferred transactions could fail with `SQLITE_BUSY_SNAPSHOT` (queries,
  medium). Scans write from a worker-thread connection; a main-thread
  transaction that read before writing could not wait out `busy_timeout`.
  `db.transaction` now begins `IMMEDIATE`; read-only callers can still ask
  for `.deferred`.
- Search sync batches were unbounded (queries, medium). A renamed artist
  cascaded to every album and track document inside its own batch. Cascades
  are deferred into the next phase, so every transaction touches at most 500
  documents, and gap detection runs one transaction per entity kind.
- File watcher never flushed a long burst and ignored folders with a period
  in the name (scan, medium x2). A burst that never goes quiet is flushed
  after `LIBRARY_WATCH_MAX_WAIT_MS` (default 10 min), and a path that exists
  as a directory is never ignored by the extension filter ("Mr. Bungle").
- Scoped scan marked files unavailable on truncated Lidarr responses and
  missed deleted albums (scan, medium). Each scoped artist is reconciled
  against Lidarr's `statistics.trackFileCount`: one that falls short keeps
  its media and gets no fingerprint; one that reports zero files is
  reconciled even when no track was enumerated.
- `AlbumDelete` webhooks forced a full re-index (Lidarr, medium). The
  payload carries the artist, so it is scoped like the other events; only
  `ArtistDelete` needs the full reconciliation.
- One failed album fetch failed the whole scoped scan (Lidarr, medium). The
  artist whose album list could not be fetched is left out of the run
  instead of aborting it or being indexed with no albums.
- SQLite defaults sized for a small host (queries, medium; also observed as
  1.4 GB RSS in production). Cache 256 MB to 64 MB, mmap 1 GB to 256 MB.
  At 80k tracks the timings are identical; at 800k the album page goes from
  60 ms to 107 ms and the map size, not the cache, is what matters, so
  hosts with large libraries and RAM to spare should raise
  `AURRAL_SQLITE_MMAP_MB`.

Left as found (low):

- Genre filter values are now trimmed before matching (the list always was),
  so a filter with surrounding whitespace no longer matches.
- `recentReleases.js` assigns into an object from the shared artist-keys
  view; harmless today because the value is unchanged.
- The derived-data version marker is written outside the backfill
  transaction; only matters with two builds sharing one volume.
- Media rows with a null `album_id` are not reached by the per-artist path
  lookup used to protect skipped artists' files.
- Every Lidarr Download event schedules a scan (they merge); `retag` is not
  a Lidarr event name.
- `slimFileTags` drops empty arrays, so the first scan after upgrade rewrites
  Aurral track metadata once.

### Production incident: frozen UI and runaway memory on the nightly

Observed after the fix pass shipped as the nightly: on a fresh boot the
container sat at 1-2 % CPU while the UI would not load, and once the process
grew until it took the host's memory. `GET /api/health/live`, which touches
neither the database nor Lidarr, hung for the full 60 s probe timeout twice,
then answered in 3.5 s, then in 30 ms: the event loop was blocked for minutes
after startup.

Causes, from the production database copy and the code:

- **Main thread sleeping in SQLite lock waits.** better-sqlite3 is
  synchronous, so a main-thread write waiting for the lock (queue claims,
  settings, the honker heartbeat) sleeps the whole event loop for up to
  `busy_timeout`. The scan worker committed one transaction after another
  and re-took the lock the instant it released it, so the main thread kept
  losing the race (writer starvation; the earlier "database is locked" after
  25 s errors were the same thing). `PRAGMA optimize` at startup ran
  `ANALYZE` on the main thread and held the lock for seconds on a large
  library, and the interrupted-scan repair (a whole-table comparison) ran on
  the main thread too. The `IMMEDIATE`-by-default transactions from the
  review made every read-heavy transaction hold the write lock for its read
  phase as well.
- **Lidarr phase failed silently and was repeated.** Since the deploy no
  Lidarr scan completed: each full pull of the 20.7k-album list timed out at
  30 s, was retried, and after ~150 s the scan job was still marked
  completed with no log line. The file watcher then scheduled a full Lidarr
  scan on any change under the Lidarr root, so the same pull was repeated
  every few minutes until Lidarr answered 503.
- **No memory ceiling.** The image set no heap limit and the compose file no
  container limit, so a runaway process grew until the host was
  unresponsive.

Fixes:

- Main connection `busy_timeout` 5000 ms to 500 ms: a lost lock race costs a
  request an error, not the whole app a freeze. Worker connections wait
  30 s. `analysis_limit = 400` bounds `PRAGMA optimize`, which now runs only
  in the scan worker after a scan; the startup `optimize` is gone.
- Scan workers yield the lock: a 10 ms sleep between search-sync batches,
  every 20 albums, every 20 files, and after each batch of 100 artist
  upserts (previously one transaction for every artist). `setImmediate`
  yields the JS loop but not the lock.
- Search-document gap detection reads outside any transaction; only the
  orphan delete holds the lock.
- Startup only closes interrupted runs and leaves a marker; the document
  repair they owe runs in the next scan worker.
- The Lidarr phase of a scan logs and fails the scan job (queue retries with
  backoff, three attempts), and records a failed run row when the indexer
  aborted before opening one.
- Bulk Lidarr reads (`/artist`, `/album`, per-artist `/track` and
  `/trackfile`) use `LIDARR_BULK_TIMEOUT_MS` (default 180 s), never retry,
  run at concurrency 4 instead of 12, and a failure opens the circuit for
  10 minutes so a scan that just timed out cannot be repeated right away.
- The file watcher maps changed paths to the Lidarr artist folders it has
  indexed and schedules artist-scoped re-indexes; a local-only request
  merges into a scoped job by adding the Aurral root (`includeLocal`)
  instead of upgrading it to a full pull. A change it cannot map (a new
  artist folder, an untracked burst over 500 paths) still needs a full pull,
  allowed once per `LIBRARY_WATCH_FULL_SCAN_INTERVAL_MS` (default one hour)
  and otherwise deferred until the interval has passed.
- Guardrails: `NODE_OPTIONS=--max-old-space-size=2048` in the image,
  `mem_limit: 3g` in the compose example, a process-memory line every minute
  under verbose logs, and a warning when RSS passes `AURRAL_MEMORY_WARN_MB`
  (default 1536).

Not resolved by this pass: which allocation grew the process during the
incident is unproven (the memory line exists to answer that next time), and
the bursts of six websocket connections at page load remain unexplained.

## Findings, ranked by severity

### Critical

**1. Discover page loads the full artist stats projection on every request.**
`backend/services/discovery/userDiscovery.js:32` spreads
`iterateCanonicalArtistProjection` on every `GET /api/discovery` only to build a set of mbid/name keys. The same pattern
appears in
`backend/services/newsService.js:230`, `backend/services/inboxService.js:356`,
`backend/services/discovery/provider.js:447`,
`backend/services/discovery/playlists.js:88`, and
`backend/services/weeklyFlow/weeklyFlowPlaylistSource.js:478` (and `:2045`). The projection query
(`backend/services/libraryQueryService.js:295`) joins albums, album_tracks, and media files for each artist, parses
every artist
`metadata_json`, runs a correlated `library_scan_runs` EXISTS per row, and pages with `OFFSET`, so the whole library is
scanned per page view.

**2. Every scan that changes anything ends with a full FTS rebuild and genre recompute.**
`backend/services/libraryIndexService.js:102-105` calls
`rebuildLibrarySearchIndex()` and `rebuildCanonicalGenreStats()` in the
`finally` block whenever `changed` is true. The rebuild deletes and reinserts every artist, album, and track document
into a trigram FTS5 index (`backend/config/library-search-index.js:198`), then runs two `json_each`
passes over every metadata blob (`backend/config/library-search-index.js:51`). Incremental FTS triggers already exist
and are bypassed.

**3. Scans fire constantly, and each is a full re-index.**
`backend/services/libraryFileWatcher.js:47` opens a recursive `fs.watch` on every Lidarr root folder and, after a 2 s
debounce, schedules a full Lidarr re-index (`:91`). `scheduleCanonicalLibraryReconciliation`
(`backend/services/libraryManager.js:62`) does the same from nine mutation paths (add/update/delete artist, album,
track). During active downloading the scan loop runs back-to-back, with finding 2 at the tail of each run.

**4. The re-index itself is expensive.** In
`backend/services/libraryLidarrIndexer.js`:

- `:164-166` fetches the complete `/artist` and `/album` lists from Lidarr (album resources embed the full artist
  object) and holds everything in heap alongside all tracks and track files.
- `:78-125` then calls `/track?artistId=` once per artist (`backend/services/lidarrClient.js:1303`), 12 concurrent,
  through the same slot queue UI requests use (`lidarrClient.js:242`). Lidarr is starved and interactive Lidarr calls
  queue behind indexer traffic.
- `:199-211` runs a sequential `await fs.stat` per track. On NFS/SMB inside Docker this alone takes minutes.
- `:246-300` performs three upserts per track, each doing an inline
  `db.prepare`, a SELECT, and a JSON text compare (`backend/services/libraryMediaStore.js:340`, `:387`, `:490`).
  Measured at about 30 µs per track even when nothing changed, so roughly 25 s of synchronous DB time per scan at 800k
  tracks. The loop yields to the event loop only between albums.

**5. `getCanonicalGenres` takes 25 s at 800k tracks.**
`backend/services/libraryQueryService.js:1496` builds five CTEs with
`json_each` over every artist, album, and track blob. It is served uncached to Subsonic `getGenres`
(`backend/services/subsonicLibraryService.js:459`), so a single client refresh freezes the server for the full duration.

### High

**6. Lidarr `/artist` full list is fetched per lookup.** `getArtistByMbid`
(`backend/services/lidarrClient.js:1120`) downloads the entire artist list on a cache miss and re-indexes all of it
(`:225`).
`backend/routes/library/handlers/misc.js:83` passes `forceRefresh: true`, so every `GET /library/lookup/:mbid` (artist
page, search results) pulls tens of megabytes. Lidarr supports `GET /artist?mbId=<uuid>`.

**7. Metadata blobs are stored whole and parsed everywhere.**
`libraryLidarrIndexer.js:222`, `:260`, and `:283` store the full Lidarr artist, album, and track resources in
`metadata_json`. Synthetic 2 KB blobs produced a 974 MB database at 800k tracks; real Lidarr blobs are larger.
`statistics`
lives inside the blob, so every download rewrites the artist and album rows, marks the scan changed, and triggers
finding 2. The SQLite page cache and mmap are 24 MB each (`backend/config/db-sqlite.js:24-25`).

**8. `sort=newest` and genre filters are correlated subqueries.**
`backend/services/libraryQueryService.js:943` computes `MAX(media.created_at)`
per album or track to sort the Library home page; `:1031` runs `json_each` per row for genre filtering. Both are paid on
every page load.

**9. `/discovery/filtered` and tag routes load every artist per request.**
`getCanonicalArtistKeyProjection` (`backend/services/libraryQueryService.js:287`)
selects and JSON-parses every artist row on each hit of
`backend/routes/discovery/handlers/main.js:80` and
`backend/routes/discovery/handlers/tags.js:127`. Linear in artist count and blob size.

**10. `GET /library/artists` defaults to limit 10000.**
`backend/routes/library/handlers/artists.js:14` runs the full stats projection. The frontend no longer calls it, but the
route is public.

### Medium

**11. Name-keyed artist upsert scans the whole artist table per file.**
`backend/services/libraryMediaStore.js:128-134` selects every artist with an mbid and filters in JS (marked with a
"ponytail" comment). This hits the aurral folder scan for any artist without an mbid.

**12. The aurral folder scan parses tags of every file on every scan.**
`backend/services/libraryFileScanner.js:204` calls `music-metadata` before checking the stored mtime.

**13. Subsonic `getArtists` is unbounded.**
`backend/services/subsonicLibraryService.js:337` calls `getCanonicalArtistPage`
with no limit and `includeStats`, aggregating the whole library. 47 ms at 8k artists; linear.

**14. Prepared statements are not cached in the library store.**
`backend/db/helpers/*` cache statements at module load;
`backend/services/libraryMediaStore.js` and
`backend/services/librarySearchIndex.js` call `db.prepare` on every invocation.

### Low

**15. Unified search scans the in-memory artist cache linearly per keystroke**
(`backend/services/unifiedSearchService.js:537`, `:571`). That cache is only populated by the `lidarr-retry` task or
`/library/recent`, so it is usually empty.

**16. Artist cover route calls `getArtistImage` even on a cache hit**
(`backend/routes/artists/handlers/cover.js:40`). The Library page issues one request per artist card, 100 per page.

**17. `frontend/src/pages/LibraryPage.jsx` is a 2.9k line single component.**
Render cost is acceptable because pages hold 100 items, but every mutation re-derives all memos.

## Recommended fix order

1. **Keys-only artist query.** Add a query returning id, mbid, name with no joins and no JSON parsing, cache it per scan
   generation, and use it in discovery, news, inbox, playlists, and flow sources. Resolves findings 1 and 9.
2. **Stop the full FTS rebuild.** Rely on the existing triggers through
   `syncSearch`. Compute genre stats and `getCanonicalGenres` in a debounced background step, persist them, and serve
   from the settings cache the way genre stats already are. Resolves findings 2 and 5.
3. **Move scans off the main thread.** Run the scan, FTS sync, and genre recompute in a `worker_threads` worker with its
   own database connection so request handling never blocks.
4. **Scope reconciliation.** Raise the watcher debounce to minutes and ignore non-audio writes. Use the Lidarr webhook
   (currently only records history,
   `backend/routes/lidarrWebhook.js:5`) to re-index a single artist instead of the whole library.
5. **Make the indexer incremental.** Skip `/track?artistId=` and `fs.stat` for artists whose stored `statistics` and
   `lastInfoSync` are unchanged; run remaining stats with bounded concurrency; batch upserts using cached prepared
   statements.
6. **Slim the stored metadata.** Persist a projection of needed fields (a
   `LIDARR_METADATA_KEYS` list already exists at
   `backend/services/libraryMediaStore.js:26`) and exclude `statistics` from change detection.
7. **Precompute sort and genre columns.** Persist `latest_media_at` on albums and tracks with an index, and materialize
   a genre membership table.
8. **Lidarr lookups by mbid.** Use `/artist?mbId=` in `getArtistByMbid` and drop `forceRefresh` in
   `backend/routes/library/handlers/misc.js:83`.
9. **Tune SQLite.** Raise `cache_size` and `mmap_size` to hundreds of megabytes.

## Reproducing the measurements

```sh
mkdir -p /tmp/aurral-perf
AURRAL_DATA_DIR=/tmp/aurral-perf AURRAL_DB_PATH=/tmp/aurral-perf/aurral.db \
  node --max-old-space-size=6144 scripts/perf-probe.mjs 800000
```

The probe seeds the canonical library tables directly and times the paths listed above against the real service modules.
