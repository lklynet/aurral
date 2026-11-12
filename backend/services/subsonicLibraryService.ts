import * as v from "valibot";
import { lenientCount, lenientText } from "./integrationData.ts";
import { audioContentType } from "./audioFileStream.ts";
import { playlistJobEntries, staticPlaylistJobs } from "./playlists/playlistJobs.ts";
import { randomUUID } from "node:crypto";
import type { RequestUser } from "../middleware/requestUser.ts";
import { dbOps, userOps } from "../db/helpers/index.ts";
import { db } from "../config/db-sqlite.ts";
import {
  getAlbumStats,
  getLibraryAlbumPage,
  getLibraryArtistPage,
  getLibraryFavoriteTargetKeys,
  getLibraryGenres,
  getLibrary,
  getLibraryForAlbumReferences,
  getLibraryForArtistReferences,
  getLibraryForTrackIds,
  getLibraryForTrackMatches,
  getLibrarySearchPage,
  getLibraryTopTracks,
  getLibraryIndexLastModified,
  getLibraryTrack,
  getLibraryTrackPage,
} from "./libraryQueryService.ts";
import { fetchReleaseGroupCoverUrl } from "./releaseGroupCoverService.ts";
import { getLibraryArtwork } from "./libraryArtwork.ts";
import { buildImageProxyUrl, warmPublicImageUrl } from "./imageProxyService.ts";
import { downloadTracker } from "./downloadJobs/downloadTracker.ts";
import type { DownloadJob } from "./downloadJobs/downloadTracker.ts";
import type { StaticPlaylist, StaticPlaylistUpdates } from "./playlists/flowPlaylistConfig.ts";
import type { PlaylistTrack, PlaylistTrackInput } from "./playlists/playlistTracks.ts";
import { flowPlaylistConfig } from "./playlists/flowPlaylistConfig.ts";
import { normalizePlaylistTrack } from "./playlists/playlistTracks.ts";
import { playlistManager } from "./playlists/playlistManager.ts";
import { getPlaylistArtworkRevisions, getPlaylistArtworkState } from "./playlistArtworkState.ts";
import { hasPermission } from "./auth.ts";
import {
  findAlbumForTrack,
  findArtistForAlbum,
  firstFile,
  indexFocusedLibrary,
  resolveLibraryTracks,
  trackFromLibrary,
  year,
  type IndexedLibrary,
  type Rating,
  type Viewer,
} from "./libraryTrackLookup.ts";
import type {
  LibraryAlbum,
  LibraryArtist,
  LibraryTrack,
  LibraryTrackFile,
} from "./libraryQueryService.ts";
import type {
  LibraryAlbumsRow,
  LibraryArtistsRow,
  LibraryTracksRow,
  SubsonicRatingsRow,
  SubsonicStarChangesRow,
  SubsonicStarsRow,
} from "../db/rows.ts";
import { libraryNameKey, subsonicId as idFor } from "./libraryMediaStore.ts";
import { buildRadio, type RadioSeed } from "./radio.ts";
import { getUserMix, getUserMixes, type Mix } from "./discovery/mixes.ts";
import { withLock } from "./jobs/queue.ts";
import { discSubtitle, discTitles } from "../../lib/discTitles.ts";
import { withPlaylistMutationLock } from "./downloadJobs/downloadLocks.ts";
import { processPlaylistOperation } from "./playlists/playlistOperations.ts";
import {
  discardLibraryJobs,
  keepSongsInLibrary,
  linkTracksToLibrary,
  releaseLibraryJobs,
} from "./playlists/playlistLibrary.ts";
import { getCachedArtistByMbid } from "./providers/brainzmashProvider.ts";
import {
  getCustomArtwork,
  getCustomArtworkMap,
  getCustomArtworkRevision,
} from "./customArtworkService.ts";

const LIBRARY_IMAGE_PROFILE = "library";

type SubsonicUser = RequestUser | null | undefined;
type PlaylistOwner = { id: string; tracks?: PlaylistTrack[] };
type StarRow = Pick<SubsonicStarsRow, "entity_kind" | "entity_key" | "created_at">;
type StarKey = Pick<StarRow, "entity_kind" | "entity_key">;
type ParsedKind =
  | "artist"
  | "album"
  | "song"
  | "flow"
  | "flow-song"
  | "shared"
  | "shared-song"
  | "art-album"
  | "art-track"
  | "art-playlist"
  | "art-playlist-track"
  | "mix";
type ParsedId = { [K in ParsedKind]: { kind: K; key: string } }[ParsedKind];
type StarredResult = { artist: SubsonicArtist[]; album: SubsonicAlbum[]; song: SubsonicSong[] };
type SubsonicQuery = {
  musicFolderId?: string;
  genre?: string;
  fromYear?: string;
  toYear?: string;
  size?: string;
  type?: string;
  offset?: string;
  count?: string;
  artistCount?: string;
  artistOffset?: string;
  albumCount?: string;
  albumOffset?: string;
  songCount?: string;
  songOffset?: string;
};
type ProtocolArtist = { id: string; name: string; musicBrainzId: string };
type SubsonicGenreFields = { genre?: string; genres?: { name: string }[] };
type SubsonicRatingFields = { userRating?: number; averageRating?: number };
type SubsonicSong = {
  id: string;
  parent: string;
  isDir: boolean;
  isVideo: boolean;
  title: string | null;
  album: string;
  artist: string;
  albumId?: string;
  artistId: string;
  albumArtists: ProtocolArtist[];
  artists: ProtocolArtist[];
  contentType: string;
  created: string;
  track: number;
  discNumber: number;
  coverArt?: string;
  duration: number;
  size: number;
  suffix: string;
  path: string;
  type: string;
  starred?: string;
  musicBrainzId: string;
  mediaType: string;
  bitRate?: number;
  year?: number;
} & SubsonicGenreFields &
  SubsonicRatingFields;
type LibrarySong = SubsonicSong & { title: string };
type SubsonicAlbum = {
  id: string;
  name: string;
  artist: string;
  artistId: string;
  artists: ProtocolArtist[];
  created: string;
  coverArt: string;
  songCount: number;
  duration: number;
  starred?: string;
  musicBrainzId: string;
  year?: number;
} & SubsonicGenreFields &
  SubsonicRatingFields;
type SubsonicArtist = {
  id: string;
  name: string;
  sortName?: string;
  coverArt: string;
  albumCount: number;
  starred?: string;
  musicBrainzId: string;
  roles: string[];
} & SubsonicRatingFields;
type SubsonicPlaylist = {
  id: string;
  name: string;
  owner: string;
  coverArt: string;
  songCount: number;
  duration: number;
  public: boolean;
  created: string;
  changed: string;
  comment?: string;
};

const parseId = (value: unknown): ParsedId | null => {
  const match =
    /^(artist|album|song|flow|flow-song|shared|shared-song|art-album|art-track|art-playlist|art-playlist-track|mix):(.+)$/.exec(
      String(value || ""),
    );
  const [, kind, key] = match ?? [];
  if (!kind || !key) return null;
  try {
    return { kind: kind as ParsedKind, key: decodeURIComponent(key) };
  } catch {
    return null;
  }
};

const seconds = (durationMs: number | null | undefined) => {
  const value = Number(durationMs);
  return Number.isFinite(value) && value > 0 ? Math.round(value / 1000) : 0;
};

const bitRateKbps = (
  quality:
    | (NonNullable<LibraryTrackFile["quality"]> & { audioBitRate?: unknown })
    | null
    | undefined,
) => {
  const kbps = Number.parseInt(String(quality?.audioBitRate), 10);
  if (kbps > 0) return kbps;
  const bitsPerSecond = Number(quality?.bitrate);
  return bitsPerSecond > 0 ? Math.round(bitsPerSecond / 1000) : null;
};

const isoDate = (epochMs: number | null | undefined) =>
  new Date(Number(epochMs) || Date.now()).toISOString();

const normalizeLimit = (value: string | undefined, fallback = 20) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 500) : fallback;
};

const normalizeOffset = (value: string | undefined) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? Math.max(parsed, 0) : 0;
};

const includesAurralMusicFolder = (options: SubsonicQuery = {}) => {
  const musicFolderId = String(options.musicFolderId || "").trim();
  return !musicFolderId || musicFolderId === "1";
};

const genreNames = (value: unknown) =>
  (Array.isArray(value) ? value : [value])
    .flatMap((entry) => String(entry || "").split(";"))
    .map((entry) => entry.trim())
    .filter(Boolean);

const readField = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

type GenreEntity = { metadata?: object | null } | null | undefined;

const entityGenres = (entity: GenreEntity) => {
  const metadata = entity?.metadata;
  return [
    readField(metadata, "genres"),
    readField(readField(metadata, "common"), "genre"),
    readField(metadata, "genre"),
    readField(readField(metadata, "tags"), "genre"),
  ]
    .flatMap(genreNames)
    .filter((genre, index, values) => values.indexOf(genre) === index);
};

const visibleFlows = (user: SubsonicUser) =>
  user && hasPermission(user, "accessPlaylists")
    ? flowPlaylistConfig.getFlowsForUser(user).filter((flow) => flow.enabled)
    : [];

const protocolArtist = (artist: LibraryArtist | null | undefined, fallback = "Unknown Artist") => ({
  id: idFor("artist", artist?.identityKey || `name:artist:${fallback.toLocaleLowerCase()}`),
  name: artist?.name || fallback,
  musicBrainzId: artist?.mbid || "",
});

