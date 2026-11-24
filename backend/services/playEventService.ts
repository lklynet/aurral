import * as v from "valibot";
import { db, dbHelpers } from "../config/db-sqlite.ts";
import { playEventQueue } from "./jobs/queues.ts";
import { shareNowPlaying } from "./hubFriends.ts";
import { setLocalNowPlaying, setNowPlayingFromScrobble } from "./localNowPlaying.ts";
import { entryForStreamPath, type QueueEntry } from "./queueEntry.ts";
import { scrobbleConnectionStore } from "./scrobbleConnectionStore.ts";
import { getKoitoListenBrainzBaseUrl } from "./koitoClient.ts";
import type { LibraryAlbumsRow, LibraryTracksRow, PlayEventsRow } from "../db/rows.ts";
import type { ListenbrainzSubmitEvent } from "./apiClients/listenbrainz.ts";
import { userOps } from "../db/helpers/index.ts";
import { emitPluginEvent } from "./plugins/pluginEvents.ts";
import { logger } from "./logger.ts";
import { asAppError } from "../../lib/errors.ts";
import { artistNames } from "../../lib/artistCredit.ts";
import { MBID_PATTERN } from "../../lib/mbid.ts";

type PlayEventInput = {
  trackId?: unknown;
  title?: unknown;
  artist?: unknown;
  album?: unknown;
  albumKey?: unknown;
  albumId?: unknown;
  albumMbid?: unknown;
  artistMbid?: unknown;
  trackMbid?: unknown;
  durationMs?: unknown;
  playedAt?: unknown;
  source?: unknown;
  streamPath?: unknown;
};

const getEventStmt = db.prepare<[number], PlayEventsRow>("SELECT * FROM play_events WHERE id = ?");
const resolveAlbumKeyStmt = db.prepare<[string, string, string, string], { identity_key: string }>(`
  SELECT identity_key
  FROM library_albums
  WHERE identity_key = ?
    OR mbid = ?
    OR release_group_mbid = ?
    OR id = ?
  LIMIT 2
`);
const libraryTrackStmt = db.prepare<
  [string, string],
  Pick<LibraryTracksRow, "metadata_json"> & Pick<LibraryAlbumsRow, "mbid" | "release_group_mbid">
>(`
  SELECT track.metadata_json, album.mbid, album.release_group_mbid
  FROM library_albums AS album
  JOIN library_album_tracks AS link ON link.album_id = album.id
  JOIN library_tracks AS track ON track.id = link.track_id
  WHERE album.identity_key = ? AND track.title = ? COLLATE NOCASE
  LIMIT 2
`);
const getHistoryStmt = db.prepare<[number, number, number], PlayEventsRow>(
  "SELECT * FROM play_events WHERE user_id = ? AND external_id IS NULL ORDER BY played_at DESC, id DESC LIMIT ? OFFSET ?",
);
const getArtistsStmt = db.prepare<
  [number, number],
  {
    artist: string;
    artist_mbid: string | null;
    play_count: number;
    last_played_at: number;
  }
>(`
  SELECT artist, MAX(artist_mbid) AS artist_mbid, COUNT(*) AS play_count,
         MAX(played_at) AS last_played_at
  FROM play_events
  WHERE user_id = ?
  GROUP BY artist
  ORDER BY play_count DESC, last_played_at DESC
  LIMIT ?
`);

const text = (value: unknown, max = 500) =>
  String(value || "")
    .trim()
    .slice(0, max);
const positiveInt = <Fallback extends number | null = null>(
  value: unknown,
  fallback: Fallback = null as Fallback,
) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
};

const albumReference = (value: unknown) => {
  const raw = text(value, 500);
  if (!raw.startsWith("album:")) return raw;
  try {
    return decodeURIComponent(raw.slice("album:".length));
  } catch {
    return "";
  }
};

const resolveAlbumKey = (input: PlayEventInput) => {
  const explicit = albumReference(input.albumKey);
  if (explicit) return explicit;
  for (const value of [input.albumId, input.albumMbid]) {
    const reference = albumReference(value);
    if (!reference) continue;
    const matches = resolveAlbumKeyStmt.all(reference, reference, reference, reference);
    const [match] = matches;
    if (match && matches.length === 1) return match.identity_key;
  }
  return null;
};

