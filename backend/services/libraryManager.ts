import PQueue from "p-queue";
import fsp from "fs/promises";
import path from "path";
import { randomUUID } from "node:crypto";
import { db } from "../config/db-sqlite.ts";
import type { LibraryArtistsRow, LibraryTracksRow } from "../db/rows.ts";
import { asAppError } from "../../lib/errors.ts";
import { isUnreleased } from "../../lib/releaseDate.ts";
import { hasPermission } from "./auth.ts";
import {
  getLibraryArtistProjection,
  getLibraryForAlbumReferences,
  getLibraryForArtistReferences,
  getLibraryForTrackIds,
  getLibraryPage,
  getLibraryTrack,
  getLibraryTrackOwnership,
  invalidateLibraryQueryCache,
  type LibraryAlbum,
  type LibraryTrack,
} from "./libraryQueryService.ts";
import { readRawLibraryMetadata, type LibraryMetadata } from "./libraryMetadata.ts";
import type { RequestUser } from "../middleware/requestUser.ts";
import { selectCanonicalFile } from "./canonicalFileSelector.ts";
import { scheduleLibraryScan } from "./libraryScanWorker.ts";
import { downloadTracker, type DownloadJob } from "./downloadJobs/downloadTracker.ts";
import {
  buildIdentityKey,
  linkLibraryAlbumTrack,
  markLibraryMediaFilesUnavailable,
  removeLibraryAlbumTracksWithoutAvailableMedia,
  removeLibraryArtistIfEmpty,
  removeLibraryTrackIfNoAvailableMedia,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryTrack,
} from "./libraryMediaStore.ts";
import {
  clearLibraryManagement,
  getLibraryManagementEntry,
  getManagementMap,
  setLibraryManagement,
} from "./libraryManagementStore.ts";
import { cancelDownloadWorkForJobs } from "./downloadJobs/downloadCancellationService.ts";
import { restoreDownloadJobCancellations } from "./downloadJobs/downloadCancellation.ts";
import { removeEmptiedFolder, removeSidecars } from "./libraryFiles/fileTransfer.ts";
import { resolveDownloadRoot } from "./downloadPaths.ts";
import { libraryFolderOwner, readOnlyFolderPaths } from "./libraryFolders.ts";
import { removePlaylistTracksWithoutDownloads } from "./playlists/trackRemoval.ts";
import { chooseRequestedRelease } from "./releaseResolver.ts";
import {
  cancelAlbumJobs,
  cancelTrackJobs,
  cancelFileUpgradeJobs,
  cancelLibraryTrackJobs,
  findAlbumJobs,
  indexAlbumJobs,
  jobMatchesTrack,
  summarizeAlbum,
} from "./albumJobs.ts";
import {
  getDownloadSourceNotConfiguredMessage,
  isAnyDownloadSourceConfigured,
} from "./downloadSourceService.ts";
import {
  isStudioAlbum,
  listArtistReleases,
  MONITORED_AURRAL_ALBUM_CONDITION,
  monitoredTrackCondition,
  monitoringToken,
  nextArtistMonitoring,
  nextMonitoringDefaults,
  normalizeMonitorRules,
  resolveArtistMonitoring,
  selectMonitoredReleases,
  type MonitorRules,
} from "./monitoring.ts";
import {
  addMonitoringExclusion,
  clearAlbumMonitoringExclusion,
  clearArtistMonitoringExclusions,
  readArtistMonitoring,
  getMonitoringDefaults,
  getStoredArtistMonitoring,
  indexArtistExclusions,
  isAlbumMonitoringExcluded,
  listMonitoringExclusions,
  saveMonitoringDefaults,
  setArtistMonitoringState,
} from "./monitoringStore.ts";
import { getArtistTopTracks } from "./musicDataSource/index.ts";
import { getNormalizedText, selectAlbumRelease } from "./providers/brainzmashRanking.ts";
import { enqueueSystemTask } from "./jobs/systemTasks.ts";
import { scheduleReleaseMetadataRefresh } from "./releaseMetadataSync.ts";
import { mapWithConcurrency } from "./discovery/helpers.ts";
import { logger } from "./logger.ts";
import {
  getAlbumByMbid as getMetadataAlbumByMbid,
  getArtistByMbid as getMetadataArtistByMbid,
} from "./providers/brainzmashProvider.ts";
import { isSilenceTrack, isVariousArtistsCredit } from "./trackMatching/titleText.ts";
import { recordTrackJobQueued } from "./aurralHistoryService.ts";
const metadataLookups = new PQueue({ concurrency: 4 });

type LibraryArtistRecord = ReturnType<typeof getLibraryForAlbumReferences>["artists"][number];

type AlbumMetadata = LibraryMetadata & {
  id?: string | number | null;
  foreignAlbumId?: string | null;
  path?: string | null;
  added?: string | null;
  librarySource?: string | null;
  edition?: string | null;
  requestedRelease?: string | null;
  trackListComplete?: boolean;
  trackList?: { release?: string | null } | null;
  secondaryTypes?: string[];
  genres?: string[];
  images?: unknown[] | null;
};

type LibraryAlbumRecord = Omit<LibraryAlbum, "metadata"> & { metadata: AlbumMetadata | null };
type LibraryTrackRecord = Omit<LibraryTrack, "metadata"> & { metadata: LibraryMetadata | null };

const _albumMonitoringUpdates = new Map<number, Promise<unknown>>();
const _artistMonitoringUpdates = new Map<number, Promise<unknown>>();
const _trackMonitoringUpdates = new Map<number, Promise<unknown>>();

const monitoredAlbumStmt = db.prepare(`
  SELECT 1 FROM library_management AS management
  JOIN library_albums AS album ON album.id = management.entity_id
  WHERE management.entity_id = ? AND ${MONITORED_AURRAL_ALBUM_CONDITION}
`);

const isMonitoredAlbum = (albumId: unknown) => Boolean(monitoredAlbumStmt.get(Number(albumId)));

const monitoredTrackStmt = db.prepare(
  `SELECT 1 FROM library_tracks AS track WHERE track.id = ? AND ${monitoredTrackCondition("track")}`,
);

const isMonitoredTrack = (trackId: unknown) => Boolean(monitoredTrackStmt.get(Number(trackId)));

const setTrackMonitoredStmt = db.prepare("UPDATE library_tracks SET monitored = ? WHERE id = ?");

const trackIdByMbidStmt = db.prepare<[string], Pick<LibraryTracksRow, "id">>(
  "SELECT id FROM library_tracks WHERE mbid = ? ORDER BY id LIMIT 1",
);

const trackIdByMbidOnAlbumStmt = db.prepare<
  [string, string, string],
  Pick<LibraryTracksRow, "id">
>(`
  SELECT track.id FROM library_tracks AS track
  JOIN library_album_tracks AS link ON link.track_id = track.id
  JOIN library_albums AS album ON album.id = link.album_id
  WHERE track.mbid = ? AND (lower(album.release_group_mbid) = ? OR lower(album.mbid) = ?)
  ORDER BY track.id LIMIT 1
`);

const setAlbumTracksMonitoredStmt = db.prepare(`
  UPDATE library_tracks SET monitored = ?
  WHERE id IN (SELECT track_id FROM library_album_tracks WHERE album_id = ?)
`);

const recordingElsewhereStmt = db.prepare(`
  SELECT 1 FROM library_tracks AS track
  JOIN library_album_tracks AS link ON link.track_id = track.id
  JOIN library_albums AS album ON album.id = link.album_id
  WHERE track.mbid = ?
    AND COALESCE(album.release_group_mbid, album.mbid, '') != ?
    AND (track.monitored = 1 OR EXISTS (
      SELECT 1 FROM library_media_files AS media
      WHERE media.track_id = track.id AND media.available = 1
    ))
  LIMIT 1
`);

const invalidMonitoring = <Message extends string>(message: Message) => ({
  error: message,
  statusCode: 400,
  code: "invalid_monitor_rules",
});

type MonitoringInput = { monitored?: unknown; useDefault?: unknown; rules?: unknown };
type ArtistMonitoring = ReturnType<typeof resolveArtistMonitoring>;
type MonitoringDefaultsState = ReturnType<typeof getMonitoringDefaults>;
type PlannedRelease = {
  id: string;
  title: string;
  type: string | null;
  secondaryTypes: string[];
  releaseDate: string | null;
  existing: boolean;
};
type PlannedTopTrack = {
  title: string;
  albumName: string | null;
  mbid: string | null;
  durationMs: number | null;
};
type ReleaseSkipReason =
  | "complete"
  | "covered"
  | "excluded"
  | "metadata_unavailable"
  | "unmonitored";
type TrackSkipReason = "excluded" | "in_library" | "on_release" | "queued";
type MonitoringPlan = {
  releases: PlannedRelease[];
  topTracks: PlannedTopTrack[];
  skipped: { releaseGroupId: string; title: string; reason: ReleaseSkipReason }[];
  skippedTracks: { title: string; reason: TrackSkipReason }[];
  topTracksError: string | null;
};
type MethodResult<Name extends keyof LibraryManager> = LibraryManager[Name] extends (
  ...args: never[]
) => infer Result
  ? WithAbsentKeys<Awaited<Result>>
  : never;
type Failure = { error: string | undefined; statusCode?: number; code?: string | number | null };
type AlbumConflict = ReturnType<typeof albumConflict>;
type AlbumAddResult = MethodResult<"_addAlbum">;
type DefaultMonitoringArtist = ReturnType<LibraryManager["_defaultMonitoringArtists"]>[number];
type NoError = { error?: undefined; statusCode?: undefined; code?: undefined };
type LibraryDeletion = {
  success: boolean;
  remains?: boolean;
  error?: string;
  statusCode?: number;
  code?: string | null;
};
type AurralRelease = Awaited<ReturnType<typeof listArtistReleases>>[number];
type MonitoringRequest = Parameters<typeof nextArtistMonitoring>[1];
type MonitoringRequestError =
  | Extract<ReturnType<typeof normalizeMonitorRules>, { error: string }>["error"]
  | "monitoring.monitored must be true or false";
type MonitoringRequestResult =
  | { error: MonitoringRequestError; statusCode: number; code: string; request?: undefined }
  | (NoError & { request: MonitoringRequest | null });
