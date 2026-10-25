import { db, dbHelpers } from "../config/db-sqlite.ts";
import type {
  LibraryAlbumCreditsRow,
  LibraryAlbumsRow,
  LibraryAlbumTracksRow,
  LibraryArtistsRow,
  LibraryMediaFilesRow,
  LibraryTracksRow,
  SettingsRow,
} from "../db/rows.ts";
import {
  computeLibraryGenreStats,
  rebuildStoredLibraryGenreStats,
} from "../config/library-search-index.ts";
import { isOwnKey } from "../../lib/ownKey.ts";
import { getLibrarySearchMatch } from "./librarySearchIndex.ts";
import {
  getManagedByMap,
  type LibraryOwner,
  invalidateLibraryManagementCache,
  onLibraryManagementChange,
  refreshLibraryManagementCache,
} from "./libraryManagementStore.ts";
import { selectCanonicalFile } from "./canonicalFileSelector.ts";

type LibraryTrackFileQuality = {
  format?: string | null;
  bitrate?: number | null;
  sampleRate?: number | null;
  bitsPerSample?: number | null;
  audioFormat?: string | null;
  quality?: { name?: string | null } | null;
};

export interface LibraryArtistImage {
  remoteUrl?: string | null;
  imageUrl?: string | null;
  url?: string | null;
  Url?: string | null;
  coverType?: string | null;
  kind?: string | null;
  CoverType?: string | null;
}

type StoredLibraryMetadata = {
  id?: string | number | null;
  monitored?: boolean | null;
  monitor?: string | null;
  addOptions?: { monitor?: string | null } | null;
  foreignArtistId?: string | null;
  foreignAlbumId?: string | null;
  librarySource?: string | null;
  images?: LibraryArtistImage[] | null;
  path?: string | null;
  added?: string | null;
  monitorNewItems?: string | null;
  qualityProfile?: { name?: string | null } | null;
  albumType?: string | null;
  releaseType?: string | null;
};

type LibraryCanonicalMedia =
  | {
      media_id: LibraryMediaFilesRow["id"];
      media_album_id: LibraryMediaFilesRow["album_id"];
      media_source: LibraryMediaFilesRow["source"];
      media_path: LibraryMediaFilesRow["path"];
      media_format: LibraryMediaFilesRow["format"];
      media_size: LibraryMediaFilesRow["size"];
      media_mtime_ms: LibraryMediaFilesRow["mtime_ms"];
      media_duration_ms: LibraryMediaFilesRow["duration_ms"];
      media_quality_json: LibraryMediaFilesRow["quality_json"];
      media_available: LibraryMediaFilesRow["available"];
      media_created_at: LibraryMediaFilesRow["created_at"];
    }
  | {
      media_id: null;
      media_album_id: null;
      media_source: null;
      media_path: null;
      media_format: null;
      media_size: null;
      media_mtime_ms: null;
      media_duration_ms: null;
      media_quality_json: null;
      media_available: null;
      media_created_at: null;
    };

type LibraryCanonicalRow = {
  artist_id: LibraryArtistsRow["id"];
  artist_identity_key: LibraryArtistsRow["identity_key"];
  artist_mbid: LibraryArtistsRow["mbid"];
  artist_name: LibraryArtistsRow["name"];
  artist_sort_name: LibraryArtistsRow["sort_name"];
  album_id: LibraryAlbumsRow["id"];
  album_identity_key: LibraryAlbumsRow["identity_key"];
  album_mbid: LibraryAlbumsRow["mbid"];
  album_release_group_mbid: LibraryAlbumsRow["release_group_mbid"];
  album_title: LibraryAlbumsRow["title"];
  album_artist: LibraryAlbumsRow["album_artist"];
  album_release_date: LibraryAlbumsRow["release_date"];
  album_created_at: LibraryAlbumsRow["created_at"];
  track_id: LibraryTracksRow["id"];
  track_identity_key: LibraryTracksRow["identity_key"];
  track_mbid: LibraryTracksRow["mbid"];
  track_title: LibraryTracksRow["title"];
  track_artist_name: LibraryTracksRow["artist_name"];
  track_monitored: LibraryTracksRow["monitored"];
  track_keep_file: LibraryTracksRow["keep_file"];
  track_created_at: LibraryTracksRow["created_at"];
  disc_number: LibraryAlbumTracksRow["disc_number"];
  track_number: LibraryAlbumTracksRow["track_number"];
} & LibraryCanonicalMedia;

export type LibraryTrackFile = {
  id: LibraryMediaFilesRow["id"];
  albumId: LibraryMediaFilesRow["album_id"];
  source: LibraryMediaFilesRow["source"];
  path: LibraryMediaFilesRow["path"];
  format: LibraryMediaFilesRow["format"];
  size: LibraryMediaFilesRow["size"];
  mtimeMs: LibraryMediaFilesRow["mtime_ms"];
  durationMs: LibraryMediaFilesRow["duration_ms"];
  quality: LibraryTrackFileQuality | null;
  available: boolean;
  createdAt: LibraryMediaFilesRow["created_at"];
};

const SOURCES = new Set(["aurral", "lidarr", "readonly", "flow"]);
const libraryCache = new Map<string, LibraryCollection>();
const pageCountCache = new Map<string, number>();
const countDataVersion = db.prepare<[], { data_version: number }>("PRAGMA data_version");
const countLocalChanges = db.prepare<[], { total: number }>("SELECT total_changes() AS total");
let pageCountVersion: string | undefined;

function getPageTotal(sql: string, parameters: unknown[]) {
  if (db.inTransaction)
    return db.prepare<unknown[], { total: number }>(sql).get(...parameters)!.total;
  const version = `${countDataVersion.get()!.data_version}:${countLocalChanges.get()!.total}`;
  if (version !== pageCountVersion) {
    pageCountCache.clear();
    pageCountVersion = version;
  }
  const key = JSON.stringify([sql, parameters]);
  if (pageCountCache.has(key)) return pageCountCache.get(key)!;
  const total = db.prepare<unknown[], { total: number }>(sql).get(...parameters)!.total;
  if (pageCountCache.size >= 64) pageCountCache.delete(pageCountCache.keys().next().value!);
  pageCountCache.set(key, total);
  return total;
}

onLibraryManagementChange(() => {
  libraryCache.clear();
});
const PAGE_KINDS = ["artists", "albums", "tracks", "genres"] as const;
const isPageKind = (kind: string): kind is (typeof PAGE_KINDS)[number] =>
  PAGE_KINDS.some((pageKind) => pageKind === kind);
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 100;
const MAX_ARTIST_PROJECTION_PAGE_SIZE = 10000;
const TRACK_OWNERSHIP_BATCH_SIZE = 200;
const artistMetadataStmt = db.prepare<[number], Pick<LibraryArtistsRow, "metadata_json">>(
  "SELECT metadata_json FROM library_artists WHERE id = ?",
);
const albumMetadataStmt = db.prepare<[number], Pick<LibraryAlbumsRow, "metadata_json">>(
  "SELECT metadata_json FROM library_albums WHERE id = ?",
);
const trackMetadataStmt = db.prepare<[number], Pick<LibraryTracksRow, "metadata_json">>(
  "SELECT metadata_json FROM library_tracks WHERE id = ?",
);
const albumCreditsStmt = db.prepare<[number], Pick<LibraryAlbumCreditsRow, "artist_mbid">>(
  "SELECT artist_mbid FROM library_album_credits WHERE album_id = ?",
);

const parseJson = <T = unknown>(value: string | null | undefined): T | null => {
  if (!value) return null;
  try {
    return dbHelpers.parseJSON(value);
  } catch {
    return null;
  }
};

const parseSources = (value: string | null): string[] =>
  String(value || "")
    .split(",")
    .map((source) => source.trim())
    .filter(Boolean)
    .sort();

function normalizeSource(source: unknown): string | null {
  const value = String(source || "")
    .trim()
    .toLowerCase();
  if (!value || value === "all") return null;
  if (!SOURCES.has(value)) throw new Error(`Unsupported library source: ${value}`);
  return value;
}

const CANONICAL_SELECT = `SELECT
  artist.id AS artist_id,
  artist.identity_key AS artist_identity_key,
  artist.mbid AS artist_mbid,
  artist.name AS artist_name,
  artist.sort_name AS artist_sort_name,
  album.id AS album_id,
  album.identity_key AS album_identity_key,
  album.mbid AS album_mbid,
  album.release_group_mbid AS album_release_group_mbid,
  album.title AS album_title,
  album.album_artist AS album_artist,
  album.release_date AS album_release_date,
  album.created_at AS album_created_at,
  track.id AS track_id,
  track.identity_key AS track_identity_key,
  track.mbid AS track_mbid,
  track.title AS track_title,
  track.artist_name AS track_artist_name,
  track.monitored AS track_monitored,
  track.keep_file AS track_keep_file,
  track.created_at AS track_created_at,
  album_track.disc_number,
  album_track.track_number,
  media.id AS media_id,
  media.album_id AS media_album_id,
  media.source AS media_source,
  media.path AS media_path,
  media.format AS media_format,
  media.size AS media_size,
  media.mtime_ms AS media_mtime_ms,
  media.duration_ms AS media_duration_ms,
  media.quality_json AS media_quality_json,
  media.available AS media_available,
  media.created_at AS media_created_at`;

export const albumMediaCondition = (mediaAlias: string, albumTrackAlias: string) =>
  `(${mediaAlias}.album_id = ${albumTrackAlias}.album_id OR ${mediaAlias}.album_id IS NULL)`;

const CANONICAL_FROM = `FROM library_artists AS artist
  JOIN library_albums AS album ON album.artist_id = artist.id
  JOIN library_album_tracks AS album_track ON album_track.album_id = album.id
  JOIN library_tracks AS track ON track.id = album_track.track_id
  LEFT JOIN library_media_files AS media
    ON media.track_id = track.id
    AND ${albumMediaCondition("media", "album_track")}`;

export interface LibraryAlbumMetadata {
  images?: LibraryArtistImage[] | null;
  albumType?: string | null;
  releaseType?: string | null;
  tags?: { releasetype?: string | string[]; genre?: string[] } | null;
  monitored?: boolean | null;
}

export interface LibraryTrackAlbumRef {
  albumId: number;
  discNumber: number;
  trackNumber: number;
}

export interface LibraryAlbum {
  id: number;
  canonicalId?: string;
  identityKey: string;
  mbid: string | null;
  releaseGroupMbid: string | null;
  artistId: number;
  title: string;
  albumArtist: string | null;
  releaseDate: string | null;
  createdAt: number;
  metadata: LibraryAlbumMetadata | null;
  providerId?: string | number | null;
  monitored?: boolean;
  monitorOption?: string;
  trackIds: number[];
  sources: string[];
  source?: string | null;
  available: boolean;
  managedBy?: LibraryOwner | null;
  monitorMode?: string | null;
  trackCount?: number;
  availableTrackCount?: number;
  creditedArtistMbids?: string[];
}

export interface LibraryTrack {
  id: number;
  canonicalId?: string;
  identityKey: string;
  mbid: string | null;
  title: string;
  artistName: string | null;
  createdAt: number;
  metadata: Record<string, unknown> | null;
  providerId?: string | number | null;
  monitored: boolean;
  keepFile: boolean;
  albums: LibraryTrackAlbumRef[];
  files: LibraryTrackFile[];
  sources: string[];
  source?: string | null;
  available: boolean;
  managedBy?: LibraryOwner | null;
  monitorMode?: string | null;
}

interface LibraryRowArtist {
  id: number;
  canonicalId: string;
  identityKey: string;
  mbid: string | null;
  name: string;
  sortName: string | null;
  metadata: Record<string, unknown> | null;
  providerId: string | number | null;
  monitored: boolean;
  monitorOption: string;
  albumIds: number[];
  sources: string[];
  source?: string | null;
  available: boolean;
  managedBy?: LibraryOwner | null;
  monitorMode?: string | null;
}

interface LibraryAlbumTrackArtist {
  id: number;
  identityKey: string;
  mbid: string | null;
  name: string;
  sortName: string | null;
  metadata: Record<string, unknown> | null;
  albumIds: number[];
  managedBy: LibraryOwner | null;
  monitorMode: string | null;
  sources: string[];
  available: boolean;
}

export type LibraryArtist =
  | NonNullable<ReturnType<typeof getLibraryArtistPage>["artists"][number]>
  | LibraryRowArtist
  | LibraryAlbumTrackArtist;
export type LibraryGenre = ReturnType<typeof computeLibraryGenreStats>[number];

function buildLibraryFromRows(rows: Iterable<LibraryCanonicalRow>) {
  const artistManagement = getManagedByMap("artist");
  const albumManagement = getManagedByMap("album");
  const artists = new Map<number, LibraryRowArtist>();
  const albums = new Map<number, LibraryAlbum>();
  const tracks = new Map<number, LibraryTrack>();

  for (const row of rows) {
    let artist = artists.get(row.artist_id);
    if (!artist) {
      const artistMetadata = parseJson<StoredLibraryMetadata>(
        artistMetadataStmt.get(row.artist_id)?.metadata_json,
      );
      artist = {
        id: row.artist_id,
        canonicalId: String(row.artist_id),
        identityKey: row.artist_identity_key,
        mbid: row.artist_mbid,
        name: row.artist_name,
        sortName: row.artist_sort_name,
        metadata: artistMetadata,
        providerId: artistMetadata?.id ?? null,
        monitored: artistMetadata?.monitored === true,
        monitorOption: artistMetadata?.monitor || artistMetadata?.addOptions?.monitor || "none",
        albumIds: [],
        sources: [],
        available: false,
      };
      artists.set(row.artist_id, artist);
    }
    artist.managedBy = artistManagement.get(row.artist_id)?.managedBy ?? null;
    artist.monitorMode = artistManagement.get(row.artist_id)?.monitorMode ?? null;
    let album = albums.get(row.album_id);
    if (!album) {
      const albumMetadata = parseJson<StoredLibraryMetadata>(
        albumMetadataStmt.get(row.album_id)?.metadata_json,
      );
      album = {
        id: row.album_id,
        canonicalId: String(row.album_id),
        identityKey: row.album_identity_key,
        mbid: row.album_mbid,
        releaseGroupMbid: row.album_release_group_mbid,
        artistId: row.artist_id,
        title: row.album_title,
        albumArtist: row.album_artist,
        releaseDate: row.album_release_date,
        createdAt: row.album_created_at,
        metadata: albumMetadata,
        providerId: albumMetadata?.id ?? null,
        monitored: albumMetadata?.monitored === true,
        monitorOption: albumMetadata?.monitor || albumMetadata?.addOptions?.monitor || "none",
        trackIds: [],
        sources: [],
        available: false,
      };
      const credits = albumCreditsStmt.all(row.album_id).map((credit) => credit.artist_mbid);
      if (credits.length) album.creditedArtistMbids = credits;
      albums.set(row.album_id, album);
    }
    album.managedBy = albumManagement.get(row.album_id)?.managedBy ?? null;
    album.monitorMode = albumManagement.get(row.album_id)?.monitorMode ?? null;
    let track = tracks.get(row.track_id);
    if (!track) {
      const trackMetadata = parseJson<StoredLibraryMetadata>(
        trackMetadataStmt.get(row.track_id)?.metadata_json,
      );
      track = {
        id: row.track_id,
        canonicalId: String(row.track_id),
        identityKey: row.track_identity_key,
        mbid: row.track_mbid,
        title: row.track_title,
        artistName: row.track_artist_name,
        createdAt: row.track_created_at,
        metadata: trackMetadata,
        providerId: trackMetadata?.id ?? null,
        monitored: row.track_monitored !== 0,
        keepFile: row.track_keep_file === 1,
        albums: [],
        files: [],
        sources: [],
        available: false,
      };
      tracks.set(row.track_id, track);
    }
    track.managedBy = album.managedBy ?? null;
    track.monitorMode = album.monitorMode ?? null;

    if (!artist.albumIds.includes(album.id)) artist.albumIds.push(album.id);
    if (!album.trackIds.includes(track.id)) album.trackIds.push(track.id);
    if (!track.albums.some((entry) => entry.albumId === album.id)) {
      track.albums.push({
        albumId: album.id,
        discNumber: row.disc_number,
        trackNumber: row.track_number,
      });
    }

    if (row.media_id != null) {
      if (row.media_source && !artist.sources.includes(row.media_source)) {
        artist.sources.push(row.media_source);
      }
      if (row.media_source && !album.sources.includes(row.media_source)) {
        album.sources.push(row.media_source);
      }
      if (row.media_source && !track.sources.includes(row.media_source)) {
        track.sources.push(row.media_source);
      }

      const file = {
        id: row.media_id,
        albumId: row.media_album_id,
        source: row.media_source,
        path: row.media_path,
        format: row.media_format,
        size: row.media_size,
        mtimeMs: row.media_mtime_ms,
        durationMs: row.media_duration_ms,
        quality: parseJson<LibraryTrackFileQuality>(row.media_quality_json),
        available: Boolean(row.media_available),
        createdAt: row.media_created_at,
      };
      if (!track.files.some((entry) => entry.id === file.id)) track.files.push(file);
      if (file.available) {
        artist.available = true;
        album.available = true;
        track.available = true;
      }
    }
  }

  for (const entities of [artists, albums, tracks]) {
    for (const entity of entities.values()) {
      entity.sources.sort();
      entity.source = entity.sources.length === 1 ? entity.sources[0] : null;
    }
  }
  for (const track of tracks.values()) {
    track.files.sort((left, right) =>
      String(left.path || "").localeCompare(String(right.path || "")),
    );
  }

  return {
    artists: [...artists.values()],
    albums: [...albums.values()],
    tracks: [...tracks.values()],
  };
}