const trackTagsSchema = v.looseObject({
  tags: v.optional(
    v.looseObject({
      musicbrainz_artistid: v.optional(v.unknown()),
      artists: v.optional(v.unknown()),
    }),
  ),
});

const tagMbids = (value: unknown) => [
  ...new Set(
    [value].flat().flatMap((id) => {
      const normalized = text(id, 100).toLowerCase();
      return MBID_PATTERN.test(normalized) ? [normalized] : [];
    }),
  ),
];

const libraryListenIds = (albumKey: string | null, title: string) => {
  const matches = albumKey ? libraryTrackStmt.all(albumKey, title) : [];
  const [track] = matches;
  if (!track || matches.length > 1) return {};
  const tags = dbHelpers.readJSON(trackTagsSchema, track.metadata_json, "library track tags")?.tags;
  const artistMbids = tagMbids(tags?.musicbrainz_artistid);
  const names = artistNames(tags?.artists);
  return {
    albumMbid: track.release_group_mbid,
    releaseMbid: track.mbid === track.release_group_mbid ? null : track.mbid,
    ...(artistMbids.length > 0 && {
      artistMbids,
      artistNames: names.length === artistMbids.length ? names : [],
    }),
  };
};

const toPublicEvent = (row: PlayEventsRow | undefined) =>
  row && {
    id: row.id,
    userId: row.user_id,
    trackId: row.track_id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    albumKey: row.album_key,
    artistMbid: row.artist_mbid,
    albumMbid: row.album_mbid,
    trackMbid: row.track_mbid,
    durationMs: row.duration_ms,
    playedAt: row.played_at,
    source: row.source,
  };

export const getPlayHistory = (
  userId: number,
  { limit = 50, offset = 0 }: { limit?: unknown; offset?: unknown } = {},
) => {
  const safeLimit = Math.min(100, Math.max(1, positiveInt(limit, 50)));
  const safeOffset = Math.max(0, positiveInt(offset, 0));
  return getHistoryStmt.all(userId, safeLimit, safeOffset).map(toPublicEvent);
};

export const getTopPlayedArtists = (userId: number, { limit = 20 }: { limit?: unknown } = {}) => {
  const safeLimit = Math.min(100, Math.max(1, positiveInt(limit, 20)));
  return getArtistsStmt.all(userId, safeLimit).map((row) => ({
    artistName: row.artist,
    mbid: row.artist_mbid || null,
    playcount: Number(row.play_count) || 0,
    lastPlayedAt: Number(row.last_played_at) || null,
  }));
};

const insertEventStmt = db.prepare<
  [
    number,
    string,
    string,
    string,
    string | null,
    string | null,
    string | null,
    string | null,
    string | null,
    number | null,
    number,
    string,
    number,
  ],
  Pick<PlayEventsRow, "id">
>(`
  INSERT INTO play_events
    (user_id, track_id, title, artist, album, album_key, artist_mbid, album_mbid,
     track_mbid, duration_ms, played_at, source, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  RETURNING id
`);

export const recordPlayEvent = (userId: number, input: PlayEventInput = {}) => {
  const trackId = text(input.trackId, 500);
  const title = text(input.title, 500);
  const artist = text(input.artist, 500);
  if (!trackId || !title || !artist) throw new Error("trackId, title, and artist are required");
  const playedAtValue = Number(input.playedAt);
  const playedAt = Number.isFinite(playedAtValue)
    ? playedAtValue < 10_000_000_000
      ? Math.trunc(playedAtValue * 1000)
      : Math.trunc(playedAtValue)
    : Date.now();
  const albumKey = resolveAlbumKey(input);
  const connections = scrobbleConnectionStore.getConnections(userId);
  const eventId = db.transaction(() => {
    const row = insertEventStmt.get(
      userId,
      trackId,
      title,
      artist,
      text(input.album, 500) || null,
      albumKey,
      text(input.artistMbid, 100) || null,
      text(input.albumMbid, 100) || null,
      text(input.trackMbid, 100) || null,
      positiveInt(input.durationMs),
      playedAt,
      text(input.source, 50) || "unknown",
      Date.now(),
    );
    if (!row) throw new Error("Play event was not saved");
    for (const [provider, connection] of Object.entries(connections)) {
      const delivery = {
        eventId: row.id,
        userId,
        provider,
        connectionRevision: connection.connectionRevision,
      };
      if (v.is(playEventDeliverySchema, delivery)) playEventQueue.enqueue(delivery);
    }
    return row.id;
  })();
  const event = toPublicEvent(getEventStmt.get(eventId));
  emitPluginEvent("track.played", {
    user: { id: userId, username: userOps.getUserById(userId)?.username ?? null },
    track: {
      id: trackId,
      title,
      artist,
      album: text(input.album, 500) || null,
      durationMs: positiveInt(input.durationMs),
      artistMbid: text(input.artistMbid, 100) || null,
      albumMbid: text(input.albumMbid, 100) || null,
      trackMbid: text(input.trackMbid, 100) || null,
    },
    playedAt,
    source: text(input.source, 50) || "unknown",
  });
  return event;
};

