import path from "node:path";
import { db } from "../config/db-sqlite.ts";
import { asAppError } from "../../lib/errors.ts";
import type { LibraryArtistsRow, PlaylistDownloadJobsRow } from "../db/rows.ts";
import { resolveDownloadRoot } from "./downloadPaths.ts";
import { createPathScopeMatcher, scanMusicRoot, scanMusicRoots } from "./libraryFileScanner.ts";
import {
  assignLibraryArtistMbid,
  getAvailableLibraryMediaPaths,
  getLibraryMediaPaths,
  assignLidarrAlbumOwners,
  chooseLibraryAlbumRelease,
  getLibraryAlbumsToList,
  getUnresolvedLibraryArtists,
  isLibraryAlbumReleaseGroup,
  removeLibraryMediaFiles,
  removeMissingLibraryMediaFiles,
  reconcileLibraryAlbums,
  removeLidarrLibrary,
  storeLibraryAlbumTrackList,
  upsertLibraryArtist,
} from "./libraryMediaStore.ts";
import { getAlbumByMbid, selectAlbumRelease } from "./providers/brainzmashProvider.ts";
import { mapWithConcurrency } from "./discovery/helpers.ts";
import { isVariousArtistsCredit } from "./trackMatching/titleText.ts";
import { flowPlaylistConfig } from "./playlists/flowPlaylistConfig.ts";
import { removePlaylistTracksWithoutDownloads } from "./playlists/trackRemoval.ts";
import { rebuildLibrarySearchIndex } from "./librarySearchIndex.ts";
import { rebuildLibraryGenreStats } from "./libraryQueryService.ts";
import type { LibraryScanRequest } from "./libraryScanRequest.ts";
import {
  musicbrainzGetArtistNameByMbid,
  musicbrainzResolveLibraryArtistMbid,
} from "./apiClients/index.ts";
import { logger } from "./logger.ts";
import {
  activeLidarrRoots,
  createLibraryScanExclusion,
  isLidarrLibraryActive,
  readOnlyFolderPaths,
  type LidarrRootsSource,
} from "./libraryFolders.ts";