type LibraryCollection = ReturnType<typeof buildLibraryFromRows>;
type LibraryAvailability = boolean | typeof LIBRARY_VIEW;
type LibraryScope = { source?: unknown; availableOnly?: LibraryAvailability };
type PageSql = { sql: string; parameters: unknown[] };

const normalizeLookupValues = (values: unknown) => [
  ...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  ),
];

const libraryArtistOrder = `ORDER BY artist.sort_name COLLATE NOCASE, artist.name COLLATE NOCASE,
  album.title COLLATE NOCASE, album_track.disc_number, album_track.track_number,
  track.title COLLATE NOCASE, media.path COLLATE NOCASE`;

function getScopedLibrary({
  source = null,
  availableOnly = false,
  conditions = [],
  parameters = [],
}: LibraryScope & { conditions?: string[]; parameters?: unknown[] }) {
  const sourceFilter = normalizeSource(source);
  const where: string[] = [...conditions];
  const values: unknown[] = [...parameters];
  if (sourceFilter) {
    where.push("media.source = ?");
    values.push(sourceFilter);
  }
  if (availableOnly === true) where.push("media.available = 1");
  const rows = db
    .prepare<unknown[], LibraryCanonicalRow>(
      `${CANONICAL_SELECT}
     ${CANONICAL_FROM}
     WHERE ${where.join(" AND ")}
     ${libraryArtistOrder}`,
    )
    .iterate(...values);
  return buildLibraryFromRows(rows);
}