const albumTracks = (library: IndexedLibrary, album: LibraryAlbum) =>
  (album?.trackIds || [])
    .map((trackId) => library.tracksById.get(trackId))
    .filter((track): track is NonNullable<typeof track> => Boolean(track));

const artistAlbums = (library: IndexedLibrary, artist: LibraryArtist) => {
  const owned = (artist?.albumIds || [])
    .map((albumId) => library.albumsById.get(albumId))
    .filter((album): album is NonNullable<typeof album> => Boolean(album));
  const { mbid } = artist;
  const shared = mbid
    ? library.albums.filter(
        (album) => album.artistId !== artist.id && album.creditedArtistMbids?.includes(mbid),
      )
    : [];
  return [...owned, ...shared];
};

const customArtworkId = (
  kind: string,
  id: string | number,
  updatedAt: number | string | null | undefined,
  context: Record<string, string> = {},
) =>
  idFor(
    `art-${kind}`,
    JSON.stringify({ id: String(id), updatedAt: Number(updatedAt), ...context }),
  );

const coverArtForAlbum = (library: IndexedLibrary, album: LibraryAlbum) => {
  const updatedAt = library.customAlbumArtwork?.get(String(album.id));
  return updatedAt
    ? customArtworkId("album", album.id, updatedAt)
    : idFor("album", album.identityKey);
};

const coverArtForTrack = (
  library: IndexedLibrary,
  track: LibraryTrack,
  album: LibraryAlbum | null | undefined,
) => {
  const updatedAt = library.customTrackArtwork?.get(String(track.id));
  return updatedAt
    ? customArtworkId("track", track.id, updatedAt)
    : album
      ? coverArtForAlbum(library, album)
      : undefined;
};

const ratingFields = (library: Viewer, key: string) => {
  const rating = library.ratings?.get(key);
  return (
    rating && {
      ...(rating.userRating && { userRating: rating.userRating }),
      averageRating: rating.averageRating,
    }
  );
};

const toSong = (
  library: IndexedLibrary,
  track: LibraryTrack,
  album: LibraryAlbum | null = findAlbumForTrack(library, track),
): LibrarySong => {
  const artist = findArtistForAlbum(library, album);
  const file = firstFile(track, album?.id, album?.managed);
  const genres = [
    ...new Set([...entityGenres(artist), ...entityGenres(album), ...entityGenres(track)]),
  ];
  const relation = track.albums?.find((entry) => entry.albumId === album?.id);
  const artistValue = protocolArtist(artist, track.artistName || "Unknown Artist");
  const trackArtistName = track.artistName?.trim();
  const trackArtistValue =
    trackArtistName && trackArtistName !== artistValue.name
      ? protocolArtist(null, trackArtistName)
      : artistValue;
  const format = String(file?.format || "mp3").toLowerCase();
  const song: LibrarySong = {
    id: idFor("song", track.identityKey),
    parent: album ? idFor("album", album.identityKey) : idFor("album", "unknown"),
    isDir: false,
    isVideo: false,
    title: track.title,
    album: album?.title || "Unknown Album",
    artist: trackArtistValue.name,
    albumId: album ? idFor("album", album.identityKey) : undefined,
    artistId: artistValue.id,
    albumArtists: [artistValue],
    artists: [trackArtistValue],
    contentType: audioContentType(format),
    created: isoDate(track.createdAt ?? file?.createdAt ?? file?.mtimeMs),
    track: Number(relation?.trackNumber) || 0,
    discNumber: Number(relation?.discNumber) || 1,
    coverArt: coverArtForTrack(library, track, album),
    duration: seconds(file?.durationMs),
    size: Number(file?.size || 0),
    suffix: format,
    path: idFor("song", track.identityKey),
    type: "music",
    starred: library.starredAt?.get(`song:${track.identityKey}`),
    ...ratingFields(library, `song:${track.identityKey}`),
    musicBrainzId: track.mbid || "",
    mediaType: "song",
  };
  const bitRate = bitRateKbps(file?.quality);
  if (bitRate) song.bitRate = bitRate;
  const releaseYear = year(album?.releaseDate);
  if (releaseYear != null) song.year = releaseYear;
  if (genres.length) {
    song.genre = genres[0];
    song.genres = genres.map((name) => ({ name }));
  }
  return song;
};

const albumData = (library: IndexedLibrary, album: LibraryAlbum) => {
  const artist = findArtistForAlbum(library, album);
  const tracks = albumTracks(library, album);
  const artistValue = protocolArtist(artist, album.albumArtist || "Unknown Artist");
  const genres = [
    ...entityGenres(artist),
    ...entityGenres(album),
    ...tracks.flatMap((track) => entityGenres(track)),
  ].filter((genre, index, values) => values.indexOf(genre) === index);
  const value: SubsonicAlbum = {
    id: idFor("album", album.identityKey),
    name: album.title,
    artist: artistValue.name,
    artistId: artistValue.id,
    artists: [artistValue],
    created: isoDate(album.createdAt),
    coverArt: coverArtForAlbum(library, album),
    songCount: tracks.length,
    duration: tracks.reduce(
      (total, track) => total + seconds(firstFile(track, album.id, album.managed)?.durationMs),
      0,
    ),
    starred: library.starredAt?.get(`album:${album.identityKey}`),
    ...ratingFields(library, `album:${album.identityKey}`),
    // OpenSubsonic wants the release MBID here; Lidarr-indexed albums only know the
    // release-group id, so they report an empty value rather than a wrong one.
    musicBrainzId: album.mbid || "",
  };
  const releaseYear = year(album.releaseDate);
  if (releaseYear != null) value.year = releaseYear;
  if (genres.length) {
    value.genre = genres[0];
    value.genres = genres.map((name) => ({ name }));
  }
  return {
    tracks,
    value,
  };
};

const toAlbumSummary = (library: IndexedLibrary, album: LibraryAlbum) =>
  albumData(library, album).value;

const toAlbum = (library: IndexedLibrary, album: LibraryAlbum) => {
  const { tracks, value } = albumData(library, album);
  const song = tracks.map((track) => toSong(library, track, album));
  const titles = discTitles(
    song.map(({ discNumber }, index) => ({
      disc: discNumber,
      title: discSubtitle(tracks[index]?.metadata),
    })),
  );
  return {
    ...value,
    ...(titles.size && { discTitles: [...titles].map(([disc, title]) => ({ disc, title })) }),
    song,
  };
};

const toArtistSummary = (
  artist: LibraryArtist & { albumCount?: number },
  library: Viewer = {},
): SubsonicArtist => ({
  id: idFor("artist", artist.identityKey),
  name: artist.name,
  ...(artist.sortName && { sortName: artist.sortName }),
  coverArt: idFor("artist", artist.identityKey),
  albumCount: artist.albumCount ?? artist.albumIds.length,
  starred: library.starredAt?.get(`artist:${artist.identityKey}`),
  ...ratingFields(library, `artist:${artist.identityKey}`),
  musicBrainzId: artist.mbid || "",
  roles: ["albumartist"],
});

const toArtist = (library: IndexedLibrary, artist: LibraryArtist) => {
  const albums = artistAlbums(library, artist);
  return {
    ...toArtistSummary({ ...artist, albumCount: albums.length }, library),
    album: albums.map((album) => toAlbumSummary(library, album)),
  };
};

export const toChildAlbum = ({ name, songCount, ...album }: SubsonicAlbum) => ({
  ...album,
  parent: album.artistId,
  isDir: true,
  isVideo: false,
  title: name,
  album: name,
  mediaType: "album",
});

export const toIndexArtist = ({
  id,
  name,
  starred,
  userRating,
  averageRating,
}: SubsonicArtist) => ({ id, name, starred, userRating, averageRating });

function findLibraryEntry(
  library: IndexedLibrary,
  parsed: { kind: "artist"; key: string },
): LibraryArtist | null;
function findLibraryEntry(
  library: IndexedLibrary,
  parsed: { kind: "album"; key: string },
): LibraryAlbum | null;
function findLibraryEntry(
  library: IndexedLibrary,
  parsed: { kind: "song"; key: string },
): LibraryTrack | null;
function findLibraryEntry(
  library: IndexedLibrary,
  parsed: ParsedId | null,
): LibraryArtist | LibraryAlbum | LibraryTrack | null;
function findLibraryEntry(library: IndexedLibrary, parsed: ParsedId | null) {
  if (!parsed) return null;
  if (parsed.kind === "artist") {
    return library.artistsByIdentity.get(parsed.key) || null;
  }
  if (parsed.kind === "album") {
    return library.albumsByIdentity.get(parsed.key) || null;
  }
  if (parsed.kind === "song") {
    return library.tracksByIdentity.get(parsed.key) || null;
  }
  return null;
}

function playlistFromId(user: SubsonicUser, value: unknown) {
  const parsed = parseId(value);
  if (!parsed || !["flow", "shared"].includes(parsed.kind)) return null;
  if (parsed.kind === "flow") return flowPlaylistConfig.getFlowForUser(user, parsed.key);
  return flowPlaylistConfig.getStaticPlaylistForUser(user, parsed.key);
}

