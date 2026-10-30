import { setTimeout as sleep } from "node:timers/promises";
import fsp from "fs/promises";
import path from "path";
import { randomUUID } from "node:crypto";
import { db } from "../config/db-sqlite.ts";
import type { LibraryAlbumsRow, LibraryArtistsRow, LibraryTracksRow } from "../db/rows.ts";
import { UUID_REGEX } from "../../lib/uuid.ts";
import { asAppError } from "../../lib/errors.ts";
import { dbOps, userOps } from "../db/helpers/index.ts";
import { hasPermission } from "../middleware/auth.ts";
import {
  iterateLibraryArtistProjection,
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
import type { LidarrAlbum, LidarrAlbumTypeOption, LidarrClient } from "./lidarrClient.ts";
import { selectCanonicalFile } from "./canonicalFileSelector.ts";
import { scheduleLibraryScan } from "./libraryScanWorker.ts";
import { downloadTracker, type DownloadJob } from "./downloadJobs/downloadTracker.ts";
import {
  buildIdentityKey,
  clearLibraryLidarrAlbum,
  clearLibraryLidarrArtist,
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
  getManagedByMap,
  setLibraryManagement,
  type LibraryOwner,
} from "./libraryManagementStore.ts";
import { cancelDownloadWorkForJobs } from "./downloadJobs/downloadCancellationService.ts";
import { restoreDownloadJobCancellations } from "./downloadJobs/downloadCancellation.ts";
import { removeEmptiedFolder, removeSidecars } from "./libraryFiles/fileTransfer.ts";
import { removePlaylistFileIfUnshared } from "./downloadJobs/fileReuse.ts";
import { resolveDownloadRoot } from "./downloadPaths.ts";
import { activeLidarrRoots, libraryFolderOwner } from "./libraryFolders.ts";
import { removePlaylistTracksWithoutDownloads } from "./playlists/trackRemoval.ts";
import { chooseRequestedRelease } from "./releaseResolver.ts";
import {
  cancelAurralAlbumJobs,
  cancelAurralTrackJobs,
  cancelFileUpgradeJobs,
  cancelLibraryTrackJobs,
  findAurralAlbumJobs,
  indexAurralAlbumJobs,
  jobMatchesTrack,
  summarizeAurralAlbum,
} from "./aurralAlbumJobs.ts";
import {
  getDownloadSourceNotConfiguredMessage,
  isAnyDownloadSourceConfigured,
} from "./downloadSourceService.ts";
import {
  isStudioAlbum,
  legacyMonitorMode,
  listAurralArtistReleases,
  MONITORED_AURRAL_ALBUM_CONDITION,
  monitoredTrackCondition,
  monitoringFromLegacyMode,
  monitoringToken,
  nextArtistMonitoring,
  nextMonitoringDefaults,
  normalizeMonitorRules,
  resolveArtistMonitoring,
  selectMonitoredReleases,
  type MonitorRules,
} from "./aurralMonitoring.ts";
import {
  addMonitoringExclusion,
  clearAlbumMonitoringExclusion,
  clearArtistMonitoringExclusions,
  getAurralArtistMonitoring,
  getMonitoringDefaults,
  indexArtistExclusions,
  isAlbumMonitoringExcluded,
  listMonitoringExclusions,
  saveMonitoringDefaults,
  setAurralArtistMonitoringState,
} from "./aurralMonitoringStore.ts";
import { getArtistTopTracks } from "./musicDataSource/index.ts";
import { getNormalizedText } from "./providers/brainzmashRanking.ts";
import { enqueueSystemTaskJob } from "./honkerDb.ts";
import { scheduleReleaseMetadataRefresh } from "./releaseMetadataSync.ts";
import {
  musicbrainzGetArtistReleaseGroups,
  musicbrainzGetArtistIdentityByMbid,
} from "./apiClients/index.ts";
import { guessArtistMbid } from "./artistMatch.ts";
import { mapWithConcurrency } from "./discovery/helpers.ts";
import { logger } from "./logger.ts";
import { runMonitoringRepairSequence } from "./libraryMonitoringRepair.ts";
import {
  getAlbumByMbid as getMetadataAlbumByMbid,
  getArtistByMbid as getMetadataArtistByMbid,
  selectAlbumRelease,
} from "./providers/brainzmashProvider.ts";
import { isVariousArtistsCredit } from "./trackMatching/titleText.ts";
const LIDARR_RETRY_MS = 60000;
const LIDARR_MONITOR_OPTIONS = new Set([
  "none",
  "existing",
  "all",
  "future",
  "missing",
  "latest",
  "first",
]);
const ARTIST_LIST_CACHE_TTL_MS = 15 * 60 * 1000;
const TRACKS_CACHE_TTL_MS = 120000;
const TRACKS_CACHE_MAX = 300;

type LibraryArtistRecord = ReturnType<typeof getLibraryForAlbumReferences>["artists"][number];

type AlbumMetadata = LibraryMetadata & {
  id?: string | number | null;
  foreignAlbumId?: string | null;
  path?: string | null;
  added?: string | null;
  librarySource?: string | null;
  monitor?: string | null;
  monitorOption?: string | null;
  edition?: string | null;
  requestedRelease?: string | null;
  trackListComplete?: boolean;
  trackList?: { release?: string | null } | null;
  aurralHandoverAt?: number;
  secondaryTypes?: string[];
  genres?: string[];
  images?: unknown[] | null;
};

type TrackMetadata = LibraryMetadata & {
  trackFileId?: unknown;
  trackFile?: { id?: unknown } | null;
  file?: { id?: unknown } | null;
};

type LibraryAlbumRecord = Omit<LibraryAlbum, "metadata"> & { metadata: AlbumMetadata | null };
type LibraryTrackRecord = Omit<LibraryTrack, "metadata"> & { metadata: TrackMetadata | null };

type LidarrArtist = NonNullable<Awaited<ReturnType<LidarrClient["getArtist"]>>> & {
  name?: string;
  monitor?: string;
  qualityProfile?: { name?: string };
  metadataProfile?: { id?: number };
};
type LidarrTrackFileRecord = Awaited<ReturnType<LidarrClient["getTrackFilesByAlbumId"]>>[number] & {
  trackIds?: number[];
  relativePath?: string;
  sizeOnDisk?: number;
  mediaInfo?: { audioFormat?: string | null } | null;
};
type LidarrTrackRecord = Awaited<ReturnType<LidarrClient["getTracksByAlbumId"]>>[number] & {
  added?: string;
  path?: string | null;
  size?: number;
  sizeOnDisk?: number;
  trackTitle?: string | null;
  trackFile?: LidarrTrackFileRecord | null;
  file?: LidarrTrackFileRecord | null;
  mediaInfo?: { audioFormat?: string | null } | null;
  quality?: { quality?: { name?: string | null } } | null;
};
type LidarrAlbumRecord = LidarrAlbum & {
  added?: string;
  monitor?: string;
  addOptions?: { monitor?: string };
  path?: string | null;
  tracks?: LidarrTrackRecord[];
  albumReleases?: { tracks?: LidarrTrackRecord[] }[];
  media?: { tracks?: LidarrTrackRecord[] }[];
};
type MappedLidarrArtist = ReturnType<LibraryManager["mapLidarrArtist"]>;
type MappedLidarrTrack = ReturnType<LibraryManager["mapLidarrTrack"]>;

let lidarrClient: LidarrClient | null = null;
let _cachedArtists: MappedLidarrArtist[] = [];
let _lastLidarrFailureAt = 0;
let _artistsCachedAt = 0;
let _artistsInflight: Promise<MappedLidarrArtist[]> | null = null;
const _tracksCache = new Map<string, { tracks: MappedLidarrTrack[]; expires: number }>();
const _albumMonitoringUpdates = new Map<number, Promise<unknown>>();
const _artistMonitoringUpdates = new Map<number, Promise<unknown>>();
const _trackMonitoringUpdates = new Map<number, Promise<unknown>>();

const monitoredAurralAlbumStmt = db.prepare(`
  SELECT 1 FROM library_management AS management
  JOIN library_albums AS album ON album.id = management.entity_id
  WHERE management.entity_id = ? AND ${MONITORED_AURRAL_ALBUM_CONDITION}
`);

const isMonitoredAurralAlbum = (albumId: unknown) =>
  Boolean(monitoredAurralAlbumStmt.get(Number(albumId)));

const monitoredTrackStmt = db.prepare(
  `SELECT 1 FROM library_tracks AS track WHERE track.id = ? AND ${monitoredTrackCondition("track")}`,
);

const isMonitoredTrack = (trackId: unknown) => Boolean(monitoredTrackStmt.get(Number(trackId)));

const setTrackMonitoredStmt = db.prepare("UPDATE library_tracks SET monitored = ? WHERE id = ?");

const setTrackKeepFileStmt = db.prepare("UPDATE library_tracks SET keep_file = ? WHERE id = ?");

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
  | "managed_by_lidarr"
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
type MonitorableArtist = {
  id?: string | number | null;
  mbid?: string | null;
  foreignArtistId?: string | null;
  monitored?: boolean;
  monitorOption?: string;
  addOptions?: { monitor?: string | null } | null;
  addedAt?: string | null;
  name?: string;
};
type MethodResult<Name extends keyof LibraryManager> = LibraryManager[Name] extends (
  ...args: never[]
) => infer Result
  ? WithAbsentKeys<Awaited<Result>>
  : never;
type AlbumMonitoringView = MethodResult<"getAlbums">[number];
type MappedLidarrAlbum = ReturnType<LibraryManager["mapLidarrAlbum"]>;
type Failure = { error: string | undefined; statusCode?: number; code?: string | number | null };
type AlbumConflict = ReturnType<typeof buildAlbumConflict>;
type AlbumAddResult = WithAbsentKeys<
  Awaited<ReturnType<LibraryManager["_addAurralAlbum"] | LibraryManager["_addAlbum"]>>
>;
type DefaultMonitoringArtist = ReturnType<LibraryManager["_defaultMonitoringArtists"]>[number];
type NoError = { error?: undefined; statusCode?: undefined; code?: undefined };
type LibraryDeletion = {
  success: boolean;
  error?: string;
  statusCode?: number;
  code?: string | null;
};
type AurralRelease = Awaited<ReturnType<typeof listAurralArtistReleases>>[number];
type AurralMonitoringRequest = NonNullable<ReturnType<typeof monitoringFromLegacyMode>>;
type MonitoringRequestError =
  | Extract<ReturnType<typeof normalizeMonitorRules>, { error: string }>["error"]
  | "monitoring.monitored must be true or false"
  | `Aurral monitoring does not support the "${string}" mode`;
type MonitoringRequestResult =
  | { error: MonitoringRequestError; statusCode: number; code: string; request?: undefined }
  | (NoError & { request: AurralMonitoringRequest | null });
type LibraryCollection = {
  artists: LibraryArtistRecord[];
  albums: LibraryAlbumRecord[];
  tracks: LibraryTrackRecord[];
};
type CodedError = Error & { statusCode?: number; code?: string };
type LibraryUser = Pick<RequestUser, "id" | "username" | "role" | "permissions"> | null;
type MonitoringArtist = { id?: string | number | null; mbid: string | null; name: string };
type ArtistAddOptions = {
  managedBy?: string | null;
  user?: LibraryUser;
  quality?: string | null;
  monitorOption?: string | null;
  monitoring?: MonitoringInput | null;
  albumOnly?: boolean;
  albumMbid?: string | null;
  triggerSearch?: boolean;
  rootFolderPath?: string | null;
  qualityProfileId?: number | string | null;
  savedRootFolderPath?: string | null;
  savedQualityProfileId?: number | string | null;
  tagId?: number | string | null;
  metadataProfileId?: number | string | null;
};
type AlbumAddOptions = {
  managedBy?: string | null;
  user?: LibraryUser;
  triggerSearch?: boolean;
  monitorMode?: string | null;
  monitorOption?: string | null;
  monitored?: boolean;
  monitoringToken?: string | null;
  artistMbid?: string | null;
  requestGroupId?: string | null;
  trackIds?: number[];
  skipCancelledTracks?: boolean;
  edition?: string | null;
};

// A request names monitoring as { monitored, useDefault, rules }. Older clients
// send one monitor option instead, which maps to the same choices.
function resolveAurralMonitoringRequest({
  monitoring,
  monitorOption,
}: {
  monitoring?: MonitoringInput | null;
  monitorOption?: string | null;
} = {}): MonitoringRequestResult {
  if (monitoring !== undefined && monitoring !== null) {
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
  const option =
    String(monitorOption ?? "none")
      .trim()
      .toLowerCase() || "none";
  const legacy = monitoringFromLegacyMode(option);
  if (legacy === undefined) {
    return {
      error: `Aurral monitoring does not support the "${option}" mode` as const,
      statusCode: 400,
      code: "unsupported_monitor_mode",
    };
  }
  return { request: legacy };
}

const describeAurralMonitoring = (
  effective: ArtistMonitoring,
  defaults: MonitoringDefaultsState,
) => ({
  monitored: Boolean(effective),
  monitorOption: legacyMonitorMode(effective),
  useDefault: effective ? effective.useDefault : true,
  rules: effective?.rules || null,
  defaultRules: defaults.rules,
});

type AurralArtistMonitoringState = {
  manager: "aurral";
  added: boolean;
  inAurral: boolean;
  error: null;
} & ReturnType<typeof describeAurralMonitoring>;

type LidarrArtistMonitoringState = {
  manager: "lidarr";
  added: boolean;
  monitorOption: string | null;
  inAurral: boolean;
  error: string | null;
};

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
export function invalidateLidarrArtistCache() {
  _cachedArtists = [];
  _artistsCachedAt = 0;
  _lastLidarrFailureAt = 0;
  _tracksCache.clear();
}
const _artistMonitoringRepairs = new Map<string, Promise<void>>();
const _albumAddInflight = new Map<string, Promise<AlbumAddResult>>();
const _artistMappingInflight = new Map<string, Promise<string | null>>();
const ALBUM_OWNED_BY_DIFFERENT_ARTIST_ERROR =
  "Album already exists in Lidarr under a different artist";
const LIBRARY_MANAGERS = new Set(["aurral", "lidarr"]);

function normalizeLibraryManager(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return LIBRARY_MANAGERS.has(normalized) ? normalized : null;
}

type AlbumConflictSource = {
  id?: string | number;
  canonicalId?: string | number | null;
  providerId?: string | number | null;
  foreignAlbumId?: string | null;
  mbid?: string | null;
  managedBy?: LibraryOwner | null;
  sources?: string[];
  available?: boolean;
  statistics?: Partial<MappedLibraryAlbum["statistics"]>;
};

function buildAlbumConflict(album: AlbumConflictSource, message: string | null = null) {
  const statistics: Partial<NonNullable<AlbumConflictSource["statistics"]>> =
    album?.statistics || {};
  const details = {
    managedBy: album?.managedBy || null,
    manager: album?.managedBy || null,
    currentManager: album?.managedBy || null,
    sources: Array.isArray(album?.sources) ? album.sources : [],
    canonicalId: album?.canonicalId || album?.id || null,
    providerId: album?.providerId || album?.foreignAlbumId || album?.mbid || null,
    availability: {
      available: Boolean(album?.available),
      trackCount: Number(statistics.trackCount || 0),
      availableTrackCount: Number(statistics.trackFileCount || 0),
      percentOfTracks: Number(statistics.percentOfTracks || 0),
      sizeOnDisk: Number(statistics.sizeOnDisk || 0),
    },
  };
  const owner = details.managedBy ? ` managed by ${details.managedBy}` : " already exists";
  return {
    error: message || `Album is${owner}`,
    statusCode: 409,
    code: "album_owner_conflict",
    ...details,
    conflict: details,
  };
}

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

function scheduleLibraryReconciliation() {
  invalidateLibraryQueryCache();
  return scheduleLibraryScan({ includeLidarr: true });
}

type MappedLibraryAlbum = ReturnType<typeof mapLibraryAlbum>;

function mapLibraryAlbum(
  album: LibraryAlbumRecord,
  artist: Pick<LibraryArtistRecord, "name" | "mbid"> | undefined,
  tracks: LibraryTrackRecord[] = [],
) {
  const albumTrackIds = Array.isArray(album.trackIds) ? album.trackIds : [];
  const albumTracks = tracks.filter((track) => albumTrackIds.includes(track.id));
  const files = albumTracks.map((track) =>
    selectCanonicalFile(track.files, album.id, album.managedBy),
  );
  const availableFiles = files.filter((file) => file?.available);
  const trackCount = albumTracks.length;
  return {
    id: String(album.id),
    canonicalId: String(album.id),
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
    managedBy: album.managedBy || null,
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
  const file = selectCanonicalFile(track.files, album?.id, album?.managedBy);
  const relation = (track.albums || []).find((entry) => entry.albumId === album?.id);
  return {
    id: String(track.id),
    canonicalId: String(track.id),
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
    managedBy: album?.managedBy || null,
    monitorMode: album?.monitorMode || null,
    monitored: track.monitored !== false,
    keepFile: track.keepFile === true,
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

const lidarrMonitorOptionStmt = db
  .prepare<[string | null, string | null], string>(`
  SELECT management.monitor_mode FROM library_artists AS artist
  JOIN library_management AS management
    ON management.entity_kind = 'artist' AND management.entity_id = artist.id
  WHERE (artist.mbid = ? OR artist.identity_key = ?) AND management.managed_by = 'lidarr'
`)
  .pluck();

function storedLidarrMonitorOption(
  mbid: string | null,
  foreignArtistId: string | null,
  monitorNewItems: string | null | undefined,
) {
  const identityKey = foreignArtistId ? buildIdentityKey("lidarr-artist", foreignArtistId) : null;
  const option = mbid || identityKey ? lidarrMonitorOptionStmt.get(mbid, identityKey) : null;
  if (!option || option === "none") return null;
  const followsNewAlbums = option === "all" || option === "future";
  return followsNewAlbums === (monitorNewItems === "all") ? option : null;
}

function recordLidarrOwner(
  lidarrArtist: LidarrArtist,
  lidarrAlbum: LidarrAlbumRecord | null = null,
) {
  const artistProviderId = String(lidarrArtist?.foreignArtistId || "").trim();
  const artistName = String(lidarrArtist?.artistName || lidarrArtist?.name || "").trim();
  if (!artistProviderId || !artistName) return;
  const claim = (entityKind: string, entityId: string | number, monitorMode: string | null) => {
    if (getLibraryManagementEntry(entityKind, entityId)) return;
    setLibraryManagement({ entityKind, entityId, managedBy: "lidarr", monitorMode });
  };
  try {
    const artistIsMbid = UUID_REGEX.test(artistProviderId);
    const artist =
      libraryArtistFallback(artistProviderId) ||
      upsertLibraryArtist({
        identityKey: buildIdentityKey(artistIsMbid ? "mbid" : "lidarr-artist", artistProviderId),
        mbid: artistIsMbid ? artistProviderId : null,
        name: artistName,
        sortName: lidarrArtist.sortName || null,
        metadata: { ...lidarrArtist, librarySource: "lidarr" },
      });
    claim("artist", artist.id, lidarrArtist.monitor || lidarrArtist.addOptions?.monitor || null);

    const albumProviderId = String(lidarrAlbum?.foreignAlbumId || "").trim();
    const albumTitle = String(lidarrAlbum?.title || "").trim();
    if (!albumProviderId || !albumTitle) return;
    const albumIsMbid = UUID_REGEX.test(albumProviderId);
    const album =
      libraryAlbumForReference(albumProviderId) ||
      upsertLibraryAlbum({
        identityKey: buildIdentityKey(
          albumIsMbid ? "release-group" : "lidarr-album",
          albumProviderId,
        ),
        mbid: albumIsMbid ? albumProviderId : null,
        releaseGroupMbid: albumIsMbid ? albumProviderId : null,
        artistId: artist.id,
        title: albumTitle,
        albumArtist: artistName,
        releaseDate: lidarrAlbum!.releaseDate || null,
        metadata: { ...lidarrAlbum, librarySource: "lidarr" },
      });
    claim("album", album.id, lidarrAlbum!.monitor || lidarrAlbum!.addOptions?.monitor || null);
  } catch (error) {
    const failure = asAppError(error);
    logger.warn("library", "Could not record Lidarr ownership", {
      message: failure?.message || String(error),
    });
  }
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

function aurralHoldsArtist(artist: LibraryArtistProjection | null | undefined) {
  if (!artist) return false;
  return (
    artist.managedBy === "aurral" ||
    libraryAlbumsForArtist(artist.id).some((album) => album.managedBy === "aurral")
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

function isLidarrNotFoundError(error: unknown) {
  const failure = asAppError(error);
  return (
    failure?.response?.status === 404 ||
    failure?.status === 404 ||
    /\b404\b|not found in lidarr/i.test(String(failure?.message || ""))
  );
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
      albumKey &&
      (job.managedBy === "lidarr" ||
        (normalize(job.albumMbid) && !albumKeys.has(normalize(job.albumMbid))));
    const matchesTrack =
      !belongsElsewhere &&
      trackKeys.some((track) =>
        track.mbid && jobTrackMbid
          ? jobTrackMbid === track.mbid
          : track.artistNames.has(normalize(job.artistName)) &&
            normalize(job.trackName) === track.title,
      );
    const matchesAlbum =
      albumKey && job.managedBy === "aurral" && albumKeys.has(normalize(job.albumMbid));
    if (matchesTrack || matchesAlbum) {
      removedJobIds.add(job.id);
    }
  }
  const jobsToRemove = jobs.filter(
    (job) => removedJobIds.has(job.id) || removedJobIds.has(job.upgradeForJobId),
  );
  if (jobsToRemove.length === 0) return [];
  await cancelDownloadWorkForJobs(jobsToRemove);
  const committedPaths = new Set<string>();
  for (const job of jobsToRemove) {
    const completedJob = downloadTracker.getJob(job.id);
    if (completedJob?.managedBy !== "lidarr" && completedJob?.finalPath) {
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
  const folders = {
    downloadRoot: resolveDownloadRoot(),
    lidarrRoots: activeLidarrRoots(await getLidarrClient()),
  };
  const deletionResults = await Promise.allSettled(
    paths.map(async (filePath) => {
      const removal = await removePlaylistFileIfUnshared(filePath, "library", {
        deleteIfUnshared: true,
        protectPlayback: false,
      });
      if (removal.action === "skipped") {
        const resolvedPath = path.resolve(filePath);
        const referencedByAnotherJob = downloadTracker
          .getAll()
          .some(
            (job) =>
              job.status === "done" &&
              typeof job.finalPath === "string" &&
              path.resolve(job.finalPath) === resolvedPath,
          );
        if (!referencedByAnotherJob && libraryFolderOwner(filePath, folders) === "aurral") {
          try {
            await fsp.unlink(filePath);
          } catch (error) {
            const failure = asAppError(error);
            if (failure?.code !== "ENOENT") throw error;
          }
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
  return deletionResults.find((result) => result.status === "rejected")?.reason || null;
}

function buildTrackFileIndex(trackFiles: LidarrTrackFileRecord[] | null | undefined) {
  const index = new Map<number | string, LidarrTrackFileRecord>();
  if (!Array.isArray(trackFiles)) return index;
  for (const file of trackFiles) {
    const fileId = Number(file?.id);
    if (Number.isFinite(fileId)) {
      index.set(fileId, file);
    }
    const trackIds = Array.isArray(file?.trackIds) ? file.trackIds : [];
    for (const trackId of trackIds) {
      const normalizedTrackId = Number(trackId);
      if (Number.isFinite(normalizedTrackId)) {
        index.set(`track:${normalizedTrackId}`, file);
      }
    }
  }
  return index;
}

function enrichLidarrTrackWithFiles(
  track: LidarrTrackRecord,
  trackFileById: Map<number | string, LidarrTrackFileRecord>,
) {
  if (!track || typeof track !== "object") return track;
  if (track.path || track.trackFile?.path) return track;

  const fileId = Number(track.trackFileId);
  if (Number.isFinite(fileId) && trackFileById.has(fileId)) {
    return { ...track, trackFile: trackFileById.get(fileId) };
  }

  const trackId = Number(track.id);
  if (Number.isFinite(trackId) && trackFileById.has(`track:${trackId}`)) {
    return { ...track, trackFile: trackFileById.get(`track:${trackId}`) };
  }

  return track;
}

function albumNeedsTrackFiles({
  albumSizeOnDisk,
  isAlbumComplete,
  tracks,
}: {
  albumSizeOnDisk: number;
  isAlbumComplete: boolean;
  tracks: LidarrTrackRecord[];
}) {
  if (albumSizeOnDisk > 0 || isAlbumComplete) return true;
  if (!Array.isArray(tracks)) return false;
  return tracks.some(
    (track) => track?.hasFile === true || Number.isFinite(Number(track?.trackFileId)),
  );
}

function findCachedArtistByMbid(mbid: string) {
  if (!mbid || !Array.isArray(_cachedArtists) || _cachedArtists.length === 0) {
    return null;
  }
  return (
    _cachedArtists.find((artist) => artist?.mbid === mbid || artist?.foreignArtistId === mbid) ||
    null
  );
}

function findCachedArtistById(id: string | number) {
  const value = String(id ?? "").trim();
  if (!value || !Array.isArray(_cachedArtists) || _cachedArtists.length === 0) {
    return null;
  }
  return _cachedArtists.find((artist) => String(artist?.id ?? "").trim() === value) || null;
}

function upsertCachedArtist(mappedArtist: MappedLidarrArtist) {
  if (!mappedArtist) return;
  const mbid = mappedArtist.mbid || mappedArtist.foreignArtistId;
  if (!mbid) return;
  const existingIndex = _cachedArtists.findIndex(
    (artist) => artist?.mbid === mbid || artist?.foreignArtistId === mbid,
  );
  if (existingIndex >= 0) {
    _cachedArtists[existingIndex] = mappedArtist;
    return;
  }
  _cachedArtists.unshift(mappedArtist);
}

function removeCachedArtistByMbid(mbid: string) {
  if (!mbid || !Array.isArray(_cachedArtists) || _cachedArtists.length === 0) {
    return;
  }
  _cachedArtists = _cachedArtists.filter(
    (artist) => artist?.mbid !== mbid && artist?.foreignArtistId !== mbid,
  );
}

const MANAGER_UNAVAILABLE = {
  lidarr: "Lidarr manages artists and albums while it is connected",
  aurral: "Lidarr is not connected, so Aurral manages artists and albums",
};

async function getActiveLibraryManager() {
  const lidarr = await getLidarrClient();
  return lidarr?.isConfigured() ? "lidarr" : "aurral";
}

async function getLidarrClient() {
  if (!lidarrClient) {
    try {
      const mod = await import("./lidarrClient.ts");
      lidarrClient = mod.lidarrClient;
    } catch (err) {}
  }
  return lidarrClient;
}

function scheduleLidarrRetry() {
  import("./honkerDb.ts")
    .then(({ enqueueSystemTaskJob, findActiveHonkerJob }) => {
      const existing = findActiveHonkerJob(
        "system-task",
        (payload) => payload?.kind === "lidarr-retry",
        { recoverExpired: true, payloadKind: "lidarr-retry" },
      );
      if (existing?.state === "pending") return;
      enqueueSystemTaskJob({ kind: "lidarr-retry" }, { delaySeconds: 60 });
    })
    .catch((err) => {
      logger.warn("library", err);
    });
}

export function getCachedArtistCount() {
  return getCachedArtists().length;
}

export function getCachedArtists() {
  const libraryArtists = getLibraryArtistProjection({ pageSize: 10000 });
  return libraryArtists.length > 0
    ? libraryArtists
    : Array.isArray(_cachedArtists)
      ? _cachedArtists
      : [];
}

function getSettings() {
  return dbOps.getSettings();
}

function normalizeReleaseTypeName(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function getMetadataProfileTypeName(item: LidarrAlbumTypeOption | null | undefined) {
  if (!item) return "";
  if (typeof item === "string") return item;
  if (typeof item.name === "string") return item.name;
  if (typeof item.value === "string") return item.value;
  if (typeof item.albumType?.name === "string") return item.albumType.name;
  return "";
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
      const file = selectCanonicalFile(track.files, album.id, album.managedBy);
      if (!file?.available) continue;
      const relation = (track.albums || []).find((entry) => entry.albumId === album.id);
      queue.push({
        id: `lib-${album.artistId}-${album.id}-${track.id}`,
        title: track.title || "Unknown Track",
        artist: track.artistName || artist?.name || "Unknown Artist",
        album: album.title || "Unknown Album",
        streamPath: `/library/canonical-stream/${encodeURIComponent(album.id)}/${encodeURIComponent(track.id)}`,
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

export { buildTrackFileIndex, enrichLidarrTrackWithFiles, albumNeedsTrackFiles };

export class LibraryManager {
  async resolveManagedBy(requested: unknown) {
    const active = await getActiveLibraryManager();
    const explicit = String(requested || "")
      .trim()
      .toLowerCase();
    if (!explicit || explicit === active) return active;
    const known = LIBRARY_MANAGERS.has(explicit);
    const error: CodedError = new Error(
      known ? MANAGER_UNAVAILABLE[active] : "managedBy must be 'aurral' or 'lidarr'",
    );
    error.statusCode = known ? 409 : 400;
    error.code = known ? "library_manager_unavailable" : "invalid_library_manager";
    throw error;
  }

  // Aurral keeps the albums it already has while Lidarr is connected.
  async resolveAlbumManagedBy(requested: unknown, albumMbid: string | null | undefined) {
    const reference = String(albumMbid || "").trim();
    if (
      normalizeLibraryManager(requested) === "aurral" &&
      reference &&
      libraryAlbumForReference(reference)?.managedBy === "aurral"
    ) {
      return "aurral";
    }
    return this.resolveManagedBy(requested);
  }

  async _addAurralArtist(mbid: string, artistName: string, options: ArtistAddOptions = {}) {
    const normalizedMbid = String(mbid || "").trim();
    const requestedName = String(artistName || "").trim();
    if (!normalizedMbid || !requestedName) {
      return { error: "artist MBID and name are required", statusCode: 400 };
    }

    const existing = libraryArtistFallback(normalizedMbid);
    const resolvedMonitoring = resolveAurralMonitoringRequest(options);
    if (resolvedMonitoring.error) return resolvedMonitoring;
    if (existing) {
      if (!existing.managedBy) {
        setLibraryManagement({
          entityKind: "artist",
          entityId: existing.id,
          managedBy: "aurral",
          monitorMode: "none",
        });
      }
      scheduleReleaseMetadataRefresh();
      return libraryArtistFallback(existing.id) || existing;
    }

    let metadata = null;
    try {
      metadata = await getMetadataArtistByMbid(normalizedMbid);
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
        monitor: "none",
        monitorOption: "none",
        addOptions: { monitor: "none" },
      },
    });
    setLibraryManagement({
      entityKind: "artist",
      entityId: artist.id,
      managedBy: "aurral",
      monitorMode: "none",
    });
    scheduleReleaseMetadataRefresh();
    return libraryArtistFallback(artist.id) || artist;
  }

  async addArtist(mbid: string, artistName: string, options: ArtistAddOptions = {}) {
    let managedBy;
    try {
      managedBy = await this.resolveManagedBy(options.managedBy);
    } catch (error) {
      const failure = asAppError(error);
      return {
        error: failure?.message,
        statusCode: failure?.statusCode || 400,
        code: failure?.code || null,
      };
    }
    if (managedBy === "aurral") {
      return this._addAurralArtist(mbid, artistName, {
        ...options,
        managedBy,
      });
    }

    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return { error: "Lidarr is not configured" };
    }
    const isArtistAlreadyAddedError = (error: unknown) => {
      const message = String(asAppError(error)?.message || "").toLowerCase();
      return (
        message.includes("artistexistsvalidator") ||
        message.includes("already been added") ||
        message.includes("constraint failed")
      );
    };
    try {
      const lidarrSettings = getSettings();
      const lidarrArtist = await lidarr.addArtist(mbid, artistName, {
        albumOnly: options.albumOnly === true,
        albumMbid: options.albumMbid,
        triggerSearch: options.triggerSearch === true,
        monitorOption: options.monitorOption || "none",
        rootFolderPath: options.rootFolderPath,
        savedRootFolderPath: options.savedRootFolderPath,
        qualityProfileId: options.qualityProfileId,
        savedQualityProfileId: options.savedQualityProfileId,
        tagId: options.tagId,
        metadataProfileId:
          options.metadataProfileId || lidarrSettings.integrations?.lidarr?.metadataProfileId,
      });
      logger.info("library", `[LibraryManager] Added artist "${artistName}" to Lidarr`);
      const mappedArtist = this.mapLidarrArtist(lidarrArtist);
      upsertCachedArtist(mappedArtist);
      recordLidarrOwner(lidarrArtist);
      scheduleLibraryReconciliation();
      import("./aurralHistoryService.ts")
        .then(({ recordArtistAdded }) =>
          recordArtistAdded({
            artistName: mappedArtist.artistName || artistName,
            artistMbid: mappedArtist.mbid || mbid,
          }),
        )
        .catch((err) => {
          logger.warn("library", err);
        });
      return mappedArtist;
    } catch (error) {
      const failure = asAppError(error);
      if (isArtistAlreadyAddedError(error)) {
        try {
          const existing = await this.getArtist(mbid, { forceRefresh: true });
          if (existing) {
            return existing;
          }
        } catch {}
      }
      logger.error(
        "library",
        `[LibraryManager] Failed to add artist to Lidarr: ${failure?.message}`,
      );
      return { error: failure?.message };
    }
  }

  async resolveArtistAddOptions(options: ArtistAddOptions = {}) {
    const managedBy = await this.resolveManagedBy(options.managedBy);
    const settings = getSettings();
    if (managedBy === "aurral") {
      return {
        managedBy,
        quality: options.quality || settings.quality || "standard",
        monitorOption: options.monitorOption || "none",
        monitoring: options.monitoring ?? null,
        albumOnly: options.albumOnly === true,
        albumMbid: options.albumMbid || null,
        rootFolderPath: null,
        qualityProfileId: null,
        tagId: options.tagId ?? null,
      };
    }

    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return { error: "Lidarr is not configured" };
    }

    const defaultMonitorOption = settings.integrations?.lidarr?.defaultMonitorOption || "none";
    const requestedMonitorOption =
      options.albumOnly === true ? "none" : options.monitorOption || defaultMonitorOption;
    const currentUser = options.user?.id != null ? userOps.getUserById(options.user.id) : null;
    const preparedAddOptions = await lidarr.resolveArtistAddConfiguration({
      requestRootFolderPath: options.rootFolderPath,
      requestQualityProfileId: options.qualityProfileId,
      savedRootFolderPath: currentUser?.lidarrRootFolderPath,
      savedQualityProfileId: currentUser?.lidarrQualityProfileId,
      settings,
    });

    return {
      managedBy,
      quality: options.quality || settings.quality || "standard",
      monitorOption: requestedMonitorOption,
      albumOnly: options.albumOnly === true,
      albumMbid: options.albumMbid || null,
      rootFolderPath: preparedAddOptions?.resolved?.rootFolderPath || null,
      qualityProfileId: preparedAddOptions?.resolved?.qualityProfileId ?? null,
      tagId: options.tagId ?? null,
      preparedAddOptions,
    };
  }

  async waitForAlbumByMbidForArtist(
    albumMbid: string,
    artistId: string | number,
    { delaysMs = [500, 1000, 2000, 4000, 8000, 8000] }: { delaysMs?: number[] } = {},
  ) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return null;
    }

    const normalizedAlbumMbid = String(albumMbid || "").trim();
    const normalizedAlbumMbidKey = normalizedAlbumMbid.toLowerCase();
    const normalizedArtistId = String(artistId || "").trim();
    if (!normalizedAlbumMbid || !normalizedArtistId) {
      return null;
    }

    const findAlbum = async () => {
      try {
        const album = await lidarr.getAlbumByMbid(normalizedAlbumMbid, {
          forceRefresh: true,
        });
        if (album && String(album.artistId) === normalizedArtistId) {
          return album;
        }
      } catch {}

      try {
        const albums = await lidarr.getAllAlbums({
          artistIds: [normalizedArtistId],
          forceRefresh: true,
        });
        return (
          albums.find(
            (album) =>
              album.foreignAlbumId.trim().toLowerCase() === normalizedAlbumMbidKey &&
              String(album.artistId) === normalizedArtistId,
          ) || null
        );
      } catch {
        return null;
      }
    };

    for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
      const album = await findAlbum();
      if (album) return album;

      if (attempt < delaysMs.length) {
        await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
      }
    }

    return null;
  }

  async applyArtistMonitoringDefaults(
    artist: MonitorableArtist,
    albums: AlbumMonitoringView[] | null = null,
  ) {
    if (!artist?.monitored || !artist?.monitorOption || artist.monitorOption === "none") {
      return;
    }

    const lidarr = await getLidarrClient();
    const allAlbums: AlbumMonitoringView[] = Array.isArray(albums)
      ? albums
      : await this.getAlbums(artist.id, null, { forceRefresh: true });
    let eligibleAlbums = allAlbums.filter((album) => album.canonicalId == null);

    if (lidarr && lidarr.isConfigured() && artist?.id) {
      try {
        const lidarrArtist: LidarrArtist | null = await lidarr.getArtist(artist.id);
        const settings = getSettings();
        const fallbackMetadataProfileId = settings.integrations?.lidarr?.metadataProfileId;
        const metadataProfileId =
          lidarrArtist?.metadataProfileId ||
          lidarrArtist?.metadataProfile?.id ||
          fallbackMetadataProfileId;
        const profiles = metadataProfileId ? await lidarr.getMetadataProfiles() : null;
        const metadataProfile = profiles?.find(
          (profile) => String(profile.id) === String(metadataProfileId),
        );

        let allowedPrimaryTypes = null;
        if (metadataProfile?.primaryAlbumTypes) {
          const allowed = new Set<string>();
          for (const item of metadataProfile.primaryAlbumTypes) {
            const name = getMetadataProfileTypeName(item);
            if (!name) continue;
            const isAllowed = typeof item === "string" ? true : item.allowed !== false;
            if (!isAllowed) continue;
            allowed.add(normalizeReleaseTypeName(name));
          }
          if (allowed.size > 0) {
            allowedPrimaryTypes = allowed;
          }
        }

        if (allowedPrimaryTypes) {
          const mbid = artist.mbid || artist.foreignArtistId || artist.id?.toString?.();
          const releaseGroups: Awaited<
            ReturnType<typeof musicbrainzGetArtistReleaseGroups>
          >[number][] = mbid ? await musicbrainzGetArtistReleaseGroups(mbid) : [];
          const mbidToType = new Map(
            releaseGroups.map((rg) => [rg.id, normalizeReleaseTypeName(rg["primary-type"])]),
          );
          eligibleAlbums = eligibleAlbums.filter((album) => {
            const key = album.mbid || album.foreignAlbumId || album.id?.toString?.();
            const type = key == null ? undefined : mbidToType.get(key);
            if (!type) return true;
            return allowedPrimaryTypes.has(type);
          });
        }
      } catch {}
    }

    const albumsToMonitor = [];
    const sortedAlbums = [...eligibleAlbums].sort((a, b) => {
      const dateA = a.releaseDate || a.addedAt || "";
      const dateB = b.releaseDate || b.addedAt || "";
      return dateB.localeCompare(dateA);
    });

    switch (artist.monitorOption) {
      case "existing":
      case "all":
        albumsToMonitor.push(...eligibleAlbums.filter((album) => !album.monitored));
        break;
      case "latest":
        if (sortedAlbums.length > 0 && !sortedAlbums[0].monitored) {
          albumsToMonitor.push(sortedAlbums[0]);
        }
        break;
      case "first": {
        const oldestAlbum = sortedAlbums[sortedAlbums.length - 1];
        if (oldestAlbum && !oldestAlbum.monitored) {
          albumsToMonitor.push(oldestAlbum);
        }
        break;
      }
      case "missing":
        albumsToMonitor.push(
          ...eligibleAlbums.filter((album) => {
            const stats = album.statistics || {};
            return !album.monitored && (stats.percentOfTracks || 0) < 100;
          }),
        );
        break;
      case "future": {
        const artistAddedDate = new Date(artist.addedAt ?? 0);
        albumsToMonitor.push(
          ...eligibleAlbums.filter((album) => {
            if (album.monitored) return false;
            if (!album.releaseDate) return false;
            const releaseDate = new Date(album.releaseDate);
            return releaseDate > artistAddedDate;
          }),
        );
        break;
      }
    }

    if (lidarr && lidarr.isConfigured()) {
      const settings = getSettings();
      const searchOnAdd = settings.integrations?.lidarr?.searchOnAdd ?? false;
      await Promise.allSettled(
        albumsToMonitor.map(async (album) => {
          try {
            const updated: MethodResult<"updateAlbum"> = await this.updateAlbum(String(album.id), {
              monitored: true,
            });
            if (updated?.error) throw new Error(updated.error);
            await this._handAurralAlbumToLidarr(album.mbid);
            if (searchOnAdd) {
              await lidarr.request("/command", "POST", {
                name: "AlbumSearch",
                albumIds: [parseInt(String(album.id), 10)],
              });
            }
          } catch (err) {
            const failure = asAppError(err);
            logger.error(
              "library",
              `Failed to monitor/search album ${album.albumName}: ${failure?.message}`,
            );
          }
        }),
      );
    }
  }

  async addArtistWithResolvedOptions(
    mbid: string,
    artistName: string,
    options: ArtistAddOptions = {},
  ) {
    const albumOnly = options.albumOnly === true;
    const requestedMonitorOption = options.monitorOption || "none";
    const artist: MethodResult<"addArtist"> = await this.addArtist(mbid, artistName, {
      managedBy: options.managedBy,
      user: options.user,
      quality: options.quality,
      albumOnly,
      albumMbid: options.albumMbid,
      triggerSearch: options.triggerSearch === true,
      monitorOption: requestedMonitorOption,
      monitoring: options.monitoring,
      rootFolderPath: options.rootFolderPath,
      qualityProfileId: options.qualityProfileId,
      tagId: options.tagId,
    });
    if (artist?.error) {
      return artist;
    }
    if (options.managedBy === "aurral" && !albumOnly) {
      const { request } = resolveAurralMonitoringRequest(options);
      if (request) return this.setAurralArtistMonitoring(mbid, request);
    }
    if (options.managedBy !== "aurral" && !albumOnly && requestedMonitorOption !== "none") {
      const albums = await this.getAlbums(artist.id, null, {
        forceRefresh: true,
        managedBy: options.managedBy,
      });
      if (albums.length > 0) {
        await this.applyArtistMonitoringDefaults(artist, albums);
      } else {
        this.scheduleArtistMonitoringDefaults(artist);
      }
    }
    return artist;
  }

  scheduleArtistMonitoringDefaults(artist: MonitorableArtist) {
    const artistId = String(artist?.id || "").trim();
    if (!artistId || _artistMonitoringRepairs.has(artistId)) return;

    const repair = (async () => {
      const delaysMs = [500, 1000, 2000, 4000, 8000, 8000];
      for (const delayMs of delaysMs) {
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, delayMs);
          timeout.unref?.();
        });
        const albums = await this.getAlbums(artistId, null, { forceRefresh: true });
        if (!albums.length) continue;
        await this.applyArtistMonitoringDefaults(artist, albums);
        return;
      }
    })()
      .catch((error) => {
        logger.warn("library", "Failed to stabilize artist monitoring defaults", {
          artistId,
          message: error.message,
        });
      })
      .finally(() => {
        _artistMonitoringRepairs.delete(artistId);
      });

    _artistMonitoringRepairs.set(artistId, repair);
  }

  async addArtistWithPreferences(mbid: string, artistName: string, options: ArtistAddOptions = {}) {
    const resolvedOptions = await this.resolveArtistAddOptions(options);
    if (resolvedOptions?.error) {
      return resolvedOptions;
    }
    return this.addArtistWithResolvedOptions(mbid, artistName, {
      ...resolvedOptions,
      user: options.user,
      albumOnly: options.albumOnly === true,
      albumMbid: options.albumMbid || resolvedOptions.albumMbid || null,
      triggerSearch: options.triggerSearch === true,
    });
  }

  async getArtist(
    mbid: string,
    {
      forceRefresh = false,
      managedBy = null,
    }: { forceRefresh?: boolean; managedBy?: string | null } = {},
  ) {
    const libraryArtist = libraryArtistFallback(mbid);
    if (normalizeLibraryManager(managedBy) === "aurral") return libraryArtist;
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) return libraryArtist;
    if (!forceRefresh) {
      const cachedArtist = findCachedArtistByMbid(mbid);
      if (cachedArtist) {
        return cachedArtist;
      }
    }
    try {
      const lidarrArtist = await lidarr.getArtistByMbid(mbid, { forceRefresh });
      if (!lidarrArtist) return managedBy == null ? libraryArtist : null;
      const mappedArtist = this.mapLidarrArtist(lidarrArtist);
      upsertCachedArtist(mappedArtist);
      return mappedArtist;
    } catch (error) {
      if (!isLidarrNotFoundError(error)) {
        return findCachedArtistByMbid(mbid) || libraryArtistFallback(mbid);
      }
      return managedBy == null ? libraryArtist : null;
    }
  }

  async getArtistById(
    id: string | number,
    { managedBy = null }: { managedBy?: string | null } = {},
  ) {
    const manager = normalizeLibraryManager(managedBy);
    const found = libraryArtistFallback(id);
    if (manager === "aurral" || (managedBy == null && found?.managedBy === "aurral")) return found;
    const libraryArtist = manager === "lidarr" && found?.managedBy === "aurral" ? null : found;
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) return libraryArtist;
    try {
      const lidarrArtist = await lidarr.getArtist(id);
      if (!lidarrArtist) return findCachedArtistById(id) || libraryArtist;
      await this.backfillLidarrArtistMappings([lidarrArtist]);
      return this.mapLidarrArtist(lidarrArtist);
    } catch (error) {
      if (!isLidarrNotFoundError(error)) return findCachedArtistById(id) || libraryArtist;
      return managedBy == null ? libraryArtist : null;
    }
  }

  async ensureArtistMonitored<T extends MonitorableArtist>(
    artist: T,
    monitorOption: string | null = null,
  ) {
    if (!artist || artist.monitored !== false) {
      return artist;
    }

    const mbid = artist.mbid || artist.foreignArtistId;
    if (!mbid) {
      return artist;
    }

    const nextMonitorOption =
      [monitorOption, artist.monitorOption, artist.addOptions?.monitor].find(Boolean) || "none";
    const updated: MethodResult<"updateArtist"> = await this.updateArtist(mbid, {
      monitored: true,
      monitorOption: nextMonitorOption,
    });
    return failed(updated) ? artist : updated;
  }

  async ensureRequestedAlbumMonitoring(
    artistId: string | number,
    albumId: string | number,
    options: { monitorOption?: string | null } = {},
  ) {
    const normalizedArtistId = String(artistId || "").trim();
    const normalizedAlbumId = String(albumId || "").trim();
    if (!normalizedArtistId || !normalizedAlbumId) {
      return { artist: null, album: null };
    }

    let artist = await this.getArtistById(normalizedArtistId, { managedBy: "lidarr" });
    if (artist?.monitored === false) {
      artist = await this.ensureArtistMonitored(artist, options.monitorOption);
    }

    let album: MethodResult<"getAlbumById"> | MethodResult<"updateAlbum"> = await this.getAlbumById(
      normalizedAlbumId,
      { managedBy: "lidarr" },
    );
    if (album?.monitored === false) {
      album = await this.updateAlbum(normalizedAlbumId, { monitored: true });
    }

    return { artist, album };
  }

  scheduleRequestedAlbumMonitoringRepair(
    artistId: string | number,
    albumId: string | number,
    options: { monitorOption?: string | null } = {},
  ) {
    const normalizedArtistId = String(artistId || "").trim();
    const normalizedAlbumId = String(albumId || "").trim();
    if (!normalizedArtistId || !normalizedAlbumId) return;

    runMonitoringRepairSequence({
      // These increments preserve the previous 1s/3s/8s/15s checkpoints.
      delaysMs: [1000, 2000, 5000, 7000],
      repair: () =>
        this.ensureRequestedAlbumMonitoring(normalizedArtistId, normalizedAlbumId, options),
    })
      .then(({ complete, error }) => {
        if (!complete && error) {
          logger.error(
            "library",
            `[LibraryManager] Failed to stabilize requested album monitoring: ${error.message}`,
          );
        }
      })
      .catch((error) => {
        logger.error(
          "library",
          `[LibraryManager] Failed to stabilize requested album monitoring: ${error.message}`,
        );
      });
  }

  async getAllArtists() {
    return [...iterateLibraryArtistProjection({ pageSize: 100 })];
  }

  async syncLidarrArtists({ forceRefresh = false } = {}) {
    if (
      forceRefresh !== true &&
      _cachedArtists.length > 0 &&
      Date.now() - _artistsCachedAt < ARTIST_LIST_CACHE_TTL_MS
    ) {
      return _cachedArtists;
    }
    if (_artistsInflight) return _artistsInflight;

    _artistsInflight = (async () => {
      try {
        const lidarr = await getLidarrClient();
        if (!lidarr || !lidarr.isConfigured()) {
          return _cachedArtists;
        }
        if (
          forceRefresh !== true &&
          _lastLidarrFailureAt &&
          Date.now() - _lastLidarrFailureAt < LIDARR_RETRY_MS
        ) {
          return _cachedArtists;
        }
        try {
          const lidarrArtists = await lidarr.getArtists({ forceRefresh: forceRefresh === true });
          _lastLidarrFailureAt = 0;
          await this.backfillLidarrArtistMappings(lidarrArtists);
          _cachedArtists = lidarrArtists.map((a) => this.mapLidarrArtist(a));
          _artistsCachedAt = Date.now();
          scheduleLibraryReconciliation();
          import("./unifiedSearchService.ts")
            .then(({ clearSearchContextCache }) => clearSearchContextCache())
            .catch(() => {});
          return _cachedArtists;
        } catch (error) {
          const failure = asAppError(error);
          const wasHealthy = _lastLidarrFailureAt === 0;
          _lastLidarrFailureAt = Date.now();
          scheduleLidarrRetry();
          if (wasHealthy) {
            const msg = failure?.message || String(error);
            logger.warn(
              "library",
              `[LibraryManager] Lidarr unavailable: ${msg} - using cached artists (if any). Retrying every 60s.`,
            );
          }
          return _cachedArtists;
        }
      } catch (_) {
        return _cachedArtists;
      }
    })().finally(() => {
      _artistsInflight = null;
    });
    return _artistsInflight;
  }

  mapLidarrArtist(lidarrArtist: LidarrArtist) {
    const artistPath = lidarrArtist.path ?? null;
    const artistId = Number(lidarrArtist.id);
    const foreignArtistId = String(lidarrArtist.foreignArtistId || "").trim() || null;
    const mappedMbid = dbOps.getLidarrArtistMbid(foreignArtistId);
    const mbid =
      mappedMbid || (foreignArtistId && UUID_REGEX.test(foreignArtistId) ? foreignArtistId : null);
    const normalizedArtistId =
      Number.isSafeInteger(artistId) && artistId > 0 ? String(artistId) : null;
    const monitorOption =
      lidarrArtist.monitor ||
      lidarrArtist.addOptions?.monitor ||
      storedLidarrMonitorOption(mbid, foreignArtistId, lidarrArtist.monitorNewItems) ||
      "none";
    const normalizedMonitorOption = monitorOption || "none";
    return {
      id: normalizedArtistId,
      mbid,
      foreignArtistId,
      artistName: lidarrArtist.artistName,
      managedBy: "lidarr" as LibraryOwner,
      path: artistPath,
      addedAt: lidarrArtist.added || new Date().toISOString(),
      monitored: lidarrArtist.monitored || false,
      monitorOption: normalizedMonitorOption,
      monitorNewItems: lidarrArtist.monitorNewItems || "none",
      addOptions: {
        monitor: normalizedMonitorOption,
      },
      quality: lidarrArtist.qualityProfile?.name || "standard",
      albumFolders: true,
      statistics: lidarrArtist.statistics || {
        albumCount: 0,
        trackCount: 0,
        sizeOnDisk: 0,
      },
    };
  }

  async resolveLidarrArtistMbid(lidarrArtist: LidarrArtist) {
    const providerId = String(lidarrArtist?.foreignArtistId || "").trim();
    const artistName = String(lidarrArtist?.artistName || "").trim();
    if (!providerId || !artistName || UUID_REGEX.test(providerId)) return null;

    const existingMbid = dbOps.getLidarrArtistMbid(providerId);
    if (existingMbid) return existingMbid;

    const mbid = await guessArtistMbid(artistName);
    if (!UUID_REGEX.test(String(mbid || ""))) return null;

    const identity = await musicbrainzGetArtistIdentityByMbid(mbid);
    const identityName = String(identity?.name || "").trim();
    const normalizedArtistName = artistName.toLowerCase();
    const acceptedArtistNames = new Set(
      [identityName, ...(Array.isArray(identity?.aliases) ? identity.aliases : [])]
        .map((name) =>
          String(name || "")
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    );
    const providerIds = Array.isArray(identity?.providerIds) ? identity.providerIds : [];
    const matchesProviderId = providerIds.some(
      (value) =>
        String(value || "")
          .trim()
          .toLowerCase() === providerId.toLowerCase(),
    );
    if (!identityName || !acceptedArtistNames.has(normalizedArtistName) || !matchesProviderId) {
      return null;
    }

    try {
      dbOps.setLidarrArtistIdMap(mbid!, providerId);
      return mbid;
    } catch (error) {
      const failure = asAppError(error);
      if (failure?.code !== "LIDARR_ARTIST_ID_CONFLICT") throw error;
      return null;
    }
  }

  async backfillLidarrArtistMappings(lidarrArtists: LidarrArtist[]) {
    const candidates: LidarrArtist[] = [];
    const seen = new Set<string>();
    for (const artist of Array.isArray(lidarrArtists) ? lidarrArtists : []) {
      const providerId = String(artist?.foreignArtistId || "").trim();
      if (
        !providerId ||
        UUID_REGEX.test(providerId) ||
        seen.has(providerId) ||
        dbOps.getLidarrArtistMbid(providerId)
      ) {
        continue;
      }
      seen.add(providerId);
      candidates.push(artist);
    }

    await mapWithConcurrency(candidates, 2, (artist: LidarrArtist) => {
      const providerId = String(artist?.foreignArtistId || "").trim();
      let mappingRequest = _artistMappingInflight.get(providerId);
      if (!mappingRequest) {
        mappingRequest = this.resolveLidarrArtistMbid(artist)
          .catch(() => null)
          .finally(() => {
            if (_artistMappingInflight.get(providerId) === mappingRequest) {
              _artistMappingInflight.delete(providerId);
            }
          });
        _artistMappingInflight.set(providerId, mappingRequest);
      }
      return mappingRequest;
    });
  }

  async updateArtist(
    mbid: string,
    updates: { monitored?: boolean; monitorOption?: string | null },
  ) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return { error: "Lidarr is not configured" };
    }
    try {
      const lidarrArtist: LidarrArtist | null = await lidarr.getArtistByMbid(mbid, {
        forceRefresh: true,
      });
      if (!lidarrArtist) return { error: "Artist not found in Lidarr" };
      if (updates.monitored !== undefined || updates.monitorOption !== undefined) {
        const monitorOption = updates.monitorOption || lidarrArtist.monitor || "none";
        const normalizedMonitorOption = monitorOption || "none";
        await lidarr.updateArtistMonitoring(lidarrArtist.id, monitorOption);
        logger.info(
          "library",
          `[LibraryManager] Updated Lidarr monitoring for "${lidarrArtist.artistName}" to "${monitorOption}"`,
        );
        const updated = await lidarr.getArtist(lidarrArtist.id);
        if (!updated) throw new Error("Artist not found in Lidarr");
        const mapped = this.mapLidarrArtist(updated);
        mapped.monitorOption = normalizedMonitorOption;
        mapped.addOptions = {
          ...(mapped.addOptions || {}),
          monitor: normalizedMonitorOption,
        };
        upsertCachedArtist(mapped);
        scheduleLibraryReconciliation();
        return mapped;
      }
      return this.mapLidarrArtist(lidarrArtist);
    } catch (error) {
      const failure = asAppError(error);
      logger.error(
        "library",
        `[LibraryManager] Failed to update artist in Lidarr: ${failure?.message}`,
      );
      return { error: failure?.message };
    }
  }

  async deleteArtist(
    mbid: string,
    deleteFiles = false,
    { manager = null }: { manager?: string | null } = {},
  ): Promise<LibraryDeletion> {
    if (/^\d+$/.test(String(mbid)))
      return this._deleteLibraryArtistById(Number(mbid), deleteFiles, { manager });
    if (manager === "lidarr") return this._deleteLidarrArtist(mbid, deleteFiles);
    if (manager === "aurral") {
      const libraryArtist = libraryArtistFallback(mbid);
      if (!libraryArtist)
        return { success: false, error: "Artist not found in Aurral", statusCode: 404 };
      return this._deleteAurralArtist(libraryArtist, deleteFiles);
    }

    const lidarr = await getLidarrClient();
    let inLidarr = false;
    if (lidarr?.isConfigured()) {
      try {
        inLidarr = Boolean(await lidarr.getArtistByMbid(mbid));
      } catch (error) {
        const failure = asAppError(error);
        if (!isLidarrNotFoundError(error)) {
          return {
            success: false,
            error: `Lidarr could not be reached: ${failure?.message}`,
            statusCode: 503,
          };
        }
      }
    }
    const libraryArtist = libraryArtistFallback(mbid);
    const aurralArtist =
      libraryArtist && (!inLidarr || aurralHoldsArtist(libraryArtist)) ? libraryArtist : null;
    if (!inLidarr && !aurralArtist) {
      return { success: false, error: "Artist not found in your library", statusCode: 404 };
    }
    if (inLidarr) {
      const removed = await this._deleteLidarrArtist(mbid, deleteFiles);
      if (!removed.success) return removed;
    }
    return aurralArtist ? this._deleteAurralArtist(aurralArtist, deleteFiles) : { success: true };
  }

  // An artist without a MusicBrainz ID, such as one ingested from untagged
  // files, is found by its Library id. Lidarr only knows artists by ID.
  async _deleteLibraryArtistById(
    id: number,
    deleteFiles: boolean,
    { manager = null }: { manager?: string | null } = {},
  ): Promise<LibraryDeletion> {
    const libraryArtist = getLibraryArtistProjection({ reference: id }).find(
      (artist) => Number(artist.id) === id,
    );
    if (!libraryArtist)
      return { success: false, error: "Artist not found in your library", statusCode: 404 };
    if (libraryArtist.mbid) return this.deleteArtist(libraryArtist.mbid, deleteFiles, { manager });
    if (manager === "lidarr" || !aurralHoldsArtist(libraryArtist)) {
      return { success: false, error: "Delete this artist in Lidarr", statusCode: 409 };
    }
    return this._deleteAurralArtist(libraryArtist, deleteFiles);
  }

  async _deleteLidarrArtist(mbid: string, deleteFiles: boolean) {
    const lidarr = await getLidarrClient();
    if (!lidarr?.isConfigured()) {
      return { success: false, error: "Lidarr is not configured", statusCode: 503 };
    }
    try {
      const lidarrArtist = await lidarr.getArtistByMbid(mbid);
      if (!lidarrArtist)
        return { success: false, error: "Artist not found in Lidarr", statusCode: 404 };
      await lidarr.deleteArtist(lidarrArtist.id, deleteFiles);
      dbOps.deleteLidarrArtistIdMap(mbid);
      removeCachedArtistByMbid(mbid);
      clearLibraryLidarrArtist(mbid);
      clearLibraryLidarrArtist(lidarrArtist.foreignArtistId);
      scheduleLibraryReconciliation();
      logger.info(
        "library",
        `[LibraryManager] Deleted artist "${lidarrArtist.artistName}" from Lidarr`,
      );
      return { success: true };
    } catch (error) {
      const failure = asAppError(error);
      logger.error(
        "library",
        `[LibraryManager] Failed to delete artist from Lidarr: ${failure?.message}`,
      );
      return { success: false, error: failure?.message };
    }
  }

  async _finishAurralAlbum(albumReference: string | number, options: AlbumAddOptions = {}) {
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
    let albumJobs = findAurralAlbumJobs(albumJobKeys(album));
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
      albumJobs = findAurralAlbumJobs(albumJobKeys(album));
      return result;
    };

    for (const track of missingTracks) {
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
            includeLidarr: false,
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
              managedBy: "aurral",
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
    const shouldStartWorker = uniqueTrackedJobIds.some((jobId) => {
      const status = downloadTracker.getJob(jobId)?.status;
      return status === "pending" || status === "downloading";
    });
    if (shouldStartWorker) {
      try {
        const { recordTrackJobQueued } = await import("./aurralHistoryService.ts");
        for (const jobId of jobIds) {
          const job = downloadTracker.getJob(jobId);
          if (job) recordTrackJobQueued(job, options.user);
        }
      } catch {}
      try {
        const { downloadWorker } = await import("./downloadJobs/downloadWorker.ts");
        await downloadWorker.start();
      } catch (error) {
        const failure = asAppError(error);
        logger.warn("library", "Aurral album jobs remain queued after worker start failed", {
          message: failure?.message || String(error),
        });
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
      albumStatus: this._summarizeAurralAlbum(album, library.tracks),
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
    const album = await getMetadataAlbumByMbid(releaseGroupMbid);
    const release = selectAlbumRelease(album, { edition });
    return (Array.isArray(release?.tracks) ? release.tracks : [])
      .map((track) => ({
        recording: String(track?.recordingId || track?.id || "").trim(),
        title: String(track?.title || "").trim(),
      }))
      .filter((track) => track.recording);
  }

  // A release other than a studio album is skipped when every recording on it
  // is already in the Library or on a release this plan downloads, such as a
  // single that the album also has.
  async planAurralArtistMonitoring(artist: MonitoringArtist, effective: ArtistMonitoring) {
    const plan: MonitoringPlan & NoError = {
      releases: [],
      topTracks: [],
      skipped: [],
      skippedTracks: [],
      topTracksError: null,
    };
    if (!effective || !artist?.mbid) return plan;
    const { rules } = effective;
    let releases: Awaited<ReturnType<typeof listAurralArtistReleases>> = [];
    if (rules.catalog !== "none" || rules.newReleases) {
      try {
        releases = await listAurralArtistReleases(artist.mbid);
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
      else if (existing?.managedBy === "lidarr") skip(release, "managed_by_lidarr");
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

  _enqueueAurralMonitoringApply(
    artist: MonitoringArtist,
    effective: ArtistMonitoring,
    plan: MonitoringPlan,
  ) {
    if (!plan.releases.length && !plan.topTracks.length) return false;
    enqueueSystemTaskJob({
      kind: "aurral-monitoring-apply",
      artistMbid: artist.mbid,
      token: monitoringToken(effective),
      releaseGroups: plan.releases.map(({ id, title }) => ({ id, title })),
      topTracks: plan.topTracks,
    });
    return true;
  }

  async getArtistMonitoring(
    mbid: string,
  ): Promise<AurralArtistMonitoringState | LidarrArtistMonitoringState> {
    const artist = libraryArtistFallback(mbid);
    const manager = artist?.managedBy === "aurral" ? "aurral" : await getActiveLibraryManager();
    const inAurral = aurralHoldsArtist(artist);
    if (manager === "aurral") {
      const defaults = getMonitoringDefaults();
      const effective =
        artist?.managedBy === "aurral"
          ? getAurralArtistMonitoring(Number(artist.id), defaults)
          : null;
      return {
        manager,
        added: Boolean(artist),
        inAurral,
        error: null,
        ...describeAurralMonitoring(effective, defaults),
      };
    }
    const state: LidarrArtistMonitoringState = {
      manager,
      added: false,
      monitorOption: "none",
      inAurral,
      error: null,
    };
    try {
      const lidarr = (await getLidarrClient())!;
      const lidarrArtist = await lidarr.getArtistByMbid(mbid, { forceRefresh: true });
      if (lidarrArtist) {
        const mapped = this.mapLidarrArtist(lidarrArtist);
        state.added = true;
        state.monitorOption = !mapped.monitored
          ? "none"
          : mapped.monitorOption !== "none"
            ? mapped.monitorOption
            : mapped.monitorNewItems === "all"
              ? null
              : "none";
      }
    } catch (error) {
      if (!isLidarrNotFoundError(error)) state.error = "Lidarr could not be reached";
    }
    return state;
  }

  async setArtistMonitoring(
    mbid: string,
    {
      monitorOption,
      monitoring,
      artistName = null,
      user = null,
    }: {
      monitorOption?: string | null;
      monitoring?: MonitoringInput | null;
      artistName?: string | null;
      user?: LibraryUser;
    } = {},
  ) {
    const option = String(monitorOption || "none");
    const name = String(artistName || libraryArtistFallback(mbid)?.name || "").trim();
    const forbidden = {
      error: "Permission required: addArtist",
      statusCode: 403,
      code: "forbidden",
    };

    const existingArtist = libraryArtistFallback(mbid);
    if (existingArtist?.managedBy === "aurral" || (await getActiveLibraryManager()) === "aurral") {
      const resolved = resolveAurralMonitoringRequest({ monitoring, monitorOption });
      if (resolved.error) return resolved;
      const artist = existingArtist;
      if (!resolved.request && artist?.managedBy !== "aurral") {
        return { ...(artist || { mbid }), monitored: false, monitorOption: "none" };
      }
      if (!artist) {
        if (!hasPermission(user, "addArtist")) return forbidden;
        const created: MethodResult<"_addAurralArtist"> = await this._addAurralArtist(mbid, name);
        if (created?.error) return created;
      }
      return this.setAurralArtistMonitoring(mbid, resolved.request);
    }

    if (monitoring != null) {
      return {
        error: "Lidarr manages this artist's monitoring. Choose a Lidarr monitor option.",
        statusCode: 400,
        code: "lidarr_monitoring",
      };
    }
    if (!LIDARR_MONITOR_OPTIONS.has(option)) {
      return {
        error: `Lidarr does not support the "${option}" mode`,
        statusCode: 400,
        code: "unsupported_monitor_mode",
      };
    }
    const lidarr = (await getLidarrClient())!;
    let lidarrArtist = null;
    try {
      lidarrArtist = await lidarr.getArtistByMbid(mbid, { forceRefresh: true });
    } catch (error) {
      const failure = asAppError(error);
      if (!isLidarrNotFoundError(error)) {
        return { error: `Lidarr could not be reached: ${failure?.message}`, statusCode: 503 };
      }
    }
    if (lidarrArtist) {
      await lidarr.updateArtistMonitoring(lidarrArtist.id, option);
    } else {
      if (option === "none") return { mbid, monitored: false, monitorOption: "none" };
      if (!hasPermission(user, "addArtist")) return forbidden;
      const added: MethodResult<"addArtistWithPreferences"> = await this.addArtistWithPreferences(
        mbid,
        name,
        { user, monitorOption: option },
      );
      if (added?.error) return added;
    }

    const refreshed = await lidarr.getArtistByMbid(mbid, { forceRefresh: true });
    if (!refreshed) return { error: "Artist not found in Lidarr", statusCode: 404 };
    const artist =
      libraryArtistFallback(mbid) ||
      libraryArtistFallback(buildIdentityKey("lidarr-artist", refreshed.foreignArtistId));
    if (artist) {
      setLibraryManagement({
        entityKind: "artist",
        entityId: Number(artist.id),
        managedBy: "lidarr",
        monitorMode: option,
      });
    }
    const mapped = { ...this.mapLidarrArtist(refreshed), monitorOption: option };
    mapped.addOptions = { ...(mapped.addOptions || {}), monitor: option };
    upsertCachedArtist(mapped);
    const stored =
      artist &&
      db
        .prepare<[number], Pick<LibraryArtistsRow, "identity_key">>(
          "SELECT identity_key FROM library_artists WHERE id = ?",
        )
        .get(Number(artist.id));
    if (stored) {
      upsertLibraryArtist({
        identityKey: stored.identity_key,
        mbid: artist.mbid,
        name: artist.name,
        metadata: {
          monitored: mapped.monitored,
          monitor: option,
          monitorOption: option,
          monitorNewItems: mapped.monitorNewItems,
          addOptions: { monitor: option },
        },
      });
    }
    if (option !== "none") {
      const albums = await this.getAlbums(mapped.id, null, {
        forceRefresh: true,
        managedBy: "lidarr",
      });
      if (albums.length > 0) await this.applyArtistMonitoringDefaults(mapped, albums);
      else this.scheduleArtistMonitoringDefaults(mapped);
    }
    scheduleLibraryReconciliation();
    return mapped;
  }

  async setAurralArtistMonitoring(mbid: string, request: AurralMonitoringRequest | null) {
    const artist = libraryArtistFallback(mbid);
    if (!artist) {
      return { error: "Artist not found in the library", statusCode: 404 };
    }
    return serializeMonitoringUpdate(_artistMonitoringUpdates, Number(artist.id), async () => {
      const currentArtist = libraryArtistFallback(artist.id);
      const artistId = Number(currentArtist.id);
      const defaults = getMonitoringDefaults();
      const previous =
        currentArtist.managedBy === "aurral" ? getAurralArtistMonitoring(artistId, defaults) : null;
      const stored = request ? nextArtistMonitoring(previous, request, defaults) : null;
      const effective = resolveArtistMonitoring(stored, defaults);
      const plan = await this.planAurralArtistMonitoring(currentArtist, effective);
      if (plan.error) return plan;
      const legacyMode = legacyMonitorMode(effective);
      db.transaction(() => {
        const storedArtist = db
          .prepare<[number], Pick<LibraryArtistsRow, "identity_key" | "metadata_json">>(
            "SELECT identity_key, metadata_json FROM library_artists WHERE id = ?",
          )
          .get(artistId)!;
        const metadata = readRawLibraryMetadata(storedArtist.metadata_json);
        const { addOptions } = metadata;
        setAurralArtistMonitoringState(artistId, stored, defaults);
        upsertLibraryArtist({
          identityKey: storedArtist.identity_key,
          mbid: currentArtist.mbid,
          name: currentArtist.name,
          metadata: {
            ...metadata,
            monitored: Boolean(stored),
            monitor: legacyMode,
            monitorOption: legacyMode,
            monitorStartedAt: effective?.newSince ?? null,
            addOptions: {
              ...(typeof addOptions === "object" ? addOptions : {}),
              monitor: legacyMode,
            },
          },
        });
      }).immediate();
      const queued = this._enqueueAurralMonitoringApply(currentArtist, effective, plan);
      return {
        ...(libraryArtistFallback(artistId) || currentArtist),
        ...describeAurralMonitoring(effective, defaults),
        monitoring: summarizeMonitoringPlan(plan, queued),
      };
    });
  }

  async previewAurralArtistMonitoring(
    mbid: string,
    {
      monitoring,
      artistName = null,
    }: { monitoring?: MonitoringInput | null; artistName?: string | null } = {},
  ) {
    const resolved = resolveAurralMonitoringRequest({ monitoring });
    if (resolved.error) return resolved;
    const artist = libraryArtistFallback(mbid);
    if (artist?.managedBy === "lidarr") {
      return {
        error: "Lidarr manages this artist's monitoring",
        statusCode: 409,
        code: "lidarr_monitoring",
      };
    }
    const defaults = getMonitoringDefaults();
    const previous =
      artist?.managedBy === "aurral"
        ? getAurralArtistMonitoring(Number(artist.id), defaults)
        : null;
    const stored = resolved.request
      ? nextArtistMonitoring(previous, resolved.request, defaults)
      : null;
    const effective = resolveArtistMonitoring(stored, defaults);
    const plan = await this.planAurralArtistMonitoring(
      artist || { mbid, name: String(artistName || "").trim() },
      effective,
    );
    if (plan.error) return plan;
    return {
      ...describeAurralMonitoring(effective, defaults),
      monitoring: summarizeMonitoringPlan(plan, false),
    };
  }

  _defaultMonitoringArtists() {
    return [...getManagedByMap("artist").entries()].filter(
      ([, entry]) => entry.managedBy === "aurral" && entry.monitorRules?.default === true,
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
      const plan = await this.planAurralArtistMonitoring(
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
          setAurralArtistMonitoringState(artistId, entry.monitorRules, next);
        }
      }).immediate();
      enqueueSystemTaskJob({ kind: "aurral-monitoring-reconcile" });
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
    const effective = artist ? getAurralArtistMonitoring(Number(artist.id)) : null;
    return (effective?.rules || getMonitoringDefaults().rules).edition;
  }

  _canAcquireMonitoredAlbum(
    artistMbid: string | null | undefined,
    albumMbid: string | null | undefined,
    expectedToken: string | null = null,
  ) {
    const artist = libraryArtistFallback(artistMbid);
    const effective = artist ? getAurralArtistMonitoring(Number(artist.id)) : null;
    if (!effective) return false;
    if (expectedToken && monitoringToken(effective) !== expectedToken) return false;
    if (isAlbumMonitoringExcluded(albumMbid)) return false;
    const album = libraryAlbumForReference(albumMbid);
    const albumState = album && getLibraryManagementEntry("album", Number(album.id));
    return album?.managedBy !== "lidarr" && albumState?.monitorMode !== "unmonitored";
  }

  async acquireAurralReleases({
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
    const effective = artist ? getAurralArtistMonitoring(Number(artist.id)) : null;
    const expectedToken = token || monitoringToken(effective);
    for (const release of releaseGroups) {
      if (!this._canAcquireMonitoredAlbum(artistMbid, release.id, expectedToken)) {
        results.push({ releaseGroupId: release.id, status: "skipped" });
        continue;
      }
      try {
        const album: MethodResult<"_addAurralAlbum"> = await this._addAurralAlbum(
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
      if (monitoringToken(getAurralArtistMonitoring(Number(artist.id))) !== token) return;
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

  async reconcileAurralMonitoring() {
    const defaults = getMonitoringDefaults();
    const monitoredArtists = [...getManagedByMap("artist").entries()].filter(
      ([, entry]) => entry.managedBy === "aurral" && entry.monitorRules,
    );
    let queuedAlbums = 0;
    let queuedTracks = 0;
    let failedArtists = 0;
    for (const [artistId, entry] of monitoredArtists) {
      const artist = libraryArtistFallback(artistId);
      if (!artist?.mbid) continue;
      const effective = resolveArtistMonitoring(entry.monitorRules, defaults);
      const plan = await this.planAurralArtistMonitoring(artist, effective);
      if (plan.error) {
        failedArtists += 1;
        continue;
      }
      const newReleases = plan.releases.filter((release) => !release.existing);
      const topTracks = plan.topTracks || [];
      if (newReleases.length === 0 && topTracks.length === 0) continue;
      await this.acquireAurralReleases({
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

  _resolveAurralAlbum(canonicalId: unknown) {
    const reference = String(canonicalId ?? "").trim();
    const id = Number(reference);
    if (!/^\d+$/.test(reference) || !Number.isSafeInteger(id) || id <= 0) {
      return {
        error: "canonicalId must be a positive integer",
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
    if (mappedAlbum.managedBy !== "aurral") {
      return buildAlbumConflict(mappedAlbum);
    }
    return { album, artist, library, mappedAlbum };
  }

  _summarizeAurralAlbum(
    album: LibraryAlbumRecord,
    tracks: LibraryTrackRecord[],
    jobsForAlbum: typeof findAurralAlbumJobs = findAurralAlbumJobs,
  ) {
    const sourceConfigured = isAnyDownloadSourceConfigured();
    return {
      managedBy: "aurral",
      ...summarizeAurralAlbum({
        tracks: tracks.filter((track) => album.trackIds.includes(track.id)),
        jobs: jobsForAlbum(albumJobKeys(album)),
        sourceConfigured,
        sourceMessage: sourceConfigured ? null : getDownloadSourceNotConfiguredMessage(),
      }),
    };
  }

  async setAurralAlbumMonitoring(
    canonicalId: unknown,
    { monitored }: { monitored?: unknown } = {},
  ) {
    if (typeof monitored !== "boolean") {
      return {
        error: "monitored must be true or false",
        statusCode: 400,
        code: "invalid_monitored",
      };
    }
    return serializeMonitoringUpdate(_albumMonitoringUpdates, Number(canonicalId), async () => {
      const resolved = this._resolveAurralAlbum(canonicalId);
      if (failed(resolved)) return resolved;
      const { album, mappedAlbum } = resolved;
      this._setAurralAlbumMonitored(album, monitored);
      if (monitored) {
        const albumMbid = album.releaseGroupMbid || album.mbid;
        clearAlbumMonitoringExclusion(albumMbid);
        const result =
          albumMbid && album.metadata?.trackListComplete !== true
            ? await this._addAurralAlbum(album.artistId, albumMbid, album.title)
            : await this._finishAurralAlbum(album.id);
        if (result?.error) return result;
        return { ...result, monitored: true };
      }
      const cancellation = await cancelAurralAlbumJobs(albumJobKeys(album));
      return {
        ...mappedAlbum,
        monitored: false,
        ...cancellation,
        albumStatus: this.getAurralAlbumStatus(album.id),
      };
    });
  }

  _setAurralAlbumMonitored(album: LibraryAlbumRecord, monitored: boolean) {
    db.transaction(() => {
      setLibraryManagement({
        entityKind: "album",
        entityId: album.id,
        managedBy: "aurral",
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

  getAurralAlbumStatus(canonicalId: string | number) {
    return this.getAurralAlbumStatuses([canonicalId])[0];
  }

  getAurralAlbumStatuses(canonicalIds: (string | number)[]) {
    const resolved = canonicalIds.map((canonicalId) => this._resolveAurralAlbum(canonicalId));
    const jobsForAlbum = indexAurralAlbumJobs(
      resolved.flatMap((entry) => (failed(entry) ? [] : albumJobKeys(entry.album))),
    );
    return resolved.map((entry) =>
      failed(entry)
        ? entry
        : {
            canonicalId: entry.mappedAlbum.canonicalId,
            ...this._summarizeAurralAlbum(entry.album, entry.library.tracks, jobsForAlbum),
          },
    );
  }

  async setAurralTrackMonitoring(
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
        error: "canonicalId must be a positive integer",
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
      const aurralAlbums = library.albums.filter((album) => album.managedBy === "aurral");
      setTrackMonitoredStmt.run(monitored ? 1 : 0, trackId);
      invalidateLibraryQueryCache({ persistedGenres: false });
      const cancelledJobIds = [];
      const queuedJobIds: string[] = [];
      let cleanupFailed = false;
      if (aurralAlbums.length === 0) {
        if (!monitored) {
          const cancellation = await cancelLibraryTrackJobs(
            track,
            trackAlbumOwnerNames(library, track),
          );
          cancelledJobIds.push(...cancellation.cancelledJobIds);
          cleanupFailed = cancellation.cleanupFailed;
        }
        return {
          canonicalId: String(trackId),
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
            aurralAlbums.find((entry) =>
              albumJobKeys(entry).some((key) => String(key || "").toLowerCase() === group),
            )) ||
          aurralAlbums.find((entry) => isMonitoredAurralAlbum(entry.id)) ||
          aurralAlbums[0];
        const result: MethodResult<"_finishAurralAlbum"> = await serializeMonitoringUpdate(
          _albumMonitoringUpdates,
          album.id,
          () => this._finishAurralAlbum(album.id, { trackIds: [trackId] }),
        );
        queuedJobIds.push(...(result?.jobIds || []));
      } else {
        for (const album of aurralAlbums) {
          const cancellation = await cancelAurralTrackJobs(albumJobKeys(album), track);
          cancelledJobIds.push(...cancellation.cancelledJobIds);
          cleanupFailed ||= cancellation.cleanupFailed;
        }
      }
      return {
        canonicalId: String(trackId),
        monitored,
        cancelledJobIds,
        queuedJobIds,
        cleanupFailed,
      };
    });
  }

  async setTrackKeepFile(canonicalId: unknown, { keepFile }: { keepFile?: unknown } = {}) {
    if (typeof keepFile !== "boolean") {
      return {
        error: "keepFile must be true or false",
        statusCode: 400,
        code: "invalid_keep_file",
      };
    }
    const reference = String(canonicalId ?? "").trim();
    const trackId = Number(reference);
    if (!/^\d+$/.test(reference) || !Number.isSafeInteger(trackId) || trackId <= 0) {
      return {
        error: "canonicalId must be a positive integer",
        statusCode: 400,
        code: "invalid_canonical_id",
      };
    }
    const track = getLibraryForTrackIds({ ids: [trackId] }).tracks.find(
      (entry) => entry.id === trackId,
    );
    if (!track) {
      return { error: "Track was not found in the library", statusCode: 404, code: "not_found" };
    }
    setTrackKeepFileStmt.run(keepFile ? 1 : 0, trackId);
    invalidateLibraryQueryCache({ persistedGenres: false });
    const cancellation = keepFile
      ? await cancelFileUpgradeJobs(
          track.files.map((file) => file.path).filter((path): path is string => Boolean(path)),
        )
      : { cancelledJobIds: [], cleanupFailed: false };
    return { canonicalId: String(trackId), keepFile, ...cancellation };
  }

  // A track asked for from an album's page goes to that album when the
  // Library holds it there.
  async monitorAurralTrack({
    canonicalTrackId = null,
    trackMbid = null,
    albumMbid = null,
  }: {
    canonicalTrackId?: unknown;
    trackMbid?: string | null;
    albumMbid?: string | null;
  } = {}) {
    const mbid = String(trackMbid || "").trim();
    const group = String(albumMbid || "")
      .trim()
      .toLowerCase();
    const trackId = /^\d+$/.test(String(canonicalTrackId ?? "").trim())
      ? Number(canonicalTrackId)
      : (mbid &&
          ((group && trackIdByMbidOnAlbumStmt.get(mbid, group, group)?.id) ||
            trackIdByMbidStmt.get(mbid)?.id)) ||
        null;
    if (!trackId) return null;
    const result = await this.setAurralTrackMonitoring(trackId, { monitored: true, albumMbid });
    return result?.error || result?.albumManaged === false ? null : result;
  }

  async searchAurralAlbumMissingTracks(canonicalId: string | number) {
    const albumId = Number(canonicalId);
    return serializeMonitoringUpdate(_albumMonitoringUpdates, albumId, () =>
      this._finishAurralAlbum(albumId, { skipCancelledTracks: true }),
    );
  }

  async cancelAurralAlbum(canonicalId: unknown) {
    const resolved = this._resolveAurralAlbum(canonicalId);
    if (failed(resolved)) return resolved;
    const { album, mappedAlbum } = resolved;
    const result = await cancelAurralAlbumJobs(albumJobKeys(album));
    return {
      canonicalId: mappedAlbum.canonicalId,
      managedBy: "aurral",
      ...result,
    };
  }

  async deleteAurralAlbum(canonicalId: unknown, deleteFiles = false) {
    const resolved = this._resolveAurralAlbum(canonicalId);
    if (failed(resolved)) return resolved;
    const { album, artist, library, mappedAlbum } = resolved;
    const artistState = getLibraryManagementEntry("artist", Number(album.artistId));
    const result = await this._removeAurralAlbumContents(album, library, deleteFiles);
    if (result.error) return result;
    const excluded = addMonitoringExclusion({
      kind: "album",
      mbid: album.releaseGroupMbid || album.mbid,
      artistMbid: artist?.mbid,
      artistName: artist?.name,
      title: album.title,
    });
    if (!artistState) removeLibraryArtistIfEmpty(album.artistId);
    return { success: true, canonicalId: mappedAlbum.canonicalId, excluded };
  }

  async _removeAurralAlbumContents(
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
      const lidarrFile = db.prepare(
        "SELECT 1 FROM library_media_files WHERE source = 'lidarr' AND available = 1 AND path IN (?, ?)",
      );
      const sharedWithLidarr = new Set(
        paths.filter((filePath) => lidarrFile.get(filePath, path.resolve(filePath))),
      );
      markLibraryMediaFilesUnavailable("aurral", [...sharedWithLidarr]);
      const error = await deleteAurralLibraryFiles(
        paths.filter((filePath) => !sharedWithLidarr.has(filePath)),
      );
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

  async _deleteAurralArtist(artist: LibraryArtistProjection, deleteFiles: boolean) {
    const ownsArtist =
      getLibraryManagementEntry("artist", Number(artist.id))?.managedBy !== "lidarr";
    if (ownsArtist) {
      setLibraryManagement({
        entityKind: "artist",
        entityId: Number(artist.id),
        managedBy: "aurral",
        monitorMode: "none",
        monitorRules: null,
      });
    }
    const library = libraryForArtist(artist.id);
    for (const album of library.albums) {
      if (album.managedBy === "lidarr") continue;
      const result = await this._removeAurralAlbumContents(album, library, deleteFiles);
      if (result.error) {
        return {
          success: false,
          code: result.code,
          statusCode: result.statusCode,
          error: result.error,
        };
      }
    }
    if (ownsArtist) {
      clearLibraryManagement("artist", Number(artist.id));
      clearArtistMonitoringExclusions(artist.mbid);
      removeLibraryArtistIfEmpty(artist.id);
    }
    logger.info("library", `[LibraryManager] Removed Aurral artist "${artist.name}"`);
    return { success: true };
  }

  async _addAurralAlbum(
    artistId: string | number | undefined,
    releaseGroupMbid: string,
    albumName: string,
    options: AlbumAddOptions = {},
  ): Promise<Awaited<ReturnType<LibraryManager["_finishAurralAlbum"]>> | AlbumConflict | Failure> {
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
      return buildAlbumConflict(existing, "Album identity already belongs to a different artist");
    }
    if (existing?.managedBy && existing.managedBy !== "aurral") {
      return buildAlbumConflict(existing);
    }
    const storedAlbum = existing
      ? null
      : db
          .prepare<[string | null], Pick<LibraryAlbumsRow, "id" | "title">>(
            "SELECT id, title FROM library_albums WHERE identity_key = ?",
          )
          .get(buildIdentityKey("release-group", normalizedAlbumMbid));
    const storedOwner = getLibraryManagementEntry("album", storedAlbum?.id)?.managedBy;
    if (storedOwner && storedOwner !== "aurral") {
      return buildAlbumConflict({
        ...storedAlbum,
        managedBy: storedOwner,
        mbid: normalizedAlbumMbid,
      });
    }
    const userRequest = !options.monitoringToken;
    if (userRequest) clearAlbumMonitoringExclusion(normalizedAlbumMbid);
    const wasMonitored = existing !== null && isMonitoredAurralAlbum(existing.id);
    const existingAlbum = existing ? libraryForAlbum(existing.id).albums[0] : null;
    const tracked =
      existing && existingAlbum && (existingAlbum.trackIds?.length ?? 0) > 0
        ? { existing, existingAlbum }
        : null;
    const finishExisting = (found: NonNullable<typeof tracked>) => {
      if (userRequest && !wasMonitored) this._setAurralAlbumMonitored(found.existingAlbum, true);
      return this._finishAurralAlbum(found.existing.id, options);
    };
    const finishExistingOr = <Result>(error: Result) => (tracked ? finishExisting(tracked) : error);
    const edition = options.edition || this._albumEdition(artist);
    if (tracked) {
      if (!tracked.existing.managedBy) {
        setLibraryManagement({
          entityKind: "album",
          entityId: tracked.existing.id,
          managedBy: "aurral",
          monitorMode: options.monitorMode || options.monitorOption || null,
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
      metadata = await getMetadataAlbumByMbid(normalizedAlbumMbid);
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
      .filter((track) => track.trackMbid && track.title);
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
      options.monitorOption ||
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
          monitor: monitorMode || "none",
          monitorOption: monitorMode || "none",
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
            ...(aliases?.length ? { artistAliases: aliases } : {}),
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
        managedBy: "aurral",
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
    return this._finishAurralAlbum(albumRecord.id, options);
  }

  async addAlbum(
    artistId: string | number,
    releaseGroupMbid: string,
    albumName: string,
    options: AlbumAddOptions = {},
  ): Promise<AlbumAddResult | AlbumConflict | Failure> {
    let managedBy;
    try {
      managedBy = await this.resolveAlbumManagedBy(options.managedBy, releaseGroupMbid);
    } catch (error) {
      const failure = asAppError(error);
      return {
        error: failure?.message,
        statusCode: failure?.statusCode || 400,
        code: failure?.code || null,
      };
    }
    const albumKey = String(releaseGroupMbid || "")
      .trim()
      .toLowerCase();
    if (!albumKey) {
      return managedBy === "aurral"
        ? this._addAurralAlbum(artistId, releaseGroupMbid, albumName, { ...options, managedBy })
        : this._addAlbum(artistId, releaseGroupMbid, albumName, { ...options, managedBy });
    }

    const existingRequest = _albumAddInflight.get(albumKey);
    if (existingRequest) {
      const result = await existingRequest;
      if (result?.managedBy && result.managedBy !== managedBy) {
        return buildAlbumConflict(result);
      }
      if (result?.artistId != null && String(result.artistId) !== String(artistId)) {
        return {
          ...buildAlbumConflict(result, ALBUM_OWNED_BY_DIFFERENT_ARTIST_ERROR),
        };
      }
      return result;
    }

    const added: Promise<AlbumAddResult> =
      managedBy === "aurral"
        ? this._addAurralAlbum(artistId, releaseGroupMbid, albumName, { ...options, managedBy })
        : this._addAlbum(artistId, releaseGroupMbid, albumName, { ...options, managedBy });
    const request = added
      .then(async (result) => {
        if (managedBy === "lidarr" && !result?.error) {
          await this._handAurralAlbumToLidarr(String(releaseGroupMbid).trim());
        }
        return result;
      })
      .finally(() => {
        if (_albumAddInflight.get(albumKey) === request) {
          _albumAddInflight.delete(albumKey);
        }
      });
    _albumAddInflight.set(albumKey, request);
    return request;
  }

  async _addAlbum(
    artistId: string | number,
    releaseGroupMbid: string,
    albumName: string,
    options: AlbumAddOptions = {},
  ): Promise<MappedLidarrAlbum | Failure> {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return { error: "Lidarr is not configured" };
    }
    try {
      const isArtistNotReadyError = (error: unknown) => {
        const msg = String(asAppError(error)?.message || "").toLowerCase();
        return msg.includes("404") || msg.includes("not found") || msg.includes("artist with id");
      };
      const isAlbumAlreadyAddedError = (error: unknown) => {
        const msg = String(asAppError(error)?.message || "").toLowerCase();
        return (
          msg.includes("this album has already been added") ||
          msg.includes("albumexistsvalidator") ||
          msg.includes("foreignalbumid") ||
          msg.includes("unique constraint")
        );
      };
      const settings = getSettings();
      const searchOnAdd = settings.integrations?.lidarr?.searchOnAdd ?? false;
      const shouldTriggerSearch =
        options.triggerSearch === true || (options.triggerSearch === undefined && searchOnAdd);
      const mapExistingAlbum = async (
        existingAlbum: LidarrAlbumRecord | null | undefined,
        fallbackArtist: LidarrArtist | null = null,
      ) => {
        if (!existingAlbum) return null;
        if (!existingAlbum.monitored) {
          await lidarr.monitorAlbum(existingAlbum.id, true);
        }
        if (shouldTriggerSearch) {
          await lidarr.triggerAlbumSearch(existingAlbum.id);
          await this.ensureRequestedAlbumMonitoring(artistId, existingAlbum.id);
          this.scheduleRequestedAlbumMonitoringRepair(artistId, existingAlbum.id);
        }
        const refreshedExisting = await lidarr
          .getAlbum(existingAlbum.id)
          .catch(() => existingAlbum);
        const refreshedArtist = await lidarr.getArtist(artistId).catch(() => fallbackArtist);
        if (!refreshedArtist) return null;
        if (!refreshedExisting) throw new Error("Album not found in Lidarr");
        const mapped = this.mapLidarrAlbum(refreshedExisting, refreshedArtist);
        recordLidarrOwner(refreshedArtist, refreshedExisting);
        scheduleLibraryReconciliation();
        return mapped;
      };
      let lidarrArtist: LidarrArtist | null = null;
      const artistResolveAttempts = 8;
      const artistResolveDelayMs = 1250;
      for (let attempt = 1; attempt <= artistResolveAttempts; attempt++) {
        try {
          lidarrArtist = await lidarr.getArtist(artistId);
        } catch (error) {
          if (attempt < artistResolveAttempts && isArtistNotReadyError(error)) {
            await sleep(artistResolveDelayMs);
            continue;
          }
          throw error;
        }
        if (lidarrArtist) break;
        if (attempt < artistResolveAttempts) {
          await sleep(artistResolveDelayMs);
        }
      }
      if (!lidarrArtist) return { error: "Artist not found in Lidarr" };
      if (lidarrArtist.monitored === false) {
        lidarrArtist = await lidarr.updateArtistMonitoring(
          artistId,
          lidarrArtist.monitor || lidarrArtist.addOptions?.monitor || "none",
        );
      }
      const existing = await lidarr.getAlbumByMbid(releaseGroupMbid, {
        forceRefresh: true,
      });
      const artistNumericId = parseInt(String(artistId), 10);
      const sameArtistExisting =
        existing && String(existing.artistId) === String(artistNumericId) ? existing : null;
      if (existing?.artistId != null && !sameArtistExisting) {
        return {
          error: ALBUM_OWNED_BY_DIFFERENT_ARTIST_ERROR,
          statusCode: 409,
        };
      }
      if (sameArtistExisting) {
        const mappedExisting = await mapExistingAlbum(sameArtistExisting, lidarrArtist);
        if (mappedExisting) return mappedExisting;
        return { error: "Failed to resolve existing album in Lidarr" };
      }
      let lidarrAlbum: LidarrAlbumRecord | null = null;
      const addAlbumAttempts = 4;
      const addAlbumDelayMs = 1500;
      for (let attempt = 1; attempt <= addAlbumAttempts; attempt++) {
        try {
          lidarrAlbum = await lidarr.addAlbum(artistId, releaseGroupMbid, albumName, {
            monitored: true,
            triggerSearch:
              options.triggerSearch === true ||
              (options.triggerSearch === undefined && searchOnAdd),
          });
          break;
        } catch (error) {
          if (isAlbumAlreadyAddedError(error)) {
            const existingAfterConflict =
              (await this.waitForAlbumByMbidForArtist(releaseGroupMbid, artistNumericId, {
                delaysMs: [500, 1000, 2000, 4000],
              })) ||
              (await lidarr
                .getAlbumByMbid(releaseGroupMbid, { forceRefresh: true })
                .catch(() => null));
            const sameArtistAfterConflict =
              existingAfterConflict &&
              String(existingAfterConflict.artistId) === String(artistNumericId)
                ? existingAfterConflict
                : null;
            if (sameArtistAfterConflict) {
              const mappedConflictAlbum = await mapExistingAlbum(
                sameArtistAfterConflict,
                lidarrArtist,
              );
              if (mappedConflictAlbum) return mappedConflictAlbum;
            }
            if (existingAfterConflict?.artistId != null) {
              return {
                error: ALBUM_OWNED_BY_DIFFERENT_ARTIST_ERROR,
                statusCode: 409,
              };
            }
          }
          if (attempt < addAlbumAttempts && isArtistNotReadyError(error)) {
            await sleep(addAlbumDelayMs);
            continue;
          }
          throw error;
        }
      }
      if (!lidarrAlbum) {
        return { error: "Failed to add album to Lidarr" };
      }
      if (shouldTriggerSearch) {
        await this.ensureRequestedAlbumMonitoring(artistId, lidarrAlbum.id);
        this.scheduleRequestedAlbumMonitoringRepair(artistId, lidarrAlbum.id);
        lidarrAlbum = await lidarr.getAlbum(lidarrAlbum.id).catch(() => lidarrAlbum);
      }
      const updatedArtist = await lidarr.getArtist(artistId);
      if (!lidarrAlbum) throw new Error("Album not found in Lidarr");
      if (!updatedArtist) throw new Error("Artist not found in Lidarr");
      const mapped = this.mapLidarrAlbum(lidarrAlbum, updatedArtist);
      recordLidarrOwner(updatedArtist, lidarrAlbum);
      scheduleLibraryReconciliation();
      return mapped;
    } catch (error) {
      const failure = asAppError(error);
      logger.error(
        "library",
        `[LibraryManager] Failed to add album to Lidarr: ${failure?.message}`,
      );
      return { error: failure?.message };
    }
  }

  async _handAurralAlbumToLidarr(albumMbid: string | null | undefined) {
    const existing = albumMbid ? libraryAlbumForReference(albumMbid) : null;
    if (existing?.managedBy !== "aurral") return;
    const album = libraryForAlbum(existing.id).albums[0];
    db.transaction(() => {
      setLibraryManagement({ entityKind: "album", entityId: album.id, managedBy: "lidarr" });
      setAlbumTracksMonitoredStmt.run(0, album.id);
      upsertLibraryAlbum({
        identityKey: album.identityKey,
        artistId: album.artistId,
        title: album.title,
        metadata: { ...album.metadata, aurralHandoverAt: Date.now() },
      });
    }).immediate();
    invalidateLibraryQueryCache({ persistedGenres: false });
    await cancelAurralAlbumJobs(albumJobKeys(album));
  }

  async requestAlbumFromSearch({
    albumMbid,
    albumName,
    artistMbid,
    artistName,
    triggerSearch = false,
    user = null,
    managedBy: requestedManagedBy = null,
  }: {
    albumMbid?: string | null;
    albumName?: string | null;
    artistMbid?: string | null;
    artistName?: string | null;
    triggerSearch?: boolean;
    user?: LibraryUser;
    managedBy?: string | null;
  } = {}) {
    const managedBy = await this.resolveAlbumManagedBy(requestedManagedBy, albumMbid);
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

    if (managedBy === "aurral") {
      const existingAlbum = libraryAlbumForReference(normalizedAlbumMbid);
      let artist = await this.getArtist(normalizedArtistMbid, {
        managedBy: "aurral",
      });
      let createdArtist = false;

      if (existingAlbum?.managedBy && existingAlbum.managedBy !== "aurral") {
        throwLibraryError(buildAlbumConflict(existingAlbum));
      }
      if (existingAlbum && artist && String(existingAlbum.artistId) !== String(artist.id)) {
        throwLibraryError(
          buildAlbumConflict(existingAlbum, "Album identity already belongs to a different artist"),
        );
      }

      if (!artist) {
        if (!hasPermission(user, "addArtist")) {
          const error: CodedError = new Error(
            "Permission required: addArtist to create the album artist",
          );
          error.statusCode = 403;
          throw error;
        }
        const created: MethodResult<"addArtistWithResolvedOptions"> =
          await this.addArtistWithResolvedOptions(normalizedArtistMbid, normalizedArtistName, {
            managedBy: "aurral",
            user,
            monitorOption: "none",
            albumOnly: true,
            albumMbid: normalizedAlbumMbid,
            triggerSearch: false,
          });
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
        {
          managedBy: "aurral",
          user,
          triggerSearch: triggerSearch === true,
        },
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
        managedBy: "aurral",
        jobIds: album.jobIds || [],
        requestGroupId: album.requestGroupId || null,
        albumStatus: album.albumStatus || null,
      };
    }

    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      const error: CodedError = new Error("Lidarr is not configured");
      error.statusCode = 503;
      throw error;
    }

    const settings = getSettings();
    const searchOnAdd = settings.integrations?.lidarr?.searchOnAdd ?? false;
    const shouldTriggerSearch = triggerSearch === true || searchOnAdd;

    let artist = await this.getArtist(normalizedArtistMbid, { managedBy });
    let createdArtist = false;

    if (!artist) {
      if (!hasPermission(user, "addArtist")) {
        const error: CodedError = new Error(
          "Permission required: addArtist to create the album artist",
        );
        error.statusCode = 403;
        throw error;
      }

      const resolvedArtistAddOptions: MethodResult<"resolveArtistAddOptions"> =
        await this.resolveArtistAddOptions({
          user,
          managedBy,
        });
      if (resolvedArtistAddOptions?.error) {
        const error: CodedError = new Error(resolvedArtistAddOptions.error);
        error.statusCode = 503;
        throw error;
      }
      const created: MethodResult<"addArtistWithResolvedOptions"> =
        await this.addArtistWithResolvedOptions(normalizedArtistMbid, normalizedArtistName, {
          ...resolvedArtistAddOptions,
          user,
          managedBy,
          albumOnly: true,
          albumMbid: normalizedAlbumMbid,
          triggerSearch: shouldTriggerSearch,
        });
      if (failed(created)) {
        const error: CodedError = new Error(created.error);
        error.statusCode = 503;
        throw error;
      }
      artist = created;
      createdArtist = true;
    }

    if (!artist?.id) {
      const error: CodedError = new Error("Failed to resolve artist in Lidarr");
      error.statusCode = 503;
      throw error;
    }

    artist = await this.ensureArtistMonitored(artist);

    let existingAlbum = await lidarr.getAlbumByMbid(normalizedAlbumMbid, {
      forceRefresh: true,
    });
    if (
      existingAlbum &&
      existingAlbum.artistId != null &&
      String(existingAlbum.artistId) !== String(artist.id)
    ) {
      const error: CodedError = new Error(ALBUM_OWNED_BY_DIFFERENT_ARTIST_ERROR);
      error.statusCode = 409;
      throw error;
    }

    const album: MethodResult<"addAlbum"> = await this.addAlbum(
      artist.id!,
      normalizedAlbumMbid,
      normalizedAlbumName,
      {
        managedBy,
        user,
        triggerSearch: shouldTriggerSearch,
      },
    );

    if (failed(album)) {
      const error: CodedError = new Error(album.error);
      error.statusCode =
        typeof album.statusCode === "number" &&
        Number.isInteger(album.statusCode) &&
        album.statusCode >= 400
          ? album.statusCode
          : 503;
      throw error;
    }

    const albumStatus =
      (album.statistics?.percentOfTracks ?? 0) >= 100 || (album.statistics?.sizeOnDisk ?? 0) > 0
        ? "available"
        : shouldTriggerSearch
          ? "searching"
          : "inLibrary";

    return {
      success: true,
      artist,
      album,
      createdArtist,
      createdAlbum: !existingAlbum,
      triggeredSearch: shouldTriggerSearch,
      status: albumStatus,
    };
  }

  async getAlbums(
    artistId: unknown,
    lidarrArtist: LidarrArtist | null = null,
    options: { managedBy?: string | null; includeAurral?: boolean; forceRefresh?: boolean } = {},
  ) {
    const manager = normalizeLibraryManager(options.managedBy);
    if (
      manager === "aurral" ||
      (manager == null && libraryArtistFallback(artistId)?.managedBy === "aurral")
    ) {
      return libraryAlbumsForArtist(artistId, { includeSharedAlbums: true });
    }
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return libraryAlbumsForArtist(artistId, { includeSharedAlbums: true });
    }
    try {
      const resolvedArtist = lidarrArtist || (await lidarr.getArtist(String(artistId)));
      if (!resolvedArtist) {
        return [];
      }
      const allAlbums = await lidarr.getAllAlbums({
        artistIds: [String(artistId)],
        forceRefresh: options.forceRefresh,
      });
      const artistAlbums = allAlbums.filter((a) => a.artistId === parseInt(String(artistId)));
      const lidarrAlbums = artistAlbums.map((a) => this.mapLidarrAlbum(a, resolvedArtist));
      if (!options.includeAurral) return lidarrAlbums;
      const lidarrMbids = new Set<string | null>(
        lidarrAlbums.map((album) => album.mbid).filter((mbid): mbid is string => Boolean(mbid)),
      );
      const aurralAlbums = libraryAlbumsForArtist(resolvedArtist.foreignArtistId, {
        includeSharedAlbums: true,
      }).filter((album) => album.managedBy === "aurral" && !lidarrMbids.has(album.mbid));
      return [...lidarrAlbums, ...aurralAlbums];
    } catch (error) {
      const failure = asAppError(error);
      if (isLidarrNotFoundError(error)) return [];
      logger.error(
        "library",
        `[LibraryManager] Failed to fetch albums from Lidarr: ${failure?.message}`,
      );
      return manager ? [] : libraryAlbumsForArtist(artistId, { includeSharedAlbums: true });
    }
  }

  async getAlbumById(
    id: string | number,
    { managedBy = null }: { managedBy?: string | null } = {},
  ) {
    const manager = normalizeLibraryManager(managedBy);
    const found = libraryAlbumForReference(id);
    if (manager === "aurral" || (managedBy == null && found?.managedBy === "aurral")) return found;
    const libraryAlbum = manager === "lidarr" && found?.managedBy === "aurral" ? null : found;
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) return libraryAlbum;
    if (!id || id === "undefined" || id === "null") {
      return null;
    }
    try {
      const lidarrAlbum = await lidarr.getAlbum(id);
      if (!lidarrAlbum) return managedBy == null ? libraryAlbum : null;
      const lidarrArtist = await lidarr.getArtist(String(lidarrAlbum.artistId));
      if (!lidarrArtist) return libraryAlbum;
      return this.mapLidarrAlbum(lidarrAlbum, lidarrArtist);
    } catch (error) {
      if (isLidarrNotFoundError(error)) return managedBy == null ? libraryAlbum : null;
      return libraryAlbum;
    }
  }

  mapLidarrAlbum(lidarrAlbum: LidarrAlbumRecord, lidarrArtist: LidarrArtist) {
    const albumPath =
      lidarrAlbum.path ??
      (lidarrArtist.path
        ? path.join(lidarrArtist.path, this.sanitizePath(lidarrAlbum.title!))
        : null);

    const rawStats = lidarrAlbum.statistics || {};
    let percentOfTracks = rawStats.percentOfTracks;

    if (percentOfTracks !== undefined) {
      if (percentOfTracks > 1 && percentOfTracks <= 100) {
        percentOfTracks = Math.round(percentOfTracks);
      } else if (percentOfTracks <= 1 && percentOfTracks >= 0) {
        percentOfTracks = Math.round(percentOfTracks * 100);
      } else if (percentOfTracks > 100) {
        percentOfTracks = Math.min(100, Math.round(percentOfTracks / 10));
      }
    }

    return {
      id: lidarrAlbum.id?.toString() || lidarrAlbum.foreignAlbumId,
      artistId: lidarrAlbum.artistId?.toString() || lidarrArtist.id?.toString(),
      artistName: lidarrArtist.name ?? null,
      mbid: lidarrAlbum.foreignAlbumId,
      foreignAlbumId: lidarrAlbum.foreignAlbumId,
      albumName: lidarrAlbum.title,
      path: albumPath,
      addedAt: lidarrAlbum.added || new Date().toISOString(),
      releaseDate: lidarrAlbum.releaseDate || null,
      monitored: lidarrAlbum.monitored || false,
      statistics: {
        trackCount: rawStats.trackCount || 0,
        sizeOnDisk: rawStats.sizeOnDisk || 0,
        percentOfTracks: percentOfTracks || 0,
      },
    };
  }

  async updateAlbum(id: string | number, updates: { monitored?: boolean }) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return { error: "Lidarr is not configured" };
    }
    const maxAttempts = 3;
    const delayMs = 1500;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const lidarrAlbum = await lidarr.getAlbum(id);
        if (!lidarrAlbum) {
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, delayMs));
            continue;
          }
          return { error: "Album not found in Lidarr" };
        }
        if (updates.monitored !== undefined) {
          await lidarr.monitorAlbum(id, updates.monitored);
        }
        const updated = await lidarr.getAlbum(id);
        if (!updated) throw new Error("Album not found in Lidarr");
        const lidarrArtist = await lidarr.getArtist(String(updated.artistId));
        if (!lidarrArtist) throw new Error("Artist not found in Lidarr");
        const mapped = this.mapLidarrAlbum(updated, lidarrArtist);
        scheduleLibraryReconciliation();
        return mapped;
      } catch (error) {
        const failure = asAppError(error);
        const msg = failure?.message || "";
        const isTransient =
          msg.includes("503") ||
          msg.includes("502") ||
          msg.includes("504") ||
          msg.includes("Service Unavailable") ||
          msg.includes("Bad Gateway") ||
          msg.includes("Gateway Timeout");
        if (isTransient && attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        logger.error(
          "library",
          `[LibraryManager] Failed to update album in Lidarr: ${failure?.message}`,
        );
        return { error: failure?.message };
      }
    }
    return { error: "Album not found in Lidarr" };
  }

  async deleteLidarrAlbumByMbid(albumMbid: string, deleteFiles = false) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return { success: false, error: "Lidarr is not configured", statusCode: 503 };
    }
    const album = await lidarr.getAlbumByMbid(albumMbid, { forceRefresh: true });
    if (!album?.id)
      return { success: false, error: "Lidarr does not have this album", statusCode: 404 };
    return this.deleteAlbum(album.id, deleteFiles);
  }

  async deleteAlbum(id: string | number, deleteFiles = false) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return { success: false, error: "Lidarr is not configured" };
    }
    try {
      await lidarr.deleteAlbum(id, deleteFiles);
      clearLibraryLidarrAlbum(id);
      scheduleLibraryReconciliation();
      return { success: true };
    } catch (error) {
      const failure = asAppError(error);
      logger.error(
        "library",
        `[LibraryManager] Failed to delete album from Lidarr: ${failure?.message}`,
      );
      return { success: false, error: failure?.message };
    }
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
      const lidarrFiles = track.files.filter((file) => file.source === "lidarr" && file.available);
      if (aurralFiles.length > 0 && lidarrFiles.length === 0) {
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

      if (
        lidarrFiles.length === 0 &&
        track.files.some((file) => file.source === "readonly" && file.available)
      ) {
        return {
          success: false,
          code: "read_only",
          error: "The track's file is in a read-only folder",
        };
      }
      const lidarr = await getLidarrClient();
      if (!lidarr || !lidarr.isConfigured()) {
        return { success: false, code: "lidarr_unavailable", error: "Lidarr is not configured" };
      }
      const lidarrLibrary: LibraryCollection = getLibraryTrack({
        trackId: id,
        source: "lidarr",
        availableOnly: false,
      });
      const lidarrTrack = lidarrLibrary.tracks.find((entry) => String(entry.id) === String(id));
      if (!lidarrTrack) return { success: false, code: "not_found", error: "Track not found" };

      const metadata: TrackMetadata = lidarrTrack.metadata || {};
      let trackFileId = Number(metadata.trackFileId || metadata.trackFile?.id || metadata.file?.id);
      if (!Number.isFinite(trackFileId)) {
        const trackAlbums = Array.isArray(lidarrTrack.albums) ? lidarrTrack.albums : [];
        const album = lidarrLibrary.albums.find((entry) =>
          trackAlbums.some((relation) => String(relation.albumId) === String(entry.id)),
        );
        let lidarrAlbumId = Number(album?.metadata?.id);
        const albumMbid = album?.releaseGroupMbid || album?.mbid;
        if (!Number.isFinite(lidarrAlbumId) && albumMbid) {
          lidarrAlbumId = Number((await lidarr.getAlbumByMbid(albumMbid))?.id);
        }
        if (Number.isFinite(lidarrAlbumId)) {
          const lidarrTracks: LidarrTrackRecord[] = await lidarr.getTracksByAlbumId(lidarrAlbumId);
          const reference = String(metadata.id ?? track.mbid ?? "");
          const title = String(track.title || "")
            .trim()
            .toLowerCase();
          const sameTitle = title
            ? lidarrTracks.filter(
                (entry) =>
                  entry.hasFile &&
                  String(entry.title || "")
                    .trim()
                    .toLowerCase() === title,
              )
            : [];
          const match =
            lidarrTracks.find(
              (entry) =>
                reference &&
                [entry.id, entry.foreignRecordingId, entry.foreignTrackId].some(
                  (candidate) => String(candidate ?? "") === reference,
                ),
            ) || (sameTitle.length === 1 ? sameTitle[0] : null);
          trackFileId = Number(match?.trackFileId);
        }
      }
      if (!Number.isFinite(trackFileId)) {
        return {
          success: false,
          code: "not_found",
          error: "Track file not found in Lidarr",
        };
      }

      await lidarr.deleteTrackFile(trackFileId);
      scheduleLibraryReconciliation();
      return { success: true };
    } catch (error) {
      const failure = asAppError(error);
      logger.error("library", `[LibraryManager] Failed to delete track file: ${failure?.message}`);
      const status = failure?.response?.status;
      const code =
        status === 404
          ? "not_found"
          : !failure?.response || (status !== undefined && status >= 500)
            ? "lidarr_unavailable"
            : "failed";
      return { success: false, code, error: failure?.message };
    }
  }

  async getTracks(
    albumId: string | number,
    { managedBy = null }: { managedBy?: string | null } = {},
  ) {
    if (!albumId || albumId === "undefined") {
      return [];
    }

    const libraryAlbum = libraryAlbumForReference(albumId);
    if (
      normalizeLibraryManager(managedBy) === "aurral" ||
      (managedBy == null && libraryAlbum?.managedBy === "aurral")
    ) {
      return libraryTracksForAlbum(albumId);
    }

    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return libraryTracksForAlbum(albumId);
    }

    const key = String(albumId);
    const cached = _tracksCache.get(key);
    if (cached && cached.expires > Date.now()) {
      return cached.tracks;
    }
    try {
      const lidarrAlbum: LidarrAlbumRecord | null = await lidarr.getAlbum(albumId);
      if (!lidarrAlbum) return managedBy == null ? libraryTracksForAlbum(albumId) : [];

      const rawPercent = lidarrAlbum.statistics?.percentOfTracks || 0;
      const albumSizeOnDisk = lidarrAlbum.statistics?.sizeOnDisk || 0;
      let normalizedPercent = rawPercent;

      if (rawPercent > 1 && rawPercent <= 100) {
        normalizedPercent = Math.round(rawPercent);
      } else if (rawPercent <= 1 && rawPercent >= 0) {
        normalizedPercent = Math.round(rawPercent * 100);
      } else if (rawPercent > 100) {
        normalizedPercent = Math.min(100, Math.round(rawPercent / 10));
      }

      const isAlbumComplete = normalizedPercent >= 100 || albumSizeOnDisk > 0;

      let rawTracks: LidarrTrackRecord[] = [];

      if (
        lidarrAlbum.tracks &&
        Array.isArray(lidarrAlbum.tracks) &&
        lidarrAlbum.tracks.length > 0
      ) {
        rawTracks = lidarrAlbum.tracks;
      } else if (lidarrAlbum.albumReleases && lidarrAlbum.albumReleases.length > 0) {
        for (const release of lidarrAlbum.albumReleases) {
          if (release.tracks && Array.isArray(release.tracks) && release.tracks.length > 0) {
            rawTracks = release.tracks;
            break;
          }
        }
      } else if (
        lidarrAlbum.media &&
        Array.isArray(lidarrAlbum.media) &&
        lidarrAlbum.media.length > 0
      ) {
        const allTracks = [];
        for (const medium of lidarrAlbum.media) {
          if (medium.tracks && Array.isArray(medium.tracks)) {
            allTracks.push(...medium.tracks);
          }
        }
        if (allTracks.length > 0) {
          rawTracks = allTracks;
        }
      }

      if (rawTracks.length === 0) {
        const lidarrTracks: LidarrTrackRecord[] = await lidarr.getTracksByAlbumId(albumId);
        if (lidarrTracks && lidarrTracks.length > 0) {
          rawTracks = lidarrTracks;
        }
      }

      let trackFileById: ReturnType<typeof buildTrackFileIndex> = new Map();
      if (
        albumNeedsTrackFiles({
          albumSizeOnDisk,
          isAlbumComplete,
          tracks: rawTracks,
        })
      ) {
        const trackFiles = await lidarr.getTrackFilesByAlbumId(albumId);
        trackFileById = buildTrackFileIndex(trackFiles);
      }

      const result = rawTracks.map((track, index) =>
        this.mapLidarrTrack(
          enrichLidarrTrackWithFiles(track, trackFileById),
          lidarrAlbum,
          index + 1,
          isAlbumComplete,
        ),
      );

      if (_tracksCache.size >= TRACKS_CACHE_MAX) {
        const firstKey = _tracksCache.keys().next().value;
        if (firstKey !== undefined) _tracksCache.delete(firstKey);
      }
      _tracksCache.set(key, {
        tracks: result,
        expires: Date.now() + TRACKS_CACHE_TTL_MS,
      });
      return result;
    } catch (error) {
      const failure = asAppError(error);
      if (cached) {
        return cached.tracks;
      }
      if (isLidarrNotFoundError(error)) {
        return managedBy == null ? libraryTracksForAlbum(albumId) : [];
      }
      logger.error(
        "library",
        `[LibraryManager] Failed to fetch tracks from Lidarr: ${failure?.message}`,
      );
      return libraryTracksForAlbum(albumId);
    }
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

  mapLidarrTrack(
    lidarrTrack: LidarrTrackRecord,
    lidarrAlbum: LidarrAlbumRecord,
    trackNumber = 0,
    _albumIsComplete = false,
  ) {
    const trackFile = lidarrTrack.trackFile || lidarrTrack.file || null;
    const filePath =
      lidarrTrack.path ||
      trackFile?.path ||
      (trackFile?.relativePath && lidarrAlbum.path
        ? path.join(lidarrAlbum.path, trackFile.relativePath)
        : null) ||
      null;
    const size =
      lidarrTrack.sizeOnDisk || lidarrTrack.size || trackFile?.size || trackFile?.sizeOnDisk || 0;
    return {
      id:
        lidarrTrack.id?.toString() ||
        lidarrTrack.foreignRecordingId ||
        `${lidarrAlbum.id}-${trackNumber}`,
      albumId: lidarrAlbum.id?.toString(),
      artistId: lidarrAlbum.artistId?.toString() || lidarrAlbum.artist?.id?.toString(),
      mbid: lidarrTrack.foreignRecordingId || lidarrTrack.foreignTrackId,
      trackName: lidarrTrack.title || lidarrTrack.trackTitle,
      trackNumber: trackNumber || lidarrTrack.trackNumber || 0,
      path: filePath,
      hasFile: !!filePath,
      size: size,
      quality:
        lidarrTrack.mediaInfo?.audioFormat ||
        trackFile?.mediaInfo?.audioFormat ||
        lidarrTrack.quality?.quality?.name ||
        trackFile?.quality?.quality?.name ||
        null,
      addedAt: lidarrTrack.added || trackFile?.dateAdded || new Date().toISOString(),
    };
  }

  sanitizePath(name: string) {
    return name.replace(/[<>:"/\\|?*]/g, "_").trim();
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
  [Name in keyof LibraryManager]: Name extends "ensureArtistMonitored"
    ? LibraryManager[Name]
    : WithAbsentKeysOnResults<LibraryManager[Name]>;
};

export const libraryManager: LibraryManagerApi = new LibraryManager();
