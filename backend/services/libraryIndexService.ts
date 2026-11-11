import path from "node:path";
import { db } from "../config/db-sqlite.ts";
import { asAppError } from "../../lib/errors.ts";
import type { LibraryArtistsRow, DownloadJobsRow } from "../db/rows.ts";
import { resolveDownloadRoot } from "./downloadPaths.ts";
import { createPathScopeMatcher, scanMusicRoot, scanMusicRoots } from "./libraryFileScanner.ts";
import {
  assignLibraryArtistMbid,
  getAvailableLibraryMediaPaths,
  getLibraryMediaPaths,
  chooseLibraryAlbumRelease,
  getLibraryAlbumsToList,
  getUnresolvedLibraryArtists,
  getUntaggedLibraryAlbums,
  isLibraryAlbumReleaseGroup,
  noteLibraryAlbumLookup,
  assignLibraryAlbumReleaseGroup,
  removeLibraryMediaFiles,
  removeMissingLibraryMediaFiles,
  reconcileLibraryAlbums,
  storeLibraryAlbumTrackList,
  upsertLibraryArtist,
  type UntaggedLibraryAlbum,
} from "./libraryMediaStore.ts";
import {
  getAlbumByMbid,
  resolveAlbumByArtistAndTitle,
  selectAlbumRelease,
} from "./providers/brainzmashProvider.ts";
import type { NormalizedAlbum } from "./providers/brainzmashMappers.ts";
import { mapWithConcurrency } from "./discovery/helpers.ts";
import { isVariousArtistsCredit } from "./trackMatching/titleText.ts";
import { flowPlaylistConfig } from "./playlists/flowPlaylistConfig.ts";
import { removePlaylistTracksWithoutDownloads } from "./playlists/trackRemoval.ts";
import { rebuildLibrarySearchIndex } from "./librarySearchIndex.ts";
import { rebuildLibraryGenreStats } from "./libraryQueryService.ts";
import type { LibraryScanRequest } from "./libraryScanRequest.ts";
import { musicbrainzGetArtistNameByMbid } from "./apiClients/index.ts";
import { matchLibraryArtist } from "./artistMatch.ts";
import { logger } from "./logger.ts";
import { createLibraryScanExclusion, readOnlyFolderPaths, isPathWithin } from "./libraryFolders.ts";

interface JobMetadata {
  artistName: string;
  albumName: string | null;
  trackName: string;
  artistMbid: string | null;
  albumMbid: string | null;
  trackMbid: string | null;
  releaseYear: string | null;
  trackNumber: number | null;
  discNumber: number | null;
}

type LibraryAlbumToList = ReturnType<typeof getLibraryAlbumsToList>[number];

type FolderScan = {
  skipped?: boolean;
  error?: string;
  filesSeen?: number;
  filesIndexed?: number;
  filesFailed?: number;
  changed?: boolean;
  removed?: number;
};

function getJobMetadataByPath() {
  const rows = db
    .prepare<
      [],
      Pick<
        DownloadJobsRow,
        | "final_path"
        | "artist_name"
        | "album_name"
        | "track_name"
        | "artist_mbid"
        | "album_mbid"
        | "track_mbid"
        | "release_year"
        | "track_number"
        | "disc_number"
      >
    >(
      `SELECT final_path, artist_name, album_name, track_name,
        artist_mbid, album_mbid, track_mbid, release_year, track_number, disc_number
       FROM download_jobs
       WHERE status = 'done' AND final_path IS NOT NULL
       ORDER BY completed_at DESC, created_at DESC`,
    )
    .all();
  const byPath = new Map<string, JobMetadata>();
  for (const row of rows) {
    const filePath = String(row.final_path || "").trim();
    if (!filePath || byPath.has(path.resolve(filePath))) continue;
    byPath.set(path.resolve(filePath), {
      artistName: row.artist_name,
      albumName: row.album_name,
      trackName: row.track_name,
      artistMbid: row.artist_mbid,
      albumMbid: row.album_mbid,
      trackMbid: row.track_mbid,
      releaseYear: row.release_year,
      trackNumber: row.track_number,
      discNumber: row.disc_number,
    });
  }
  return byPath;
}