function toPlaylistSong(
  playlist: PlaylistOwner,
  kind: string,
  job: DownloadJob,
  viewer: Viewer = {},
  owned = findAvailableLibraryTrack(trackFromJob(job)),
  customArtworkUpdatedAt: number | null = null,
) {
  const customCoverArt = customArtworkUpdatedAt
    ? customArtworkId("playlist-track", job.id, customArtworkUpdatedAt, {
        playlistKind: kind,
        playlistId: playlist.id,
      })
    : null;
  if (owned) {
    return {
      ...toSong(
        { ...owned.library, starredAt: viewer.starredAt, ratings: viewer.ratings },
        owned.track,
      ),
      parent: idFor(kind, playlist.id),
      ...(customCoverArt && { coverArt: customCoverArt }),
    };
  }
  const artist = protocolArtist(null, job.artistName || "Unknown Artist");
  const format =
    String(job.finalPath || "")
      .split(".")
      .pop()
      ?.toLowerCase() || "mp3";
  const songKind = kind === "flow" ? "flow-song" : "shared-song";
  const id = idFor(songKind, `${playlist.id}:${job.id}`);
  const albumMbid = String(job.albumMbid || "").trim();
  const song: SubsonicSong = {
    id,
    parent: idFor(kind, playlist.id),
    isDir: false,
    isVideo: false,
    title: job.trackName,
    album: job.albumName || "Unknown Album",
    artist: artist.name,
    artistId: artist.id,
    albumArtists: [artist],
    artists: [artist],
    coverArt:
      customCoverArt || (albumMbid ? idFor("album", `release-group:${albumMbid}`) : undefined),
    contentType: audioContentType(format),
    created: isoDate(job.createdAt),
    // Stars on unmatched playlist songs stay keyed by the playlist song, not a library track.
    starred: viewer.starredAt?.get(`${songKind}:${playlist.id}:${job.id}`),
    track: job.trackNumber || 0,
    discNumber: job.discNumber || 1,
    duration: seconds(job.durationMs),
    size: 0,
    suffix: format,
    path: id,
    type: "music",
    musicBrainzId: job.trackMbid || "",
    mediaType: "song",
  };
  if (job.qualityBitrateKbps && job.qualityBitrateKbps > 0) song.bitRate = job.qualityBitrateKbps;
  return song;
}

const playlistJobs = (playlist: PlaylistOwner | null | undefined) =>
  playlistJobEntries(playlist).map(({ job }) => job);

function playlistOwnsJob(
  playlist: PlaylistOwner | null | undefined,
  job: DownloadJob | null | undefined,
) {
  if (!playlist || !job) return false;
  if (String(job.playlistType || "") === String(playlist.id || "")) return true;
  return (playlist.tracks || []).some(
    (track) => String(track?.canonicalJobId || "") === String(job.id || ""),
  );
}

function playlistJobFromId(user: SubsonicUser, value: string) {
  const parsed = parseId(value);
  if (!parsed || !["flow-song", "shared-song"].includes(parsed.kind)) return null;
  const separator = parsed.key.indexOf(":");
  if (separator < 1) return null;
  const kind = parsed.kind === "flow-song" ? "flow" : "shared";
  const playlist = playlistFromId(user, idFor(kind, parsed.key.slice(0, separator)));
  if (!playlist) return null;
  const job = downloadTracker.getJob(parsed.key.slice(separator + 1));
  return job && playlistOwnsJob(playlist, job) && job.status === "done"
    ? { kind, playlist, job }
    : null;
}

const isPlayableJob = (job: DownloadJob) => job.status === "done";

const visiblePlaylistJobs = (
  flow: PlaylistOwner,
  { includePending = false }: { includePending?: boolean } = {},
) => playlistJobs(flow).filter((job) => includePending || isPlayableJob(job));

const playlistCoverArt = (kind: string, playlistId: string, revision: number | undefined) =>
  revision
    ? customArtworkId("playlist", playlistId, revision, { playlistKind: kind })
    : idFor(kind, playlistId);
const getArtworkChangedStmt = db.prepare<[], { changed_at: number | null }>(
  "SELECT MAX(updated_at) AS changed_at FROM custom_artwork WHERE entity_kind IN ('album', 'track')",
);
const latestArtworkChange = (artwork: Map<string, number>) => Math.max(0, ...artwork.values());
const epochMs = (value: number | string | null | undefined) => {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Date.now();
};

// Stars and ratings are per-user library state, so changing one has to move the timestamp too or
// clients keep the values they cached before it.
export function getLibraryLastModified(user: SubsonicUser) {
  const stars = user?.id ? Number(getStarsChangedStmt.get(user.id)?.changed_at) || 0 : 0;
  const artwork = Number(getArtworkChangedStmt.get()?.changed_at) || 0;
  const artworkRevision = Math.max(
    getCustomArtworkRevision("album"),
    getCustomArtworkRevision("track"),
  );
  return Math.max(getLibraryIndexLastModified() ?? 0, stars, artwork, artworkRevision);
}

export function listArtists(user: SubsonicUser) {
  const library = viewerFor(user);
  return getLibraryArtistPage({ source: "all", availableOnly: true }).artists.map((artist) =>
    toArtistSummary(artist, library),
  );
}

export function getArtist(value: string, user?: SubsonicUser) {
  const parsed = parseId(value);
  if (parsed?.kind !== "artist") return null;
  const named = parsed.key.startsWith("name:artist:")
    ? db
        .prepare<[string], Pick<LibraryArtistsRow, "id">>(
          "SELECT id FROM library_artists WHERE name = ? COLLATE NOCASE ORDER BY id LIMIT 1",
        )
        .get(parsed.key.slice("name:artist:".length))
    : undefined;
  const library = indexFocusedLibrary(
    getLibraryForArtistReferences({
      source: "all",
      availableOnly: true,
      references: named ? [parsed.key, String(named.id)] : [parsed.key],
      includeSharedAlbums: true,
    }),
    viewerFor(user),
  );
  const artist =
    findLibraryEntry(library, parsed) || (named ? library.artistsById.get(named.id) : undefined);
  return artist?.identityKey ? toArtist(library, artist) : null;
}

export function getAlbum(value: string, user?: SubsonicUser) {
  const parsed = parseId(value);
  if (parsed?.kind !== "album") return null;
  const library = indexFocusedLibrary(
    getLibraryForAlbumReferences({
      source: "all",
      availableOnly: true,
      references: [parsed.key],
    }),
    viewerFor(user),
  );
  const album = findLibraryEntry(library, parsed);
  return album?.identityKey ? toAlbum(library, album) : null;
}

export function getSong(value: string, user?: SubsonicUser) {
  const playlistEntry = playlistJobFromId(user, value);
  if (playlistEntry) {
    const customArtwork = getCustomArtworkMap("playlist-track", [playlistEntry.job.id]);
    return toPlaylistSong(
      playlistEntry.playlist,
      playlistEntry.kind,
      playlistEntry.job,
      viewerFor(user),
      undefined,
      customArtwork.get(String(playlistEntry.job.id)) || null,
    );
  }

  const parsed = parseId(value);
  if (parsed?.kind !== "song") return null;
  const library = indexFocusedLibrary(
    getLibraryTrack({
      trackId: parsed.key,
      source: "all",
      availableOnly: true,
    }),
    viewerFor(user),
  );
  const track = findLibraryEntry(library, parsed);
  return track?.identityKey ? toSong(library, track) : null;
}

const radioSeedFor = (parsed: ParsedId | null, artistOnly: boolean): RadioSeed | null => {
  if (parsed?.kind === "artist") {
    return parsed.key.startsWith("name:artist:")
      ? { artists: [{ name: parsed.key.slice("name:artist:".length) }] }
      : { artists: [{ id: parsed.key }] };
  }
  if (artistOnly) return null;
  if (parsed?.kind === "song") return { trackIds: [parsed.key] };
  if (parsed?.kind === "album") return { albumIds: [parsed.key] };
  return null;
};

export async function getSimilarSongs(
  value: string,
  { count, artistOnly = false }: { count?: string; artistOnly?: boolean },
  user: SubsonicUser,
) {
  const seed = radioSeedFor(parseId(value), artistOnly);
  if (!seed) return [];
  const userId = user && user.id > 0 ? user.id : null;
  const trackIds = await buildRadio({ userId, seed, limit: normalizeLimit(count, 50) });
  const library = indexFocusedLibrary(
    getLibraryForTrackIds({ ids: trackIds, source: "all", availableOnly: true }),
    viewerFor(user),
  );
  return trackIds.flatMap((trackId) => {
    const track = library.tracksById.get(trackId);
    return track ? [toSong(library, track)] : [];
  });
}

export function findUniqueLibrarySong(artist: string, title: string, user?: SubsonicUser) {
  if (!String(artist).trim() || !String(title).trim()) return null;
  const library = indexFocusedLibrary(
    getLibraryForTrackMatches({
      source: "all",
      availableOnly: true,
      titles: [String(title).trim()],
    }),
    viewerFor(user),
  );
  const songs = library.tracks
    .map((track) => toSong(library, track))
    .filter(
      (song) =>
        song.artist.toLocaleLowerCase() === String(artist).trim().toLocaleLowerCase() &&
        song.title.toLocaleLowerCase() === String(title).trim().toLocaleLowerCase(),
    );
  return songs.length === 1 ? songs[0] : null;
}

export function getMusicDirectory(value: string, user?: SubsonicUser) {
  if (value === "root" || value === "1") {
    const rootId = value === "1" ? "1" : "root";
    return {
      id: rootId,
      name: "Aurral",
      child: listArtists(user).map((artist) => ({
        id: artist.id,
        parent: rootId,
        isDir: true,
        title: artist.name,
        artist: artist.name,
      })),
    };
  }
  const parsed = parseId(value);
  if (parsed?.kind === "artist") {
    const artist = getArtist(value, user);
    return artist
      ? { id: artist.id, name: artist.name, child: artist.album.map(toChildAlbum) }
      : null;
  }
  if (parsed?.kind === "album") {
    const album = getAlbum(value, user);
    return album ? { id: album.id, name: album.name, child: album.song || [] } : null;
  }
  return null;
}