type LibraryCollection = {
  artists: LibraryArtistRecord[];
  albums: LibraryAlbumRecord[];
  tracks: LibraryTrackRecord[];
};
type CodedError = Error & { statusCode?: number; code?: string };
type LibraryUser = Pick<RequestUser, "id" | "username" | "role" | "permissions"> | null;
type MonitoringArtist = { id?: string | number | null; mbid: string | null; name: string };
type ArtistAddOptions = {
  user?: LibraryUser;
  monitoring?: MonitoringInput | null;
  albumOnly?: boolean;
};
const announceArtistAdded = (artistName: string, { albumOnly, user }: ArtistAddOptions) => {
  if (albumOnly) return;
  import("./notificationService.ts")
    .then(({ notifyArtistAdded }) => notifyArtistAdded({ artistName, user }))
    .catch((error) =>
      logger.warn("library", "Could not announce an added artist", {
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
};

type AlbumAddOptions = {
  user?: LibraryUser;
  monitorMode?: string | null;
  monitored?: boolean;
  monitoringToken?: string | null;
  artistMbid?: string | null;
  requestGroupId?: string | null;
  trackIds?: number[];
  skipCancelledTracks?: boolean;
  edition?: string | null;
};

function resolveMonitoringRequest(
  monitoring: MonitoringInput | null | undefined,
): MonitoringRequestResult {
  if (monitoring == null) return { request: null };
  if (typeof monitoring !== "object" || typeof monitoring.monitored !== "boolean") {
    return invalidMonitoring("monitoring.monitored must be true or false");
  }
  if (!monitoring.monitored) return { request: null };
  if (monitoring.useDefault !== false) return { request: { useDefault: true, rules: null } };
  const normalized = normalizeMonitorRules(monitoring.rules);
  return normalized.error
    ? normalized
    : { request: { useDefault: false, rules: normalized.rules } };
}

const describeMonitoring = (effective: ArtistMonitoring, defaults: MonitoringDefaultsState) => ({
  monitored: Boolean(effective),
  useDefault: effective ? effective.useDefault : true,
  rules: effective?.rules || null,
  defaultRules: defaults.rules,
});

const summarizeMonitoringPlan = (plan: MonitoringPlan, queued: boolean) => ({
  queued,
  releaseGroupIds: plan.releases.map((release) => release.id),
  releases: plan.releases,
  topTracks: plan.topTracks,
  skipped: plan.skipped,
  skippedTracks: plan.skippedTracks,
  topTracksError: plan.topTracksError,
});

async function serializeMonitoringUpdate<T>(
  updates: Map<number, Promise<unknown>>,
  id: number,
  update: () => Promise<T>,
): Promise<T> {
  const previous = updates.get(id) || Promise.resolve();
  const current = previous.catch(() => {}).then(update);
  updates.set(id, current);
  try {
    return await current;
  } finally {
    if (updates.get(id) === current) updates.delete(id);
  }
}
const _albumAddInflight = new Map<string, Promise<AlbumAddResult>>();
const ALBUM_OWNED_BY_DIFFERENT_ARTIST_ERROR =
  "Album identity already belongs to a different artist";

const albumConflict = (error: string) => ({
  error,
  statusCode: 409,
  code: "album_owner_conflict",
});

function storedStringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function failed<Result>(result: Result): result is Extract<Result, { error: string | undefined }> {
  return (
    typeof result === "object" && result !== null && "error" in result && Boolean(result.error)
  );
}

function throwLibraryError<Result extends { error?: string | null } | null | undefined>(
  result: Result,
): asserts result is Exclude<Result, { error: string | undefined }> {
  if (!result?.error) return;
  const error: CodedError = new Error(result.error);
  Object.assign(error, result);
  throw error;
}

function mapLibraryAlbum(
  album: LibraryAlbumRecord,
  artist: Pick<LibraryArtistRecord, "name" | "mbid"> | undefined,
  tracks: LibraryTrackRecord[] = [],
) {
  const albumTrackIds = Array.isArray(album.trackIds) ? album.trackIds : [];
  const albumTracks = tracks.filter((track) => albumTrackIds.includes(track.id));
  const files = albumTracks.map((track) =>
    selectCanonicalFile(track.files, album.id, album.managed),
  );
  const availableFiles = files.flatMap((file) => (file?.available ? [file] : []));
  const trackCount = albumTracks.length;
  return {
    id: String(album.id),
    providerId: album.metadata?.id ?? null,
    artistId: String(album.artistId),
    artistName: artist?.name || album.albumArtist || null,
    artistMbid: artist?.mbid || null,
    mbid: album.releaseGroupMbid || album.mbid || null,
    releaseGroupMbid: album.releaseGroupMbid || null,
    foreignAlbumId:
      album.metadata?.foreignAlbumId || album.releaseGroupMbid || album.mbid || album.identityKey,
    albumName: album.title,
    title: album.title,
    path: album.metadata?.path || null,
    addedAt: album.metadata?.added || null,
    releaseDate: album.releaseDate || null,
    monitored: album.metadata?.monitored === true,
    managed: Boolean(album.managed),
    monitorMode: album.monitorMode || null,
    sources: album.sources,
    available: Boolean(album.available),
    statistics: {
      trackCount,
      trackFileCount: availableFiles.length,
      sizeOnDisk: availableFiles.reduce((total, file) => total + Number(file.size || 0), 0),
      percentOfTracks: trackCount > 0 ? Math.round((availableFiles.length / trackCount) * 100) : 0,
    },
  };
}

function mapLibraryTrack(track: LibraryTrackRecord, album: LibraryAlbumRecord | undefined) {
  const file = selectCanonicalFile(track.files, album?.id, album?.managed);
  const relation = (track.albums || []).find((entry) => entry.albumId === album?.id);
  return {
    id: String(track.id),
    providerId: track.metadata?.id ?? null,
    albumId: album ? String(album.id) : null,
    artistId: album ? String(album.artistId) : null,
    mbid: track.mbid || null,
    foreignTrackId:
      track.metadata?.foreignRecordingId ||
      track.metadata?.foreignTrackId ||
      track.mbid ||
      track.identityKey,
    trackName: track.title,
    title: track.title,
    trackNumber: relation?.trackNumber || 0,
    discNumber: relation?.discNumber || 1,
    path: file?.path || null,
    hasFile: Boolean(file?.available),
    available: Boolean(file?.available),
    source: file?.source || null,
    managed: Boolean(album?.managed),
    monitorMode: album?.monitorMode || null,
    monitored: track.monitored !== false,
    sources: track.sources,
    size: Number(file?.size || 0),
    quality:
      file?.quality?.audioFormat || file?.quality?.quality?.name || file?.quality?.format || null,
    addedAt: track.metadata?.added || null,
  };
}

function libraryArtistFallback(reference: unknown) {
  return getLibraryArtistProjection({ reference })[0] || null;
}

type LibraryArtistProjection = NonNullable<ReturnType<typeof libraryArtistFallback>>;

function libraryForArtist(
  reference: unknown,
  { includeSharedAlbums = false } = {},
): LibraryCollection {
  return getLibraryForArtistReferences({
    source: "all",
    availableOnly: false,
    references: [reference],
    includeSharedAlbums,
  });
}

function libraryForAlbum(reference: string | number | null | undefined): LibraryCollection {
  return getLibraryForAlbumReferences({
    source: "all",
    availableOnly: false,
    references: [reference],
  });
}

function libraryAlbumsForArtist(
  reference: unknown,
  options: { includeSharedAlbums?: boolean } = {},
) {
  const library = libraryForArtist(reference, options);
  const artistsById = new Map(library.artists.map((artist) => [artist.id, artist]));
  return library.albums.map((album) =>
    mapLibraryAlbum(album, artistsById.get(album.artistId), library.tracks),
  );
}

function libraryAlbumForReference(reference: string | number | null | undefined) {
  const library = libraryForAlbum(reference);
  const album = library.albums[0];
  if (!album) return null;
  const artist = library.artists.find((entry) => entry.id === album.artistId);
  return mapLibraryAlbum(album, artist, library.tracks);
}

function libraryTracksForAlbum(reference: string | number | null | undefined) {
  const library = libraryForAlbum(reference);
  const album = library.albums[0];
  if (!album) return [];
  return library.tracks
    .filter((track) => track.albums.some((entry) => entry.albumId === album.id))
    .map((track) => mapLibraryTrack(track, album));
}

// An album's jobs carry its release group or, from older versions, its
// stored mbid.
const albumJobKeys = (album: Pick<LibraryAlbumRecord, "releaseGroupMbid" | "mbid">) => [
  album.releaseGroupMbid,
  album.mbid,
];

const trackAlbumOwnerNames = (library: LibraryCollection, track: LibraryTrackRecord) =>
  library.albums
    .filter((album) => album.trackIds?.includes(track.id))
    .map((album) => library.artists.find((artist) => artist.id === album.artistId)?.name)
    .filter((name): name is string => Boolean(name));

async function removeLibraryDownloadJobs(
  library: LibraryCollection,
  tracks: LibraryTrackRecord[],
  { albumMbids = [] }: { albumMbids?: (string | null)[] } = {},
) {
  const normalize = (value: unknown) =>
    String(value || "")
      .trim()
      .toLocaleLowerCase();
  const trackKeys = tracks.map((track) => ({
    mbid: normalize(track?.mbid),
    artistNames: new Set(
      [track?.artistName, ...trackAlbumOwnerNames(library, track)].map(normalize).filter(Boolean),
    ),
    title: normalize(track?.title),
  }));
  const albumKeys = new Set([albumMbids].flat().map(normalize).filter(Boolean));
  const albumKey = albumKeys.size > 0;
  const jobs = downloadTracker.getAll();
  const removedJobIds = new Set<string | null | undefined>();
  for (const job of jobs) {
    if (job.playlistType !== "library") continue;
    const jobTrackMbid = normalize(job.trackMbid);
    const belongsElsewhere =
      albumKey && normalize(job.albumMbid) && !albumKeys.has(normalize(job.albumMbid));
    const matchesTrack =
      !belongsElsewhere &&
      trackKeys.some((track) =>
        track.mbid && jobTrackMbid
          ? jobTrackMbid === track.mbid
          : track.artistNames.has(normalize(job.artistName)) &&
            normalize(job.trackName) === track.title,
      );
    const matchesAlbum = albumKey && albumKeys.has(normalize(job.albumMbid));
    if (matchesTrack || matchesAlbum) {
      removedJobIds.add(job.id);
    }
  }
  return dropDownloadJobs(removedJobIds);
}

async function dropDownloadJobs(jobIds: Set<string | null | undefined>) {
  const jobsToRemove = downloadTracker
    .getAll()
    .filter((job) => jobIds.has(job.id) || jobIds.has(job.upgradeForJobId));
  if (jobsToRemove.length === 0) return [];
  await cancelDownloadWorkForJobs(jobsToRemove);
  const committedPaths = new Set<string>();
  for (const job of jobsToRemove) {
    const completedJob = downloadTracker.getJob(job.id);
    if (completedJob?.finalPath) {
      committedPaths.add(completedJob.finalPath);
    }
    downloadTracker.removeJob(job.id);
  }
  try {
    await removePlaylistTracksWithoutDownloads();
  } catch (error) {
    const failure = asAppError(error);
    logger.warn("library", "Could not remove deleted tracks from playlists", {
      message: failure?.message || String(error),
    });
  }
  return [...committedPaths];
}

async function deleteAurralLibraryFiles(paths: string[]) {
  const folders = { downloadRoot: resolveDownloadRoot(), readOnlyRoots: readOnlyFolderPaths() };
  const deletablePaths = new Set(
    paths
      .filter((filePath) => libraryFolderOwner(filePath, folders) === "aurral")
      .map((filePath) => path.resolve(filePath)),
  );
  const deletionResults = await Promise.allSettled(
    paths.map(async (filePath) => {
      if (deletablePaths.has(path.resolve(filePath))) {
        try {
          await fsp.unlink(filePath);
        } catch (error) {
          if (asAppError(error)?.code !== "ENOENT") throw error;
        }
      }
      return filePath;
    }),
  );
  const reconciledPaths = deletionResults
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);
  if (reconciledPaths.length > 0) {
    markLibraryMediaFilesUnavailable("aurral", reconciledPaths);
  }
  const removedPaths = new Set(
    reconciledPaths
      .map((filePath) => path.resolve(filePath))
      .filter((filePath) => deletablePaths.has(filePath)),
  );
  await dropDownloadJobs(
    new Set(
      downloadTracker
        .getAll()
        .filter(
          (job) =>
            job.status === "done" &&
            typeof job.finalPath === "string" &&
            removedPaths.has(path.resolve(job.finalPath)),
        )
        .map((job) => job.id),
    ),
  );
  const emptiedFolders = new Set<string>();
  for (const filePath of reconciledPaths) {
    if (libraryFolderOwner(filePath, folders) !== "aurral") continue;
    if (
      await fsp.access(filePath).then(
        () => true,
        () => false,
      )
    )
      continue;
    await removeSidecars(filePath).catch(() => {});
    emptiedFolders.add(path.dirname(filePath));
  }
  for (const folder of emptiedFolders) {
    await removeEmptiedFolder(folder, folders.downloadRoot).catch(() => {});
  }
  const rejected = deletionResults.find((result) => result.status === "rejected");
  return rejected ? (asAppError(rejected.reason) ?? new Error(String(rejected.reason))) : null;
}

export function getCachedArtistCount() {
  return getLibraryArtistProjection({ pageSize: 10000 }).length;
}

export function buildPlaybackQueueFromLibrary({
  artists = [],
  albums = [],
  tracks = [],
}: {
  artists?: Pick<LibraryArtistRecord, "id" | "name">[];
  albums?: LibraryAlbumRecord[];
  tracks?: LibraryTrackRecord[];
} = {}) {
  const artistsById = new Map(artists.map((artist) => [artist.id, artist]));
  const tracksById = new Map(tracks.map((track) => [track.id, track]));
  const queue = [];

  for (const album of albums) {
    const artist = artistsById.get(album.artistId);
    for (const trackId of album.trackIds || []) {
      const track = tracksById.get(trackId);
      if (!track) continue;
      const file = selectCanonicalFile(track.files, album.id, album.managed);
      if (!file?.available) continue;
      const relation = (track.albums || []).find((entry) => entry.albumId === album.id);
      queue.push({
        id: `lib-${album.artistId}-${album.id}-${track.id}`,
        title: track.title || "Unknown Track",
        artist: track.artistName || artist?.name || "Unknown Artist",
        album: album.title || "Unknown Album",
        streamPath: `/library/stream/${encodeURIComponent(album.id)}/${encodeURIComponent(track.id)}`,
        streamFormat: file.format || null,
        quality: file.quality?.quality?.name || file.quality?.audioFormat || null,
        trackNumber: relation?.trackNumber || 0,
      });
    }
  }

  return queue.sort(
    (left, right) =>
      left.artist.localeCompare(right.artist) ||
      left.album.localeCompare(right.album) ||
      left.trackNumber - right.trackNumber,
  );
}

export class LibraryManager {
  async _addArtist(mbid: string, artistName: string, options: ArtistAddOptions = {}) {
    const normalizedMbid = String(mbid || "").trim();
    const requestedName = String(artistName || "").trim();
    if (!normalizedMbid || !requestedName) {
      return { error: "artist MBID and name are required", statusCode: 400 };
    }

    const existing = libraryArtistFallback(normalizedMbid);
    const resolvedMonitoring = resolveMonitoringRequest(options.monitoring);
    if (resolvedMonitoring.error) return resolvedMonitoring;
    if (existing) {
      if (!existing.managed) {
        setLibraryManagement({
          entityKind: "artist",
          entityId: existing.id,
          monitorMode: "none",
        });
      }
      scheduleReleaseMetadataRefresh();
      return libraryArtistFallback(existing.id) || existing;
    }

    let metadata = null;
    try {
      metadata = await metadataLookups.add(() => getMetadataArtistByMbid(normalizedMbid));
    } catch (error) {
      const failure = asAppError(error);
      logger.warn("library", "Aurral artist metadata lookup failed", {
        mbid: normalizedMbid,
        message: failure?.message || String(error),
      });
    }
    if (metadata?.id && String(metadata.id).trim().toLowerCase() !== normalizedMbid.toLowerCase()) {
      return {
        error: "Artist metadata does not unambiguously identify the requested artist",
        statusCode: 422,
        code: "ambiguous_identity",
      };
    }
    const name = String(metadata?.name || requestedName).trim();
    if (!name) {
      const error: CodedError = new Error("Could not resolve an unambiguous artist identity");
      error.statusCode = 422;
      error.code = "ambiguous_identity";
      return { error: error.message, statusCode: error.statusCode, code: error.code };
    }

    const artist = upsertLibraryArtist({
      identityKey: buildIdentityKey("mbid", normalizedMbid),
      mbid: normalizedMbid,
      name,
      sortName: metadata?.sortName || name,
      metadata: {
        ...(metadata || {}),
        id: normalizedMbid,
        foreignArtistId: normalizedMbid,
        librarySource: "aurral",
        added: new Date().toISOString(),
        monitored: false,
      },
    });
    setLibraryManagement({
      entityKind: "artist",
      entityId: artist.id,
      monitorMode: "none",
    });
    scheduleReleaseMetadataRefresh();
    announceArtistAdded(name, options);
    return (
      libraryArtistFallback(artist.id) ?? {
        error: "Artist was added but could not be read back",
        statusCode: 500,
      }
    );
  }

  async addArtist(mbid: string, artistName: string, options: ArtistAddOptions = {}) {
    const artist: MethodResult<"_addArtist"> = await this._addArtist(mbid, artistName, options);
    if (artist?.error || options.albumOnly) return artist;
    const { request } = resolveMonitoringRequest(options.monitoring);
    return request ? this.applyArtistMonitoring(mbid, request) : artist;
  }

  getArtist(reference: unknown) {
    return libraryArtistFallback(reference);
  }

  async deleteArtist(reference: string, deleteFiles = false): Promise<LibraryDeletion> {
    const artist = /^\d+$/.test(reference)
      ? getLibraryArtistProjection({ reference: Number(reference) }).find(
          (entry) => Number(entry.id) === Number(reference),
        )
      : libraryArtistFallback(reference);
    if (!artist)
      return { success: false, error: "Artist not found in your library", statusCode: 404 };
    return this._deleteArtist(artist, deleteFiles);
  }

  async _finishAlbum(albumReference: string | number, options: AlbumAddOptions = {}) {
    const library = libraryForAlbum(albumReference);
    const album = library.albums[0];
    if (!album) {
      return { error: "Album was not found in the library", statusCode: 404 };
    }
    if (
      options.monitoringToken &&
      !this._canAcquireMonitoredAlbum(
        options.artistMbid,
        album.releaseGroupMbid || album.mbid,
        options.monitoringToken,
      )
    ) {
      return { status: "skipped" };
    }

    const artist = library.artists.find((entry) => entry.id === album.artistId);
    const mappedAlbum = mapLibraryAlbum(album, artist, library.tracks);
    const albumMbid = album.releaseGroupMbid || album.mbid || null;
    const albumTracks = library.tracks.filter((track) => album.trackIds.includes(track.id));
    let albumJobs = findAlbumJobs(albumJobKeys(album));
    const requestGroupId =
      options.requestGroupId ||
      albumJobs.find((job) => job.requestGroupId)?.requestGroupId ||
      randomUUID();
    const albumTrackTitles = albumTracks.map((track) => track.title).filter(Boolean);
    const releaseMbid = album.metadata?.requestedRelease || null;
    const requestedTrackIds = Array.isArray(options.trackIds)
      ? new Set(options.trackIds.map(Number))
      : null;
    const requestKind = requestedTrackIds ? "track" : "album";
    // A job kept from an earlier request asks for the edition asked for now.
    // One it restarts is the kind of request asked for now, and a queued job
    // a whole-album request covers becomes part of it.
    const askForEdition = (job: DownloadJob, { restarted = true } = {}) => {
      if (releaseMbid && job.releaseMbid !== releaseMbid)
        downloadTracker.updateMetadata(job.id, { releaseMbid });
      if (restarted || requestKind === "album") downloadTracker.setRequestKind(job.id, requestKind);
    };
    const compilation = isVariousArtistsCredit(artist?.name, artist?.mbid);
    // A compilation track's job keeps the album's "Various Artists" credit,
    // which tags and media servers group the album by, and matches files by
    // the track's own artist under any of its names, such as "The Jackson 5"
    // for "The Jacksons".
    const artistAliasesFor = (track: LibraryTrackRecord) =>
      compilation
        ? [...new Set([track.artistName, ...(track.metadata?.artistAliases || [])])].filter(
            (name): name is string => Boolean(name && !isVariousArtistsCredit(name)),
          )
        : storedStringList(artist?.metadata?.aliases);
    const missingTracks = albumTracks.filter(
      (track) =>
        track.available !== true &&
        track.monitored !== false &&
        (!requestedTrackIds || requestedTrackIds.has(Number(track.id))),
    );
    const sourceConfigured = isAnyDownloadSourceConfigured();
    const jobIds = [];
    const trackedJobIds = [];
    let blockedTracks = 0;
    const canChangeJobs = () =>
      !options.monitoringToken ||
      this._canAcquireMonitoredAlbum(options.artistMbid, albumMbid, options.monitoringToken);
    const applyJobChange = <Value>(change: () => Value, trackId: number) => {
      const result = db
        .transaction(() => {
          if (!canChangeJobs()) return { skipped: true };
          return isMonitoredTrack(trackId) ? { value: change() } : { trackSkipped: true };
        })
        .immediate();
      albumJobs = findAlbumJobs(albumJobKeys(album));
      return result;
    };

    for (const track of isUnreleased(album.releaseDate) ? [] : missingTracks) {
      if (
        options.monitoringToken &&
        !this._canAcquireMonitoredAlbum(
          options.artistMbid,
          album.releaseGroupMbid || album.mbid,
          options.monitoringToken,
        )
      ) {
        return { status: "skipped" };
      }
      const relation = (track.albums || []).find((entry) => entry.albumId === album.id);
      const matchingJobs = albumJobs.filter((job) => jobMatchesTrack(job, track));
      const activeJob = matchingJobs.find(
        (job) =>
          job.status === "pending" ||
          job.status === "downloading" ||
          job.status === "cancel_requested",
      );
      if (activeJob) {
        askForEdition(activeJob, { restarted: false });
        trackedJobIds.push(activeJob.id);
        continue;
      }
      if (options.skipCancelledTracks && matchingJobs.at(-1)?.status === "cancelled") continue;

      const completedJob = matchingJobs.find((job) => job.status === "done");
      if (completedJob) {
        const stat = completedJob.finalPath
          ? await fsp.stat(completedJob.finalPath).catch(() => null)
          : null;
        if (stat?.isFile()) {
          trackedJobIds.push(completedJob.id);
          scheduleLibraryScan({
            includeReadOnly: false,
            changedPaths: [completedJob.finalPath!],
          });
          continue;
        }
        if (
          options.monitoringToken &&
          !this._canAcquireMonitoredAlbum(
            options.artistMbid,
            album.releaseGroupMbid || album.mbid,
            options.monitoringToken,
          )
        ) {
          return { status: "skipped" };
        }
        if (!sourceConfigured) {
          if (
            applyJobChange(
              () => downloadTracker.setFailed(completedJob.id, "Completed file is missing"),
              track.id,
            ).skipped
          ) {
            return { status: "skipped" };
          }
          continue;
        }
        const retriedCompletedJob = applyJobChange(() => {
          askForEdition(completedJob);
          return downloadTracker.setPending(completedJob.id, "Completed file is missing", {
            asRetryCycle: true,
          });
        }, track.id);
        if (retriedCompletedJob.skipped) return { status: "skipped" };
        if (retriedCompletedJob.value) {
          jobIds.push(completedJob.id);
          trackedJobIds.push(completedJob.id);
        }
        continue;
      }

      if (!sourceConfigured) continue;

      const retryJob = matchingJobs.find(
        (job) =>
          job.status === "failed" || (!options.skipCancelledTracks && job.status === "cancelled"),
      );
      if (retryJob) {
        const retriedJob = applyJobChange(() => {
          restoreDownloadJobCancellations([retryJob.id]);
          askForEdition(retryJob);
          return downloadTracker.setPending(retryJob.id, "Retrying missing Aurral album track", {
            asRetryCycle: true,
          });
        }, track.id);
        if (retriedJob.skipped) return { status: "skipped" };
        if (retriedJob.value) {
          jobIds.push(retryJob.id);
          trackedJobIds.push(retryJob.id);
        }
        continue;
      }

      if (matchingJobs.some((job) => job.status === "blocked")) {
        blockedTracks += 1;
        continue;
      }

      const queuedJob = applyJobChange(
        () =>
          downloadTracker.addJob(
            {
              artistName: artist?.name || album.albumArtist || "Unknown Artist",
              trackName: track.title,
              albumName: album.title,
              artistMbid: artist?.mbid || null,
              albumMbid,
              releaseMbid,
              trackMbid: track.mbid || null,
              releaseYear: album.releaseDate ? String(album.releaseDate).slice(0, 4) : null,
              durationMs: track.metadata?.durationMs,
              trackNumber: relation?.trackNumber || 0,
              discNumber: relation?.discNumber || null,
              albumTrackCount: albumTracks.length,
              albumTrackTitles,
              artistAliases: artistAliasesFor(track),
              requestGroupId,
              reason: "Aurral album request",
            },
            "library",
            { requestKind },
          ),
        track.id,
      );
      if (queuedJob.skipped) return { status: "skipped" };
      const jobId = queuedJob.value;
      if (jobId) {
        jobIds.push(jobId);
        trackedJobIds.push(jobId);
      }
    }

    const uniqueTrackedJobIds = [...new Set(trackedJobIds)];
    for (const job of albumJobs) {
      if (
        job.startedByPlaylist &&
        albumTracks.some(
          (track) =>
            (!requestedTrackIds || requestedTrackIds.has(Number(track.id))) &&
            jobMatchesTrack(job, track),
        )
      )
        downloadTracker.setStartedByPlaylist(job.id, null);
    }
    const hasActiveJob = uniqueTrackedJobIds.some((jobId) => {
      const status = downloadTracker.getJob(jobId)?.status;
      return status === "pending" || status === "downloading";
    });
    if (hasActiveJob) {
      for (const jobId of jobIds) {
        const job = downloadTracker.getJob(jobId);
        if (job) recordTrackJobQueued(job, options.user);
      }
    }

    const available = mappedAlbum.statistics.percentOfTracks >= 100;
    return {
      ...mappedAlbum,
      jobIds: uniqueTrackedJobIds,
      requestGroupId: uniqueTrackedJobIds.length > 0 ? requestGroupId : null,
      missingTrackCount: missingTracks.length,
      queuedTrackCount: jobIds.length,
      blockedTrackCount: blockedTracks,
      albumStatus: this._summarizeAlbum(album, library.tracks),
      status: available
        ? "available"
        : uniqueTrackedJobIds.length > 0
          ? "queued"
          : blockedTracks > 0 || (!sourceConfigured && missingTracks.length > 0)
            ? "blocked"
            : "inLibrary",
    };
  }

  async _releaseTracks(releaseGroupMbid: string, edition: string | null | undefined) {
    const album = await metadataLookups.add(() => getMetadataAlbumByMbid(releaseGroupMbid));
    const release = selectAlbumRelease(album, { edition });
    return (Array.isArray(release?.tracks) ? release.tracks : [])
      .map((track) => ({
        recording: String(track?.recordingId || track?.id || "").trim(),
        title: String(track?.title || "").trim(),
      }))
      .filter((track) => track.recording && !isSilenceTrack(track.title));
  }

  // A release other than a studio album is skipped when every recording on it
  // is already in the Library or on a release this plan downloads, such as a
  // single that the album also has.
  async planArtistMonitoring(artist: MonitoringArtist, effective: ArtistMonitoring) {
    const plan: MonitoringPlan & NoError = {
      releases: [],
      topTracks: [],
      skipped: [],
      skippedTracks: [],
      topTracksError: null,
    };
    if (!effective || !artist?.mbid) return plan;
    const { rules } = effective;
    let releases: Awaited<ReturnType<typeof listArtistReleases>> = [];
    if (rules.catalog !== "none" || rules.newReleases) {
      try {
        releases = await listArtistReleases(artist.mbid);
      } catch (error) {
        const failure = asAppError(error);
        logger.warn("library", "Aurral monitoring could not load artist releases", {
          artistMbid: artist.mbid,
          message: failure?.message || String(error),
        });
        return {
          error: "Artist releases are unavailable; monitoring was not changed",
          statusCode: 503,
          code: "metadata_unavailable",
        } as const;
      }
    }
    const exclusions = indexArtistExclusions(artist.mbid);
    const skip = (release: AurralRelease, reason: ReleaseSkipReason) =>
      plan.skipped.push({ releaseGroupId: release.id, title: release.title, reason });
    const candidates = [];
    for (const release of selectMonitoredReleases(releases, rules, effective)) {
      const existing = libraryAlbumForReference(release.id);
      const override = existing ? getLibraryManagementEntry("album", Number(existing.id)) : null;
      if (exclusions.isAlbumExcluded(release.id)) skip(release, "excluded");
      else if (override?.monitorMode === "unmonitored") skip(release, "unmonitored");
      else if (existing && existing.statistics.percentOfTracks >= 100) {
        if (rules.edition === "expanded" && !this.albumWantsExpandedEdition(release.id)) {
          candidates.push({ release, existing: true, complete: true });
        } else skip(release, "complete");
      } else candidates.push({ release, existing: Boolean(existing) });
    }
    const needsTracklists =
      rules.topTracks > 0 || candidates.some(({ release }) => !isStudioAlbum(release));
    const plannedRecordings = new Set<string>();
    const plannedTitles = new Set<string>();
    for (const { release, existing, complete } of candidates) {
      const studioAlbum = isStudioAlbum(release);
      let tracks: { recording: string; title: string }[] = [];
      if (needsTracklists || complete) {
        try {
          tracks = await this._releaseTracks(release.id, rules.edition);
        } catch (error) {
          if (complete || !studioAlbum) {
            skip(release, "metadata_unavailable");
            continue;
          }
        }
      }
      if (complete) {
        const linked = new Set(libraryTracksForAlbum(release.id).map((track) => track.mbid));
        if (tracks.every(({ recording }) => linked.has(recording))) {
          skip(release, "complete");
          continue;
        }
      }
      const covered =
        !studioAlbum &&
        tracks.length > 0 &&
        tracks.every(
          ({ recording }) =>
            plannedRecordings.has(recording) || recordingElsewhereStmt.get(recording, release.id),
        );
      if (covered) {
        skip(release, "covered");
        continue;
      }
      for (const track of tracks) {
        plannedRecordings.add(track.recording);
        plannedTitles.add(getNormalizedText(track.title));
      }
      plan.releases.push({
        id: release.id,
        title: release.title,
        type: release.type || null,
        secondaryTypes: release.secondaryTypes || [],
        releaseDate: release.firstReleaseDate || null,
        existing,
      });
    }
    if (rules.topTracks > 0)
      await this._planTopTracks(artist, rules, plan, { exclusions, plannedTitles });
    return plan;
  }

  async _planTopTracks(
    artist: MonitoringArtist,
    rules: MonitorRules,
    plan: MonitoringPlan,
    {
      exclusions,
      plannedTitles,
    }: { exclusions: ReturnType<typeof indexArtistExclusions>; plannedTitles: Set<string> },
  ) {
    let entries;
    try {
      entries = await getArtistTopTracks(
        { name: artist.name, mbid: artist.mbid },
        { limit: rules.topTracks },
      );
    } catch (error) {
      const failure = asAppError(error);
      logger.warn("library", "Aurral monitoring could not load top tracks", {
        artistMbid: artist.mbid,
        message: failure?.message || String(error),
      });
      plan.topTracksError = "Top tracks are unavailable right now. Aurral tries again tomorrow.";
      return;
    }
    const { findQueuedLibraryTrackJob } = await import("./libraryTrackRequests.ts");
    const seen = new Set<string>();
    for (const entry of (Array.isArray(entries) ? entries : []).slice(0, rules.topTracks)) {
      const title = String(entry?.name || "").trim();
      const key = getNormalizedText(title);
      if (!title || seen.has(key)) continue;
      seen.add(key);
      const mbid = String(entry.mbid || "").trim() || null;
      const byTitle = { artistName: artist.name, trackName: title };
      const reason = exclusions.isTrackExcluded({ mbid, title })
        ? "excluded"
        : (mbid && getLibraryTrackOwnership({ ...byTitle, trackMbid: mbid })) ||
            getLibraryTrackOwnership(byTitle)
          ? "in_library"
          : plannedTitles.has(key)
            ? "on_release"
            : (mbid && findQueuedLibraryTrackJob({ ...byTitle, trackMbid: mbid })) ||
                findQueuedLibraryTrackJob(byTitle)
              ? "queued"
              : null;
      if (reason) plan.skippedTracks.push({ title, reason });
      else {
        plan.topTracks.push({
          title,
          albumName: String(entry.albumName || "").trim() || null,
          mbid,
          durationMs: Number(entry.durationMs) || null,
        });
      }
    }
  }

  _enqueueMonitoringApply(
    artist: MonitoringArtist,
    effective: ArtistMonitoring,
    plan: MonitoringPlan,
  ) {
    if (!plan.releases.length && !plan.topTracks.length) return false;
    enqueueSystemTask({
      kind: "aurral-monitoring-apply",
      artistMbid: artist.mbid,
      token: monitoringToken(effective),
      releaseGroups: plan.releases.map(({ id, title }) => ({ id, title })),
      topTracks: plan.topTracks,
    });
    return true;
  }

  getArtistMonitoring(mbid: string) {
    const artist = libraryArtistFallback(mbid);
    const defaults = getMonitoringDefaults();
    const effective = artist?.managed ? readArtistMonitoring(Number(artist.id), defaults) : null;
    return { added: Boolean(artist), ...describeMonitoring(effective, defaults) };
  }

  async setArtistMonitoring(
    mbid: string,
    {
      monitoring,
      artistName = null,
      user = null,
    }: {
      monitoring?: MonitoringInput | null;
      artistName?: string | null;
      user?: LibraryUser;
    } = {},
  ) {
    const artist = libraryArtistFallback(mbid);
    const resolved = resolveMonitoringRequest(monitoring);
    if (resolved.error) return resolved;
    if (!resolved.request && !artist?.managed) {
      return { ...(artist || { mbid }), monitored: false };
    }
    if (!artist) {
      if (!hasPermission(user, "addArtist")) {
        return { error: "Permission required: addArtist", statusCode: 403, code: "forbidden" };
      }
      const name = String(artistName || "").trim();
      const created: MethodResult<"_addArtist"> = await this._addArtist(mbid, name, { user });
      if (created?.error) return created;
    }
    return this.applyArtistMonitoring(mbid, resolved.request);
  }

  async applyArtistMonitoring(mbid: string, request: MonitoringRequest | null) {
    const artist = libraryArtistFallback(mbid);
    if (!artist) {
      return { error: "Artist not found in the library", statusCode: 404 };
    }
    return serializeMonitoringUpdate(_artistMonitoringUpdates, Number(artist.id), async () => {
      const currentArtist = libraryArtistFallback(artist.id);
      if (!currentArtist) return { error: "Artist not found in the library", statusCode: 404 };
      const artistId = Number(currentArtist.id);
      const defaults = getMonitoringDefaults();
      const previous = currentArtist.managed ? readArtistMonitoring(artistId, defaults) : null;
      const stored = request ? nextArtistMonitoring(previous, request, defaults) : null;
      const effective = resolveArtistMonitoring(stored, defaults);
      const plan = await this.planArtistMonitoring(currentArtist, effective);
      if (plan.error) return plan;
      db.transaction(() => this._storeArtistMonitoring(artistId, stored, defaults)).immediate();
      const queued = this._enqueueMonitoringApply(currentArtist, effective, plan);
      return {
        ...(libraryArtistFallback(artistId) || currentArtist),
        ...describeMonitoring(effective, defaults),
        monitoring: summarizeMonitoringPlan(plan, queued),
      };
    });
  }

  _storeArtistMonitoring(
    artistId: number,
    stored: ReturnType<typeof nextArtistMonitoring> | null,
    defaults: MonitoringDefaultsState,
  ) {
    const effective = resolveArtistMonitoring(stored, defaults);
    const artist = db
      .prepare<
        [number],
        Pick<LibraryArtistsRow, "identity_key" | "mbid" | "name" | "metadata_json">
      >("SELECT identity_key, mbid, name, metadata_json FROM library_artists WHERE id = ?")
      .get(artistId)!;
    const metadata = readRawLibraryMetadata(artist.metadata_json);
    const startsMonitoring = Boolean(stored) && !getStoredArtistMonitoring(artistId);
    setArtistMonitoringState(artistId, stored, defaults);
    upsertLibraryArtist({
      identityKey: artist.identity_key,
      mbid: artist.mbid,
      name: artist.name,
      metadata: {
        ...metadata,
        ...(startsMonitoring && { added: new Date().toISOString() }),
        monitored: Boolean(stored),
        monitorStartedAt: effective?.newSince ?? null,
      },
    });
  }

  async previewArtistMonitoring(
    mbid: string,
    {
      monitoring,
      artistName = null,
    }: { monitoring?: MonitoringInput | null; artistName?: string | null } = {},
  ) {
    const resolved = resolveMonitoringRequest(monitoring);
    if (resolved.error) return resolved;
    const artist = libraryArtistFallback(mbid);
    const defaults = getMonitoringDefaults();
    const previous = artist?.managed ? readArtistMonitoring(Number(artist.id), defaults) : null;
    const stored = resolved.request
      ? nextArtistMonitoring(previous, resolved.request, defaults)
      : null;
    const effective = resolveArtistMonitoring(stored, defaults);
    const plan = await this.planArtistMonitoring(
      artist || { mbid, name: String(artistName || "").trim() },
      effective,
    );
    if (plan.error) return plan;
    return {
      ...describeMonitoring(effective, defaults),
      monitoring: summarizeMonitoringPlan(plan, false),
    };
  }

  _defaultMonitoringArtists() {
    return [...getManagementMap("artist").entries()].filter(
      ([, entry]) => entry.monitorRules?.default === true,
    );
  }

  getMonitoringDefaultsState() {
    const defaults = getMonitoringDefaults();
    return {
      rules: defaults.rules,
      updatedAt: defaults.updatedAt || null,
      artistCount: this._defaultMonitoringArtists().length,
    };
  }

  async previewMonitoringDefaults(rules: unknown) {
    const normalized = normalizeMonitorRules(rules);
    if (normalized.error) return normalized;
    const next = nextMonitoringDefaults(getMonitoringDefaults(), normalized.rules);
    const artists = this._defaultMonitoringArtists();
    const preview = {
      rules: normalized.rules,
      artistCount: artists.length,
      releaseCount: 0,
      trackCount: 0,
      failedArtistCount: 0,
    };
    if (next.updatedAt === getMonitoringDefaults().updatedAt) return preview;
    await mapWithConcurrency(artists, 4, async ([artistId, entry]: DefaultMonitoringArtist) => {
      const artist = libraryArtistFallback(artistId);
      if (!artist?.mbid) return;
      const plan = await this.planArtistMonitoring(
        artist,
        resolveArtistMonitoring(entry.monitorRules, next),
      );
      if (plan.error) {
        preview.failedArtistCount += 1;
        return;
      }
      preview.releaseCount += plan.releases.filter((release) => !release.existing).length;
      preview.trackCount += plan.topTracks.length;
    });
    return preview;
  }

  setMonitoringDefaults(rules: unknown) {
    const normalized = normalizeMonitorRules(rules);
    if (normalized.error) return normalized;
    const previous = getMonitoringDefaults();
    const next = nextMonitoringDefaults(previous, normalized.rules);
    if (next !== previous) {
      db.transaction(() => {
        saveMonitoringDefaults(next);
        for (const [artistId, entry] of this._defaultMonitoringArtists()) {
          setArtistMonitoringState(artistId, entry.monitorRules, next);
        }
      }).immediate();
      enqueueSystemTask({ kind: "aurral-monitoring-reconcile" });
    }
    return this.getMonitoringDefaultsState();
  }

  listMonitoringExclusions(options: Parameters<typeof listMonitoringExclusions>[0]) {
    return listMonitoringExclusions(options);
  }

  albumWantsExpandedEdition(albumMbid: string) {
    return libraryForAlbum(albumMbid).albums[0]?.metadata?.edition === "expanded";
  }

  _albumEdition(artist: LibraryArtistProjection | null) {
    const effective = artist ? readArtistMonitoring(Number(artist.id)) : null;
    return (effective?.rules || getMonitoringDefaults().rules).edition;
  }

  _canAcquireMonitoredAlbum(
    artistMbid: string | null | undefined,
    albumMbid: string | null | undefined,
    expectedToken: string | null = null,
  ) {
    const artist = libraryArtistFallback(artistMbid);
    const effective = artist ? readArtistMonitoring(Number(artist.id)) : null;
    if (!effective) return false;
    if (expectedToken && monitoringToken(effective) !== expectedToken) return false;
    if (isAlbumMonitoringExcluded(albumMbid)) return false;
    const album = libraryAlbumForReference(albumMbid);
    const albumState = album && getLibraryManagementEntry("album", Number(album.id));
    return albumState?.monitorMode !== "unmonitored";
  }

  async acquireReleases({
    artistMbid,
    releaseGroups = [],
    topTracks = [],
    token = null,
  }: {
    artistMbid?: string;
    releaseGroups?: Pick<PlannedRelease, "id" | "title">[];
    topTracks?: PlannedTopTrack[];
    token?: string | null;
  } = {}) {
    const results = [];
    const artist = libraryArtistFallback(artistMbid);
    const effective = artist ? readArtistMonitoring(Number(artist.id)) : null;
    const expectedToken = token || monitoringToken(effective);
    for (const release of releaseGroups) {
      if (!this._canAcquireMonitoredAlbum(artistMbid, release.id, expectedToken)) {
        results.push({ releaseGroupId: release.id, status: "skipped" });
        continue;
      }
      try {
        const album: MethodResult<"_addAlbum"> = await this._addAlbum(
          artistMbid,
          release.id,
          release.title,
          {
            artistMbid,
            monitoringToken: expectedToken,
            edition: effective?.rules.edition,
          },
        );
        if (album?.error) {
          logger.warn("library", "Aurral monitoring could not acquire an album", {
            artistMbid,
            releaseGroupId: release.id,
            message: album.error,
          });
        }
        results.push({
          releaseGroupId: release.id,
          status: album?.error ? "failed" : album.albumStatus?.status || album.status,
        });
      } catch (error) {
        const failure = asAppError(error);
        logger.warn("library", "Aurral monitoring could not acquire an album", {
          artistMbid,
          releaseGroupId: release.id,
          message: failure?.message || String(error),
        });
        results.push({ releaseGroupId: release.id, status: "failed" });
      }
    }
    if (artist && topTracks.length > 0)
      await this._acquireTopTracks(artist, topTracks, expectedToken);
    return results;
  }

  async _acquireTopTracks(
    artist: LibraryArtistProjection,
    topTracks: PlannedTopTrack[],
    token: string | null,
  ) {
    const { requestLibraryTrack } = await import("./libraryTrackRequests.ts");
    const exclusions = indexArtistExclusions(artist.mbid);
    for (const track of topTracks) {
      if (monitoringToken(readArtistMonitoring(Number(artist.id))) !== token) return;
      if (exclusions.isTrackExcluded(track)) continue;
      try {
        await requestLibraryTrack(
          {
            artistName: artist.name,
            trackName: track.title,
            albumName: track.albumName || null,
            artistMbid: artist.mbid,
            trackMbid: track.mbid || null,
            durationMs: track.durationMs || undefined,
          },
          { automatic: true },
        );
      } catch (error) {
        const failure = asAppError(error);
        logger.warn("library", "Aurral monitoring could not queue a top track", {
          artistMbid: artist.mbid,
          title: track.title,
          message: failure?.message || String(error),
        });
      }
    }
  }

  async reconcileMonitoring() {
    const defaults = getMonitoringDefaults();
    const monitoredArtists = [...getManagementMap("artist").entries()].filter(
      ([, entry]) => entry.monitorRules,
    );
    let queuedAlbums = 0;
    let queuedTracks = 0;
    let failedArtists = 0;
    for (const [artistId, entry] of monitoredArtists) {
      const artist = libraryArtistFallback(artistId);
      if (!artist?.mbid) continue;
      const effective = resolveArtistMonitoring(entry.monitorRules, defaults);
      const plan = await this.planArtistMonitoring(artist, effective);
      if (plan.error) {
        failedArtists += 1;
        continue;
      }
      const newReleases = plan.releases.filter((release) => !release.existing);
      const topTracks = plan.topTracks || [];
      if (newReleases.length === 0 && topTracks.length === 0) continue;
      await this.acquireReleases({
        artistMbid: artist.mbid,
        releaseGroups: newReleases,
        topTracks,
        token: monitoringToken(effective),
      });
      queuedAlbums += newReleases.length;
      queuedTracks += topTracks.length;
    }
    logger.info("library", "Aurral monitoring reconciliation finished", {
      artists: monitoredArtists.length,
      queuedAlbums,
      queuedTracks,
      failedArtists,
    });
    return { artists: monitoredArtists.length, queuedAlbums, queuedTracks, failedArtists };
  }

  _resolveAlbum(canonicalId: unknown) {
    const reference = String(canonicalId ?? "").trim();
    const id = Number(reference);
    if (!/^\d+$/.test(reference) || !Number.isSafeInteger(id) || id <= 0) {
      return {
        error: "Album ID must be a positive integer",
        statusCode: 400,
        code: "invalid_canonical_id",
      };
    }
    const library = libraryForAlbum(id);
    const album = library.albums.find((entry) => entry.id === id);
    if (!album) {
      return { error: "Album was not found in the library", statusCode: 404 };
    }
    const artist = library.artists.find((entry) => entry.id === album.artistId);
    const mappedAlbum = mapLibraryAlbum(album, artist, library.tracks);
    if (!mappedAlbum.managed) {
      return albumConflict("Aurral does not manage this album");
    }
    return { album, artist, library, mappedAlbum };
  }

  _summarizeAlbum(
    album: LibraryAlbumRecord,
    tracks: LibraryTrackRecord[],
    jobsForAlbum: typeof findAlbumJobs = findAlbumJobs,
  ) {
    const sourceConfigured = isAnyDownloadSourceConfigured();
    return {
      releaseDate: album.releaseDate || null,
      ...summarizeAlbum({
        tracks: tracks.filter((track) => album.trackIds.includes(track.id)),
        jobs: jobsForAlbum(albumJobKeys(album)),
        unreleased: isUnreleased(album.releaseDate),
        sourceConfigured,
        sourceMessage: sourceConfigured ? null : getDownloadSourceNotConfiguredMessage(),
      }),
    };
  }

  async setAlbumMonitoring(canonicalId: unknown, { monitored }: { monitored?: unknown } = {}) {
    if (typeof monitored !== "boolean") {
      return {
        error: "monitored must be true or false",
        statusCode: 400,
        code: "invalid_monitored",
      };
    }
    return serializeMonitoringUpdate(_albumMonitoringUpdates, Number(canonicalId), async () => {
      const resolved = this._resolveAlbum(canonicalId);
      if (failed(resolved)) return resolved;
      const { album, mappedAlbum } = resolved;
      this._setAlbumMonitored(album, monitored);
      if (monitored) {
        const albumMbid = album.releaseGroupMbid || album.mbid;
        clearAlbumMonitoringExclusion(albumMbid);
        const result =
          albumMbid && album.metadata?.trackListComplete !== true
            ? await this._addAlbum(album.artistId, albumMbid, album.title)
            : await this._finishAlbum(album.id);
        if (result?.error) return result;
        return { ...result, monitored: true };
      }
      const cancellation = await cancelAlbumJobs(albumJobKeys(album));
      return {
        ...mappedAlbum,
        monitored: false,
        ...cancellation,
        albumStatus: this.getAlbumStatus(album.id),
      };
    });
  }

  _setAlbumMonitored(album: LibraryAlbumRecord, monitored: boolean) {
    db.transaction(() => {
      setLibraryManagement({
        entityKind: "album",
        entityId: album.id,
        monitorMode: monitored ? "monitored" : "unmonitored",
      });
      upsertLibraryAlbum({
        identityKey: album.identityKey,
        artistId: album.artistId,
        title: album.title,
        metadata: { ...album.metadata, monitored },
      });
      setAlbumTracksMonitoredStmt.run(monitored ? 1 : 0, album.id);
    }).immediate();
    invalidateLibraryQueryCache({ persistedGenres: false });
  }

  getAlbumStatus(canonicalId: string | number) {
    const [status] = this.getAlbumStatuses([canonicalId]);
    return status ?? { error: "Album was not found in the library", statusCode: 404 };
  }

  getAlbumStatuses(canonicalIds: (string | number)[]) {
    const resolved = canonicalIds.map((canonicalId) => this._resolveAlbum(canonicalId));
    const jobsForAlbum = indexAlbumJobs(
      resolved.flatMap((entry) => (failed(entry) ? [] : albumJobKeys(entry.album))),
    );
    return resolved.map((entry) =>
      failed(entry)
        ? entry
        : {
            libraryId: entry.mappedAlbum.id,
            ...this._summarizeAlbum(entry.album, entry.library.tracks, jobsForAlbum),
          },
    );
  }

  async setTrackMonitoring(
    canonicalId: unknown,
    { monitored, albumMbid = null }: { monitored?: unknown; albumMbid?: string | null } = {},
  ) {
    if (typeof monitored !== "boolean") {
      return {
        error: "monitored must be true or false",
        statusCode: 400,
        code: "invalid_monitored",
      } as const;
    }
    const reference = String(canonicalId ?? "").trim();
    const trackId = Number(reference);
    if (!/^\d+$/.test(reference) || !Number.isSafeInteger(trackId) || trackId <= 0) {
      return {
        error: "Track ID must be a positive integer",
        statusCode: 400,
        code: "invalid_canonical_id",
      } as const;
    }
    return serializeMonitoringUpdate(_trackMonitoringUpdates, trackId, async () => {
      const library = getLibraryForTrackIds({ ids: [trackId] });
      const track = library.tracks.find((entry) => entry.id === trackId);
      if (!track) {
        return {
          error: "Track was not found in the library",
          statusCode: 404,
          code: "not_found",
        } as const;
      }
      const managedAlbums = library.albums.filter((album) => album.managed);
      const [firstManagedAlbum] = managedAlbums;
      setTrackMonitoredStmt.run(monitored ? 1 : 0, trackId);
      invalidateLibraryQueryCache({ persistedGenres: false });
      const cancelledJobIds: string[] = [];
      const queuedJobIds: string[] = [];
      let cleanupFailed = false;
      if (!monitored) {
        const upgrades = await cancelFileUpgradeJobs(
          track.files.map((file) => file.path).filter((path): path is string => Boolean(path)),
        );
        cancelledJobIds.push(...upgrades.cancelledJobIds);
        cleanupFailed = upgrades.cleanupFailed;
      }
      if (!firstManagedAlbum) {
        if (!monitored) {
          const cancellation = await cancelLibraryTrackJobs(
            track,
            trackAlbumOwnerNames(library, track),
          );
          cancelledJobIds.push(...cancellation.cancelledJobIds);
          cleanupFailed ||= cancellation.cleanupFailed;
        }
        return {
          libraryId: String(trackId),
          monitored,
          cancelledJobIds,
          queuedJobIds,
          cleanupFailed,
          albumManaged: false,
        };
      }
      if (monitored) {
        const group = String(albumMbid || "")
          .trim()
          .toLowerCase();
        const album =
          (group &&
            managedAlbums.find((entry) =>
              albumJobKeys(entry).some((key) => String(key || "").toLowerCase() === group),
            )) ||
          managedAlbums.find((entry) => isMonitoredAlbum(entry.id)) ||
          firstManagedAlbum;
        const result: MethodResult<"_finishAlbum"> = await serializeMonitoringUpdate(
          _albumMonitoringUpdates,
          album.id,
          () => this._finishAlbum(album.id, { trackIds: [trackId] }),
        );
        queuedJobIds.push(...(result?.jobIds || []));
      } else {
        for (const album of managedAlbums) {
          const cancellation = await cancelTrackJobs(albumJobKeys(album), track);
          cancelledJobIds.push(...cancellation.cancelledJobIds);
          cleanupFailed ||= cancellation.cleanupFailed;
        }
      }
      return {
        libraryId: String(trackId),
        monitored,
        cancelledJobIds,
        queuedJobIds,
        cleanupFailed,
      };
    });
  }

  // A track asked for from an album's page goes to that album when the
  // Library holds it there.
  async monitorTrack({
    libraryTrackId = null,
    trackMbid = null,
    albumMbid = null,
  }: {
    libraryTrackId?: unknown;
    trackMbid?: string | null;
    albumMbid?: string | null;
  } = {}) {
    const mbid = String(trackMbid || "").trim();
    const group = String(albumMbid || "")
      .trim()
      .toLowerCase();
    const trackId = /^\d+$/.test(String(libraryTrackId ?? "").trim())
      ? Number(libraryTrackId)
      : (mbid &&
          ((group && trackIdByMbidOnAlbumStmt.get(mbid, group, group)?.id) ||
            trackIdByMbidStmt.get(mbid)?.id)) ||
        null;
    if (!trackId) return null;
    const result = await this.setTrackMonitoring(trackId, { monitored: true, albumMbid });
    return result?.error || result?.albumManaged === false ? null : result;
  }

  async searchAlbumMissingTracks(canonicalId: string | number) {
    const albumId = Number(canonicalId);
    return serializeMonitoringUpdate(_albumMonitoringUpdates, albumId, () =>
      this._finishAlbum(albumId, { skipCancelledTracks: true }),
    );
  }

  async cancelAlbum(canonicalId: unknown) {
    const resolved = this._resolveAlbum(canonicalId);
    if (failed(resolved)) return resolved;
    const { album, mappedAlbum } = resolved;
    const result = await cancelAlbumJobs(albumJobKeys(album));
    return {
      libraryId: mappedAlbum.id,
      ...result,
    };
  }

  async deleteAlbum(canonicalId: unknown, deleteFiles = false) {
    const resolved = this._resolveAlbum(canonicalId);
    if (failed(resolved)) return resolved;
    const { album, artist, library, mappedAlbum } = resolved;
    const artistState = getLibraryManagementEntry("artist", Number(album.artistId));
    const result = await this._removeAlbumContents(album, library, deleteFiles);
    if (result.error) return result;
    const excluded = addMonitoringExclusion({
      kind: "album",
      mbid: album.releaseGroupMbid || album.mbid,
      artistMbid: artist?.mbid,
      artistName: artist?.name,
      title: album.title,
    });
    if (!artistState) removeLibraryArtistIfEmpty(album.artistId);
    return {
      success: true,
      libraryId: mappedAlbum.id,
      excluded,
    };
  }

  async _removeAlbumContents(
    album: LibraryAlbumRecord,
    library: LibraryCollection,
    deleteFiles: boolean,
  ) {
    const tracks = library.tracks.filter((track) => album.trackIds.includes(track.id));
    let committedPaths;
    try {
      committedPaths = await removeLibraryDownloadJobs(library, tracks, {
        albumMbids: albumJobKeys(album),
      });
    } catch (error) {
      const failure = asAppError(error);
      logger.error(
        "library",
        `[LibraryManager] Failed to cancel album downloads: ${failure?.message}`,
      );
      return {
        error: "Downloads could not be cancelled, so nothing more was removed. Try again.",
        statusCode: 409,
        code: "download_cancellation_failed",
      };
    }
    const paths = [
      ...new Set([
        ...tracks.flatMap((track) =>
          track.files
            .filter((file) => file.source === "aurral" && file.path)
            .map((file) => file.path),
        ),
        ...committedPaths,
      ]),
    ];
    if (deleteFiles) {
      const error = await deleteAurralLibraryFiles(paths);
      if (error) {
        logger.error(
          "library",
          `[LibraryManager] Failed to delete Aurral album file: ${error.message}`,
        );
        return { error: error.message, statusCode: 500, code: "failed" };
      }
    } else {
      markLibraryMediaFilesUnavailable("aurral", paths);
    }
    removeLibraryAlbumTracksWithoutAvailableMedia(album.id);
    clearLibraryManagement("album", album.id);
    logger.info("library", `[LibraryManager] Removed Aurral album "${album.title}"`);
    return {};
  }

  async _deleteArtist(artist: LibraryArtistProjection, deleteFiles: boolean) {
    setLibraryManagement({
      entityKind: "artist",
      entityId: Number(artist.id),
      monitorMode: "none",
      monitorRules: null,
    });
    const library = libraryForArtist(artist.id);
    for (const album of library.albums) {
      const result = await this._removeAlbumContents(album, library, deleteFiles);
      if (result.error) {
        return {
          success: false,
          code: result.code,
          statusCode: result.statusCode,
          error: result.error,
        };
      }
    }
    clearLibraryManagement("artist", Number(artist.id));
    clearArtistMonitoringExclusions(artist.mbid);
    const remains = !removeLibraryArtistIfEmpty(artist.id);
    logger.info("library", `[LibraryManager] Removed Aurral artist "${artist.name}"`);
    return { success: true, remains };
  }

  async _addAlbum(
    artistId: string | number | undefined,
    releaseGroupMbid: string,
    albumName: string,
    options: AlbumAddOptions = {},
  ): Promise<Awaited<ReturnType<LibraryManager["_finishAlbum"]>> | AlbumConflict | Failure> {
    const normalizedAlbumMbid = String(releaseGroupMbid || "").trim();
    const artist = libraryArtistFallback(artistId);
    if (!artist) {
      return { error: "Artist not found in the library", statusCode: 404 };
    }
    if (!normalizedAlbumMbid) {
      return { error: "releaseGroupMbid is required", statusCode: 400 };
    }
    if (
      options.monitoringToken &&
      !this._canAcquireMonitoredAlbum(
        options.artistMbid,
        normalizedAlbumMbid,
        options.monitoringToken,
      )
    ) {
      return { status: "skipped" };
    }

    const existing = libraryAlbumForReference(normalizedAlbumMbid);
    if (existing && String(existing.artistId) !== String(artist.id)) {
      return albumConflict(ALBUM_OWNED_BY_DIFFERENT_ARTIST_ERROR);
    }
    const userRequest = !options.monitoringToken;
    if (userRequest) clearAlbumMonitoringExclusion(normalizedAlbumMbid);
    const wasMonitored = existing !== null && isMonitoredAlbum(existing.id);
    const existingAlbum = existing ? libraryForAlbum(existing.id).albums[0] : null;
    const tracked =
      existing && existingAlbum && (existingAlbum.trackIds?.length ?? 0) > 0
        ? { existing, existingAlbum }
        : null;
    const finishExisting = (found: NonNullable<typeof tracked>) => {
      if (userRequest && !wasMonitored) this._setAlbumMonitored(found.existingAlbum, true);
      return this._finishAlbum(found.existing.id, options);
    };
    const finishExistingOr = <Result>(error: Result) => (tracked ? finishExisting(tracked) : error);
    const edition = options.edition || this._albumEdition(artist);
    if (tracked) {
      if (!tracked.existing.managed) {
        setLibraryManagement({
          entityKind: "album",
          entityId: tracked.existing.id,
          monitorMode: options.monitorMode || null,
        });
      }
      if (
        tracked.existingAlbum.metadata?.trackListComplete === true &&
        (edition !== "expanded" || tracked.existingAlbum.metadata?.edition === "expanded")
      )
        return finishExisting(tracked);
    }

    let metadata;
    try {
      metadata = await metadataLookups.add(() => getMetadataAlbumByMbid(normalizedAlbumMbid));
    } catch (error) {
      const failure = asAppError(error);
      logger.warn("library", "Aurral album metadata lookup failed", {
        mbid: normalizedAlbumMbid,
        message: failure?.message || String(error),
      });
      return finishExistingOr({
        error: "Album metadata is unavailable; the request can be retried",
        statusCode: 503,
        code: "metadata_unavailable",
      });
    }
    if (
      options.monitoringToken &&
      !this._canAcquireMonitoredAlbum(
        options.artistMbid,
        normalizedAlbumMbid,
        options.monitoringToken,
      )
    ) {
      return { status: "skipped" };
    }
    if (
      metadata?.id &&
      String(metadata.id).trim().toLowerCase() !== normalizedAlbumMbid.toLowerCase()
    ) {
      return finishExistingOr({
        error: "Album metadata does not unambiguously identify the requested album",
        statusCode: 422,
        code: "ambiguous_identity",
      });
    }

    const providerArtists = Array.isArray(metadata?.artists) ? metadata.artists : [];
    const providerArtistIds = [metadata?.artistId, ...providerArtists.map((entry) => entry?.id)]
      .map((value) =>
        String(value || "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean);
    const artistMbid = String(artist.mbid || "")
      .trim()
      .toLowerCase();
    if (artistMbid && providerArtistIds.length > 0 && !providerArtistIds.includes(artistMbid)) {
      return finishExistingOr({
        error: "Album metadata does not unambiguously identify the requested artist",
        statusCode: 422,
        code: "ambiguous_identity",
      });
    }

    // The edition an album was asked for stays its edition when it is asked
    // for again, whatever release its files later turn out to be.
    const selectedRelease = chooseRequestedRelease(metadata, {
      requestedRelease:
        existingAlbum?.metadata?.edition === edition
          ? existingAlbum.metadata.requestedRelease
          : null,
      listedRelease: existingAlbum?.metadata?.trackList?.release,
      edition,
    });
    const tracks = (Array.isArray(selectedRelease?.tracks) ? selectedRelease.tracks : [])
      .map((track) => ({
        ...track,
        trackMbid: String(track?.recordingId || track?.id || "").trim(),
        title: String(track?.title || "").trim(),
      }))
      .filter((track) => track.trackMbid && track.title && !isSilenceTrack(track.title));
    if (tracks.length === 0) {
      return finishExistingOr({
        error: "Album metadata does not contain an unambiguous track list",
        statusCode: 422,
        code: "ambiguous_identity",
      });
    }

    const providerArtist =
      providerArtists.find(
        (entry) =>
          String(entry?.id || "")
            .trim()
            .toLowerCase() === artistMbid,
      ) ||
      providerArtists[0] ||
      null;
    // A compilation keeps "Various Artists" on the album and names each
    // track's own artist.
    const compilation = isVariousArtistsCredit(artist.name, artist.mbid);
    const trackArtists = new Map(
      providerArtists.map((entry) => [
        String(entry?.id || "")
          .trim()
          .toLowerCase(),
        entry,
      ]),
    );
    // A track another artist is credited with names that artist on any album.
    const albumArtistId = String(providerArtist?.id || "")
      .trim()
      .toLowerCase();
    const trackArtist = (track: (typeof tracks)[number]) => {
      const credited =
        trackArtists.get(
          String(track.artistId || "")
            .trim()
            .toLowerCase(),
        ) || null;
      return compilation ||
        String(credited?.id || "")
          .trim()
          .toLowerCase() !== albumArtistId
        ? credited
        : null;
    };
    const trackArtistName = (track: (typeof tracks)[number]) =>
      String(trackArtist(track)?.name || "").trim() || null;
    const resolvedAlbumName = String(metadata?.title || albumName || "").trim();
    if (!resolvedAlbumName) {
      return finishExistingOr({
        error: "Album metadata does not contain an unambiguous album name",
        statusCode: 422,
        code: "ambiguous_identity",
      });
    }
    const monitorMode =
      options.monitorMode ||
      (userRequest ? "monitored" : getLibraryManagementEntry("album", existing?.id)?.monitorMode) ||
      null;
    const saveAlbum = () => {
      const albumRecord = upsertLibraryAlbum({
        identityKey: buildIdentityKey("release-group", normalizedAlbumMbid),
        mbid: normalizedAlbumMbid,
        releaseGroupMbid: normalizedAlbumMbid,
        artistId: artist.id,
        title: resolvedAlbumName,
        albumArtist: artist.name || providerArtist?.name || null,
        releaseDate: metadata?.releaseDate || selectedRelease?.releaseDate || null,
        metadata: {
          id: normalizedAlbumMbid,
          foreignAlbumId: normalizedAlbumMbid,
          librarySource: "aurral",
          added: existing?.addedAt || new Date().toISOString(),
          monitored: options.monitored !== false,
          trackListComplete: true,
          edition,
          requestedRelease: selectedRelease?.id || null,
          albumType: metadata?.type || "Album",
          secondaryTypes: metadata?.secondaryTypes || [],
          genres: metadata?.genres || [],
          images: metadata?.images || [],
        },
      });

      for (const track of tracks) {
        const aliases = compilation ? trackArtist(track)?.aliases : undefined;
        const trackRecord = upsertLibraryTrack({
          identityKey: buildIdentityKey("recording", track.trackMbid),
          mbid: track.trackMbid,
          title: track.title,
          artistName: trackArtistName(track) || artist.name || providerArtist?.name || null,
          metadata: {
            id: track.trackMbid,
            foreignRecordingId: track.trackMbid,
            foreignTrackId: track.id || track.trackMbid,
            librarySource: "aurral",
            durationMs: track.durationMs,
            mediumNumber: track.mediumNumber,
            trackNumber: track.trackPosition || track.trackNumber || 0,
            ...(aliases?.length && { artistAliases: aliases }),
          },
        });
        linkLibraryAlbumTrack({
          albumId: albumRecord.id,
          trackId: trackRecord.id,
          discNumber: track.mediumNumber || 1,
          trackNumber: track.trackPosition || track.trackNumber || 0,
        });
      }

      if (userRequest && !wasMonitored) setAlbumTracksMonitoredStmt.run(1, albumRecord.id);
      setLibraryManagement({
        entityKind: "album",
        entityId: albumRecord.id,
        monitorMode,
      });
      return albumRecord;
    };
    const albumRecord = options.monitoringToken
      ? db
          .transaction(() => {
            if (
              !this._canAcquireMonitoredAlbum(
                options.artistMbid,
                normalizedAlbumMbid,
                options.monitoringToken,
              )
            ) {
              return null;
            }
            return saveAlbum();
          })
          .immediate()
      : saveAlbum();
    if (!albumRecord) return { status: "skipped" };
    return this._finishAlbum(albumRecord.id, options);
  }

  async addAlbum(
    artistId: string | number,
    releaseGroupMbid: string,
    albumName: string,
    options: AlbumAddOptions = {},
  ): Promise<AlbumAddResult | AlbumConflict | Failure> {
    const albumKey = String(releaseGroupMbid || "")
      .trim()
      .toLowerCase();
    if (!albumKey) return this._addAlbum(artistId, releaseGroupMbid, albumName, options);

    const existingRequest = _albumAddInflight.get(albumKey);
    if (existingRequest) {
      const result = await existingRequest;
      if (result?.artistId != null && String(result.artistId) !== String(artistId)) {
        return albumConflict(ALBUM_OWNED_BY_DIFFERENT_ARTIST_ERROR);
      }
      return result;
    }

    const request: Promise<AlbumAddResult> = this._addAlbum(
      artistId,
      releaseGroupMbid,
      albumName,
      options,
    ).finally(() => {
      if (_albumAddInflight.get(albumKey) === request) _albumAddInflight.delete(albumKey);
    });
    _albumAddInflight.set(albumKey, request);
    return request;
  }

  async requestAlbumFromSearch({
    albumMbid,
    albumName,
    artistMbid,
    artistName,
    user = null,
  }: {
    albumMbid?: string | null;
    albumName?: string | null;
    artistMbid?: string | null;
    artistName?: string | null;
    user?: LibraryUser;
  } = {}) {
    const normalizedAlbumMbid = String(albumMbid || "").trim();
    const normalizedAlbumName = String(albumName || "").trim();
    const normalizedArtistMbid = String(artistMbid || "").trim();
    const normalizedArtistName = String(artistName || "").trim();

    if (!normalizedAlbumMbid || !normalizedAlbumName) {
      const error: CodedError = new Error("albumMbid and albumName are required");
      error.statusCode = 400;
      throw error;
    }
    if (!normalizedArtistMbid || !normalizedArtistName) {
      const error: CodedError = new Error("artistMbid and artistName are required");
      error.statusCode = 400;
      throw error;
    }

    const existingAlbum = libraryAlbumForReference(normalizedAlbumMbid);
    let artist = this.getArtist(normalizedArtistMbid);
    let createdArtist = false;

    if (existingAlbum && artist && String(existingAlbum.artistId) !== String(artist.id)) {
      throwLibraryError(albumConflict(ALBUM_OWNED_BY_DIFFERENT_ARTIST_ERROR));
    }

    if (!artist) {
      if (!hasPermission(user, "addArtist")) {
        const error: CodedError = new Error(
          "Permission required: addArtist to create the album artist",
        );
        error.statusCode = 403;
        throw error;
      }
      const created: MethodResult<"addArtist"> = await this.addArtist(
        normalizedArtistMbid,
        normalizedArtistName,
        { user, albumOnly: true },
      );
      throwLibraryError(created);
      artist = created;
      createdArtist = true;
    }

    if (!artist?.id) {
      const error: CodedError = new Error("Failed to resolve artist in the library");
      error.statusCode = 503;
      throw error;
    }

    const album: MethodResult<"addAlbum"> = await this.addAlbum(
      artist.id,
      normalizedAlbumMbid,
      normalizedAlbumName,
      { user },
    );
    throwLibraryError(album);
    return {
      success: true,
      artist,
      album,
      createdArtist,
      createdAlbum: !existingAlbum,
      triggeredSearch: Boolean(album?.jobIds?.length),
      status: album.status,
      jobIds: album.jobIds || [],
      requestGroupId: album.requestGroupId || null,
      albumStatus: album.albumStatus || null,
    };
  }

  getAlbums(artistId: unknown) {
    return libraryAlbumsForArtist(artistId, { includeSharedAlbums: true });
  }

  getAlbumById(id: string | number) {
    return libraryAlbumForReference(id);
  }

  async deleteTrack(id: string) {
    try {
      const library = getLibraryTrack({
        trackId: id,
        availableOnly: false,
      });
      const track = library.tracks.find((entry) => String(entry.id) === String(id));
      if (!track) return { success: false, code: "not_found", error: "Track not found" };

      const aurralFiles = track.files.filter((file) => file.source === "aurral" && file.path);
      if (aurralFiles.length > 0) {
        let committedPaths;
        try {
          committedPaths = await removeLibraryDownloadJobs(library, [track]);
        } catch (error) {
          const failure = asAppError(error);
          logger.error(
            "library",
            `[LibraryManager] Failed to cancel track downloads: ${failure?.message}`,
          );
          return {
            success: false,
            code: "download_cancellation_failed",
            error: failure?.message,
          };
        }
        const paths = [...new Set([...aurralFiles.map((file) => file.path), ...committedPaths])];
        try {
          const error = await deleteAurralLibraryFiles(paths);
          if (error) {
            logger.error(
              "library",
              `[LibraryManager] Failed to delete Aurral track file: ${error.message}`,
            );
            return { success: false, code: "failed", error: error.message };
          }
          removeLibraryTrackIfNoAvailableMedia(id);
          const artist = library.artists?.find((entry) =>
            library.albums?.some(
              (album) => album.artistId === entry.id && album.trackIds?.includes(track.id),
            ),
          );
          addMonitoringExclusion({
            kind: "track",
            mbid: track.mbid,
            artistMbid: artist?.mbid,
            artistName: artist?.name || track.artistName,
            title: track.title,
          });
          return { success: true };
        } catch (error) {
          const failure = asAppError(error);
          logger.error(
            "library",
            `[LibraryManager] Failed to delete Aurral track file: ${failure?.message}`,
          );
          return { success: false, code: "failed", error: failure?.message };
        }
      }

      if (track.files.some((file) => file.source === "readonly" && file.available)) {
        return {
          success: false,
          code: "read_only",
          error: "The track's file is in a read-only folder",
        };
      }
      return { success: false, code: "not_found", error: "Track has no file to delete" };
    } catch (error) {
      const failure = asAppError(error);
      logger.error("library", `[LibraryManager] Failed to delete track file: ${failure?.message}`);
      return { success: false, code: "failed", error: failure?.message };
    }
  }

  getTracks(albumId: string | number) {
    return albumId && albumId !== "undefined" ? libraryTracksForAlbum(albumId) : [];
  }

  async getPlaybackQueue({ page = 1, pageSize = 100 } = {}) {
    return buildPlaybackQueueFromLibrary(
      getLibraryPage({
        source: "all",
        availableOnly: true,
        kind: "tracks",
        page,
        pageSize,
      }),
    );
  }
}

type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type WithAbsentKeys<Value, All = Exclude<Value, readonly unknown[]>> = 0 extends 1 & Value
  ? Value
  : Value extends readonly [unknown, ...unknown[]]
    ? Value
    : Value extends readonly (infer Element)[]
      ? WithAbsentKeys<Element>[]
      : Value extends object
        ? Value & { [Key in Exclude<KeysOfUnion<All> | keyof NoError, keyof Value>]?: undefined }
        : Value;
type WithAbsentKeysOnResults<Method> = Method extends (...args: infer Args) => infer Result
  ? (
      ...args: Args
    ) => 0 extends 1 & Result
      ? Result
      : [Result] extends [Promise<infer Value>]
        ? Promise<WithAbsentKeys<Value>>
        : WithAbsentKeys<Result>
  : Method;
type LibraryManagerApi = {
  [Name in keyof LibraryManager]: WithAbsentKeysOnResults<LibraryManager[Name]>;
};

export const libraryManager: LibraryManagerApi = new LibraryManager();