function getLibraryFlowPaths() {
  const flowIds = flowPlaylistConfig
    .getFlows()
    .filter((flow: { showInLibrary?: boolean }) => flow.showInLibrary === true)
    .map((flow: { id: string }) => flow.id);
  if (flowIds.length === 0) return [];
  const placeholders = flowIds.map(() => "?").join(",");
  const rows = db
    .prepare<string[], Pick<DownloadJobsRow, "final_path">>(
      `SELECT DISTINCT final_path
       FROM download_jobs
       WHERE status = 'done' AND final_path IS NOT NULL
         AND (owner_id IN (${placeholders}) OR owner_type IN (${placeholders}))`,
    )
    .all(...flowIds, ...flowIds);
  return [...new Set(rows.map((row) => path.resolve(String(row.final_path))))];
}

async function syncLibraryFlowFiles(
  musicRoot: string,
  jobMetadataByPath: Map<string, JobMetadata>,
  force: boolean,
  changedPaths: string[] | null,
  changedFiles: Set<string>,
): Promise<FolderScan> {
  const targeted = Array.isArray(changedPaths);
  const matchesScope = targeted ? createPathScopeMatcher(changedPaths) : () => true;
  const flowPaths = pathsWithin(musicRoot, getLibraryFlowPaths()).filter(matchesScope);
  const scan = await scanMusicRoot({
    rootPath: musicRoot,
    source: "flow",
    filePaths: flowPaths,
    force: force || targeted,
    metadataEnricher: (_metadata, filePath) => jobMetadataByPath.get(path.resolve(filePath)),
    syncSearch: targeted,
    changedFiles,
  });
  const included = new Set(flowPaths);
  const removedPaths = [...getLibraryMediaPaths("flow")].filter(
    (filePath) => matchesScope(filePath) && !included.has(filePath),
  );
  const available = getAvailableLibraryMediaPaths("flow");
  for (const filePath of removedPaths) if (available.has(filePath)) changedFiles.add(filePath);
  const removed = removeLibraryMediaFiles("flow", removedPaths);
  return { ...scan, removed, changed: scan.changed || removed > 0 };
}

async function canonicalizeArtistNames(
  jobMetadataByPath: Map<string, JobMetadata>,
  paths: string[] | null = null,
) {
  const candidates = new Set<string>();
  for (const [filePath, metadata] of jobMetadataByPath) {
    if (Array.isArray(paths) && !paths.some((rootPath) => isPathWithin(rootPath, filePath)))
      continue;
    const artistMbid = String(metadata?.artistMbid || "").trim();
    const artistName = String(metadata?.artistName || "").trim();
    if (!artistMbid || !/[;,×!]/.test(artistName) || candidates.has(artistMbid)) continue;
    candidates.add(artistMbid);
  }

  for (const artistMbid of candidates) {
    const existing = db
      .prepare<[string], Pick<LibraryArtistsRow, "id">>(
        "SELECT id FROM library_artists WHERE mbid = ?",
      )
      .get(artistMbid);
    if (!existing) continue;
    const artistName = await musicbrainzGetArtistNameByMbid(artistMbid).catch(() => null);
    if (!artistName) continue;
    upsertLibraryArtist({
      identityKey: `mbid:${artistMbid}`,
      mbid: artistMbid,
      name: artistName,
    });
  }
}

async function resolveUnmatchedLibraryArtists() {
  let changed = false;
  for (const artist of getUnresolvedLibraryArtists()) {
    let mbid;
    try {
      mbid = await matchLibraryArtist(artist.name, artist.albums);
    } catch (error) {
      const failure = asAppError(error);
      logger.warn("library", "Stopped matching unmatched artists; metadata provider unavailable", {
        message: failure?.message || String(error),
      });
      break;
    }
    if (mbid && assignLibraryArtistMbid(artist.id, mbid)) changed = true;
  }
  return changed;
}