export function searchLibrary(
  query: string,
  options: SubsonicQuery = {},
  user: RequestUser | null = null,
) {
  if (!includesAurralMusicFolder(options)) return { artist: [], album: [], song: [] };
  const needle = String(query || "")
    .trim()
    .toLocaleLowerCase();
  const result = getLibrarySearchPage({
    source: "all",
    availableOnly: true,
    query: needle,
    artistLimit: normalizeLimit(options.artistCount),
    artistOffset: normalizeOffset(options.artistOffset),
    albumLimit: normalizeLimit(options.albumCount),
    albumOffset: normalizeOffset(options.albumOffset),
    songLimit: normalizeLimit(options.songCount),
    songOffset: normalizeOffset(options.songOffset),
  });
  const viewer = viewerFor(user);
  const artistLibrary = indexFocusedLibrary(
    { artists: result.artists, albums: [], tracks: [] },
    viewer,
  );
  const albumLibrary = indexFocusedLibrary(result.albums, viewer);
  const trackLibrary = indexFocusedLibrary(result.tracks, viewer);
  return {
    artist: artistLibrary.artists.map((artist) => toArtistSummary(artist, artistLibrary)),
    album: albumLibrary.albums.map((album) => toAlbumSummary(albumLibrary, album)),
    song: trackLibrary.tracks.map((track) => toSong(trackLibrary, track)),
  };
}

export function getRandomSongs(options: SubsonicQuery = {}, user: RequestUser | null = null) {
  if (!includesAurralMusicFolder(options)) return [];
  const library = indexFocusedLibrary(
    getLibraryTrackPage({
      source: "all",
      availableOnly: true,
      genre: options.genre,
      fromYear: options.fromYear,
      toYear: options.toYear,
      limit: normalizeLimit(options.size, 10),
      random: true,
    }),
    viewerFor(user),
  );
  return library.tracks.map((track) => toSong(library, track));
}

export function getAlbumList(options: SubsonicQuery = {}, user: RequestUser | null = null) {
  if (!includesAurralMusicFolder(options)) return [];
  const type = String(options.type || "alphabeticalByName");
  const offset = normalizeOffset(options.offset);
  const limit = normalizeLimit(options.size);
  if (type === "starred") {
    return getStarred(user).album.slice(offset, offset + limit);
  }
  if (type === "frequent" || type === "recent")
    return getPlayedAlbums(type, user, { offset, limit });
  // Aurral does not currently store per-user ratings. Returning no albums is
  // accurate; falling through would falsely label an alphabetical list as rated.
  if (type === "highest") return [];
  const library = indexFocusedLibrary(
    getLibraryAlbumPage({
      source: "all",
      availableOnly: true,
      type,
      genre: options.genre,
      fromYear: options.fromYear,
      toYear: options.toYear,
      offset,
      limit,
    }),
    viewerFor(user),
  );
  return library.albums.map((album) => toAlbumSummary(library, album));
}

export function getSongsByGenre(
  genre: string,
  options: SubsonicQuery = {},
  user: RequestUser | null = null,
) {
  if (!includesAurralMusicFolder(options)) return [];
  const target = String(genre || "")
    .trim()
    .toLocaleLowerCase();
  if (!target) return [];
  const library = indexFocusedLibrary(
    getLibraryTrackPage({
      source: "all",
      availableOnly: true,
      genre: target,
      offset: normalizeOffset(options.offset),
      limit: normalizeLimit(options.count),
    }),
    viewerFor(user),
  );
  return library.tracks.map((track) => toSong(library, track));
}

export function getGenres() {
  return getLibraryGenres({ source: "all", availableOnly: true });
}

const getStarsStmt = db.prepare<[number], StarRow>(
  "SELECT entity_kind, entity_key, created_at FROM subsonic_stars WHERE user_id = ? ORDER BY created_at, entity_kind, entity_key",
);
const preparePlayedAlbumsStmt = (orderBy: string) =>
  db.prepare<[number, number, number], Pick<LibraryAlbumsRow, "identity_key">>(`
  SELECT album.identity_key
  FROM play_album_stats AS played
  JOIN library_albums AS album
    ON album.identity_key = played.album_key
  WHERE played.user_id = ?
    AND EXISTS (
      SELECT 1
      FROM library_album_tracks AS album_track
      JOIN library_media_files AS media
        ON media.track_id = album_track.track_id
        AND (media.album_id = album_track.album_id OR media.album_id IS NULL)
      WHERE album_track.album_id = album.id
        AND media.available = 1
    )
  GROUP BY album.id
  ORDER BY ${orderBy},
    album.title COLLATE NOCASE,
    album.id
  LIMIT ? OFFSET ?
`);
const playedAlbumsStmts = {
  frequent: preparePlayedAlbumsStmt("SUM(played.play_count) DESC, MAX(played.last_played_at) DESC"),
  recent: preparePlayedAlbumsStmt("MAX(played.last_played_at) DESC"),
};
const addStarStmt = db.prepare(
  "INSERT OR IGNORE INTO subsonic_stars (user_id, entity_kind, entity_key, created_at) VALUES (?, ?, ?, ?)",
);
const removeStarStmt = db.prepare(
  "DELETE FROM subsonic_stars WHERE user_id = ? AND entity_kind = ? AND entity_key = ?",
);
const touchStarsStmt = db.prepare(
  `INSERT INTO subsonic_star_changes (user_id, changed_at) VALUES (?, ?)
   ON CONFLICT(user_id) DO UPDATE SET changed_at = excluded.changed_at`,
);
const getStarsChangedStmt = db.prepare<[number], Pick<SubsonicStarChangesRow, "changed_at">>(
  "SELECT changed_at FROM subsonic_star_changes WHERE user_id = ?",
);

function getPlayedAlbums(
  type: "frequent" | "recent",
  user: SubsonicUser,
  { offset, limit }: { offset: number; limit: number },
) {
  if (!user?.id || limit === 0) return [];
  const albumKeys = playedAlbumsStmts[type]
    .all(user.id, limit, offset)
    .map((row) => row.identity_key);
  if (!albumKeys.length) return [];
  const library = indexFocusedLibrary(
    getLibrary({
      availableOnly: true,
      favoriteKeys: albumKeys.map((key) => ({ kind: "album", key })),
    }),
    viewerFor(user),
  );
  return albumKeys
    .map((key) => library.albumsByIdentity.get(key))
    .filter((album): album is NonNullable<typeof album> => Boolean(album))
    .map((album) => toAlbumSummary(library, album));
}

// Clients compare lastModified for equality/greater-than, so a star change must land strictly after
// both the previous star timestamp and the library timestamp even on a fast clock.
const touchStars = (userId: number) => {
  const previous = Number(getStarsChangedStmt.get(userId)?.changed_at) || 0;
  const floor = Math.max(previous, getLibraryIndexLastModified() ?? 0);
  touchStarsStmt.run(userId, Math.max(Date.now(), floor + 1));
};

const trackFromJob = (job: DownloadJob | null | undefined) => {
  const track = normalizePlaylistTrack({
    artistName: job?.artistName,
    trackName: job?.trackName,
    albumName: job?.albumName,
    artistMbid: job?.artistMbid,
    albumMbid: job?.albumMbid,
    trackMbid: job?.trackMbid,
    releaseYear: job?.releaseYear,
    durationMs: job?.durationMs,
    trackNumber: job?.trackNumber,
    artistAliases: job?.artistAliases,
  });
  return (
    track && {
      ...track,
      albumTrackCount: job?.albumTrackCount,
      albumTrackTitles: job?.albumTrackTitles,
    }
  );
};

const resolvePlaylistSong = (user: SubsonicUser, value: string) => {
  const parsed = parseId(value);
  if (!parsed || !["flow-song", "shared-song"].includes(parsed.kind)) return null;
  const separator = parsed.key.indexOf(":");
  if (separator < 1) return null;
  const kind = parsed.kind === "flow-song" ? "flow" : "shared";
  const playlist = playlistFromId(user, idFor(kind, parsed.key.slice(0, separator)));
  if (!playlist) return null;
  const job = downloadTracker.getJob(parsed.key.slice(separator + 1));
  if (!playlistOwnsJob(playlist, job) && job?.playlistType !== "library") return null;
  const track = trackFromJob(job);
  return track ? { kind, playlist, job, track } : null;
};

const resolveSubsonicTrack = (user: SubsonicUser, value: string) => {
  const playlistSong = resolvePlaylistSong(user, value);
  if (playlistSong) return playlistSong;
  const parsed = parseId(value);
  if (parsed?.kind !== "song") return null;
  const library = indexFocusedLibrary(
    getLibraryTrack({
      trackId: parsed.key,
      source: "all",
      availableOnly: false,
    }),
  );
  const track = findLibraryEntry(library, parsed);
  const normalized = trackFromLibrary(library, track);
  return normalized ? { kind: "song", track: normalized, libraryTrack: track } : null;
};

const favoriteAutoKeepEnabled = () => dbOps.getSettings()?.subsonic?.favoriteAutoKeep !== false;

const playlistSongKind = (playlistId: string) =>
  flowPlaylistConfig.getFlow(playlistId) ? "flow-song" : "shared-song";

export function playlistTrackFavoriteIds(playlistId: string, jobs: DownloadJob[]) {
  const kind = playlistSongKind(playlistId);
  const owned = resolveLibraryTracks(jobs.map(trackFromJob));
  return jobs.map((job, index) => {
    const libraryTrack = owned[index]?.track;
    return libraryTrack
      ? idFor("song", libraryTrack.identityKey)
      : idFor(kind, `${playlistId}:${job.id}`);
  });
}

