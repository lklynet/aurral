import * as v from "valibot";
import { db } from "../config/db-sqlite.ts";
import { getHonkerDb, getPlayEventOutbox } from "./honkerDb.ts";
import { scrobbleConnectionStore } from "./scrobbleConnectionStore.ts";
import { getKoitoListenBrainzBaseUrl } from "./koitoClient.ts";
import type { PlayEventsRow } from "../db/rows.ts";

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
};

const getEventStmt = db.prepare<[number], PlayEventsRow>("SELECT * FROM play_events WHERE id = ?");
const resolveAlbumKeyStmt = db.prepare<[string, string, string, string], { identity_key: string }>(`
  SELECT identity_key
  FROM library_albums
  WHERE identity_key = ?
    OR mbid = ?
    OR release_group_mbid = ?
    OR CAST(id AS TEXT) = ?
  LIMIT 2
`);
const getHistoryStmt = db.prepare<[number, number, number], PlayEventsRow>(
  "SELECT * FROM play_events WHERE user_id = ? ORDER BY played_at DESC, id DESC LIMIT ? OFFSET ?",
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
    if (matches.length === 1) return matches[0].identity_key;
  }
  return null;
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
  const honker = getHonkerDb();
  const tx = honker.transaction();
  let eventId: number | undefined;
  try {
    const rows = tx.query(
      `
      INSERT INTO play_events
        (user_id, track_id, title, artist, album, album_key, artist_mbid, album_mbid,
         track_mbid, duration_ms, played_at, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `,
      [
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
      ],
    ) as { id: number }[];
    eventId = rows[0]?.id;
    for (const [provider, connection] of Object.entries(connections)) {
      getPlayEventOutbox().enqueueTx(tx, {
        eventId,
        userId,
        provider,
        connectionRevision: connection.connectionRevision,
      });
    }
    tx.commit();
  } catch (error) {
    try {
      tx.rollback();
    } catch {}
    throw error;
  }
  const event = toPublicEvent(getEventStmt.get(eventId));
  return event;
};

export const playEventDeliverySchema = v.looseObject({
  eventId: v.number(),
  userId: v.number(),
  provider: v.picklist(["lastfm", "listenbrainz", "koito"]),
  connectionRevision: v.string(),
});

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
  if (provider === "lastfm") {
    const { lastfmScrobble } = await import("./apiClients/lastfm.ts");
    await lastfmScrobble(event, connection.token);
    return;
  }
  if (provider === "listenbrainz") {
    const { listenbrainzSubmit } = await import("./apiClients/listenbrainz.ts");
    await listenbrainzSubmit({ token: connection.token, event });
    return;
  }
  if (provider === "koito") {
    const { listenbrainzSubmit } = await import("./apiClients/listenbrainz.ts");
    await listenbrainzSubmit({
      token: connection.token,
      baseUrl: getKoitoListenBrainzBaseUrl(connection.baseUrl || ""),
      event,
    });
    return;
  }
};