function holdsMostSongs(album: UntaggedLibraryAlbum, group: NormalizedAlbum) {
  const held = album.files.filter((file) =>
    isLibraryAlbumReleaseGroup({ artistMbid: album.artistMbid, files: [file] }, group),
  );
  return held.length * 2 >= album.files.length;
}

// An untagged album of a linked artist takes the release group of its title
// that holds at least half of its songs, so it lists its tracks like a tagged
// album.
async function matchUntaggedLibraryAlbums(retry: boolean) {
  let changed = false;
  for (const album of getUntaggedLibraryAlbums({ retry })) {
    let releaseGroup;
    try {
      releaseGroup = await resolveAlbumByArtistAndTitle({
        artistName: album.artistName,
        artistMbid: album.artistMbid,
        albumTitle: album.title,
        releaseYear: album.releaseDate,
        holds: async (id) => holdsMostSongs(album, await getAlbumByMbid(id)),
      });
    } catch (error) {
      if (asAppError(error)?.code === "ERR_METADATA_COOLDOWN") continue;
      logger.warn("library", "Stopped matching untagged albums; metadata provider unavailable", {
        message: asAppError(error)?.message || String(error),
      });
      break;
    }
    if (!releaseGroup) noteLibraryAlbumLookup(album.id, album.basis);
    else if (assignLibraryAlbumReleaseGroup(album.id, releaseGroup) != null) changed = true;
  }
  return changed;
}

// Each album with a MusicBrainz release group lists the tracks of the release
// its files come from, again whenever its files change. A release group
// MusicBrainz does not have, or one that is not the album's, as files tagged
// by a wrong guess carry, lists only the album's files.
async function completeLibraryTrackLists() {
  let changed = false;
  let unavailable: unknown = null;
  await mapWithConcurrency(getLibraryAlbumsToList(), 4, async (album: LibraryAlbumToList) => {
    if (unavailable) return;
    let metadata = null;
    try {
      metadata = await getAlbumByMbid(album.releaseGroupMbid);
    } catch (error) {
      const failure = asAppError(error);
      if (failure?.code === "ERR_METADATA_COOLDOWN") return;
      if (failure?.response?.status !== 404) {
        unavailable ??= error;
        return;
      }
    }
    const release =
      metadata && isLibraryAlbumReleaseGroup(album, metadata)
        ? chooseLibraryAlbumRelease(album, metadata.releases, selectAlbumRelease(metadata))
        : null;
    const artists = new Map<string | null | undefined, string>(
      (metadata?.artists || []).map((artist) => [artist.id, artist.name]),
    );
    const compilation = isVariousArtistsCredit(artists.get(metadata?.artistId), metadata?.artistId);
    if (
      storeLibraryAlbumTrackList(album.id, {
        release,
        basis: album.basis,
        artistNameFor: (track) => (compilation ? artists.get(track.artistId) : null) || null,
      })
    )
      changed = true;
  });
  if (unavailable) {
    logger.warn("library", "Stopped listing album tracks; metadata provider unavailable", {
      message: asAppError(unavailable)?.message || String(unavailable),
    });
  }
  return changed;
}

function pathsWithin(rootPath: string, paths: string[] | null | undefined) {
  return (Array.isArray(paths) ? paths : []).filter((candidatePath) =>
    isPathWithin(rootPath, candidatePath),
  );
}

// A scan kept to the Library folder still covers the read-only folders inside
// it. A folder that left the list takes its music out of the Library on the
// next scan of every folder. Its files stay on disk.
async function scanReadOnlyFolders(
  roots: string[],
  {
    within,
    changedPaths,
    force,
    isExcluded,
    changedFiles,
  }: {
    within: string | null;
    changedPaths: string[] | null;
    force: boolean;
    isExcluded: ReturnType<typeof createLibraryScanExclusion>;
    changedFiles: Set<string>;
  },
): Promise<FolderScan> {
  const scanned = within ? roots.filter((root) => isPathWithin(within, root)) : roots;
  const scan =
    scanned.length > 0
      ? await scanMusicRoots({
          rootPaths: scanned,
          changedPaths,
          force,
          source: "readonly",
          syncSearch: Array.isArray(changedPaths),
          isExcluded,
          changedFiles,
        })
      : skippedScan();
  if (Array.isArray(changedPaths) || within) return scan;
  const leftPaths = [...getLibraryMediaPaths("readonly")].filter(
    (filePath) => !roots.some((root) => isPathWithin(root, filePath)) || isExcluded(filePath),
  );
  const removed = removeMissingLibraryMediaFiles("readonly", leftPaths);
  for (const filePath of removed) changedFiles.add(filePath);
  if (removed.length > 0) reconcileLibraryAlbums();
  return { ...scan, changed: scan.changed || removed.length > 0 };
}