const copyPlaylistSongStarsStmt = db.prepare<[string, string, string]>(
  `INSERT OR IGNORE INTO subsonic_stars (user_id, entity_kind, entity_key, created_at)
   SELECT user_id, 'song', ?, created_at FROM subsonic_stars WHERE entity_kind = ? AND entity_key = ?`,
);
const deletePlaylistSongStarsStmt = db.prepare<[string, string]>(
  "DELETE FROM subsonic_stars WHERE entity_kind = ? AND entity_key = ?",
);

export function keepPlaylistStarsInLibrary(playlistId: string) {
  const kind = playlistSongKind(playlistId);
  const playlist = flowPlaylistConfig.getStaticPlaylist(playlistId);
  const jobs = playlist
    ? staticPlaylistJobs(playlist)
    : downloadTracker.getByPlaylistId(playlistId);
  const owned = resolveLibraryTracks(jobs.map(trackFromJob));
  db.transaction(() => {
    jobs.forEach((job, index) => {
      const identityKey = owned[index]?.track?.identityKey;
      if (!identityKey) return;
      const key = `${playlistId}:${job.id}`;
      copyPlaylistSongStarsStmt.run(identityKey, kind, key);
      deletePlaylistSongStarsStmt.run(kind, key);
    });
  })();
}

const findAvailableLibraryTrack = (track: PlaylistTrackInput | null | undefined) =>
  resolveLibraryTracks([track])[0];

// Map playlist-song star rows to their library song row when the entry is a library track.
const libraryStarRows = <T extends StarKey>(user: SubsonicUser, rows: T[]) => {
  const playlistSongs = rows.map((row) =>
    ["flow-song", "shared-song"].includes(row?.entity_kind)
      ? resolvePlaylistSong(user, idFor(row.entity_kind, row.entity_key))
      : null,
  );
  const resolved = resolveLibraryTracks(playlistSongs.map((song) => song?.track || null));
  return rows.map((row, index) => {
    const libraryTrack = resolved[index]?.track;
    return libraryTrack
      ? { ...row, entity_kind: "song", entity_key: libraryTrack.identityKey }
      : row;
  });
};

const refreshSubsonicPlaylist = (playlistId: string) => {
  playlistManager.requestPlaylistSync([playlistId]);
  playlistManager.scheduleScanLibrary();
};

const normalizeStaticPlaylistId = (value: unknown) => {
  const parsed = parseId(value);
  return parsed?.kind === "shared" ? parsed.key : String(value || "").trim();
};

const replaceSubsonicPlaylistTracks = async (
  user: SubsonicUser,
  playlist: StaticPlaylist,
  tracks: PlaylistTrackInput[],
  updates: StaticPlaylistUpdates = {},
) => {
  if (!playlist || !flowPlaylistConfig.canUserAccessStaticPlaylist(user, playlist)) return null;
  const linked = await linkTracksToLibrary(
    tracks.map(normalizePlaylistTrack).filter((track) => track !== null),
    { startedByPlaylist: playlist.id },
  );
  let removedJobIds: (string | undefined)[] = [];
  const updated = await withPlaylistMutationLock(playlist.id, () => {
    const current = flowPlaylistConfig.getStaticPlaylist(playlist.id);
    if (!current) return null;
    const kept = new Set(linked.tracks.map((track) => track.canonicalJobId));
    removedJobIds = current.tracks
      .map((track) => track.canonicalJobId)
      .filter((jobId) => !kept.has(jobId));
    return flowPlaylistConfig.updateStaticPlaylist(playlist.id, {
      ...updates,
      tracks: linked.tracks,
    });
  }).catch(async (error: unknown) => {
    await discardLibraryJobs(linked.createdJobIds);
    throw error;
  });
  if (!updated) {
    await discardLibraryJobs(linked.createdJobIds);
    return null;
  }
  await releaseLibraryJobs(playlist.id, removedJobIds);
  refreshSubsonicPlaylist(playlist.id);
  return updated;
};

export async function createSubsonicPlaylist(
  user: SubsonicUser,
  { name, songIds = [] }: { name?: string; songIds?: string[] } = {},
) {
  if (!hasPermission(user, "accessPlaylists")) return null;
  const safeName = String(name || "").trim();
  if (!safeName) return null;
  const resolved = songIds.map((id) => resolveSubsonicTrack(user, id));
  if (resolved.some((entry) => !entry)) return null;
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    id: randomUUID(),
    name: safeName,
    ownerUserId: user!.id,
    tracks: [],
  });
  try {
    const updated = await replaceSubsonicPlaylistTracks(
      user,
      playlist,
      resolved.map((entry) => entry!.track),
    );
    if (!updated) flowPlaylistConfig.deleteStaticPlaylist(playlist.id);
    return updated;
  } catch (error) {
    flowPlaylistConfig.deleteStaticPlaylist(playlist.id);
    throw error;
  }
}

const playlistEditError = (code: string, message: string) =>
  Object.assign(new Error(message), { code });

export async function updateSubsonicPlaylist(
  user: SubsonicUser,
  {
    playlistId,
    name,
    comment,
    songIds,
    songIdsToAdd = [],
    songIndexesToRemove = [],
  }: {
    playlistId?: string;
    name?: string;
    comment?: string;
    songIds?: string[];
    songIdsToAdd?: string[];
    songIndexesToRemove?: (string | number)[];
  } = {},
) {
  return withLock("playlist-operation", async () => {
    if (parseId(playlistId)?.kind === "flow" && playlistFromId(user, playlistId)) {
      throw playlistEditError("SUBSONIC_PLAYLIST_READ_ONLY", "Flows are read-only");
    }
    if (parseId(playlistId)?.kind === "mix") {
      throw playlistEditError("SUBSONIC_PLAYLIST_READ_ONLY", "Mixes are read-only");
    }
    const playlist = flowPlaylistConfig.getStaticPlaylistForUser(
      user,
      normalizeStaticPlaylistId(playlistId),
    );
    if (!playlist || !hasPermission(user, "accessPlaylists")) return null;
    const entries = playlistJobEntries(playlist);
    const visibleEntries = entries.filter(({ job }) => isPlayableJob(job));
    const removedEntries =
      songIds !== undefined
        ? visibleEntries
        : [...new Set(songIndexesToRemove)].map((index) => {
            const entry =
              typeof index === "number" && Number.isInteger(index) ? visibleEntries[index] : null;
            if (!entry) {
              throw playlistEditError(
                "SUBSONIC_PLAYLIST_ENTRY_NOT_FOUND",
                `Playlist has no song at index ${index}`,
              );
            }
            return entry;
          });
    const resolvedAdds = (songIds ?? songIdsToAdd).map((id) => resolveSubsonicTrack(user, id));
    if (!resolvedAdds.every((entry) => entry !== null)) return null;
    const removedIndexes = new Set(removedEntries.map(({ trackIndex }) => trackIndex));
    const keptTracks =
      songIds !== undefined ? [] : playlist.tracks.filter((_, index) => !removedIndexes.has(index));
    const nextTracks = [...keptTracks, ...resolvedAdds.map((entry) => entry.track)];
    const updates: StaticPlaylistUpdates = {};
    if (name !== undefined) updates.name = String(name || "").trim();
    if (comment !== undefined) updates.description = String(comment || "").trim() || null;
    return replaceSubsonicPlaylistTracks(user, playlist, nextTracks, updates);
  });
}

export async function deleteSubsonicPlaylist(user: SubsonicUser, playlistId: string) {
  const playlist = flowPlaylistConfig.getStaticPlaylistForUser(
    user,
    normalizeStaticPlaylistId(playlistId),
  );
  if (!playlist || !hasPermission(user, "accessPlaylists")) return false;
  return processPlaylistOperation({
    kind: "static-playlist-delete",
    playlistId: playlist.id,
  });
}

const starTarget = (value: unknown) => {
  const parsed = parseId(value);
  return parsed && ["artist", "album", "song", "flow-song", "shared-song"].includes(parsed.kind)
    ? parsed
    : null;
};

export function star(user: SubsonicUser, value: string) {
  return starMany(user, [value]);
}

export async function starMany(
  user: SubsonicUser,
  values: string[],
  { skipLibraryValidation = false }: { skipLibraryValidation?: boolean } = {},
) {
  const starTargets = values.map(starTarget);
  const parsed = starTargets.flatMap((target) => (target ? [target] : []));
  if (!starTargets.length || parsed.length !== starTargets.length || !user?.id) return false;
  const libraryTargets = parsed
    .filter((target) => ["artist", "album", "song"].includes(target.kind))
    .map((target) => idFor(target.kind, target.key));
  const playlistSongs = parsed.map((target) =>
    ["flow-song", "shared-song"].includes(target.kind)
      ? resolvePlaylistSong(user, idFor(target.kind, target.key))
      : null,
  );
  const libraryTargetKeys = skipLibraryValidation
    ? null
    : getLibraryFavoriteTargetKeys(libraryTargets);
  if (libraryTargetKeys && libraryTargets.some((target) => !libraryTargetKeys.has(target))) {
    return false;
  }
  if (
    parsed.some((target, index) =>
      ["flow-song", "shared-song"].includes(target.kind) ? !playlistSongs[index] : false,
    )
  )
    return false;
  if (favoriteAutoKeepEnabled()) {
    const linked = await linkTracksToLibrary(
      playlistSongs.flatMap((song) => (song ? [song.track] : [])),
      { startedByPlaylist: null },
    );
    if (linked.tracks.some((track) => !track.canonicalJobId)) {
      await discardLibraryJobs(linked.createdJobIds);
      return false;
    }
    keepSongsInLibrary(parsed.flatMap((target) => (target.kind === "song" ? [target.key] : [])));
  }
  const addStars = db.transaction(() => {
    let changed = false;
    for (const target of parsed) {
      changed =
        addStarStmt.run(user.id, target.kind, target.key, Date.now()).changes > 0 || changed;
    }
    if (changed) touchStars(user.id);
  });
  addStars();
  return true;
}

