import path from "node:path";
import { db } from "../config/db-sqlite.js";
import { resolveDownloadRoot } from "./downloadPaths.js";
import { createPathScopeMatcher, scanMusicRoot, scanMusicRoots } from "./libraryFileScanner.js";
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
} from "./libraryMediaStore.js";
import { getAlbumByMbid, selectAlbumRelease } from "./providers/brainzmashProvider.js";
import { mapWithConcurrency } from "./discovery/helpers.js";
import { isVariousArtistsCredit } from "./trackMatching/titleText.js";
import { flowPlaylistConfig } from "./playlists/flowPlaylistConfig.js";
import { removePlaylistTracksWithoutDownloads } from "./playlists/trackRemoval.js";
import { rebuildLibrarySearchIndex } from "./librarySearchIndex.js";
import { rebuildLibraryGenreStats } from "./libraryQueryService.js";
import {
  musicbrainzGetArtistNameByMbid,
  musicbrainzResolveLibraryArtistMbid,
} from "./apiClients/index.js";
import { logger } from "./logger.js";
import {
  activeLidarrRoots,
  createLibraryScanExclusion,
  isLidarrLibraryActive,
} from "./libraryFolders.js";

function getAurralJobMetadataByPath() {
  const rows = db
    .prepare(
      `SELECT final_path, artist_name, album_name, track_name,
        artist_mbid, album_mbid, track_mbid, release_year, track_number, disc_number
       FROM playlist_download_jobs
       WHERE status = 'done' AND final_path IS NOT NULL
       ORDER BY completed_at DESC, created_at DESC`,
    )
    .all();
  const byPath = new Map();
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
    .filter((flow) => flow.showInLibrary === true)
    .map((flow) => flow.id);
  if (flowIds.length === 0) return [];
  const placeholders = flowIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT DISTINCT final_path
       FROM playlist_download_jobs
       WHERE status = 'done' AND final_path IS NOT NULL
         AND (playlist_id IN (${placeholders}) OR playlist_type IN (${placeholders}))`,
    )
    .all(...flowIds, ...flowIds);
  return [...new Set(rows.map((row) => path.resolve(String(row.final_path))))];
}

async function syncLibraryFlowFiles(
  musicRoot,
  jobMetadataByPath,
  force,
  changedPaths,
  changedFiles,
) {
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

async function canonicalizeAurralArtistNames(jobMetadataByPath, paths = null) {
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
    const existing = db.prepare("SELECT id FROM library_artists WHERE mbid = ?").get(artistMbid);
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
      logger.warn("library", "Stopped matching unmatched artists; metadata provider unavailable", {
        message: error?.message || String(error),
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
  let unavailable = null;
  await mapWithConcurrency(getLibraryAlbumsToList(), 4, async (album) => {
    if (unavailable) return;
    let metadata = null;
    try {
      metadata = await getAlbumByMbid(album.releaseGroupMbid);
    } catch (error) {
      if (error?.response?.status !== 404) {
        unavailable ??= error;
        return;
      }
    }
    const release =
      metadata && isLibraryAlbumReleaseGroup(album, metadata)
        ? chooseLibraryAlbumRelease(album, metadata.releases, selectAlbumRelease(metadata))
        : null;
    const artists = new Map((metadata?.artists || []).map((artist) => [artist.id, artist.name]));
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
      message: unavailable?.message || String(unavailable),
    });
  }
  return changed;
}

function isPathWithin(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathsWithin(rootPath, paths) {
  return (Array.isArray(paths) ? paths : []).filter((candidatePath) =>
    isPathWithin(rootPath, candidatePath),
  );
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
} = {}) {
  const jobMetadataByPath = getAurralJobMetadataByPath();
  const targeted = Array.isArray(changedPaths);
  const localPaths = pathsWithin(musicRoot, changedPaths);
  let local;
  let lidarr = { skipped: true, filesSeen: 0, filesIndexed: 0, filesFailed: 0 };
  let flow = skippedScan();
  let scanFailed = false;
  let artistsResolved = false;
  let tracksListed = false;
  let lidarrRemoved = false;
  const lidarrActive = isLidarrLibraryActive(lidarrClient);
  const lidarrFolders = activeLidarrRoots(lidarrClient, lidarrRoots);
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
            isExcluded: createLibraryScanExclusion("aurral", {
              downloadRoot: musicRoot,
              lidarrRoots: lidarrFolders,
            }),
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
          isExcluded: createLibraryScanExclusion("lidarr", {
            downloadRoot: musicRoot,
            lidarrRoots: lidarrFolders,
          }),
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
        logger.error("library", "Lidarr root scan failed", {
          message: error?.message || String(error),
        });
        lidarr = {
          skipped: false,
          error: error?.message || String(error),
          filesSeen: 0,
          filesIndexed: 0,
          filesFailed: 0,
        };
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
      flow?.changed
    ) {
      if (!targeted || scanFailed || artistsResolved || flow?.removed > 0)
        rebuildLibrarySearchIndex();
      if (!targeted) rebuildLibraryGenreStats();
    }
  }
  return { local, lidarr, flow, lidarrRemoved };
}