interface AurralJobMetadata {
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

function getAurralJobMetadataByPath() {
  const rows = db
    .prepare<
      [],
      Pick<
        PlaylistDownloadJobsRow,
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
       FROM playlist_download_jobs
       WHERE status = 'done' AND final_path IS NOT NULL
       ORDER BY completed_at DESC, created_at DESC`,
    )
    .all();
  const byPath = new Map<string, AurralJobMetadata>();
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
    .prepare<string[], Pick<PlaylistDownloadJobsRow, "final_path">>(
      `SELECT DISTINCT final_path
       FROM playlist_download_jobs
       WHERE status = 'done' AND final_path IS NOT NULL
         AND (playlist_id IN (${placeholders}) OR playlist_type IN (${placeholders}))`,
    )
    .all(...flowIds, ...flowIds);
  return [...new Set(rows.map((row) => path.resolve(String(row.final_path))))];
}

async function syncLibraryFlowFiles(
  musicRoot: string,
  jobMetadataByPath: Map<string, AurralJobMetadata>,
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

async function canonicalizeAurralArtistNames(
  jobMetadataByPath: Map<string, AurralJobMetadata>,
  paths: string[] | null = null,
) {
  const candidates = new Map();
  for (const [filePath, metadata] of jobMetadataByPath) {
    if (Array.isArray(paths) && !paths.some((rootPath) => isPathWithin(rootPath, filePath)))
      continue;
    const artistMbid = String(metadata?.artistMbid || "").trim();
    const artistName = String(metadata?.artistName || "").trim();
    if (!artistMbid || !/[;,×!]/.test(artistName) || candidates.has(artistMbid)) continue;
    candidates.set(artistMbid, artistName);
  }

  for (const artistMbid of candidates.keys()) {
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
      mbid = await musicbrainzResolveLibraryArtistMbid(artist.name);
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

function isPathWithin(rootPath: string, candidatePath: string) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathsWithin(rootPath: string, paths: string[] | null | undefined) {
  return (Array.isArray(paths) ? paths : []).filter((candidatePath) =>
    isPathWithin(rootPath, candidatePath),
  );
}

// A folder that left the list takes its music out of the Library. Its files
// stay on disk.
async function scanReadOnlyFolders(
  roots: string[],
  {
    changedPaths,
    force,
    isExcluded,
    changedFiles,
  }: {
    changedPaths: string[] | null;
    force: boolean;
    isExcluded: ReturnType<typeof createLibraryScanExclusion>;
    changedFiles: Set<string>;
  },
): Promise<FolderScan> {
  const scan =
    roots.length > 0
      ? await scanMusicRoots({
          rootPaths: roots,
          changedPaths,
          force,
          source: "readonly",
          syncSearch: Array.isArray(changedPaths),
          isExcluded,
          changedFiles,
        })
      : skippedScan();
  if (Array.isArray(changedPaths)) return scan;
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
  lidarrClient,
  includeLidarr = true,
  lidarrRoots = null,
  changedPaths = null,
  force = false,
  changedFiles = new Set(),
}: LibraryScanRequest & {
  musicRoot?: string;
  lidarrClient?: LidarrRootsSource;
  lidarrRoots?: string[] | null;
  changedFiles?: Set<string>;
} = {}) {
  const jobMetadataByPath = getAurralJobMetadataByPath();
  const targeted = Array.isArray(changedPaths);
  const localPaths = pathsWithin(musicRoot, changedPaths);
  let local: FolderScan | undefined;
  let lidarr: FolderScan = { skipped: true, filesSeen: 0, filesIndexed: 0, filesFailed: 0 };
  let flow: FolderScan = skippedScan();
  let readOnly: FolderScan = skippedScan();
  let scanFailed = false;
  let artistsResolved = false;
  let tracksListed = false;
  let lidarrRemoved = false;
  const lidarrActive = isLidarrLibraryActive(lidarrClient);
  const lidarrFolders = activeLidarrRoots(lidarrClient, lidarrRoots);
  const readOnlyRoots = readOnlyFolderPaths();
  const folders = { downloadRoot: musicRoot, lidarrRoots: lidarrFolders, readOnlyRoots };
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
      await canonicalizeAurralArtistNames(jobMetadataByPath, targeted ? localPaths : null);
    }
    if (includeLidarr && lidarrFolders.length > 0) {
      try {
        lidarr = await scanMusicRoots({
          rootPaths: lidarrFolders,
          changedPaths: targeted ? changedPaths : null,
          force,
          source: "lidarr",
          syncSearch: targeted,
          isExcluded: createLibraryScanExclusion("lidarr", folders),
          changedFiles,
        });
        if (!targeted) {
          const removedRootPaths = [...getLibraryMediaPaths("lidarr")].filter(
            (filePath) => !lidarrFolders.some((root) => isPathWithin(root, filePath)),
          );
          const removedRootFiles = removeMissingLibraryMediaFiles("lidarr", removedRootPaths);
          for (const filePath of removedRootFiles) changedFiles.add(filePath);
          if (removedRootFiles.length > 0) lidarr.changed = true;
        }
      } catch (error) {
        scanFailed = true;
        const failure = asAppError(error);
        logger.error("library", "Lidarr root scan failed", {
          message: failure?.message || String(error),
        });
        lidarr = {
          skipped: false,
          error: failure?.message || String(error),
          filesSeen: 0,
          filesIndexed: 0,
          filesFailed: 0,
        };
      }
    }
    if (includeLidarr) {
      try {
        readOnly = await scanReadOnlyFolders(readOnlyRoots, {
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
    }
    if (lidarrActive) assignLidarrAlbumOwners();
    else if (!targeted) {
      lidarrRemoved = removeLidarrLibrary();
      if (lidarrRemoved) reconcileLibraryAlbums();
    }
    artistsResolved = await resolveUnmatchedLibraryArtists();
    tracksListed = await completeLibraryTrackLists();
    if (tracksListed) reconcileLibraryAlbums();
    if (!targeted) {
      await removePlaylistTracksWithoutDownloads().catch((error) => {
        logger.warn("library", "Could not remove missing tracks from playlists", {
          message: error?.message || String(error),
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
      tracksListed ||
      lidarrRemoved ||
      local?.changed ||
      lidarr?.changed ||
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
  return { local, lidarr, readOnly, flow, lidarrRemoved };
}