const skippedScan = () => ({
  skipped: true,
  filesSeen: 0,
  filesIndexed: 0,
  filesFailed: 0,
  changed: false,
});

export async function scanConfiguredLibrary({
  musicRoot = resolveDownloadRoot(),
  includeReadOnly = true,
  changedPaths = null,
  force = false,
  changedFiles = new Set(),
}: LibraryScanRequest & {
  musicRoot?: string;
  changedFiles?: Set<string>;
} = {}) {
  const jobMetadataByPath = getJobMetadataByPath();
  const targeted = Array.isArray(changedPaths);
  const localPaths = pathsWithin(musicRoot, changedPaths);
  let local: FolderScan | undefined;
  let flow: FolderScan = skippedScan();
  let readOnly: FolderScan = skippedScan();
  let scanFailed = false;
  let artistsResolved = false;
  let albumsMatched = false;
  let tracksListed = false;
  const readOnlyRoots = readOnlyFolderPaths();
  const folders = { downloadRoot: musicRoot, readOnlyRoots };
  try {
    local =
      targeted && localPaths.length === 0
        ? skippedScan()
        : await scanMusicRoot({
            rootPath: musicRoot,
            source: "aurral",
            changedPaths: targeted ? localPaths : null,
            force,
            metadataEnricher: (_metadata, filePath) =>
              jobMetadataByPath.get(path.resolve(filePath)),
            syncSearch: targeted,
            isExcluded: createLibraryScanExclusion("aurral", folders),
            changedFiles,
          });
    if (!targeted || localPaths.length > 0) {
      flow = await syncLibraryFlowFiles(
        musicRoot,
        jobMetadataByPath,
        force,
        targeted ? localPaths : null,
        changedFiles,
      );
    }
    if (!targeted || localPaths.length > 0) {
      await canonicalizeArtistNames(jobMetadataByPath, targeted ? localPaths : null);
    }
    try {
      readOnly = await scanReadOnlyFolders(readOnlyRoots, {
        within: targeted || includeReadOnly ? null : musicRoot,
        changedPaths: targeted ? changedPaths : null,
        force,
        isExcluded: createLibraryScanExclusion("readonly", folders),
        changedFiles,
      });
    } catch (error) {
      scanFailed = true;
      const failure = asAppError(error);
      logger.error("library", "Read-only folder scan failed", {
        message: failure?.message || String(error),
      });
      readOnly = { ...skippedScan(), skipped: false, error: failure?.message || String(error) };
    }
    artistsResolved = await resolveUnmatchedLibraryArtists();
    albumsMatched = await matchUntaggedLibraryAlbums(force);
    tracksListed = await completeLibraryTrackLists();
    if (tracksListed) reconcileLibraryAlbums();
    if (!targeted) {
      await removePlaylistTracksWithoutDownloads().catch((error) => {
        logger.warn("library", "Could not remove missing tracks from playlists", {
          message: asAppError(error)?.message || String(error),
        });
      });
    }
  } catch (error) {
    scanFailed = true;
    throw error;
  } finally {
    if (
      scanFailed ||
      artistsResolved ||
      albumsMatched ||
      tracksListed ||
      local?.changed ||
      readOnly?.changed ||
      flow?.changed
    ) {
      if (
        !targeted ||
        scanFailed ||
        artistsResolved ||
        (flow?.removed !== undefined && flow.removed > 0)
      )
        rebuildLibrarySearchIndex();
      if (!targeted) rebuildLibraryGenreStats();
    }
  }
  return { local, readOnly, flow };
}