export const playEventDeliverySchema = v.looseObject({
  eventId: v.number(),
  userId: v.number(),
  provider: v.picklist(["listenbrainz", "koito"]),
  connectionRevision: v.string(),
});

type ScrobbleConnection = NonNullable<ReturnType<typeof scrobbleConnectionStore.getConnection>>;

const sendListen = async (connection: ScrobbleConnection, listen: ListenbrainzSubmitEvent) => {
  const { listenbrainzSubmit } = await import("./apiClients/listenbrainz.ts");
  await listenbrainzSubmit({
    token: connection.token,
    baseUrl:
      connection.provider === "koito"
        ? getKoitoListenBrainzBaseUrl(connection.baseUrl || "")
        : undefined,
    event: listen,
  });
};

export const sendNowPlaying = (
  userId: number,
  input: PlayEventInput = {},
  entry = entryForStreamPath(text(input.streamPath)),
) => {
  const title = text(input.title, 500);
  const artist = text(input.artist, 500);
  if (!title || !artist) throw new Error("title and artist are required");
  const connections = Object.values(scrobbleConnectionStore.getConnections(userId));
  const listen = {
    listenType: "playing_now",
    title,
    artist,
    album: text(input.album, 500) || null,
    durationMs: positiveInt(input.durationMs),
    artistMbids: [text(input.artistMbid, 100) || null],
    albumMbid: text(input.albumMbid, 100) || null,
    trackMbid: text(input.trackMbid, 100) || null,
    ...(connections.length > 0 && libraryListenIds(resolveAlbumKey(input), title)),
  } satisfies ListenbrainzSubmitEvent;
  setLocalNowPlaying(userId, {
    title,
    artist,
    album: listen.album,
    durationMs: listen.durationMs,
    entry,
  });
  return Promise.all([
    shareNowPlaying(userId, { title, artist, album: listen.album, durationMs: listen.durationMs }),
    ...connections.map((connection) =>
      sendListen(connection, listen).catch((error: unknown) => {
        logger.info("scrobbling", `${connection.provider} did not take now playing`, {
          error: asAppError(error)?.message,
        });
      }),
    ),
  ]);
};

export const showScrobbleAsNowPlaying = (
  userId: number,
  { title, artist, album, durationMs, playedAt }: NonNullable<ReturnType<typeof recordPlayEvent>>,
  entry: QueueEntry | null,
) => {
  const track = { title, artist, album, durationMs };
  if (setNowPlayingFromScrobble(userId, { ...track, playedAt, entry })) {
    void shareNowPlaying(userId, track);
  }
};

export const deliverPlayEvent = async ({
  eventId,
  userId,
  provider,
  connectionRevision,
}: v.InferOutput<typeof playEventDeliverySchema>) => {
  const event = toPublicEvent(getEventStmt.get(eventId));
  const connection = scrobbleConnectionStore.getConnection(userId, provider);
  if (
    !event ||
    !connection ||
    !connectionRevision ||
    connection.connectionRevision !== connectionRevision
  )
    return;
  await sendListen(connection, {
    ...event,
    artistMbids: [event.artistMbid],
    ...libraryListenIds(event.albumKey, event.title),
    listenType: "single",
  });
};