export function unstar(user: SubsonicUser, value: string) {
  return unstarMany(user, [value]);
}

export function unstarMany(user: SubsonicUser, values: string[]) {
  const starTargets = values.map(starTarget);
  const parsed = starTargets.flatMap((target) => (target ? [target] : []));
  if (!starTargets.length || parsed.length !== starTargets.length || !user?.id) return false;
  const targetRows = parsed.map((target) => ({ entity_kind: target.kind, entity_key: target.key }));
  const targetKeys = new Set(
    [...targetRows, ...libraryStarRows(user, targetRows)].map(
      (entry) => `${entry.entity_kind}:${entry.entity_key}`,
    ),
  );
  const rows = starredRows(user);
  const libraryRows = libraryStarRows(user, rows);
  const removed: { id: string; starredAt: number }[] = [];
  const removeStars = db.transaction(() => {
    rows.forEach((row, index) => {
      const libraryRow = libraryRows[index];
      if (
        (targetKeys.has(`${row.entity_kind}:${row.entity_key}`) ||
          (libraryRow !== undefined &&
            targetKeys.has(`${libraryRow.entity_kind}:${libraryRow.entity_key}`))) &&
        removeStarStmt.run(user.id, row.entity_kind, row.entity_key).changes > 0
      ) {
        removed.push({
          id: idFor(row.entity_kind, row.entity_key),
          starredAt: Number(row.created_at) || Date.now(),
        });
      }
    });
    if (removed.length) touchStars(user.id);
  });
  removeStars();
  return removed;
}

const upsertRatingStmt = db.prepare<[number, string, string, number, number]>(
  `INSERT INTO subsonic_ratings (user_id, entity_kind, entity_key, rating, updated_at)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(user_id, entity_kind, entity_key)
   DO UPDATE SET rating = excluded.rating, updated_at = excluded.updated_at`,
);
const deleteRatingStmt = db.prepare<[number, string, string]>(
  "DELETE FROM subsonic_ratings WHERE user_id = ? AND entity_kind = ? AND entity_key = ?",
);

export function setRating(user: SubsonicUser, value: string, rating: number) {
  const target = starTarget(value);
  if (!target || !user?.id) return false;
  const [row] = libraryStarRows(user, [{ entity_kind: target.kind, entity_key: target.key }]);
  if (!row || !["artist", "album", "song"].includes(row.entity_kind)) return false;
  const id = idFor(row.entity_kind, row.entity_key);
  if (!getLibraryFavoriteTargetKeys([id]).has(id)) return false;
  db.transaction(() => {
    const changes = rating
      ? upsertRatingStmt.run(user.id, row.entity_kind, row.entity_key, rating, Date.now()).changes
      : deleteRatingStmt.run(user.id, row.entity_kind, row.entity_key).changes;
    if (changes) touchStars(user.id);
  })();
  return true;
}

const starEntriesSchema = v.fallback(
  v.array(
    v.fallback(
      v.looseObject({ id: v.optional(v.unknown()), starredAt: v.optional(v.unknown()) }),
      {},
    ),
  ),
  [],
);

export function restoreStars(user: SubsonicUser, entries: unknown) {
  const parsed = v.parse(starEntriesSchema, entries).map((entry) => ({
    target: starTarget(entry.id),
    starredAt: Number(entry.starredAt),
  }));
  const restorable = parsed.flatMap(({ target, starredAt }) =>
    target && Number.isSafeInteger(starredAt) && starredAt > 0 ? [{ target, starredAt }] : [],
  );
  if (!parsed.length || !user?.id || restorable.length !== parsed.length) {
    return false;
  }
  const addStars = db.transaction(() => {
    let changed = false;
    for (const { target, starredAt } of restorable) {
      changed = addStarStmt.run(user.id, target.kind, target.key, starredAt).changes > 0 || changed;
    }
    if (changed) touchStars(user.id);
  });
  addStars();
  return true;
}

export type ImportedFavorite = { mbid: string; starredAt: number } & (
  | { kind: "artist"; artist: string }
  | { kind: "album"; album: string; artist: string }
  | { kind: "song"; title: string; artist: string; album: string; durationMs: number | undefined }
);

const favoriteArtistsStmt = db.prepare<
  [],
  Pick<LibraryArtistsRow, "identity_key" | "mbid" | "name">
>("SELECT identity_key, mbid, name FROM library_artists ORDER BY id");
const favoriteAlbumsStmt = db.prepare<
  [],
  Pick<
    LibraryAlbumsRow,
    "identity_key" | "mbid" | "release_group_mbid" | "title" | "album_artist"
  > & {
    artist_name: string;
  }
>(
  `SELECT album.identity_key, album.mbid, album.release_group_mbid, album.title, album.album_artist,
     artist.name AS artist_name
   FROM library_albums AS album
   JOIN library_artists AS artist ON artist.id = album.artist_id
   ORDER BY album.id`,
);

const nameKey = (...names: (string | null | undefined)[]) => {
  const keys = names.map(libraryNameKey);
  return keys.every(Boolean) ? keys.join("\u0000") : null;
};

const indexByKeys = <T extends { identity_key: string }>(
  rows: T[],
  keys: (row: T) => (string | null | undefined)[],
) => {
  const index = new Map<string, string>();
  for (const row of rows) {
    for (const key of keys(row)) if (key && !index.has(key)) index.set(key, row.identity_key);
  }
  return index;
};

// Favorites from another server become this user's own stars, matched by MusicBrainz ID and
// then by name. Anything not in the library is skipped and counted.
export function importFavorites(userId: number, favorites: ImportedFavorite[]) {
  const artists = favorites.some((favorite) => favorite.kind === "artist")
    ? indexByKeys(favoriteArtistsStmt.all(), (row) => [row.mbid, nameKey(row.name)])
    : new Map<string, string>();
  const albums = favorites.some((favorite) => favorite.kind === "album")
    ? indexByKeys(favoriteAlbumsStmt.all(), (row) => [
        row.mbid,
        row.release_group_mbid,
        nameKey(row.artist_name, row.title),
        nameKey(row.album_artist, row.title),
      ])
    : new Map<string, string>();
  const songs = favorites.filter((favorite) => favorite.kind === "song");
  const songKeys = new Map(
    resolveLibraryTracks(songs).map((match, index) => [songs[index], match?.track.identityKey]),
  );
  const matches = favorites.flatMap((favorite) => {
    const key =
      favorite.kind === "artist"
        ? artists.get(favorite.mbid) || artists.get(nameKey(favorite.artist) ?? "")
        : favorite.kind === "album"
          ? albums.get(favorite.mbid) || albums.get(nameKey(favorite.artist, favorite.album) ?? "")
          : songKeys.get(favorite);
    return key ? [{ kind: favorite.kind, key, starredAt: favorite.starredAt }] : [];
  });
  const addStars = db.transaction(() => {
    let added = 0;
    for (const { kind, key, starredAt } of matches) {
      added += addStarStmt.run(userId, kind, key, starredAt).changes;
    }
    if (added) touchStars(userId);
    return added;
  });
  return { added: addStars(), missing: favorites.length - matches.length };
}

const starredRows = (user: SubsonicUser): StarRow[] => (user?.id ? getStarsStmt.all(user.id) : []);

const starredAtFromRows = (rows: StarRow[]) => {
  const starredAt = new Map();
  for (const row of rows) {
    const key = `${row.entity_kind}:${row.entity_key}`;
    if (!starredAt.has(key)) {
      starredAt.set(key, new Date(Number(row.created_at) || Date.now()).toISOString());
    }
  }
  return starredAt;
};

// Star timestamps keyed by protocol id, with playlist-song stars resolved to their library track.
const starredAtFor = (user: SubsonicUser) =>
  starredAtFromRows(libraryStarRows(user, starredRows(user)));

const ratingsStmt = db.prepare<
  [number],
  Pick<SubsonicRatingsRow, "entity_kind" | "entity_key"> & {
    average: number;
    user_rating: number | null;
  }
>(
  `SELECT entity_kind, entity_key, AVG(rating) AS average,
     MAX(CASE WHEN user_id = ? THEN rating END) AS user_rating
   FROM subsonic_ratings
   GROUP BY entity_kind, entity_key`,
);

const ratingsFor = (user: SubsonicUser) =>
  new Map(
    ratingsStmt.all(user?.id ?? 0).map((row): [string, Rating] => [
      `${row.entity_kind}:${row.entity_key}`,
      {
        ...(row.user_rating && { userRating: row.user_rating }),
        averageRating: Math.round(row.average * 100) / 100,
      },
    ]),
  );

const viewerFor = (user: SubsonicUser): Viewer => ({
  starredAt: starredAtFor(user),
  ratings: ratingsFor(user),
});

export function getStarredIdentityKeys(user: SubsonicUser) {
  return new Set(
    libraryStarRows(user, starredRows(user)).map((row) => `${row.entity_kind}:${row.entity_key}`),
  );
}