export function getLibraryArtistMbids({
  source = null,
  availableOnly = false,
  mbids = [],
}: LibraryScope & { mbids?: (string | number | null | undefined)[] } = {}): Set<string | null> {
  const references = normalizeLookupValues(mbids);
  if (!references.length) return new Set();
  const sourceFilter = normalizeSource(source);
  const parameters: unknown[] = [...references];
  const conditions: string[] = [`artist.mbid IN (${references.map(() => "?").join(",")})`];
  if (sourceFilter) {
    conditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  if (availableOnly === true) conditions.push("media.available = 1");
  const rows = db
    .prepare<unknown[], { mbid: string | null }>(
      `SELECT DISTINCT artist.mbid AS mbid
     ${CANONICAL_FROM}
     WHERE ${conditions.join(" AND ")}`,
    )
    .all(...parameters);
  return new Set(rows.map((row) => row.mbid).filter(Boolean));
}

const libraryArtistProjection = (row: LibraryArtistProjectionRow) => {
  const metadata: StoredLibraryMetadata = parseJson<StoredLibraryMetadata>(row.metadata_json) || {};
  const providerId = metadata.id == null ? null : String(metadata.id);
  const monitorOption = metadata.monitor || metadata.addOptions?.monitor || "none";
  const sources = new Set(
    String(row.sources || "")
      .split(",")
      .map((source) => source.trim())
      .filter(Boolean),
  );
  if (metadata.librarySource === "lidarr") sources.add("lidarr");
  const management = getManagedByMap("artist").get(Number(row.id)) || null;
  return {
    id: String(row.id),
    canonicalId: String(row.id),
    providerId,
    lidarrManaged: metadata.librarySource === "lidarr",
    managedBy: management?.managedBy ?? null,
    monitorMode: management?.monitorMode ?? null,
    mbid: row.mbid || null,
    foreignArtistId: metadata.foreignArtistId || row.mbid || row.identity_key,
    artistName: row.name,
    name: row.name,
    sortName: row.sort_name || row.name,
    images: Array.isArray(metadata.images) ? metadata.images : [],
    path: metadata.path || null,
    addedAt: metadata.added || (row.created_at ? new Date(row.created_at).toISOString() : null),
    monitored: metadata.monitored === true,
    monitorOption,
    monitorNewItems: metadata.monitorNewItems || "none",
    addOptions: metadata.addOptions || { monitor: monitorOption },
    quality: metadata.qualityProfile?.name || "standard",
    albumFolders: true,
    statistics: {
      albumCount: Number(row.album_count || 0),
      trackCount: Number(row.track_count || 0),
      sizeOnDisk: Number(row.size_on_disk || 0),
    },
    sources: [...sources].sort(),
    available: Boolean(row.available),
    stale: Boolean(row.stale),
  };
};

const libraryArtistKeyProjection = (row: LibraryArtistKeyRow) => {
  const metadata: StoredLibraryMetadata = parseJson<StoredLibraryMetadata>(row.metadata_json) || {};
  return {
    id: String(row.id),
    mbid: row.mbid || null,
    foreignArtistId: metadata.foreignArtistId || row.mbid || row.identity_key,
    name: row.name,
    artistName: row.name,
  };
};

export function getLibraryArtistNames() {
  return db.prepare<[], Pick<LibraryArtistsRow, "name">>("SELECT name FROM library_artists").all();
}

export function getLibraryArtistKeyProjection() {
  const rows = db
    .prepare<[], LibraryArtistKeyRow>(
      `SELECT id, identity_key, mbid, name, metadata_json
     FROM library_artists`,
    )
    .all();
  return rows.map(libraryArtistKeyProjection);
}

export function getLibraryArtistsSignature() {
  const row = db
    .prepare<[], { count: number; maxId: number; updatedAt: string }>(
      `SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS maxId, CAST(COALESCE(SUM(updated_at), 0) AS TEXT) AS updatedAt
     FROM library_artists`,
    )
    .get()!;
  return `${row.count}:${row.maxId}:${row.updatedAt}`;
}

export function sampleLibraryArtistsForDiscovery({
  recentLimit = 12,
  randomLimit = 28,
}: { recentLimit?: number; randomLimit?: number } = {}) {
  const recent = db
    .prepare<[number], Pick<LibraryArtistsRow, "id" | "mbid" | "name">>(
      "SELECT id, mbid, name FROM library_artists ORDER BY created_at DESC, id DESC LIMIT ?",
    )
    .all(Math.max(0, recentLimit));
  const recentIds = new Set(recent.map((row) => row.id));
  const random = db
    .prepare<[number], Pick<LibraryArtistsRow, "id" | "mbid" | "name">>(
      "SELECT id, mbid, name FROM library_artists ORDER BY RANDOM() LIMIT ?",
    )
    .all(Math.max(0, randomLimit) + recentIds.size)
    .filter((row) => !recentIds.has(row.id))
    .slice(0, Math.max(0, randomLimit));
  const toSeed = (profileBucket: string) => (row: Pick<LibraryArtistsRow, "mbid" | "name">) => ({
    mbid: row.mbid || null,
    artistName: row.name,
    source: "library",
    profileBucket,
  });
  return {
    recent: recent.map(toSeed("recent_additions")),
    random: random.map(toSeed("library_sample")),
  };
}

type LibraryArtistProjectionOptions = {
  page?: number | string;
  pageSize?: number | string;
  offset?: number | string | null;
  reference?: unknown;
  artistIds?: number[] | null;
};

type LibraryArtistKeyRow = Pick<
  LibraryArtistsRow,
  "id" | "identity_key" | "mbid" | "name" | "metadata_json"
>;

type LibraryArtistProjectionRow = Pick<
  LibraryArtistsRow,
  "id" | "identity_key" | "mbid" | "name" | "sort_name" | "metadata_json" | "created_at"
> & {
  album_count: number;
  track_count: number;
  size_on_disk: number;
  sources: string | null;
  available: number;
  stale: number;
};

function buildLibraryArtistProjectionQuery({
  page = 1,
  pageSize = 100,
  offset = null,
  reference = null,
  artistIds = null,
}: LibraryArtistProjectionOptions = {}) {
  const normalizedPage = Math.max(1, Number.parseInt(String(page), 10) || 1);
  const normalizedPageSize = Math.min(
    MAX_ARTIST_PROJECTION_PAGE_SIZE,
    Math.max(1, Number.parseInt(String(pageSize), 10) || 100),
  );
  const normalizedOffset =
    offset == null
      ? (normalizedPage - 1) * normalizedPageSize
      : Math.max(0, Number.parseInt(String(offset), 10) || 0);
  const references = normalizeLookupValues(reference == null ? [] : [reference]);
  const parameters: unknown[] = [];
  const where: string[] = [];
  if (references.length) {
    where.push(`(
      artist.id IN (${references.map(() => "?").join(",")}) OR
      artist.mbid IN (${references.map(() => "?").join(",")}) OR
      artist.identity_key IN (${references.map(() => "?").join(",")}) OR
      CAST(json_extract(artist.metadata_json, '$.id') AS TEXT) IN (${references.map(() => "?").join(",")}) OR
      CAST(json_extract(artist.metadata_json, '$.foreignArtistId') AS TEXT) IN (${references.map(() => "?").join(",")}) OR
      lower(artist.name) IN (${references.map(() => "lower(?)").join(",")})
    )`);
    parameters.push(
      ...references,
      ...references,
      ...references,
      ...references,
      ...references,
      ...references,
    );
  }
  const ids = Array.isArray(artistIds) ? artistIds : null;
  if (ids) {
    where.push(`artist.id IN (${ids.map(() => "?").join(",") || "NULL"})`);
    parameters.push(...ids);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = references.length || ids ? "" : "LIMIT ? OFFSET ?";
  if (!references.length && !ids) {
    parameters.push(normalizedPageSize, normalizedOffset);
  }
  return {
    parameters,
    sql: `
    WITH artist_page AS MATERIALIZED (
      SELECT
        artist.id,
        artist.identity_key,
        artist.mbid,
        artist.name,
        artist.sort_name,
        artist.metadata_json,
        artist.created_at
      FROM library_artists AS artist
      ${whereSql}
      ORDER BY artist.sort_name COLLATE NOCASE, artist.name COLLATE NOCASE, artist.id
      ${limit}
    )
    SELECT
      artist.id,
      artist.identity_key,
      artist.mbid,
      artist.name,
      artist.sort_name,
      artist.metadata_json,
      artist.created_at,
      COUNT(DISTINCT album.id) AS album_count,
      COUNT(DISTINCT album_track.track_id) AS track_count,
      COALESCE(SUM(CASE WHEN media.available = 1 THEN media.size ELSE 0 END), 0) AS size_on_disk,
      GROUP_CONCAT(DISTINCT media.source) AS sources,
      MAX(CASE WHEN media.available = 1 THEN 1 ELSE 0 END) AS available,
      CASE WHEN EXISTS (
        SELECT 1
        FROM library_scan_runs AS scan
        WHERE scan.source = 'lidarr'
          AND scan.status = 'failed'
          AND EXISTS (SELECT 1 FROM library_media_files WHERE source = 'lidarr')
          AND scan.id > COALESCE((
            SELECT complete.id
            FROM library_scan_runs AS complete
            WHERE complete.source = 'lidarr' AND complete.status = 'complete'
            ORDER BY complete.id DESC
            LIMIT 1
          ), 0)
      ) THEN 1 ELSE 0 END AS stale
    FROM artist_page AS artist
    LEFT JOIN library_albums AS album ON album.artist_id = artist.id
    LEFT JOIN library_album_tracks AS album_track ON album_track.album_id = album.id
    LEFT JOIN library_media_files AS media ON media.track_id = album_track.track_id
      AND (media.album_id = album_track.album_id OR media.album_id IS NULL)
    GROUP BY artist.id
    ORDER BY artist.sort_name COLLATE NOCASE, artist.name COLLATE NOCASE, artist.id
  `,
  };
}

export function getLibraryArtistProjection(options: LibraryArtistProjectionOptions = {}) {
  const query = buildLibraryArtistProjectionQuery(options);
  const rows = db
    .prepare<unknown[], LibraryArtistProjectionRow>(query.sql)
    .all(...query.parameters);
  return rows.map(libraryArtistProjection);
}

export function getRecentlyAddedLibraryArtists({
  availableOnly = false,
  limit = 20,
}: { availableOnly?: LibraryAvailability; limit?: number } = {}) {
  const rows = db
    .prepare<[number], { id: number; added_at: number }>(
      `WITH identified AS MATERIALIZED (
       SELECT
         artist.id,
         artist.created_at,
         artist.mbid,
         artist.identity_key,
         CASE
           WHEN NULLIF(trim(artist.mbid), '') IS NOT NULL
             THEN 'id:' || lower(trim(artist.mbid))
           WHEN json_valid(artist.metadata_json)
             AND NULLIF(trim(CAST(json_extract(artist.metadata_json, '$.foreignArtistId') AS TEXT)), '') IS NOT NULL
             THEN 'id:' || lower(trim(CAST(json_extract(artist.metadata_json, '$.foreignArtistId') AS TEXT)))
           WHEN json_valid(artist.metadata_json)
             AND NULLIF(trim(CAST(json_extract(artist.metadata_json, '$.id') AS TEXT)), '') IS NOT NULL
             THEN 'provider:'
               || lower(COALESCE(NULLIF(trim(CAST(json_extract(artist.metadata_json, '$.librarySource') AS TEXT)), ''), 'unknown'))
               || ':' || lower(trim(CAST(json_extract(artist.metadata_json, '$.id') AS TEXT)))
           ELSE 'identity:' || lower(trim(artist.identity_key))
         END AS canonical_key
       FROM library_artists AS artist
     ), first_added AS MATERIALIZED (
       SELECT canonical_key, MIN(created_at) AS added_at
       FROM identified
       GROUP BY canonical_key
     ), candidates AS MATERIALIZED (
       SELECT
         artist.id,
         artist.created_at,
         artist.mbid,
         artist.canonical_key,
         first_added.added_at
       FROM identified AS artist
       JOIN first_added ON first_added.canonical_key = artist.canonical_key
       WHERE EXISTS (
         SELECT 1
         FROM library_albums AS album
         JOIN library_album_tracks AS album_track ON album_track.album_id = album.id
         JOIN library_media_files AS media INDEXED BY idx_library_media_files_track_album_source_available_created
           ON media.track_id = album_track.track_id
         WHERE album.artist_id = artist.id
           AND ${albumMediaCondition("media", "album_track")}${recentMediaFilter(null, availableOnly, "media")}
       )
     ), ranked AS (
       SELECT
         id,
         added_at,
         ROW_NUMBER() OVER (
           PARTITION BY canonical_key
           ORDER BY CASE WHEN mbid IS NULL THEN 1 ELSE 0 END, created_at, id
         ) AS duplicate_rank
       FROM candidates
     )
     SELECT id, added_at
     FROM ranked
     WHERE duplicate_rank = 1
     ORDER BY added_at DESC, id DESC
     LIMIT ?`,
    )
    .all(limit);
  const addedAtById = new Map(
    rows.map((row) => [String(row.id), new Date(row.added_at).toISOString()]),
  );
  const artistsById = new Map(
    getLibraryArtistProjection({ artistIds: rows.map((row) => row.id) }).map((artist) => [
      artist.id,
      artist,
    ]),
  );
  return rows
    .map((row) => artistsById.get(String(row.id)))
    .filter((artist) => artist !== undefined)
    .map((artist) => ({ ...artist, addedAt: addedAtById.get(artist.id) }));
}

export function getLibraryArtistProjectionQueryPlan(options: LibraryArtistProjectionOptions = {}) {
  const query = buildLibraryArtistProjectionQuery(options);
  return db
    .prepare<unknown[], { id: number; parent: number; notused: number; detail: string }>(
      `EXPLAIN QUERY PLAN ${query.sql}`,
    )
    .all(...query.parameters);
}

export function* iterateLibraryArtistProjection({
  pageSize = 100,
}: { pageSize?: number | string } = {}) {
  for (let page = 1; ; page += 1) {
    const artists = getLibraryArtistProjection({ page, pageSize });
    yield* artists;
    if (artists.length < Math.min(100, Math.max(1, Number.parseInt(String(pageSize), 10) || 100)))
      break;
  }
}

type LibraryDateAlbumRow = Pick<
  LibraryAlbumsRow,
  | "id"
  | "identity_key"
  | "mbid"
  | "release_group_mbid"
  | "artist_id"
  | "title"
  | "release_date"
  | "metadata_json"
> & {
  artist_identity_key: LibraryArtistsRow["identity_key"];
  artist_mbid: LibraryArtistsRow["mbid"];
  artist_name: LibraryArtistsRow["name"];
  artist_metadata_json: LibraryArtistsRow["metadata_json"];
  track_count: number;
  available_track_count: number;
  size_on_disk: number;
  sources: string | null;
  available: number | null;
};

const libraryDateAlbumProjection = (row: LibraryDateAlbumRow) => {
  const metadata: StoredLibraryMetadata = parseJson<StoredLibraryMetadata>(row.metadata_json) || {};
  const artistMetadata: StoredLibraryMetadata =
    parseJson<StoredLibraryMetadata>(row.artist_metadata_json) || {};
  const sources = parseSources(row.sources);
  const management = getManagedByMap("album").get(Number(row.id)) || null;
  const trackCount = Number(row.track_count || 0);
  const availableTrackCount = Number(row.available_track_count || 0);
  return {
    id: String(row.id),
    canonicalId: String(row.id),
    providerId: metadata.id == null ? null : String(metadata.id),
    artistId: String(row.artist_id),
    providerArtistId: artistMetadata.id == null ? null : String(artistMetadata.id),
    artistName: row.artist_name,
    artistMbid: row.artist_mbid || null,
    foreignArtistId: artistMetadata.foreignArtistId || row.artist_mbid || row.artist_identity_key,
    mbid: row.mbid || row.release_group_mbid || null,
    releaseGroupMbid: row.release_group_mbid || null,
    foreignAlbumId:
      metadata.foreignAlbumId || row.mbid || row.release_group_mbid || row.identity_key,
    albumName: row.title,
    title: row.title,
    releaseDate: row.release_date,
    monitored: metadata.monitored === true,
    managedBy: management?.managedBy ?? null,
    monitorMode: management?.monitorMode ?? null,
    source: sources.length === 1 ? sources[0] : null,
    sources,
    available: Boolean(row.available),
    albumType: metadata.albumType || metadata.releaseType || null,
    trackCount,
    availableTrackCount,
    statistics: {
      trackCount,
      trackFileCount: availableTrackCount,
      sizeOnDisk: Number(row.size_on_disk || 0),
      percentOfTracks: trackCount > 0 ? Math.round((availableTrackCount / trackCount) * 100) : 0,
    },
  };
};

export function getLibraryAlbumsByReleaseDate({
  from,
  to = null,
  limit = 100,
  missingOnly = false,
  artistIds = [],
}: {
  from?: string | null;
  to?: string | null;
  limit?: number | string;
  missingOnly?: boolean;
  artistIds?: unknown[];
} = {}) {
  const fromDate = String(from || "").trim();
  const toDate = String(to || "").trim();
  if (!fromDate) return [];
  const conditions = ["album.release_date >= ?"];
  const parameters: (string | number)[] = [fromDate];
  if (toDate) {
    conditions.push("album.release_date <= ?");
    parameters.push(toDate);
  }
  const libraryArtistIds = [
    ...new Set(
      (Array.isArray(artistIds) ? artistIds : [])
        .map((value) => Number(value))
        .filter((value) => Number.isSafeInteger(value) && value > 0),
    ),
  ];
  if (Array.isArray(artistIds) && artistIds.length > 0) {
    if (!libraryArtistIds.length) return [];
    conditions.push("album.artist_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))");
    parameters.push(JSON.stringify(libraryArtistIds));
  }
  if (missingOnly === true) {
    conditions.push(`NOT EXISTS (
      SELECT 1
      FROM library_album_tracks AS owned_relation
      JOIN library_media_files AS owned_media
        ON owned_media.track_id = owned_relation.track_id
        AND (owned_media.album_id = owned_relation.album_id OR owned_media.album_id IS NULL)
      WHERE owned_relation.album_id = album.id
        AND owned_media.available = 1
    )`);
  }
  parameters.push(Math.min(1000, Math.max(1, Number.parseInt(String(limit), 10) || 100)));
  const rows = db
    .prepare<unknown[], LibraryDateAlbumRow>(`
    WITH date_albums AS MATERIALIZED (
      SELECT
        album.id,
        album.identity_key,
        album.mbid,
        album.release_group_mbid,
        album.artist_id,
        album.title,
        album.release_date,
        album.metadata_json,
        artist.identity_key AS artist_identity_key,
        artist.mbid AS artist_mbid,
        artist.name AS artist_name,
        artist.metadata_json AS artist_metadata_json
      FROM library_albums AS album
      JOIN library_artists AS artist ON artist.id = album.artist_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY album.release_date DESC, album.id DESC
      LIMIT ?
    )
    SELECT
      album.*,
      COUNT(DISTINCT album_track.track_id) AS track_count,
      COUNT(DISTINCT CASE WHEN media.available = 1 THEN album_track.track_id END) AS available_track_count,
      COALESCE(SUM(CASE WHEN media.available = 1 THEN media.size ELSE 0 END), 0) AS size_on_disk,
      GROUP_CONCAT(DISTINCT media.source) AS sources,
      MAX(media.available) AS available
    FROM date_albums AS album
    LEFT JOIN library_album_tracks AS album_track ON album_track.album_id = album.id
    LEFT JOIN library_media_files AS media
      ON media.track_id = album_track.track_id
      AND (media.album_id = album_track.album_id OR media.album_id IS NULL)
    GROUP BY album.id
    ORDER BY album.release_date DESC, album.id DESC
  `)
    .all(...parameters);
  return rows.map(libraryDateAlbumProjection);
}

export function getLibraryIndexLastModified() {
  const row = db
    .prepare<[], { last_modified: number | null }>(
      `SELECT MAX(updated_at) AS last_modified FROM (
       SELECT MAX(updated_at) AS updated_at FROM library_artists
       UNION ALL SELECT MAX(updated_at) FROM library_albums
       UNION ALL SELECT MAX(updated_at) FROM library_tracks
       UNION ALL SELECT MAX(updated_at) FROM library_media_files
       UNION ALL SELECT MAX(completed_at) FROM library_scan_runs WHERE source IN ('lidarr-removal', 'library-tidy')
     )`,
    )
    .get();
  return Number(row?.last_modified) || null;
}

export function getLibraryTrackPath(
  albumReference: string | null | undefined,
  trackReference: string | null | undefined,
) {
  const albumValue = String(albumReference ?? "").trim();
  const trackValue = String(trackReference ?? "").trim();
  if (!albumValue || !trackValue) return null;

  const [albumId] = resolveLibraryReferenceIds(
    "library_albums",
    [albumValue],
    [
      "identity_key",
      "mbid",
      "release_group_mbid",
      "CAST(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.id') END AS TEXT)",
    ],
  );
  const [trackId] = resolveLibraryReferenceIds(
    "library_tracks",
    [trackValue],
    [
      "identity_key",
      "mbid",
      "CAST(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.id') END AS TEXT)",
    ],
  );
  const album = albumId ? { id: albumId } : null;
  const track = trackId ? { id: trackId } : null;
  if (!album || !track) return null;

  const files = db
    .prepare<
      [number, number, number],
      Pick<LibraryMediaFilesRow, "id" | "source" | "path" | "available"> & {
        albumId: number | null;
      }
    >(
      `SELECT media.id,
            media.album_id AS albumId,
            media.source,
            media.path,
            media.available
     FROM library_media_files AS media
     JOIN library_album_tracks AS album_track
       ON album_track.album_id = ? AND album_track.track_id = media.track_id
     WHERE media.track_id = ?
       AND media.available = 1
       AND (media.album_id = ? OR media.album_id IS NULL)
     ORDER BY media.path COLLATE NOCASE`,
    )
    .all(album.id, track.id, album.id);
  const managedBy = getManagedByMap("album").get(Number(album.id))?.managedBy || null;
  return selectCanonicalFile(files, album.id, managedBy)?.path || null;
}

export function getLibraryTrack({
  trackId,
  source = null,
  availableOnly = false,
  albumId = null,
}: LibraryScope & { trackId?: string | number | null; albumId?: string | number | null } = {}) {
  const reference = String(trackId ?? "").trim();
  if (!reference) return { artists: [], albums: [], tracks: [] };

  const [resolvedTrackId] = resolveLibraryReferenceIds(
    "library_tracks",
    [reference],
    [
      "identity_key",
      "mbid",
      "CAST(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.id') END AS TEXT)",
    ],
  );
  if (!resolvedTrackId) return { artists: [], albums: [], tracks: [] };
  const conditions = ["track.id = ?"];
  const parameters = [resolvedTrackId];
  if (albumId !== null && albumId !== undefined && String(albumId).trim()) {
    conditions.push("album.id = ?");
    parameters.push(Number(albumId));
  }

  return getScopedLibrary({
    source,
    availableOnly,
    conditions,
    parameters,
  });
}

export function getLibraryTrackOwnership({
  trackMbid = null,
  artistName = null,
  trackName = null,
  source = null,
}: LibraryScope & {
  trackMbid?: string | null;
  artistName?: string | null;
  trackName?: string | null;
} = {}) {
  const sourceFilter = normalizeSource(source);
  const conditions: string[] = ["media.available = 1"];
  const parameters: unknown[] = [];
  if (sourceFilter) {
    conditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }

  const mbid = String(trackMbid || "").trim();
  if (mbid) {
    conditions.push("track.mbid = ?");
    parameters.push(mbid);
  } else {
    const artist = String(artistName || "").trim();
    const title = String(trackName || "").trim();
    if (!artist || !title) return false;
    conditions.push("track.title = ? COLLATE NOCASE");
    conditions.push("(track.artist_name = ? COLLATE NOCASE OR artist.name = ? COLLATE NOCASE)");
    parameters.push(title, artist, artist);
  }

  return Boolean(
    db
      .prepare<unknown[], { owned: number }>(
        `SELECT EXISTS (
       SELECT 1
       ${CANONICAL_FROM}
       WHERE ${conditions.join(" AND ")}
     ) AS owned`,
      )
      .get(...parameters)?.owned,
  );
}

type LibraryTrackOwnershipInput = {
  trackMbid?: string | null;
  artistName?: string | null;
  trackName?: string | null;
};

type LibraryTrackOwnershipReference =
  | { kind: "mbid"; value: string }
  | { kind: "names"; artistName: string; trackName: string; key: string };

function normalizeTrackOwnershipReference(
  track: LibraryTrackOwnershipInput | null | undefined,
): LibraryTrackOwnershipReference | null {
  const trackMbid = String(track?.trackMbid || "").trim();
  if (trackMbid) return { kind: "mbid", value: trackMbid };

  const artistName = String(track?.artistName || "").trim();
  const trackName = String(track?.trackName || "").trim();
  if (!artistName || !trackName) return null;
  return {
    kind: "names",
    artistName,
    trackName,
    key: `${artistName.toLowerCase()}\u0000${trackName.toLowerCase()}`,
  };
}

function getTrackOwnershipReferenceKey(reference: LibraryTrackOwnershipReference | null) {
  if (!reference) return "";
  return `${reference.kind}:${reference.kind === "mbid" ? reference.value : reference.key}`;
}

export function getLibraryTrackOwnershipBatch(
  tracks: LibraryTrackOwnershipInput[] | null | undefined,
  { source = null }: { source?: string | null } = {},
) {
  const sourceFilter = normalizeSource(source);
  const references = (Array.isArray(tracks) ? tracks : []).map(normalizeTrackOwnershipReference);
  const uniqueReferences = new Map<string, LibraryTrackOwnershipReference>();
  for (const reference of references) {
    const key = getTrackOwnershipReferenceKey(reference);
    if (key && !uniqueReferences.has(key)) uniqueReferences.set(key, reference!);
  }

  const ownedMbids = new Set<string>();
  const ownedNames = new Set<string>();
  const values = [...uniqueReferences.values()];
  for (let index = 0; index < values.length; index += TRACK_OWNERSHIP_BATCH_SIZE) {
    const batch = values.slice(index, index + TRACK_OWNERSHIP_BATCH_SIZE);
    const conditions: string[] = ["media.available = 1"];
    const parameters: unknown[] = [];
    if (sourceFilter) {
      conditions.push("media.source = ?");
      parameters.push(sourceFilter);
    }
    const mbids = batch
      .filter((reference) => reference.kind === "mbid")
      .map((reference) => reference.value);
    const titles = batch
      .filter((reference) => reference.kind === "names")
      .map((reference) => reference.trackName);
    const referenceConditions: string[] = [];
    if (mbids.length) {
      referenceConditions.push(`track.mbid IN (${mbids.map(() => "?").join(",")})`);
      parameters.push(...mbids);
    }
    if (titles.length) {
      referenceConditions.push(
        `track.title COLLATE NOCASE IN (${titles.map(() => "?").join(",")})`,
      );
      parameters.push(...titles);
    }
    const rows = db
      .prepare<
        unknown[],
        {
          track_mbid: string | null;
          track_artist_name: string | null;
          artist_name: string;
          track_title: string;
        }
      >(
        `SELECT track.mbid AS track_mbid,
              track.artist_name AS track_artist_name,
              artist.name AS artist_name,
              track.title AS track_title
       ${CANONICAL_FROM}
       WHERE ${conditions.join(" AND ")}
         AND (${referenceConditions.join(" OR ")})`,
      )
      .all(...parameters);
    for (const row of rows) {
      const trackMbid = String(row.track_mbid || "").trim();
      if (trackMbid) ownedMbids.add(trackMbid);
      const trackName = String(row.track_title || "").trim();
      for (const credit of [row.track_artist_name, row.artist_name]) {
        const artistName = String(credit || "").trim();
        if (artistName && trackName) {
          ownedNames.add(`${artistName.toLowerCase()}\u0000${trackName.toLowerCase()}`);
        }
      }
    }
  }

  return references.map((reference) => {
    if (!reference) return false;
    return reference.kind === "mbid"
      ? ownedMbids.has(reference.value)
      : ownedNames.has(reference.key);
  });
}

export function getLibraryTrackCount({ source = null, availableOnly = false }: LibraryScope = {}) {
  const sourceFilter = normalizeSource(source);
  const conditions: string[] = [];
  const parameters: unknown[] = [];
  if (sourceFilter) {
    conditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  if (availableOnly === true) conditions.push("media.available = 1");
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return Number(
    db
      .prepare<unknown[], { total: number }>(
        `SELECT COUNT(DISTINCT track.id) AS total
     ${CANONICAL_FROM}
     ${where}`,
      )
      .get(...parameters)?.total || 0,
  );
}

export function getLibraryTrackSample({
  source = null,
  availableOnly = false,
  limit = 100,
}: LibraryScope & { limit?: number | string } = {}) {
  const sourceFilter = normalizeSource(source);
  const conditions: string[] = [];
  const parameters: unknown[] = [];
  if (sourceFilter) {
    conditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  if (availableOnly === true) conditions.push("media.available = 1");
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const boundedLimit = Math.min(500, Math.max(1, Number.parseInt(String(limit), 10) || 100));
  const rows = db
    .prepare<unknown[], LibraryCanonicalRow>(
      `${CANONICAL_SELECT}
     ${CANONICAL_FROM}
     ${where}
     ${libraryArtistOrder}
     LIMIT ?`,
    )
    .iterate(...parameters, boundedLimit);
  return buildLibraryFromRows(rows);
}

const CANONICAL_FAVORITE_TABLES = {
  artist: "library_artists",
  album: "library_albums",
  song: "library_tracks",
};

function parseLibraryFavoriteId(value: unknown) {
  const input = String(value || "").trim();
  const separator = input.indexOf(":");
  if (separator <= 0) return null;
  const kind = input.slice(0, separator);
  if (!isOwnKey(CANONICAL_FAVORITE_TABLES, kind)) return null;
  const rawKey = input.slice(separator + 1);
  if (!rawKey) return null;
  try {
    const key = decodeURIComponent(rawKey).trim();
    return key ? { kind, key, rawKey } : null;
  } catch {
    return null;
  }
}

export function getLibraryFavoriteTargetKeys(values: unknown[] = []) {
  const targets = (Array.isArray(values) ? values : []).map(parseLibraryFavoriteId).filter(Boolean);
  const found = new Set<string>();
  for (const [kind, table] of Object.entries(CANONICAL_FAVORITE_TABLES)) {
    const keys = [
      ...new Set(targets.filter((target) => target!.kind === kind).map((target) => target!.key)),
    ];
    if (!keys.length) continue;
    const rows = db
      .prepare<unknown[], { identity_key: string }>(
        `SELECT identity_key FROM ${table}
       WHERE identity_key IN (${keys.map(() => "?").join(",")})`,
      )
      .all(...keys);
    for (const row of rows) {
      for (const target of targets) {
        if (target!.kind !== kind || target!.key !== row.identity_key) continue;
        found.add(`${kind}:${target!.rawKey}`);
        found.add(`${kind}:${encodeURIComponent(target!.key)}`);
      }
    }
  }
  return found;
}

const artistAlbumIdsSql = (column: "id" | "mbid", placeholders: string) => `
  SELECT owned.id FROM library_albums AS owned
  JOIN library_artists AS owner ON owner.id = owned.artist_id
  WHERE owner.${column} IN (${placeholders})
  UNION
  SELECT credit.album_id FROM library_album_credits AS credit
  JOIN library_artists AS credited ON credited.mbid = credit.artist_mbid
  WHERE credited.${column} IN (${placeholders})`;

type ArtistLibraryScope = LibraryScope & { includeSharedAlbums?: boolean };

function getLibraryForArtistColumn(
  column: "id" | "mbid",
  values: unknown[],
  { source, availableOnly, includeSharedAlbums = false }: ArtistLibraryScope,
) {
  if (!values.length) return { artists: [], albums: [], tracks: [] };
  const placeholders = values.map(() => "?").join(",");
  return getScopedLibrary({
    source,
    availableOnly,
    conditions: [
      includeSharedAlbums
        ? `album.id IN (${artistAlbumIdsSql(column, placeholders)})`
        : `artist.${column} IN (${placeholders})`,
    ],
    parameters: includeSharedAlbums ? [...values, ...values] : values,
  });
}

export function getLibraryForArtists({
  mbids = [],
  ...scope
}: ArtistLibraryScope & { mbids?: unknown[] } = {}) {
  return getLibraryForArtistColumn("mbid", normalizeLookupValues(mbids), scope);
}

function resolveLibraryReferenceIds(table: string, references: string[], columns: string[]) {
  const requested = references.map(() => "(?, ?)").join(", ");
  const idCandidate = `(
    SELECT direct.id
    FROM ${table} AS direct
    WHERE direct.id = requested.record_id
    LIMIT 1
  )`;
  const aliasCandidates = columns.map(
    (column) => `(
    SELECT alias.id
    FROM ${table} AS alias
    WHERE ${column} = requested.reference
    ORDER BY alias.id
    LIMIT 1
  )`,
  );
  const sql = `
    SELECT id FROM ${table}
    WHERE id IN (
      WITH requested(reference, record_id) AS (VALUES ${requested})
      SELECT COALESCE(${[idCandidate, ...aliasCandidates].join(",")})
      FROM requested
    )`;
  const parameters = references.flatMap((reference) => {
    const numericId = /^\d+$/.test(reference) ? Number(reference) : null;
    return [reference, Number.isSafeInteger(numericId) && numericId! > 0 ? numericId : null];
  });
  return db
    .prepare<unknown[], { id: number }>(sql)
    .all(...parameters)
    .map((row) => row.id);
}

export function getLibraryForArtistReferences({
  references: requestedReferences = [],
  ...scope
}: ArtistLibraryScope & { references?: unknown[] } = {}) {
  const references = normalizeLookupValues(requestedReferences);
  if (!references.length) return { artists: [], albums: [], tracks: [] };
  const ids = resolveLibraryReferenceIds("library_artists", references, [
    "identity_key",
    "mbid",
    "CAST(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.id') END AS TEXT)",
    "CAST(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.foreignArtistId') END AS TEXT)",
    "name COLLATE NOCASE",
  ]);
  return getLibraryForArtistColumn("id", ids, scope);
}

export function getLibraryForAlbumIds({
  source = null,
  availableOnly = false,
  ids = [],
}: LibraryScope & { ids?: unknown[] } = {}) {
  const values = [
    ...new Set(
      (Array.isArray(ids) ? ids : [])
        .map((value) => Number(value))
        .filter((value) => Number.isSafeInteger(value) && value > 0),
    ),
  ];
  if (!values.length) return { artists: [], albums: [], tracks: [] };
  return getScopedLibrary({
    source,
    availableOnly,
    conditions: [`album.id IN (${values.map(() => "?").join(",")})`],
    parameters: values,
  });
}

export function getLibraryForTrackIds({
  source = null,
  availableOnly = false,
  ids = [],
  albumId = null,
}: LibraryScope & { ids?: unknown[]; albumId?: string | number | null } = {}) {
  const values = [
    ...new Set(
      (Array.isArray(ids) ? ids : [])
        .map((value) => Number(value))
        .filter((value) => Number.isSafeInteger(value) && value > 0),
    ),
  ];
  if (!values.length) return { artists: [], albums: [], tracks: [] };
  const conditions = [`track.id IN (${values.map(() => "?").join(",")})`];
  const parameters = [...values];
  if (albumId !== null && albumId !== undefined && String(albumId).trim()) {
    conditions.push("album.id = ?");
    parameters.push(Number(albumId));
  }
  return getScopedLibrary({ source, availableOnly, conditions, parameters });
}

// SQLite caps bound parameters per statement; keep each IN list comfortably below it.
const LOOKUP_CHUNK_SIZE = 500;

const chunked = <T>(values: T[]): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += LOOKUP_CHUNK_SIZE) {
    chunks.push(values.slice(index, index + LOOKUP_CHUNK_SIZE));
  }
  return chunks;
};

export function getLibraryForTrackMatches({
  source = null,
  availableOnly = false,
  mbids = [],
  titles = [],
}: LibraryScope & { mbids?: unknown[]; titles?: unknown[] } = {}) {
  const mbidValues = normalizeLookupValues(mbids);
  const titleValues = normalizeLookupValues(titles);
  if (!mbidValues.length && !titleValues.length) return { artists: [], albums: [], tracks: [] };
  const clauses = [
    ...chunked(mbidValues).map((chunk) => ({
      sql: `track.mbid IN (${chunk.map(() => "?").join(",")})`,
      chunk,
    })),
    ...chunked(titleValues).map((chunk) => ({
      sql: `track.title COLLATE NOCASE IN (${chunk.map(() => "?").join(",")})`,
      chunk,
    })),
  ];
  const addMissingById = <T extends { id: number }>(target: Map<number, T>, entities: T[]) => {
    for (const entity of entities) {
      if (!target.has(entity.id)) target.set(entity.id, entity);
    }
  };
  // Any-size input resolves in ceil(n / chunk) statements; a track matched by more than one
  // clause is only kept once.
  const merged = {
    artists: new Map<number, LibraryRowArtist>(),
    albums: new Map<number, LibraryAlbum>(),
    tracks: new Map<number, LibraryTrack>(),
  };
  for (let index = 0; index < clauses.length; index += 2) {
    const group = clauses.slice(index, index + 2);
    const library = getScopedLibrary({
      source,
      availableOnly,
      conditions: [`(${group.map((clause) => clause.sql).join(" OR ")})`],
      parameters: group.flatMap((clause) => clause.chunk),
    });
    addMissingById(merged.artists, library.artists);
    addMissingById(merged.albums, library.albums);
    addMissingById(merged.tracks, library.tracks);
  }
  return {
    artists: [...merged.artists.values()],
    albums: [...merged.albums.values()],
    tracks: [...merged.tracks.values()],
  };
}

export function getLibraryForAlbumReferences({
  source = null,
  availableOnly = false,
  references: requestedReferences = [],
}: LibraryScope & { references?: unknown[] } = {}) {
  const references = normalizeLookupValues(requestedReferences);
  if (!references.length) return { artists: [], albums: [], tracks: [] };
  const columns = [
    "identity_key",
    "mbid",
    "release_group_mbid",
    "CAST(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.id') END AS TEXT)",
  ];
  const ids = resolveLibraryReferenceIds("library_albums", references, columns);
  if (!ids.length) return { artists: [], albums: [], tracks: [] };
  const sourceFilter = normalizeSource(source);
  const mediaConditions = [
    "media.track_id = album_track.track_id",
    albumMediaCondition("media", "album_track"),
  ];
  const parameters: unknown[] = [];
  if (sourceFilter) {
    mediaConditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  if (availableOnly === true) mediaConditions.push("media.available = 1");
  parameters.push(...ids);
  const mediaJoin = sourceFilter || availableOnly === true ? "JOIN" : "LEFT JOIN";
  const rows = db
    .prepare<unknown[], LibraryCanonicalRow>(
      `${CANONICAL_SELECT}
     FROM library_tracks AS track
     JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
     JOIN library_albums AS album ON album.id = album_track.album_id
     JOIN library_artists AS artist ON artist.id = album.artist_id
     ${mediaJoin} library_media_files AS media ON ${mediaConditions.join(" AND ")}
     WHERE album.id IN (${ids.map(() => "?").join(",")})
     ${libraryArtistOrder}`,
    )
    .iterate(...parameters);
  return buildLibraryFromRows(rows);
}

export function getLibrary({
  source = null,
  availableOnly = false,
  favoriteKeys = null,
}: LibraryScope & {
  favoriteKeys?: { kind: string; key: string | null | undefined }[] | null;
} = {}) {
  refreshLibraryManagementCache();
  const sourceFilter = normalizeSource(source);
  const cacheKey = `${sourceFilter || "all"}:${availableOnly === true ? "available" : "all"}`;
  const favoriteTargets = Array.isArray(favoriteKeys)
    ? favoriteKeys.filter(
        (target) =>
          target &&
          ["artist", "album", "song"].includes(target.kind) &&
          String(target.key || "").trim(),
      )
    : null;
  if (favoriteTargets && favoriteTargets.length === 0) {
    return { artists: [], albums: [], tracks: [] };
  }
  if (!favoriteTargets) {
    const cached = libraryCache.get(cacheKey);
    if (cached) return cached;
  }
  const conditions: string[] = [];
  const parameters: unknown[] = [];

  if (sourceFilter) {
    conditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  if (availableOnly === true) conditions.push("media.available = 1");
  if (favoriteTargets) {
    const targetQueries: string[] = [];
    const add = (query: string, kind: string) => {
      const keys = favoriteTargets
        .filter((target) => target.kind === kind)
        .map((target) => String(target.key).trim());
      if (!keys.length) return;
      targetQueries.push(query.replace("?", keys.map(() => "?").join(",")));
      parameters.push(...keys);
    };
    add("SELECT id FROM library_tracks WHERE identity_key IN (?)", "song");
    add(
      "SELECT album_track.track_id FROM library_album_tracks AS album_track " +
        "JOIN library_albums AS album ON album.id = album_track.album_id " +
        "WHERE album.identity_key IN (?)",
      "album",
    );
    add(
      "SELECT album_track.track_id FROM library_album_tracks AS album_track " +
        "JOIN library_albums AS album ON album.id = album_track.album_id " +
        "JOIN library_artists AS artist ON artist.id = album.artist_id " +
        "WHERE artist.identity_key IN (?)",
      "artist",
    );
    if (!targetQueries.length) return { artists: [], albums: [], tracks: [] };
    conditions.push(`track.id IN (${targetQueries.join(" UNION ")})`);
    conditions.push("media.id IS NOT NULL");
  }

  const rows = db
    .prepare<unknown[], LibraryCanonicalRow>(
      `${CANONICAL_SELECT}
    ${CANONICAL_FROM}
    ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
    ORDER BY artist.sort_name COLLATE NOCASE, artist.name COLLATE NOCASE,
      album.title COLLATE NOCASE, album_track.disc_number, album_track.track_number,
      track.title COLLATE NOCASE, media.path COLLATE NOCASE`,
    )
    .iterate(...parameters);
  const library = buildLibraryFromRows(rows);
  if (!favoriteTargets) libraryCache.set(cacheKey, library);
  return library;
}

const text = (value: unknown) => String(value || "").trim();

const pageNumber = (value: unknown) => Math.max(1, Number.parseInt(String(value), 10) || 1);

const pageSize = (value: string | number, max = MAX_PAGE_SIZE) =>
  Math.min(max, Math.max(1, Number.parseInt(String(value), 10) || DEFAULT_PAGE_SIZE));

type LibraryArtistPageRow = {
  artist_id: LibraryArtistsRow["id"];
  artist_identity_key: LibraryArtistsRow["identity_key"];
  artist_mbid: LibraryArtistsRow["mbid"];
  artist_name: LibraryArtistsRow["name"];
  artist_sort_name: LibraryArtistsRow["sort_name"];
  artist_metadata_json: LibraryArtistsRow["metadata_json"];
  album_count: number;
};

type LibraryArtistAggregateRow = LibraryArtistPageRow & {
  track_count: number;
  size_on_disk: number;
  sources: string | null;
  available: number | null;
};

const genreStatsCache = new Map<string, unknown[]>();
const GENRE_STATS_SETTING_PREFIX = "libraryGenreStats:";

const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");

const mediaSourceClause = (sourceFilter: string | null, alias = "page_media") => {
  const conditions: string[] = [];
  const parameters: unknown[] = [];
  if (sourceFilter) {
    conditions.push(`${alias}.source = ?`);
    parameters.push(sourceFilter);
  }
  return { conditions, parameters };
};

const recentMediaFilter = (
  sourceFilter: string | null,
  availableOnly: LibraryAvailability,
  alias = "page_media",
) => {
  const conditions: string[] = [];
  if (sourceFilter) conditions.push(`${alias}.source = '${sourceFilter}'`);
  if (availableOnly === true) conditions.push(`${alias}.available = 1`);
  return conditions.length ? ` AND ${conditions.join(" AND ")}` : "";
};

const recentMediaOrder = (
  kind: string,
  sourceFilter: string | null,
  availableOnly: LibraryAvailability,
  direction: string,
) => {
  const orderDirection = direction === "desc" ? "ASC" : "DESC";
  const mediaFilter = recentMediaFilter(sourceFilter, availableOnly);
  if (kind === "artists") {
    return `COALESCE((
      SELECT MAX(page_media.created_at)
      FROM library_albums AS page_album
      JOIN library_album_tracks AS page_album_track ON page_album_track.album_id = page_album.id
      JOIN library_media_files AS page_media INDEXED BY idx_library_media_files_track_album_source_available_created
        ON page_media.track_id = page_album_track.track_id
      WHERE page_album.artist_id = artist.id
        AND ${albumMediaCondition("page_media", "page_album_track")}${mediaFilter}
    ), 0) ${orderDirection}, artist.name COLLATE NOCASE ${direction === "desc" ? "DESC" : "ASC"}`;
  }
  if (kind === "albums") {
    return `COALESCE((
      SELECT MAX(page_media.created_at)
      FROM library_album_tracks AS page_album_track
      JOIN library_media_files AS page_media INDEXED BY idx_library_media_files_track_album_source_available_created
        ON page_media.track_id = page_album_track.track_id
      WHERE page_album_track.album_id = album.id
        AND ${albumMediaCondition("page_media", "page_album_track")}${mediaFilter}
    ), 0) ${orderDirection}, album.title COLLATE NOCASE ${direction === "desc" ? "DESC" : "ASC"}`;
  }
  return `COALESCE((
    SELECT MAX(page_media.created_at)
    FROM library_media_files AS page_media INDEXED BY idx_library_media_files_track_album_source_available_created
    WHERE page_media.track_id = track.id${mediaFilter}
  ), 0) ${orderDirection}, track.title COLLATE NOCASE ${direction === "desc" ? "DESC" : "ASC"}`;
};

// The Library shows what can be played, and the albums Aurral is fetching.
export const LIBRARY_VIEW = "library";

const aurralFetching = (alias: string) => `CASE WHEN json_valid(${alias}.metadata_json)
  THEN json_extract(${alias}.metadata_json, '$.librarySource') = 'aurral'
    AND json_extract(${alias}.metadata_json, '$.monitored') = 1
  ELSE 0 END`;

const visibleAlbum = (sourceFilter: string | null): PageSql => {
  const playable = pageMediaExists("albums", sourceFilter, true);
  if (sourceFilter) return playable;
  return {
    sql: `(${playable.sql} OR ${aurralFetching("album")})`,
    parameters: playable.parameters,
  };
};

const pageMediaExists = (
  kind: string,
  sourceFilter: string | null,
  availableOnly: LibraryAvailability,
): PageSql => {
  if (availableOnly === LIBRARY_VIEW) {
    if (kind === "tracks") return pageMediaExists(kind, sourceFilter, true);
    const album = visibleAlbum(sourceFilter);
    if (kind === "albums") return album;
    return {
      sql: `EXISTS (SELECT 1 FROM library_albums AS album WHERE album.artist_id = artist.id AND ${album.sql})`,
      parameters: album.parameters,
    };
  }
  if (!sourceFilter && availableOnly !== true) {
    if (kind === "artists") {
      return {
        sql: `EXISTS (
          SELECT 1
          FROM library_albums AS page_album
          JOIN library_album_tracks AS page_album_track ON page_album_track.album_id = page_album.id
          JOIN library_tracks AS page_track ON page_track.id = page_album_track.track_id
          WHERE page_album.artist_id = artist.id
        )`,
        parameters: [],
      };
    }
    if (kind === "albums") {
      return {
        sql: `EXISTS (
          SELECT 1
          FROM library_album_tracks AS page_album_track
          JOIN library_tracks AS page_track ON page_track.id = page_album_track.track_id
          WHERE page_album_track.album_id = album.id
        )`,
        parameters: [],
      };
    }
    return { sql: "1 = 1", parameters: [] };
  }
  const { conditions, parameters } = mediaSourceClause(sourceFilter);
  if (availableOnly === true) conditions.push("page_media.available = 1");
  const conditionSql = conditions.length ? conditions.join(" AND ") : "1 = 1";
  if (kind === "artists") {
    return {
      sql: `EXISTS (
        SELECT 1
        FROM library_albums AS page_album
        JOIN library_album_tracks AS page_album_track ON page_album_track.album_id = page_album.id
        JOIN library_media_files AS page_media INDEXED BY idx_library_media_files_track_album_source_available
          ON page_media.track_id = page_album_track.track_id
        WHERE page_album.artist_id = artist.id
          AND ${albumMediaCondition("page_media", "page_album_track")}
          AND ${conditionSql}
      )`,
      parameters,
    };
  }
  if (kind === "albums") {
    return {
      sql: `EXISTS (
        SELECT 1
        FROM library_album_tracks AS page_album_track
        JOIN library_media_files AS page_media INDEXED BY idx_library_media_files_track_album_source_available
          ON page_media.track_id = page_album_track.track_id
        WHERE page_album_track.album_id = album.id
          AND ${albumMediaCondition("page_media", "page_album_track")}
          AND ${conditionSql}
      )`,
      parameters,
    };
  }
  return {
    sql: `EXISTS (
      SELECT 1 FROM library_media_files AS page_media INDEXED BY idx_library_media_files_track_album_source_available
      WHERE page_media.track_id = track.id AND ${conditionSql}
    )`,
    parameters,
  };
};

const genrePredicate = (aliases: string[], genre: string): PageSql => {
  const clauses: string[] = [];
  const parameters: unknown[] = [];
  aliases.forEach((alias) => {
    clauses.push(`${alias}.id IN (
      SELECT entity_id FROM library_entity_genres
      WHERE entity_kind = '${alias}s' AND lower(name) = lower(?)
    )`);
    parameters.push(genre);
  });
  return { sql: `(${clauses.join(" OR ")})`, parameters };
};

const pageLimit = (value: string | number | null | undefined, fallback = 10000) => {
  if (value === null || value === undefined || value === "") return fallback;
  return Math.min(10000, Math.max(0, Number.parseInt(String(value), 10) || 0));
};

const pageOffset = (value: string | number) => Math.max(0, Number.parseInt(String(value), 10) || 0);

export function getLibraryArtistPage({
  source = null,
  availableOnly = false,
  query = "",
  offset = 0,
  limit = null,
  includeStats = false,
  searchMatch = null,
  artistIds = null,
}: LibraryScope & {
  query?: string;
  offset?: number | string;
  limit?: number | string | null;
  includeStats?: boolean;
  searchMatch?: string | null;
  artistIds?: unknown[] | null;
} = {}) {
  const sourceFilter = normalizeSource(source);
  const media = pageMediaExists("artists", sourceFilter, availableOnly);
  const artistManagement = getManagedByMap("artist");
  const conditions = [media.sql];
  const parameters = [...media.parameters];
  const normalizedQuery = text(query).toLocaleLowerCase();
  if (normalizedQuery && !searchMatch) {
    conditions.push("lower(artist.name) LIKE ? ESCAPE '\\'");
    parameters.push(`%${escapeLike(normalizedQuery)}%`);
  }
  const boundedLimit =
    limit === null || limit === undefined || limit === "" ? null : pageLimit(limit);
  const pageSql = boundedLimit === null ? "" : "LIMIT ? OFFSET ?";
  const searchJoin = searchMatch
    ? `JOIN library_search_documents AS search_document
         ON search_document.entity_kind = 'artist' AND search_document.entity_id = artist.id
       JOIN library_search_fts AS search_fts
         ON search_fts.rowid = search_document.id AND library_search_fts MATCH ?`
    : "";
  if (searchMatch) {
    const pattern = `%${escapeLike(normalizedQuery)}%`;
    const document =
      Array.isArray(artistIds) ||
      db
        .prepare<[string], { 1: number }>(
          `SELECT 1 FROM library_search_documents
       WHERE entity_kind = 'artist' AND lower(title) LIKE ? ESCAPE '\\'
       LIMIT 1`,
        )
        .get(pattern);
    if (!document) return { artists: [], albums: [], tracks: [] };
    parameters.unshift(searchMatch);
    conditions.push("lower(search_document.title) LIKE ? ESCAPE '\\'");
    parameters.push(`%${escapeLike(normalizedQuery)}%`);
  }
  const ids = Array.isArray(artistIds)
    ? [
        ...new Set(
          artistIds
            .map((value) => Number(value))
            .filter((value) => Number.isSafeInteger(value) && value > 0),
        ),
      ]
    : db
        .prepare<unknown[], { id: number }>(
          `SELECT artist.id
       FROM library_artists AS artist
       ${searchJoin}
       WHERE ${conditions.join(" AND ")}
       ${
         searchMatch
           ? "ORDER BY coalesce(artist.sort_name, artist.name) COLLATE NOCASE, artist.name COLLATE NOCASE, artist.id"
           : "ORDER BY coalesce(artist.sort_name, artist.name) COLLATE NOCASE, artist.name COLLATE NOCASE, artist.id"
       }
       ${pageSql}`,
        )
        .all(...parameters, ...(boundedLimit === null ? [] : [boundedLimit, pageOffset(offset)]))
        .map((row) => row.id);
  if (!ids.length) return { artists: [], albums: [], tracks: [] };

  const shownAlbums = availableOnly === LIBRARY_VIEW ? visibleAlbum(sourceFilter) : null;
  if (!includeStats) {
    const filterAlbums = Boolean(sourceFilter) || availableOnly === true || Boolean(shownAlbums);
    const albumJoin = filterAlbums ? "JOIN" : "LEFT JOIN";
    const albumFilter = shownAlbums
      ? `AND ${shownAlbums.sql}`
      : filterAlbums
        ? `AND EXISTS (
          SELECT 1
          FROM library_album_tracks AS album_track
          JOIN library_media_files AS media
            ON media.track_id = album_track.track_id
            AND ${albumMediaCondition("media", "album_track")}
          WHERE album_track.album_id = album.id
            ${sourceFilter ? "AND media.source = ?" : ""}
            ${availableOnly === true ? "AND media.available = 1" : ""}
        )`
        : "";
    const rows = db
      .prepare<unknown[], LibraryArtistPageRow>(
        `SELECT
         artist.id AS artist_id,
         artist.identity_key AS artist_identity_key,
         artist.mbid AS artist_mbid,
         artist.name AS artist_name,
         artist.sort_name AS artist_sort_name,
         artist.metadata_json AS artist_metadata_json,
         COUNT(DISTINCT album.id) AS album_count
       FROM library_artists AS artist
       ${albumJoin} library_albums AS album ON album.artist_id = artist.id
       WHERE artist.id IN (${ids.map(() => "?").join(",")})
         ${albumFilter}
       GROUP BY artist.id`,
      )
      .all(...ids, ...(shownAlbums ? shownAlbums.parameters : sourceFilter ? [sourceFilter] : []));
    const byId = new Map(
      rows.map((row) => {
        const metadata = parseJson<StoredLibraryMetadata>(row.artist_metadata_json);
        return [
          row.artist_id,
          {
            id: row.artist_id,
            canonicalId: String(row.artist_id),
            identityKey: row.artist_identity_key,
            mbid: row.artist_mbid,
            name: row.artist_name,
            sortName: row.artist_sort_name,
            metadata,
            providerId: metadata?.id ?? null,
            albumIds: [],
            albumCount: Number(row.album_count || 0),
            managedBy: artistManagement.get(row.artist_id)?.managedBy ?? null,
            monitorMode: artistManagement.get(row.artist_id)?.monitorMode ?? null,
            sources: [],
            source: null,
            monitored: metadata?.monitored === true,
            available: availableOnly === true,
          },
        ];
      }),
    );
    return {
      artists: ids
        .map((id) => byId.get(id))
        .filter((artist): artist is NonNullable<typeof artist> => Boolean(artist)),
      albums: [],
      tracks: [],
    };
  }

  const aggregateParameters = [];
  const mediaConditions = [
    "media.track_id = album_track.track_id",
    albumMediaCondition("media", "album_track"),
  ];
  if (sourceFilter) {
    mediaConditions.push("media.source = ?");
    aggregateParameters.push(sourceFilter);
  }
  if (availableOnly === true) mediaConditions.push("media.available = 1");
  const mediaJoin = sourceFilter || availableOnly === true ? "JOIN" : "LEFT JOIN";
  aggregateParameters.push(...ids, ...(shownAlbums?.parameters || []));
  const rows = db
    .prepare<unknown[], LibraryArtistAggregateRow>(
      `SELECT
       artist.id AS artist_id,
       artist.identity_key AS artist_identity_key,
       artist.mbid AS artist_mbid,
       artist.name AS artist_name,
       artist.sort_name AS artist_sort_name,
       artist.metadata_json AS artist_metadata_json,
       COUNT(DISTINCT album.id) AS album_count,
       COUNT(DISTINCT album_track.track_id) AS track_count,
       COALESCE(SUM(media.size), 0) AS size_on_disk,
       GROUP_CONCAT(DISTINCT media.source) AS sources,
       MAX(media.available) AS available
     FROM library_artists AS artist
     JOIN library_albums AS album ON album.artist_id = artist.id
     JOIN library_album_tracks AS album_track ON album_track.album_id = album.id
     ${mediaJoin} library_media_files AS media ON ${mediaConditions.join(" AND ")}
     WHERE artist.id IN (${ids.map(() => "?").join(",")})
       ${shownAlbums ? `AND ${shownAlbums.sql}` : ""}
     GROUP BY artist.id
     ORDER BY coalesce(artist.sort_name, artist.name) COLLATE NOCASE,
       artist.name COLLATE NOCASE`,
    )
    .all(...aggregateParameters);
  const byId = new Map(
    rows.map((row) => {
      const metadata = parseJson<StoredLibraryMetadata>(row.artist_metadata_json);
      const sources = parseSources(row.sources);
      return [
        row.artist_id,
        {
          id: row.artist_id,
          canonicalId: String(row.artist_id),
          identityKey: row.artist_identity_key,
          mbid: row.artist_mbid,
          name: row.artist_name,
          sortName: row.artist_sort_name,
          metadata,
          providerId: metadata?.id ?? null,
          albumIds: [],
          albumCount: Number(row.album_count || 0),
          trackCount: Number(row.track_count || 0),
          sizeOnDisk: Number(row.size_on_disk || 0),
          managedBy: artistManagement.get(row.artist_id)?.managedBy ?? null,
          monitorMode: artistManagement.get(row.artist_id)?.monitorMode ?? null,
          sources,
          source: sources.length === 1 ? sources[0] : null,
          monitored: metadata?.monitored === true,
          available: Boolean(row.available),
        },
      ];
    }),
  );
  return {
    artists: ids
      .map((id) => byId.get(id))
      .filter((artist): artist is NonNullable<typeof artist> => Boolean(artist)),
    albums: [],
    tracks: [],
  };
}

function albumGenrePredicate(genre: string) {
  const direct = genrePredicate(["artist", "album"], genre);
  const tracks = genrePredicate(["track"], genre);
  return {
    sql: `(${direct.sql} OR EXISTS (
      SELECT 1
      FROM library_album_tracks AS genre_album_track
      JOIN library_tracks AS track ON track.id = genre_album_track.track_id
      WHERE genre_album_track.album_id = album.id
        AND ${tracks.sql}
    ))`,
    parameters: [...direct.parameters, ...tracks.parameters],
  };
}

export function getLibraryAlbumPage({
  source = null,
  availableOnly = false,
  type = "alphabeticalByName",
  genre = "",
  fromYear = null,
  toYear = null,
  query = "",
  artistId = null,
  offset = 0,
  limit = 20,
  searchMatch = null,
}: LibraryScope & {
  type?: string;
  genre?: string;
  fromYear?: string | number | null;
  toYear?: string | number | null;
  query?: string;
  artistId?: string | number | null;
  offset?: number | string;
  limit?: number | string;
  searchMatch?: string | null;
} = {}) {
  const sourceFilter = normalizeSource(source);
  const media = pageMediaExists("albums", sourceFilter, availableOnly);
  const conditions = [media.sql];
  const parameters = [...media.parameters];
  const normalizedQuery = text(query).toLocaleLowerCase();
  if (normalizedQuery && !searchMatch) {
    const fields = ["album.title", "album.album_artist", "artist.name"];
    const pattern = `%${escapeLike(normalizedQuery)}%`;
    conditions.push(
      `(${fields.map((field) => `lower(coalesce(${field}, '')) LIKE ? ESCAPE '\\'`).join(" OR ")})`,
    );
    parameters.push(...fields.map(() => pattern));
  }
  if (artistId !== null && artistId !== undefined && String(artistId).trim()) {
    conditions.push("album.artist_id = ?");
    parameters.push(Number(artistId));
  }
  const normalizedGenre = text(genre);
  if (normalizedGenre) {
    const predicate = albumGenrePredicate(normalizedGenre);
    conditions.push(predicate.sql);
    parameters.push(...predicate.parameters);
  }
  const parsedFromYear = Number.parseInt(String(fromYear), 10);
  const parsedToYear = Number.parseInt(String(toYear), 10);
  const lowerYear =
    Number.isFinite(parsedFromYear) && Number.isFinite(parsedToYear)
      ? Math.min(parsedFromYear, parsedToYear)
      : parsedFromYear;
  const upperYear =
    Number.isFinite(parsedFromYear) && Number.isFinite(parsedToYear)
      ? Math.max(parsedFromYear, parsedToYear)
      : parsedToYear;
  if (Number.isFinite(lowerYear)) {
    conditions.push("CAST(substr(COALESCE(album.release_date, ''), 1, 4) AS INTEGER) >= ?");
    parameters.push(lowerYear);
  }
  if (Number.isFinite(upperYear)) {
    conditions.push("CAST(substr(COALESCE(album.release_date, ''), 1, 4) AS INTEGER) <= ?");
    parameters.push(upperYear);
  }

  let orderBy;
  if (type === "random") {
    orderBy = "random()";
  } else if (type === "newest") {
    orderBy = recentMediaOrder("albums", sourceFilter, availableOnly, "asc");
  } else if (type === "alphabeticalByArtist") {
    orderBy =
      "coalesce(album.album_artist, artist.name) COLLATE NOCASE, album.title COLLATE NOCASE";
  } else if (type === "byYear") {
    orderBy = `CAST(substr(COALESCE(album.release_date, ''), 1, 4) AS INTEGER) ${Number.isFinite(parsedFromYear) && Number.isFinite(parsedToYear) && parsedFromYear > parsedToYear ? "DESC" : "ASC"}, album.title COLLATE NOCASE`;
  } else if (type === "byGenre") {
    orderBy =
      "coalesce(artist.name, album.album_artist) COLLATE NOCASE, album.title COLLATE NOCASE";
  } else {
    orderBy =
      "album.title COLLATE NOCASE, coalesce(album.album_artist, artist.name) COLLATE NOCASE";
  }

  const paginatedOrderBy = type === "random" ? orderBy : `${orderBy}, album.id`;
  const boundedLimit = pageLimit(limit, 20);
  if (boundedLimit === 0) return { artists: [], albums: [], tracks: [] };
  const searchJoin = searchMatch
    ? `JOIN library_search_documents AS search_document
         ON search_document.entity_kind = 'album' AND search_document.entity_id = album.id
       JOIN library_search_fts AS search_fts
         ON search_fts.rowid = search_document.id AND library_search_fts MATCH ?`
    : "";
  if (searchMatch) {
    const pattern = `%${escapeLike(normalizedQuery)}%`;
    const document = db
      .prepare<[string, string], { 1: number }>(
        `SELECT 1 FROM library_search_documents
       WHERE entity_kind = 'album'
         AND (lower(title) LIKE ? ESCAPE '\\' OR lower(artist_name) LIKE ? ESCAPE '\\')
       LIMIT 1`,
      )
      .get(pattern, pattern);
    if (!document) return { artists: [], albums: [], tracks: [] };
    parameters.unshift(searchMatch);
    conditions.push(
      "(lower(search_document.title) LIKE ? ESCAPE '\\' OR lower(search_document.artist_name) LIKE ? ESCAPE '\\')",
    );
    parameters.push(`%${escapeLike(normalizedQuery)}%`, `%${escapeLike(normalizedQuery)}%`);
  }
  const ids = db
    .prepare<unknown[], { id: number }>(
      `SELECT album.id
     FROM library_albums AS album
     JOIN library_artists AS artist ON artist.id = album.artist_id
     ${searchJoin}
     WHERE ${conditions.join(" AND ")}
     GROUP BY album.id
     ORDER BY ${paginatedOrderBy}
     LIMIT ? OFFSET ?`,
    )
    .all(...parameters, boundedLimit, pageOffset(offset))
    .map((row) => row.id);
  const library = getLibraryForAlbumIds({ source: sourceFilter, availableOnly, ids });
  const albumsById = new Map(library.albums.map((album) => [album.id, album]));
  library.albums = ids.map((id) => albumsById.get(id)).filter((album) => album !== undefined);
  return library;
}

function getRandomTrackIds({
  conditions,
  parameters,
  limit,
  offset,
}: {
  conditions: string[];
  parameters: unknown[];
  limit: number;
  offset: number;
}) {
  const maximum = Number(
    db
      .prepare<[], { maximum: number | null }>("SELECT max(id) AS maximum FROM library_tracks")
      .get()?.maximum || 0,
  );
  if (!maximum) return [];
  const needed = limit + offset;
  const pivot = Math.floor(Math.random() * maximum) + 1;
  const read = (operator: string, boundary: number, count: number) =>
    db
      .prepare<unknown[], { id: number }>(
        `SELECT track.id
     FROM library_tracks AS track
     WHERE ${conditions.join(" AND ")} AND track.id ${operator} ?
     ORDER BY track.id
     LIMIT ?`,
      )
      .all(...parameters, boundary, count)
      .map((row) => row.id);
  const ids = read(">=", pivot, needed);
  if (ids.length < needed) ids.push(...read("<", pivot, needed - ids.length));
  return ids.slice(offset, offset + limit);
}

export function getLibraryTrackPage({
  source = null,
  availableOnly = false,
  query = "",
  genre = "",
  fromYear = null,
  toYear = null,
  artist = "",
  artistId = null,
  albumId = null,
  offset = 0,
  limit = 20,
  random = false,
  searchMatch = null,
}: LibraryScope & {
  query?: string;
  genre?: string;
  fromYear?: string | number | null;
  toYear?: string | number | null;
  artist?: string;
  artistId?: string | number | null;
  albumId?: string | number | null;
  offset?: number | string;
  limit?: number | string;
  random?: boolean;
  searchMatch?: string | null;
} = {}) {
  const sourceFilter = normalizeSource(source);
  const media = pageMediaExists("tracks", sourceFilter, availableOnly);
  const conditions = [media.sql];
  const parameters = [...media.parameters];
  const fields = [
    "track.title",
    "track.artist_name",
    "album.title",
    "album.album_artist",
    "artist.name",
  ];
  const normalizedQuery = text(query).toLocaleLowerCase();
  if (normalizedQuery && !searchMatch) {
    const pattern = `%${escapeLike(normalizedQuery)}%`;
    conditions.push(
      `(${fields.map((field) => `lower(coalesce(${field}, '')) LIKE ? ESCAPE '\\'`).join(" OR ")})`,
    );
    parameters.push(...fields.map(() => pattern));
  }
  const artistReference = text(artist);
  const normalizedArtist = artistReference.toLocaleLowerCase();
  if (normalizedArtist) {
    conditions.push(
      "(lower(artist.name) = ? OR lower(coalesce(track.artist_name, '')) = ? OR artist.identity_key = ?)",
    );
    parameters.push(normalizedArtist, normalizedArtist, artistReference);
  }
  if (artistId !== null && artistId !== undefined && String(artistId).trim()) {
    conditions.push("artist.id = ?");
    parameters.push(Number(artistId));
  }
  if (albumId !== null && albumId !== undefined && String(albumId).trim()) {
    conditions.push("album.id = ?");
    parameters.push(Number(albumId));
  }
  const normalizedGenre = text(genre);
  if (normalizedGenre) {
    const predicate = genrePredicate(["artist", "album", "track"], normalizedGenre);
    conditions.push(predicate.sql);
    parameters.push(...predicate.parameters);
  }
  const parsedFromYear = Number.parseInt(String(fromYear), 10);
  const parsedToYear = Number.parseInt(String(toYear), 10);
  const lowerYear =
    Number.isFinite(parsedFromYear) && Number.isFinite(parsedToYear)
      ? Math.min(parsedFromYear, parsedToYear)
      : parsedFromYear;
  const upperYear =
    Number.isFinite(parsedFromYear) && Number.isFinite(parsedToYear)
      ? Math.max(parsedFromYear, parsedToYear)
      : parsedToYear;
  if (Number.isFinite(lowerYear)) {
    conditions.push("CAST(substr(COALESCE(album.release_date, ''), 1, 4) AS INTEGER) >= ?");
    parameters.push(lowerYear);
  }
  if (Number.isFinite(upperYear)) {
    conditions.push("CAST(substr(COALESCE(album.release_date, ''), 1, 4) AS INTEGER) <= ?");
    parameters.push(upperYear);
  }
  const boundedLimit = pageLimit(limit, 20);
  if (boundedLimit === 0) return { artists: [], albums: [], tracks: [] };
  const useSearchIndex =
    Boolean(searchMatch) &&
    !artistReference &&
    !(artistId !== null && artistId !== undefined && String(artistId).trim()) &&
    !(albumId !== null && albumId !== undefined && String(albumId).trim()) &&
    !normalizedGenre;
  if (useSearchIndex) {
    const pattern = `%${escapeLike(normalizedQuery)}%`;
    const searchConditions = [
      ...conditions,
      "(lower(search_document.title) LIKE ? ESCAPE '\\' OR lower(search_document.artist_name) LIKE ? ESCAPE '\\' OR lower(search_document.album_name) LIKE ? ESCAPE '\\')",
    ];
    const ids = db
      .prepare<unknown[], { id: number }>(
        `SELECT track.id
       FROM library_tracks AS track
       JOIN library_search_documents AS search_document
         ON search_document.entity_kind = 'track' AND search_document.entity_id = track.id
       JOIN library_search_fts AS search_fts
         ON search_fts.rowid = search_document.id AND library_search_fts MATCH ?
       WHERE ${searchConditions.join(" AND ")}
       ORDER BY track.id
       LIMIT ? OFFSET ?`,
      )
      .all(searchMatch, ...parameters, pattern, pattern, pattern, boundedLimit, pageOffset(offset))
      .map((row) => row.id);
    const library = getLibraryForTrackIds({ source: sourceFilter, availableOnly, ids, albumId });
    const tracksById = new Map(library.tracks.map((track) => [track.id, track]));
    library.tracks = ids.map((id) => tracksById.get(id)).filter((track) => track !== undefined);
    return library;
  }
  if (
    random &&
    !normalizedQuery &&
    !artistReference &&
    !normalizedGenre &&
    !Number.isFinite(lowerYear) &&
    !Number.isFinite(upperYear) &&
    !(artistId !== null && artistId !== undefined && String(artistId).trim()) &&
    !(albumId !== null && albumId !== undefined && String(albumId).trim())
  ) {
    const ids = getRandomTrackIds({
      conditions,
      parameters,
      limit: boundedLimit,
      offset: pageOffset(offset),
    });
    const library = getLibraryForTrackIds({ source: sourceFilter, availableOnly, ids, albumId });
    const tracksById = new Map(library.tracks.map((track) => [track.id, track]));
    library.tracks = ids.map((id) => tracksById.get(id)).filter((track) => track !== undefined);
    return library;
  }
  const orderBy = random
    ? "random()"
    : "artist.sort_name COLLATE NOCASE, artist.name COLLATE NOCASE, album.title COLLATE NOCASE, album_track.disc_number, album_track.track_number, track.title COLLATE NOCASE";
  const ids = db
    .prepare<unknown[], { id: number }>(
      `SELECT track.id
     FROM library_tracks AS track
     JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
     JOIN library_albums AS album ON album.id = album_track.album_id
     JOIN library_artists AS artist ON artist.id = album.artist_id
     WHERE ${conditions.join(" AND ")}
     GROUP BY track.id
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
    )
    .all(...parameters, boundedLimit, pageOffset(offset))
    .map((row) => row.id);
  const library = getLibraryForTrackIds({ source: sourceFilter, availableOnly, ids, albumId });
  const tracksById = new Map(library.tracks.map((track) => [track.id, track]));
  library.tracks = ids.map((id) => tracksById.get(id)).filter((track) => track !== undefined);
  return library;
}

export function getLibrarySearchPage({
  source = null,
  availableOnly = false,
  query = "",
  artistLimit = 20,
  artistOffset = 0,
  albumLimit = 20,
  albumOffset = 0,
  songLimit = 20,
  songOffset = 0,
}: LibraryScope & {
  query?: string;
  artistLimit?: number | string;
  artistOffset?: number | string;
  albumLimit?: number | string;
  albumOffset?: number | string;
  songLimit?: number | string;
  songOffset?: number | string;
} = {}) {
  const searchMatch = getLibrarySearchMatch(query);
  const albumLibrary = getLibraryAlbumPage({
    source,
    availableOnly,
    query,
    limit: albumLimit,
    offset: albumOffset,
    searchMatch,
  });
  const trackLibrary = getLibraryTrackPage({
    source,
    availableOnly,
    query,
    limit: songLimit,
    offset: songOffset,
    searchMatch,
  });
  return {
    artists: getLibraryArtistPage({
      source,
      availableOnly,
      query,
      limit: artistLimit,
      offset: artistOffset,
      searchMatch,
    }).artists,
    albums: albumLibrary,
    tracks: trackLibrary,
  };
}

export function getLibraryTopTracks({
  source = null,
  availableOnly = false,
  artist,
  limit = 20,
}: LibraryScope & { artist?: string; limit?: number | string } = {}) {
  return getLibraryTrackPage({ source, availableOnly, artist, limit });
}

export function getLibraryGenres({ source = null, availableOnly = false }: LibraryScope = {}) {
  const sourceFilter = normalizeSource(source);
  return readGenreStats(`subsonic:${genreStatsScope(sourceFilter, availableOnly)}`, () =>
    computeLibraryGenres(sourceFilter, availableOnly),
  );
}

function computeLibraryGenres(sourceFilter: string | null, availableOnly: LibraryAvailability) {
  const mediaConditions = [
    "media.track_id = album_track.track_id",
    albumMediaCondition("media", "album_track"),
  ];
  const parameters: unknown[] = [];
  if (sourceFilter) {
    mediaConditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  if (availableOnly === true) mediaConditions.push("media.available = 1");
  return db
    .prepare<unknown[], { value: string; albumCount: number; songCount: number | null }>(
      `WITH eligible_tracks AS MATERIALIZED (
       SELECT DISTINCT
         album.id AS album_id,
         track.id AS track_id,
         artist.id AS artist_id
       FROM library_albums AS album
       JOIN library_artists AS artist ON artist.id = album.artist_id
       JOIN library_album_tracks AS album_track ON album_track.album_id = album.id
       JOIN library_tracks AS track ON track.id = album_track.track_id
       WHERE EXISTS (
         SELECT 1
         FROM library_media_files AS media
         WHERE ${mediaConditions.join(" AND ")}
       )
     ),
     eligible_albums AS (
       SELECT DISTINCT album_id, artist_id FROM eligible_tracks
     ),
     direct_genres AS (
       SELECT eligible.album_id, genres.name AS genre
       FROM eligible_albums AS eligible
       JOIN library_entity_genres AS genres
         ON genres.entity_kind = 'artists' AND genres.entity_id = eligible.artist_id
       UNION
       SELECT eligible.album_id, genres.name AS genre
       FROM eligible_albums AS eligible
       JOIN library_entity_genres AS genres
         ON genres.entity_kind = 'albums' AND genres.entity_id = eligible.album_id
     ),
     track_genres AS (
       SELECT DISTINCT eligible.album_id, eligible.track_id, genres.name AS genre
       FROM eligible_tracks AS eligible
       CROSS JOIN library_entity_genres AS genres
       WHERE genres.entity_kind = 'tracks' AND genres.entity_id = eligible.track_id
         AND NOT EXISTS (
           SELECT 1 FROM direct_genres AS direct
           WHERE direct.album_id = eligible.album_id AND direct.genre = genres.name
         )
     ),
     track_counts AS (
       SELECT album_id, COUNT(*) AS song_count
       FROM eligible_tracks
       GROUP BY album_id
     ),
     album_genres AS (
       SELECT direct.album_id, direct.genre, tracks.song_count
       FROM direct_genres AS direct
       JOIN track_counts AS tracks ON tracks.album_id = direct.album_id
       UNION ALL
       SELECT track.album_id, track.genre, COUNT(*) AS song_count
       FROM track_genres AS track
       GROUP BY track.album_id, track.genre
     )
     SELECT genre AS value, COUNT(*) AS albumCount, SUM(song_count) AS songCount
     FROM album_genres
     GROUP BY genre
     ORDER BY genre COLLATE NOCASE`,
    )
    .all(...parameters)
    .map((row) => ({
      albumCount: Number(row.albumCount || 0),
      songCount: Number(row.songCount || 0),
      value: row.value,
    }));
}

function buildPageQuery({
  kind,
  sourceFilter,
  availableOnly,
  query,
  genre,
  sort,
  direction,
  artistId,
  albumId,
}: {
  kind: string;
  sourceFilter: string | null;
  availableOnly: LibraryAvailability;
  query: string;
  genre: string;
  sort: string;
  direction: string;
  artistId: string | number | null;
  albumId: string | number | null;
}) {
  const where: string[] = [];
  const parameters: unknown[] = [];
  const media = pageMediaExists(kind, sourceFilter, availableOnly);
  where.push(media.sql);
  parameters.push(...media.parameters);
  const searchMatch = getLibrarySearchMatch(query);

  let from: string;
  let idExpression: string;
  let searchableFields: string[];
  let genreAliases: string[];
  let entityKind: string;
  let groupBy: string | null = null;
  if (kind === "artists") {
    entityKind = "artist";
    from = "FROM library_artists AS artist";
    idExpression = "artist.id";
    searchableFields = ["artist.name"];
    genreAliases = ["artist"];
    if (artistId) {
      where.push("artist.id = ?");
      parameters.push(Number(artistId));
    }
    if (albumId) {
      where.push(
        "EXISTS (SELECT 1 FROM library_albums AS filter_album WHERE filter_album.id = ? AND filter_album.artist_id = artist.id)",
      );
      parameters.push(Number(albumId));
    }
  } else if (kind === "albums") {
    entityKind = "album";
    from =
      "FROM library_albums AS album JOIN library_artists AS artist ON artist.id = album.artist_id";
    idExpression = "album.id";
    searchableFields = ["album.title", "album.album_artist", "artist.name"];
    genreAliases = ["artist", "album"];
    if (artistId) {
      where.push(`album.id IN (${artistAlbumIdsSql("id", "?")})`);
      parameters.push(Number(artistId), Number(artistId));
    }
    if (albumId) {
      where.push("album.id = ?");
      parameters.push(Number(albumId));
    }
  } else {
    entityKind = "track";
    const needsRelations =
      Boolean(artistId || albumId || genre || sort === "artist") || Boolean(query && !searchMatch);
    from = needsRelations
      ? `FROM library_tracks AS track
        JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
        JOIN library_albums AS album ON album.id = album_track.album_id
        JOIN library_artists AS artist ON artist.id = album.artist_id`
      : "FROM library_tracks AS track";
    if (needsRelations) groupBy = "track.id";
    idExpression = "track.id";
    searchableFields = [
      "track.title",
      "track.artist_name",
      "album.title",
      "album.album_artist",
      "artist.name",
    ];
    genreAliases = ["artist", "album", "track"];
    if (artistId) {
      where.push("artist.id = ?");
      parameters.push(Number(artistId));
    }
    if (albumId) {
      where.push("album.id = ?");
      parameters.push(Number(albumId));
    }
  }

  if (searchMatch) {
    from += `
      JOIN library_search_documents AS search_document
        ON search_document.entity_kind = '${entityKind}'
        AND search_document.entity_id = ${idExpression}
      JOIN library_search_fts AS search_fts
        ON search_fts.rowid = search_document.id
        AND library_search_fts MATCH ?`;
    parameters.unshift(searchMatch);
    const pattern = `%${escapeLike(query)}%`;
    const indexedFields =
      kind === "artists"
        ? ["search_document.title"]
        : kind === "albums"
          ? ["search_document.title", "search_document.artist_name"]
          : ["search_document.title", "search_document.artist_name", "search_document.album_name"];
    where.push(
      `(${indexedFields.map((field) => `lower(${field}) LIKE ? ESCAPE '\\'`).join(" OR ")})`,
    );
    parameters.push(...indexedFields.map(() => pattern));
  } else if (query) {
    const pattern = `%${escapeLike(query)}%`;
    where.push(
      `(${searchableFields
        .map((field) => `lower(coalesce(${field}, '')) LIKE ? ESCAPE '\\'`)
        .join(" OR ")})`,
    );
    parameters.push(...searchableFields.map(() => pattern));
  }
  if (genre) {
    const predicate = genrePredicate(genreAliases, genre);
    where.push(predicate.sql);
    parameters.push(...predicate.parameters);
  }

  const orderDirection = direction === "desc" ? "DESC" : "ASC";
  let orderBy: string;
  if (sort === "newest") {
    orderBy = recentMediaOrder(kind, sourceFilter, availableOnly, direction);
    orderBy += kind === "albums" ? ", album.id" : kind === "artists" ? ", artist.id" : ", track.id";
  } else if (sort === "artist" && kind !== "artists") {
    const artistName =
      kind === "tracks" ? "coalesce(nullif(track.artist_name, ''), artist.name)" : "artist.name";
    orderBy = `${artistName} COLLATE NOCASE ${orderDirection}, ${kind === "albums" ? "album.title" : "track.title"} COLLATE NOCASE ${orderDirection}`;
    if (kind === "albums") orderBy += ", album.id";
    else orderBy += ", track.id";
  } else if (kind === "artists") {
    orderBy = `coalesce(artist.sort_name, artist.name) COLLATE NOCASE ${orderDirection}, artist.name COLLATE NOCASE ${orderDirection}, artist.id ${orderDirection}`;
  } else {
    orderBy = `${kind === "albums" ? "album.title" : "track.title"} COLLATE NOCASE ${orderDirection}`;
    if (kind === "albums") orderBy += `, album.id ${orderDirection}`;
    else orderBy += `, track.id ${orderDirection}`;
  }

  return {
    from,
    idExpression,
    where: where.join(" AND "),
    parameters,
    orderBy,
    groupBy,
  };
}

const genreStatsScope = (sourceFilter: string | null, availableOnly: LibraryAvailability) =>
  `${sourceFilter || "all"}:${availableOnly === true ? "available" : "all"}`;

function readGenreStats<T>(cacheKey: string, compute: () => T[]): T[] {
  const cached = genreStatsCache.get(cacheKey);
  if (cached) return cached as T[];
  const settingKey = `${GENRE_STATS_SETTING_PREFIX}${cacheKey}`;
  const stored = db
    .prepare<[string], Pick<SettingsRow, "value">>("SELECT value FROM settings WHERE key = ?")
    .get(settingKey)?.value;
  if (stored) {
    const parsed = parseJson<T[]>(stored);
    if (Array.isArray(parsed)) {
      genreStatsCache.set(cacheKey, parsed);
      return parsed;
    }
  }
  const stats = compute();
  genreStatsCache.set(cacheKey, stats);
  return stats;
}

function getLibraryGenreStats({
  sourceFilter,
  availableOnly: requested,
}: {
  sourceFilter: string | null;
  availableOnly: LibraryAvailability;
}) {
  const availableOnly = requested === LIBRARY_VIEW || requested === true;
  return readGenreStats(genreStatsScope(sourceFilter, availableOnly), () =>
    computeLibraryGenreStats(db, { sourceFilter, availableOnly }),
  );
}

function getPageLibrary(
  kind: string,
  ids: number[],
  sourceFilter: string | null,
  availableOnly: LibraryAvailability,
  albumId: string | number | null = null,
) {
  if (!ids.length) return { artists: [], albums: [], tracks: [] };
  const alias = kind === "artists" ? "artist" : kind === "albums" ? "album" : "track";
  const conditions = [`${alias}.id IN (${ids.map(() => "?").join(",")})`];
  const parameters: unknown[] = [...ids];
  if (sourceFilter) {
    conditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  if (availableOnly === true) conditions.push("media.available = 1");
  if (kind === "tracks" && albumId) {
    conditions.push("album.id = ?");
    parameters.push(Number(albumId));
  }
  const rows = db
    .prepare<unknown[], LibraryCanonicalRow>(
      `${CANONICAL_SELECT}
     ${CANONICAL_FROM}
     WHERE ${conditions.join(" AND ")}
     ORDER BY artist.sort_name COLLATE NOCASE, artist.name COLLATE NOCASE,
       album.title COLLATE NOCASE, album_track.disc_number, album_track.track_number,
       track.title COLLATE NOCASE, media.path COLLATE NOCASE`,
    )
    .iterate(...parameters);
  return buildLibraryFromRows(rows);
}

type AlbumTrackSummaryRow = {
  artist_id: LibraryArtistsRow["id"];
  artist_identity_key: LibraryArtistsRow["identity_key"];
  artist_mbid: LibraryArtistsRow["mbid"];
  artist_name: LibraryArtistsRow["name"];
  artist_sort_name: LibraryArtistsRow["sort_name"];
  artist_metadata_json: LibraryArtistsRow["metadata_json"];
  album_id: LibraryAlbumsRow["id"];
  album_identity_key: LibraryAlbumsRow["identity_key"];
  album_mbid: LibraryAlbumsRow["mbid"];
  album_release_group_mbid: LibraryAlbumsRow["release_group_mbid"];
  album_title: LibraryAlbumsRow["title"];
  album_artist: LibraryAlbumsRow["album_artist"];
  album_release_date: LibraryAlbumsRow["release_date"];
  album_created_at: LibraryAlbumsRow["created_at"];
  album_metadata_json: LibraryAlbumsRow["metadata_json"];
  sources: string | null;
  available: number | null;
};

type AlbumTrackPageOptions = {
  query?: string;
  genre?: string;
  sort?: string;
  direction?: string;
  artistId?: string | number | null;
};

function buildAlbumTrackPageQuery(
  albumId: string | number,
  sourceFilter: string | null,
  {
    query = "",
    genre = "",
    sort = "album",
    direction = "asc",
    artistId = null,
  }: AlbumTrackPageOptions = {},
) {
  const conditions = ["album.id = ?"];
  const parameters: unknown[] = [];
  const mediaConditions = [
    "media.track_id = track.id",
    albumMediaCondition("media", "album_track"),
  ];
  if (sourceFilter) {
    mediaConditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  parameters.push(Number(albumId));
  if (artistId) {
    conditions.push("artist.id = ?");
    parameters.push(Number(artistId));
  }
  if (query) {
    const pattern = `%${escapeLike(query)}%`;
    conditions.push(
      `(${["track.title", "track.artist_name", "album.title", "album.album_artist", "artist.name"]
        .map((field) => `lower(coalesce(${field}, '')) LIKE ? ESCAPE '\\'`)
        .join(" OR ")})`,
    );
    parameters.push(
      ...[
        "track.title",
        "track.artist_name",
        "album.title",
        "album.album_artist",
        "artist.name",
      ].map(() => pattern),
    );
  }
  if (genre) {
    const predicate = genrePredicate(["artist", "album", "track"], genre);
    conditions.push(predicate.sql);
    parameters.push(...predicate.parameters);
  }
  const orderDirection = direction === "desc" ? "DESC" : "ASC";
  const orderBy =
    sort === "album"
      ? "album_track.disc_number ASC, album_track.track_number ASC"
      : sort === "newest"
        ? recentMediaOrder("tracks", sourceFilter, false, direction)
        : sort === "artist"
          ? `coalesce(nullif(track.artist_name, ''), artist.name) COLLATE NOCASE ${orderDirection}, track.title COLLATE NOCASE ${orderDirection}`
          : `track.title COLLATE NOCASE ${orderDirection}`;
  return {
    from: `FROM library_tracks AS track
      JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
      JOIN library_albums AS album ON album.id = album_track.album_id
      JOIN library_artists AS artist ON artist.id = album.artist_id
      LEFT JOIN library_media_files AS media ON ${mediaConditions.join(" AND ")}`,
    where: conditions.join(" AND "),
    parameters,
    orderBy,
  };
}

function getAlbumTrackSummary(albumId: string | number, sourceFilter: string | null) {
  const mediaConditions = [
    "media.track_id = album_track.track_id",
    albumMediaCondition("media", "album_track"),
  ];
  const parameters: unknown[] = [];
  if (sourceFilter) {
    mediaConditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  parameters.push(Number(albumId));
  const row = db
    .prepare<unknown[], AlbumTrackSummaryRow>(
      `SELECT
       artist.id AS artist_id,
       artist.identity_key AS artist_identity_key,
       artist.mbid AS artist_mbid,
       artist.name AS artist_name,
       artist.sort_name AS artist_sort_name,
       artist.metadata_json AS artist_metadata_json,
       album.id AS album_id,
       album.identity_key AS album_identity_key,
       album.mbid AS album_mbid,
       album.release_group_mbid AS album_release_group_mbid,
       album.title AS album_title,
       album.album_artist AS album_artist,
       album.release_date AS album_release_date,
       album.created_at AS album_created_at,
       album.metadata_json AS album_metadata_json,
       GROUP_CONCAT(DISTINCT media.source) AS sources,
       MAX(media.available) AS available
     FROM library_albums AS album
     JOIN library_artists AS artist ON artist.id = album.artist_id
     JOIN library_album_tracks AS album_track ON album_track.album_id = album.id
     LEFT JOIN library_media_files AS media ON ${mediaConditions.join(" AND ")}
     WHERE album.id = ?
     GROUP BY album.id`,
    )
    .get(...parameters);
  if (!row) return { artist: null, album: null };
  const sources = parseSources(row.sources);
  const artistManagement = getManagedByMap("artist").get(row.artist_id) || null;
  const albumManagement = getManagedByMap("album").get(row.album_id) || null;
  return {
    artist: {
      id: row.artist_id,
      identityKey: row.artist_identity_key,
      mbid: row.artist_mbid,
      name: row.artist_name,
      sortName: row.artist_sort_name,
      metadata: parseJson<StoredLibraryMetadata>(row.artist_metadata_json),
      albumIds: [row.album_id],
      managedBy: artistManagement?.managedBy ?? null,
      monitorMode: artistManagement?.monitorMode ?? null,
      sources,
      available: Boolean(row.available),
    },
    album: {
      id: row.album_id,
      identityKey: row.album_identity_key,
      mbid: row.album_mbid,
      releaseGroupMbid: row.album_release_group_mbid,
      artistId: row.artist_id,
      title: row.album_title,
      albumArtist: row.album_artist,
      releaseDate: row.album_release_date,
      createdAt: row.album_created_at,
      metadata: parseJson<StoredLibraryMetadata>(row.album_metadata_json),
      trackIds: [],
      managedBy: albumManagement?.managedBy ?? null,
      monitorMode: albumManagement?.monitorMode ?? null,
      sources,
      available: Boolean(row.available),
    },
  };
}

function getAlbumTrackPageLibrary(
  albumId: string | number,
  sourceFilter: string | null,
  ids: number[],
) {
  if (!ids.length) return { artists: [], albums: [], tracks: [] };
  const mediaConditions = [
    "media.track_id = album_track.track_id",
    albumMediaCondition("media", "album_track"),
  ];
  const parameters: unknown[] = [];
  if (sourceFilter) {
    mediaConditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  parameters.push(Number(albumId), ...ids);
  const rows = db
    .prepare<unknown[], LibraryCanonicalRow>(
      `${CANONICAL_SELECT}
     FROM library_tracks AS track
     JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
     JOIN library_albums AS album ON album.id = album_track.album_id
     JOIN library_artists AS artist ON artist.id = album.artist_id
     LEFT JOIN library_media_files AS media ON ${mediaConditions.join(" AND ")}
     WHERE album.id = ? AND track.id IN (${ids.map(() => "?").join(",")})
     ORDER BY album_track.disc_number, album_track.track_number,
       track.title COLLATE NOCASE, media.path COLLATE NOCASE`,
    )
    .iterate(...parameters);
  return buildLibraryFromRows(rows);
}

function getAlbumTrackPage(
  albumId: string | number,
  sourceFilter: string | null,
  page: number,
  currentPageSize: number,
  options: AlbumTrackPageOptions = {},
) {
  const queryDefinition = buildAlbumTrackPageQuery(albumId, sourceFilter, options);
  const total = Number(
    db
      .prepare<unknown[], { total: number }>(
        `SELECT COUNT(DISTINCT track.id) AS total
     ${queryDefinition.from}
     WHERE ${queryDefinition.where}`,
      )
      .get(...queryDefinition.parameters)?.total || 0,
  );
  const pageIds = db
    .prepare<unknown[], { page_id: number }>(
      `SELECT track.id AS page_id
     ${queryDefinition.from}
     WHERE ${queryDefinition.where}
     GROUP BY track.id
     ORDER BY ${queryDefinition.orderBy}, album_track.disc_number, album_track.track_number,
       media.path COLLATE NOCASE
     LIMIT ? OFFSET ?`,
    )
    .all(...queryDefinition.parameters, currentPageSize, (page - 1) * currentPageSize)
    .map((row) => row.page_id);
  const library = getAlbumTrackPageLibrary(albumId, sourceFilter, pageIds);
  const tracksById = new Map(library.tracks.map((track) => [track.id, track]));
  const pageItems = pageIds.map((id) => tracksById.get(id)).filter((track) => track !== undefined);
  const summary = getAlbumTrackSummary(albumId, sourceFilter);
  const stats = getAlbumStats([Number(albumId)], sourceFilter).get(String(albumId));
  const album = summary.album;
  const albums = album
    ? [
        {
          ...album,
          trackIds: pageItems.map((track) => track.id),
          trackCount: total,
          availableTrackCount: stats?.availableTrackCount ?? 0,
        },
      ]
    : [];
  return {
    kind: "tracks" as const,
    page,
    pageSize: currentPageSize,
    total,
    hasMore: page * currentPageSize < total,
    items: pageItems,
    artists: summary.artist ? [summary.artist] : [],
    albums,
    tracks: pageItems,
    genres: getLibraryGenreStats({ sourceFilter, availableOnly: false }),
  };
}

function getAlbumStats(
  albumIds: number[],
  sourceFilter: string | null,
): Map<string, { trackCount: number; availableTrackCount: number }> {
  if (!albumIds.length) return new Map();
  const conditions = [`album_track.album_id IN (${albumIds.map(() => "?").join(",")})`];
  const parameters: unknown[] = [];
  const mediaConditions = [
    "media.track_id = album_track.track_id",
    albumMediaCondition("media", "album_track"),
  ];
  if (sourceFilter) {
    mediaConditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  parameters.push(...albumIds);
  const rows = db
    .prepare<unknown[], { album_id: number; track_count: number; available_track_count: number }>(
      `SELECT
       album_track.album_id AS album_id,
       COUNT(DISTINCT album_track.track_id) AS track_count,
       COUNT(DISTINCT CASE WHEN media.available = 1 THEN album_track.track_id END) AS available_track_count
     FROM library_album_tracks AS album_track
     LEFT JOIN library_media_files AS media
       ON ${mediaConditions.join(" AND ")}
     WHERE ${conditions.join(" AND ")}
     GROUP BY album_track.album_id`,
    )
    .all(...parameters);
  return new Map(
    rows.map((row) => [
      String(row.album_id),
      {
        trackCount: Number(row.track_count),
        availableTrackCount: Number(row.available_track_count),
      },
    ]),
  );
}

type LibraryPageOptions = LibraryScope & {
  kind?: string;
  page?: unknown;
  pageSize?: number | string;
  offset?: number | string | null;
  query?: unknown;
  genre?: unknown;
  sort?: unknown;
  direction?: unknown;
  artistId?: string | number | null;
  albumId?: string | number | null;
};

type LibraryPageItems = {
  artists: ReturnType<typeof getLibraryArtistPage>["artists"][number][];
  albums: (LibraryAlbum & { trackCount: number; availableTrackCount: number })[];
  tracks: LibraryTrack[];
  genres: LibraryGenre[];
};

type LibraryPage<Kind extends keyof LibraryPageItems = keyof LibraryPageItems> = {
  [PageKind in Kind]: {
    kind: PageKind;
    page: number;
    pageSize: number;
    total: number;
    hasMore: boolean;
    items: LibraryPageItems[PageKind];
    artists: LibraryArtist[];
    albums: LibraryAlbum[];
    tracks: LibraryTrack[];
    genres: LibraryGenre[];
  };
}[Kind];

export function getLibraryPage<Kind extends keyof LibraryPageItems>(
  options: LibraryPageOptions & { kind: Kind },
): LibraryPage<Kind>;
export function getLibraryPage(
  options?: LibraryPageOptions & { kind?: undefined },
): LibraryPage<"albums">;
export function getLibraryPage(options?: LibraryPageOptions): LibraryPage;
export function getLibraryPage({
  source = null,
  availableOnly = false,
  kind = "albums",
  page = 1,
  pageSize: requestedPageSize = DEFAULT_PAGE_SIZE,
  offset = null,
  query = "",
  genre = "",
  sort = null,
  direction = "asc",
  artistId = null,
  albumId = null,
}: LibraryPageOptions = {}): LibraryPage {
  const normalizedKind = text(kind).toLocaleLowerCase();
  if (!isPageKind(normalizedKind)) {
    throw new Error(`Unsupported library page kind: ${normalizedKind}`);
  }
  const sourceFilter = normalizeSource(source);
  const normalizedQuery = text(query).toLocaleLowerCase();
  const normalizedGenre = text(genre);
  const normalizedDirection = text(direction).toLocaleLowerCase();
  const normalizedSort =
    text(sort).toLocaleLowerCase() || (normalizedKind === "tracks" && albumId ? "album" : "name");
  const currentPage = pageNumber(page);
  const currentPageSize = pageSize(
    requestedPageSize,
    normalizedKind === "artists" ? MAX_ARTIST_PROJECTION_PAGE_SIZE : MAX_PAGE_SIZE,
  );
  const currentOffset =
    offset == null
      ? (currentPage - 1) * currentPageSize
      : Math.max(0, Number.parseInt(String(offset), 10) || 0);

  if (normalizedKind === "genres") {
    let collection = getLibraryGenreStats({ sourceFilter, availableOnly });
    if (normalizedQuery) {
      collection = collection.filter((entry) =>
        entry.name.toLocaleLowerCase().includes(normalizedQuery),
      );
    }
    if (normalizedDirection === "desc") collection = [...collection].reverse();
    const total = collection.length;
    const items = collection.slice(
      (currentPage - 1) * currentPageSize,
      currentPage * currentPageSize,
    );
    return {
      kind: normalizedKind,
      page: currentPage,
      pageSize: currentPageSize,
      total,
      hasMore: currentPage * currentPageSize < total,
      items,
      artists: [],
      albums: [],
      tracks: [],
      genres: getLibraryGenreStats({ sourceFilter, availableOnly }),
    };
  }

  if (normalizedKind === "tracks" && albumId && availableOnly !== true) {
    return getAlbumTrackPage(albumId, sourceFilter, currentPage, currentPageSize, {
      query: normalizedQuery,
      genre: normalizedGenre,
      sort: normalizedSort,
      direction: normalizedDirection,
      artistId,
    });
  }

  const queryDefinition = buildPageQuery({
    kind: normalizedKind,
    sourceFilter,
    availableOnly,
    query: normalizedQuery,
    genre: normalizedGenre,
    sort: normalizedSort,
    direction: normalizedDirection,
    artistId,
    albumId,
  });
  const total = getPageTotal(
    `SELECT COUNT(DISTINCT ${queryDefinition.idExpression}) AS total
     ${queryDefinition.from}
     WHERE ${queryDefinition.where}`,
    queryDefinition.parameters,
  );
  const matchingIds = `SELECT ${queryDefinition.idExpression} AS page_id
     ${queryDefinition.from}
     WHERE ${queryDefinition.where}`;
  const broadTrackSearch =
    normalizedKind === "tracks" &&
    normalizedQuery &&
    normalizedSort === "name" &&
    !queryDefinition.groupBy &&
    currentOffset + currentPageSize <= 1000 &&
    total > getPageTotal("SELECT COUNT(*) AS total FROM library_tracks", []) / 2;
  const pageQuery = broadTrackSearch
    ? `SELECT track.id AS page_id
       FROM library_tracks AS track INDEXED BY idx_library_tracks_title
       CROSS JOIN library_search_documents AS search_document
       CROSS JOIN library_search_fts AS search_fts
       WHERE search_document.entity_kind = 'track' AND search_document.entity_id = track.id
         AND search_fts.rowid = search_document.id AND library_search_fts MATCH ?
         AND ${queryDefinition.where}
       ORDER BY ${queryDefinition.orderBy}`
    : `${matchingIds}
     ${queryDefinition.groupBy ? `GROUP BY ${queryDefinition.groupBy}` : ""}
     ORDER BY ${queryDefinition.orderBy}`;
  const ids = db
    .prepare<unknown[], { page_id: number }>(
      `${pageQuery}
     LIMIT ? OFFSET ?`,
    )
    .all(...queryDefinition.parameters, currentPageSize, currentOffset)
    .map((row) => row.page_id);
  if (normalizedKind === "artists") {
    const library = getLibraryArtistPage({
      source: sourceFilter,
      availableOnly,
      artistIds: ids,
      includeStats: true,
    });
    const artistsById = new Map(library.artists.map((artist) => [String(artist.id), artist]));
    const items = ids
      .map((id) => artistsById.get(String(id)))
      .filter((artist) => artist !== undefined);
    return {
      kind: normalizedKind,
      page: currentPage,
      pageSize: currentPageSize,
      total,
      hasMore: currentPage * currentPageSize < total,
      items,
      artists: items,
      albums: [],
      tracks: [],
      genres: getLibraryGenreStats({ sourceFilter, availableOnly }),
    };
  }
  const library = getPageLibrary(normalizedKind, ids, sourceFilter, availableOnly, albumId);
  const artistsById = new Map(library.artists.map((artist) => [String(artist.id), artist]));
  const albumsById = new Map(library.albums.map((album) => [String(album.id), album]));
  const albumStats = getAlbumStats(
    library.albums.map((album) => album.id),
    sourceFilter,
  );
  const withAlbumStats = (album: LibraryAlbum) => {
    const stats = albumStats.get(String(album.id));
    return {
      ...album,
      trackCount: stats?.trackCount ?? album.trackIds.length,
      availableTrackCount: stats?.availableTrackCount ?? 0,
    };
  };
  const albumItems =
    normalizedKind === "albums"
      ? ids
          .map((id) => library.albums.find((entity) => String(entity.id) === String(id)))
          .filter((entity) => entity !== undefined)
          .map(withAlbumStats)
      : [];
  const trackItems =
    normalizedKind === "tracks"
      ? ids
          .map((id) => library.tracks.find((entity) => String(entity.id) === String(id)))
          .filter((entity) => entity !== undefined)
      : [];

  const relatedAlbums =
    normalizedKind === "tracks"
      ? [
          ...new Set(
            trackItems.flatMap((track) => track.albums.map((entry) => String(entry.albumId))),
          ),
        ]
          .map((id) => albumsById.get(id))
          .filter((album) => album !== undefined)
          .map(withAlbumStats)
      : albumItems;
  const relatedArtists: LibraryArtist[] = relatedAlbums
    .map((album) => artistsById.get(String(album.artistId)))
    .filter((artist) => artist !== undefined)
    .filter(
      (artist, index, values) =>
        values.findIndex((candidate) => candidate.id === artist.id) === index,
    );
  if (artistId && !relatedArtists.some((artist) => String(artist.id) === String(artistId))) {
    relatedArtists.push(
      ...getLibraryArtistPage({
        source: sourceFilter,
        artistIds: [artistId],
      }).artists,
    );
  }

  const genres = getLibraryGenreStats({ sourceFilter, availableOnly });
  if (normalizedKind === "albums") {
    return {
      kind: normalizedKind,
      page: currentPage,
      pageSize: currentPageSize,
      total,
      hasMore: currentPage * currentPageSize < total,
      items: albumItems,
      artists: relatedArtists,
      albums: relatedAlbums,
      tracks: [],
      genres,
    };
  }
  return {
    kind: normalizedKind,
    page: currentPage,
    pageSize: currentPageSize,
    total,
    hasMore: currentPage * currentPageSize < total,
    items: trackItems,
    artists: relatedArtists,
    albums: relatedAlbums,
    tracks: trackItems,
    genres,
  };
}

export function rebuildLibraryGenreStats() {
  db.prepare("DELETE FROM settings WHERE key LIKE ?").run(`${GENRE_STATS_SETTING_PREFIX}%`);
  genreStatsCache.clear();
  rebuildStoredLibraryGenreStats(db);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    `${GENRE_STATS_SETTING_PREFIX}subsonic:${genreStatsScope(null, true)}`,
    JSON.stringify(computeLibraryGenres(null, true)),
  );
}

export function invalidateLibraryQueryCache({
  persistedGenres = true,
}: { persistedGenres?: boolean } = {}) {
  libraryCache.clear();
  pageCountCache.clear();
  genreStatsCache.clear();
  invalidateLibraryManagementCache();
  if (persistedGenres) {
    db.prepare("DELETE FROM settings WHERE key LIKE ?").run(`${GENRE_STATS_SETTING_PREFIX}%`);
  }
}

export { normalizeSource };