const buildStarred = (library: IndexedLibrary, rows: StarRow[], user: SubsonicUser) => {
  const starred: StarredResult = { artist: [], album: [], song: [] };
  for (const row of rows) {
    const parsed = { kind: row.entity_kind, key: row.entity_key };
    if (["flow-song", "shared-song"].includes(parsed.kind)) {
      const separator = parsed.key.indexOf(":");
      const kind = parsed.kind === "flow-song" ? "flow" : "shared";
      const playlist =
        separator > 0 ? playlistFromId(user, idFor(kind, parsed.key.slice(0, separator))) : null;
      const job = separator > 0 ? downloadTracker.getJob(parsed.key.slice(separator + 1)) : null;
      if (playlist && playlistOwnsJob(playlist, job)) {
        // Rows still flagged as playlist songs did not resolve to a library track above.
        const updatedAt = getCustomArtworkMap("playlist-track", [job!.id]).get(String(job!.id));
        starred.song.push(toPlaylistSong(playlist, kind, job!, library, null, updatedAt || null));
      }
      continue;
    }
    if (parsed.kind === "artist") {
      const artist = findLibraryEntry(library, { kind: parsed.kind, key: parsed.key });
      if (artist) starred.artist.push(toArtistSummary(artist, library));
    }
    if (parsed.kind === "album") {
      const album = findLibraryEntry(library, { kind: parsed.kind, key: parsed.key });
      if (album) starred.album.push(toAlbumSummary(library, album));
    }
    if (parsed.kind === "song") {
      const track = findLibraryEntry(library, { kind: parsed.kind, key: parsed.key });
      if (track) starred.song.push(toSong(library, track));
    }
  }
  return starred;
};

export function getStarredWithLibrary(
  user: SubsonicUser,
  { availableOnly = false }: { availableOnly?: boolean } = {},
) {
  const stored = starredRows(user);
  const resolved = libraryStarRows(user, stored);
  // Several playlist-song stars can resolve to the same library track; render it once.
  const seen = new Set();
  const rows = resolved.filter((row) => {
    const key = `${row.entity_kind}:${row.entity_key}`;
    return seen.has(key) ? false : seen.add(key);
  });
  // A playlist song stays favorited under the id it was starred with after it resolves to the Library.
  const songIds = [
    ...new Set(
      [...stored, ...resolved]
        .filter((row) => ["song", "flow-song", "shared-song"].includes(row.entity_kind))
        .map((row) => idFor(row.entity_kind, row.entity_key)),
    ),
  ];
  const libraryRows = rows.filter((row) => ["artist", "album", "song"].includes(row.entity_kind));
  const library = getLibrary({
    availableOnly,
    favoriteKeys: libraryRows.map((row) => ({ kind: row.entity_kind, key: row.entity_key })),
  });
  return {
    starred: buildStarred(
      indexFocusedLibrary(library, {
        starredAt: starredAtFromRows(rows),
        ratings: ratingsFor(user),
      }),
      rows,
      user,
    ),
    songIds,
    library,
  };
}

export function getLibraryFavorites(user: SubsonicUser) {
  const { starred, songIds, library } = getStarredWithLibrary(user);
  const ids = (entries: { id: string }[]) => entries.map((entry) => entry.id);
  const favorite = new Set([...ids(starred.artist), ...ids(starred.album), ...ids(starred.song)]);
  const tracks = library.tracks.filter((track) => favorite.has(idFor("song", track.identityKey)));
  const trackAlbumIds = new Set(tracks.flatMap((track) => track.albums.map((ref) => ref.albumId)));
  const keptAlbums = library.albums.filter(
    (album) => trackAlbumIds.has(album.id) || favorite.has(idFor("album", album.identityKey)),
  );
  const stats = getAlbumStats(
    keptAlbums.map((album) => album.id),
    null,
  );
  const albums = keptAlbums.map((album) => ({
    ...album,
    trackCount: stats.get(String(album.id))?.trackCount ?? album.trackIds.length,
    availableTrackCount: stats.get(String(album.id))?.availableTrackCount ?? 0,
  }));
  const albumArtistIds = new Set(albums.map((album) => album.artistId));
  const artists = library.artists.filter(
    (artist) => albumArtistIds.has(artist.id) || favorite.has(idFor("artist", artist.identityKey)),
  );
  return {
    artistIds: ids(starred.artist),
    albumIds: ids(starred.album),
    songIds,
    playlistSongs: starred.song.filter((song) => /^(flow|shared)-song:/.test(song.id)),
    library: { artists, albums, tracks },
  };
}

export function getStarred(user: SubsonicUser) {
  return getStarredWithLibrary(user, { availableOnly: true }).starred;
}

export async function getArtistInfo(value: string) {
  const artist = getArtist(value);
  if (!artist) return null;
  const metadata = artist.musicBrainzId ? await getCachedArtistByMbid(artist.musicBrainzId) : null;
  return {
    id: artist.id,
    ...(metadata?.overview && { biography: metadata.overview }),
    ...(artist.musicBrainzId && { musicBrainzId: artist.musicBrainzId }),
    lastFmUrl: `https://www.last.fm/music/${encodeURIComponent(artist.name)}`,
    similarArtist: [],
  };
}

export function getTopSongs(
  artist: string,
  options: SubsonicQuery = {},
  user: RequestUser | null = null,
) {
  const target = String(artist || "").trim();
  if (!target) return [];
  const library = indexFocusedLibrary(
    getLibraryTopTracks({
      source: "all",
      availableOnly: true,
      artist: target,
      limit: normalizeLimit(options.count),
      userId: user?.id ?? null,
    }),
    viewerFor(user),
  );
  return library.tracks.map((track) => toSong(library, track));
}

export function getSubsonicPlaylists(user: SubsonicUser) {
  const artworkRevision = getCustomArtworkRevision("playlist-track");
  const coverRevisions = getPlaylistArtworkRevisions();
  const flows = visibleFlows(user).map((flow) => {
    const jobs = visiblePlaylistJobs(flow);
    const artworkChangedAt = latestArtworkChange(
      getCustomArtworkMap(
        "playlist-track",
        jobs.map((job) => job.id),
      ),
    );
    const playlist: SubsonicPlaylist = {
      id: idFor("flow", flow.id),
      name: flow.name,
      owner: userOps.getUserById(flow.ownerUserId)?.username || "",
      coverArt: playlistCoverArt("flow", flow.id, coverRevisions.get(flow.id)),
      songCount: jobs.length,
      duration: jobs.reduce((total, job) => total + seconds(job.durationMs), 0),
      public: false,
      created: new Date(flow.createdAt || Date.now()).toISOString(),
      changed: new Date(
        Math.max(
          epochMs(flow.lastRunAt || flow.createdAt),
          artworkChangedAt,
          artworkRevision,
          coverRevisions.get(flow.id) || 0,
        ),
      ).toISOString(),
    };
    if (flow.description) playlist.comment = flow.description;
    return playlist;
  });
  const staticPlaylists = flowPlaylistConfig.getStaticPlaylistsForUser(user).map((playlist) => {
    const jobs = visiblePlaylistJobs(playlist, { includePending: true });
    const artworkChangedAt = latestArtworkChange(
      getCustomArtworkMap(
        "playlist-track",
        jobs.map((job) => job.id),
      ),
    );
    const value: SubsonicPlaylist = {
      id: idFor("shared", playlist.id),
      name: playlist.name,
      owner: userOps.getUserById(playlist.ownerUserId)?.username || "",
      coverArt: playlistCoverArt("shared", playlist.id, coverRevisions.get(playlist.id)),
      songCount: jobs.length,
      duration: jobs.reduce((total, job) => total + seconds(job.durationMs), 0),
      public: false,
      created: new Date(playlist.createdAt || Date.now()).toISOString(),
      changed: new Date(
        Math.max(
          epochMs(playlist.importedAt || playlist.createdAt),
          artworkChangedAt,
          artworkRevision,
          coverRevisions.get(playlist.id) || 0,
        ),
      ).toISOString(),
    };
    if (playlist.description) value.comment = playlist.description;
    return value;
  });
  return [...flows, ...staticPlaylists];
}

export function getSubsonicPlaylist(value: string, user: SubsonicUser) {
  const parsed = parseId(value);
  const kind = parsed?.kind === "shared" ? "shared" : "flow";
  const playlist = playlistFromId(user, value);
  if (!playlist || (kind === "flow" && !flowPlaylistConfig.isEnabled(playlist.id))) return null;
  const jobs = visiblePlaylistJobs(playlist);
  const viewer = viewerFor(user);
  const owned = resolveLibraryTracks(jobs.map((job) => trackFromJob(job)));
  const customArtwork = getCustomArtworkMap(
    "playlist-track",
    jobs.map((job) => job.id),
  );
  const artworkChangedAt = latestArtworkChange(customArtwork);
  const coverRevision = getPlaylistArtworkState(playlist.id)?.revision;
  return {
    id: idFor(kind, playlist.id),
    name: playlist.name,
    ...(playlist.description && { comment: playlist.description }),
    owner: userOps.getUserById(playlist.ownerUserId)?.username || "",
    coverArt: playlistCoverArt(kind, playlist.id, coverRevision),
    songCount: jobs.length,
    duration: jobs.reduce((total, job) => total + seconds(job.durationMs), 0),
    public: false,
    created: new Date(playlist.createdAt || Date.now()).toISOString(),
    changed: new Date(
      Math.max(
        epochMs(
          (kind === "flow" && "lastRunAt" in playlist
            ? playlist.lastRunAt
            : "importedAt" in playlist
              ? playlist.importedAt
              : undefined) || playlist.createdAt,
        ),
        artworkChangedAt,
        getCustomArtworkRevision("playlist-track"),
        coverRevision || 0,
      ),
    ).toISOString(),
    entry: jobs.map((job, index) =>
      toPlaylistSong(
        playlist,
        kind,
        job,
        viewer,
        owned[index],
        customArtwork.get(String(job.id)) || null,
      ),
    ),
  };
}

const userMixes = async (user: SubsonicUser) => (user && user.id > 0 ? getUserMixes(user.id) : []);

function toMixPlaylists(user: SubsonicUser, mixes: Mix[]) {
  const library = indexFocusedLibrary(
    getLibraryForTrackIds({
      ids: mixes.flatMap((mix) => mix.trackIds),
      source: "all",
      availableOnly: true,
    }),
    viewerFor(user),
  );
  const changed = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000).toISOString();
  return mixes.map((mix) => {
    const entry = mix.trackIds.flatMap((trackId) => {
      const track = library.tracksById.get(trackId);
      return track ? [toSong(library, track)] : [];
    });
    const playlist: SubsonicPlaylist = {
      id: idFor("mix", mix.id),
      name: mix.name,
      comment: mix.description,
      owner: user?.username || "",
      coverArt: entry[0]?.coverArt || idFor("mix", mix.id),
      songCount: entry.length,
      duration: entry.reduce((total, song) => total + song.duration, 0),
      public: false,
      created: changed,
      changed,
    };
    return { playlist, entry };
  });
}

const mixPlaylistSummaries = new WeakMap<Mix[], SubsonicPlaylist[]>();

export async function getSubsonicMixPlaylists(user: SubsonicUser) {
  const mixes = await userMixes(user);
  const cached = mixPlaylistSummaries.get(mixes);
  if (cached) return cached;
  const playlists = toMixPlaylists(user, mixes).map(({ playlist }) => playlist);
  mixPlaylistSummaries.set(mixes, playlists);
  return playlists;
}

export async function getSubsonicMixPlaylist(value: string, user: SubsonicUser) {
  const parsed = parseId(value);
  if (parsed?.kind !== "mix" || !user || user.id <= 0) return null;
  const mix = await getUserMix(user.id, parsed.key);
  if (!mix) return null;
  const [found] = toMixPlaylists(user, [mix]);
  return found ? { ...found.playlist, entry: found.entry } : null;
}

export function resolveStreamPath(value: string, user: SubsonicUser) {
  const playlistEntry = playlistJobFromId(user, value);
  if (playlistEntry) {
    return playlistEntry.job.finalPath;
  }

  const parsed = parseId(value);
  if (parsed?.kind !== "song") return null;
  const library = indexFocusedLibrary(
    getLibraryTrack({
      trackId: parsed.key,
      source: "all",
      availableOnly: true,
    }),
  );
  const track = findLibraryEntry(library, parsed);
  const album = findAlbumForTrack(library, track);
  const file = firstFile(track, album?.id, album?.managed);
  return file?.available && file.path ? file.path : null;
}

const libraryTrackKey = db.prepare<[number], Pick<LibraryTracksRow, "identity_key">>(
  "SELECT identity_key FROM library_tracks WHERE id = ?",
);
const libraryTrackByKey = db.prepare<[string], Pick<LibraryTracksRow, "id">>(
  "SELECT id FROM library_tracks WHERE identity_key = ?",
);

function playlistSongId(user: SubsonicUser, job: DownloadJob) {
  const flow = job.playlistType ? flowPlaylistConfig.getFlowForUser(user, job.playlistType) : null;
  if (flow && playlistOwnsJob(flow, job)) return idFor("flow-song", `${flow.id}:${job.id}`);
  const shared = flowPlaylistConfig
    .getStaticPlaylistsForUser(user)
    .find((playlist) => playlistOwnsJob(playlist, job));
  return shared ? idFor("shared-song", `${shared.id}:${job.id}`) : null;
}

export function songIdForQueueEntry(
  user: SubsonicUser,
  entry: { trackId: number } | { jobId: string },
) {
  if ("trackId" in entry) {
    const row = libraryTrackKey.get(entry.trackId);
    return row ? idFor("song", row.identity_key) : null;
  }
  const job = downloadTracker.getJob(entry.jobId);
  if (!job || !isPlayableJob(job)) return null;
  const owned = findAvailableLibraryTrack(trackFromJob(job));
  return owned?.track.identityKey
    ? idFor("song", owned.track.identityKey)
    : playlistSongId(user, job);
}

export function queueEntryForSong(user: SubsonicUser, value: string) {
  const playlistEntry = playlistJobFromId(user, value);
  if (playlistEntry) return { job: playlistEntry.job };
  const parsed = parseId(value);
  const row = parsed?.kind === "song" ? libraryTrackByKey.get(parsed.key) : undefined;
  return row ? { trackId: row.id } : null;
}

const storedImageUrl = (key: string) => dbOps.getImage(key)?.imageUrl || null;

const replaceStoredImage = (key: string, expected: string | null, imageUrl: string) => {
  if (storedImageUrl(key) === expected) dbOps.setImage(key, imageUrl);
};

const cachedArtworkUrl = async (key: string) => {
  const stored = storedImageUrl(key);
  if (!stored || stored === "NOT_FOUND") return null;
  const artwork = await warmPublicImageUrl(stored, LIBRARY_IMAGE_PROFILE);
  if (artwork && artwork !== stored) replaceStoredImage(key, stored, artwork);
  return artwork || buildImageProxyUrl(stored);
};

const customArtworkTargetSchema = v.fallback(
  v.looseObject({
    id: lenientCount,
    updatedAt: lenientCount,
    playlistKind: lenientText,
    playlistId: lenientText,
  }),
  {},
);

const customArtworkTarget = (parsed: ParsedId | null) => {
  if (!parsed?.kind?.startsWith("art-")) return null;
  try {
    const value = v.parse(customArtworkTargetSchema, JSON.parse(parsed.key));
    const id = String(value.id || "").trim();
    const updatedAt = Number(value.updatedAt);
    return id && Number.isFinite(updatedAt)
      ? {
          id,
          updatedAt,
          playlistKind: value.playlistKind ?? "",
          playlistId: value.playlistId ?? "",
        }
      : null;
  } catch {
    return null;
  }
};

export function resolveCustomArtwork(value: string, user: SubsonicUser) {
  const parsed = parseId(value);
  const target = customArtworkTarget(parsed);
  if (!target) return null;

  let kind;
  if (parsed!.kind === "art-album") kind = "album";
  if (parsed!.kind === "art-track") kind = "track";
  if (parsed!.kind === "art-playlist-track") {
    if (!["flow", "shared"].includes(target.playlistKind)) return null;
    const playlist = playlistFromId(user, idFor(target.playlistKind, target.playlistId));
    const job = downloadTracker.getJob(target.id);
    if (!playlist || !playlistOwnsJob(playlist, job)) return null;
    kind = "playlist-track";
  }
  if (!kind) return null;

  const artwork = getCustomArtwork(kind, target.id);
  return artwork && Number(artwork.updatedAt) === target.updatedAt ? artwork : null;
}

export async function resolveArtworkUrl(value: string) {
  const parsed = parseId(value);
  if (parsed?.kind !== "album" || !parsed.key.startsWith("release-group:")) return null;
  const releaseGroupMbid = parsed.key.slice("release-group:".length);
  const cacheKey = `rg:${releaseGroupMbid}`;
  const cached = await cachedArtworkUrl(cacheKey);
  if (cached) return cached;
  const result = await fetchReleaseGroupCoverUrl(releaseGroupMbid);
  if (!result?.imageUrl) return null;
  const artwork = await warmPublicImageUrl(result.imageUrl, LIBRARY_IMAGE_PROFILE);
  if (artwork) dbOps.setImage(cacheKey, artwork);
  return artwork;
}

export async function resolveLibraryArtwork(value: string) {
  const parsed = parseId(value);
  if (!parsed) return null;
  if (parsed.kind === "artist") {
    const library = indexFocusedLibrary(
      getLibraryForArtistReferences({
        source: "all",
        availableOnly: false,
        references: [parsed.key],
      }),
    );
    const artist = findLibraryEntry(library, parsed);
    return artist ? getLibraryArtwork("artist", String(artist.id)) : null;
  }
  if (parsed.kind !== "album" && parsed.kind !== "song") return null;
  const library = indexFocusedLibrary(
    parsed.kind === "album"
      ? getLibraryForAlbumReferences({
          source: "all",
          availableOnly: false,
          references: [parsed.key],
        })
      : getLibraryTrack({ trackId: parsed.key, source: "all", availableOnly: false }),
  );
  const album =
    parsed.kind === "album"
      ? findLibraryEntry(library, parsed)
      : findAlbumForTrack(library, findLibraryEntry(library, parsed));
  return album ? getLibraryArtwork("album", String(album.id)) : null;
}

export async function resolvePlaylistArtwork(value: string, user: SubsonicUser) {
  const parsed = parseId(value);
  const target = parsed?.kind === "art-playlist" ? customArtworkTarget(parsed) : null;
  const playlist = target
    ? playlistFromId(user, idFor(target.playlistKind, target.id))
    : playlistFromId(user, value);
  if (!playlist) return null;
  const artwork = await playlistManager.resolveArtworkFile(playlist.id);
  return artwork && { ...artwork, versioned: Boolean(target) };
}

export { idFor, parseId };
