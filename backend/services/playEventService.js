import { db } from "../config/db-sqlite.js";
import { logger } from "./logger.js";
import { enqueuePlayEventDelivery } from "./honkerDb.js";
import { scrobbleConnectionStore } from "./scrobbleConnectionStore.js";
import { normalizeKoitoBaseUrl } from "./koitoClient.js";

const insertEventStmt = db.prepare(`
  INSERT INTO play_events
    (user_id, track_id, title, artist, album, artist_mbid, album_mbid, track_mbid,
     duration_ms, played_at, source, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const getEventStmt = db.prepare("SELECT * FROM play_events WHERE id = ?");
const getHistoryStmt = db.prepare(
  "SELECT * FROM play_events WHERE user_id = ? ORDER BY played_at DESC, id DESC LIMIT ? OFFSET ?",
);
const getArtistsStmt = db.prepare(`
  SELECT artist, MAX(artist_mbid) AS artist_mbid, COUNT(*) AS play_count,
         MAX(played_at) AS last_played_at
  FROM play_events
  WHERE user_id = ?
  GROUP BY artist
  ORDER BY play_count DESC, last_played_at DESC
  LIMIT ?
`);

const text = (value, max = 500) => String(value || "").trim().slice(0, max);
const positiveInt = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
};

const toPublicEvent = (row) => row && ({
  id: row.id,
  userId: row.user_id,
  trackId: row.track_id,
  title: row.title,
  artist: row.artist,
  album: row.album,
  artistMbid: row.artist_mbid,
  albumMbid: row.album_mbid,
  trackMbid: row.track_mbid,
  durationMs: row.duration_ms,
  playedAt: row.played_at,
  source: row.source,
});

export const getPlayHistory = (userId, { limit = 50, offset = 0 } = {}) => {
  const safeLimit = Math.min(100, Math.max(1, positiveInt(limit, 50)));
  const safeOffset = Math.max(0, positiveInt(offset, 0));
  return getHistoryStmt.all(userId, safeLimit, safeOffset).map(toPublicEvent);
};

export const getTopPlayedArtists = (userId, { limit = 20 } = {}) => {
  const safeLimit = Math.min(100, Math.max(1, positiveInt(limit, 20)));
  return getArtistsStmt.all(userId, safeLimit).map((row) => ({
    artistName: row.artist,
    mbid: row.artist_mbid || null,
    playcount: Number(row.play_count) || 0,
    lastPlayedAt: Number(row.last_played_at) || null,
  }));
};

export const recordPlayEvent = (userId, input = {}) => {
  const trackId = text(input.trackId, 500);
  const title = text(input.title, 500);
  const artist = text(input.artist, 500);
  if (!trackId || !title || !artist) throw new Error("trackId, title, and artist are required");
  const playedAtValue = Number(input.playedAt);
  const playedAt = Number.isFinite(playedAtValue)
    ? (playedAtValue < 10_000_000_000 ? Math.trunc(playedAtValue * 1000) : Math.trunc(playedAtValue))
    : Date.now();
  const result = insertEventStmt.run(
    userId,
    trackId,
    title,
    artist,
    text(input.album, 500) || null,
    text(input.artistMbid, 100) || null,
    text(input.albumMbid, 100) || null,
    text(input.trackMbid, 100) || null,
    positiveInt(input.durationMs),
    playedAt,
    text(input.source, 50) || "unknown",
    Date.now(),
  );
  const event = toPublicEvent(getEventStmt.get(result.lastInsertRowid));
  const providers = new Set(Object.keys(scrobbleConnectionStore.getConnections(userId)));
  for (const provider of providers) {
    try {
      enqueuePlayEventDelivery({ eventId: event.id, userId, provider });
    } catch (error) {
      logger.warn("play-events", "Could not enqueue scrobble delivery", {
        userId,
        provider,
        error: error?.message || String(error),
      });
    }
  }
  return event;
};

export const deliverPlayEvent = async ({ eventId, userId, provider }) => {
  const event = toPublicEvent(getEventStmt.get(eventId));
  const connection = scrobbleConnectionStore.getConnection(userId, provider);
  if (!event) return;
  if (provider === "lastfm" && connection) {
    const { lastfmScrobble } = await import("./apiClients/lastfm.js");
    await lastfmScrobble(event, connection.token);
    return;
  }
  if (provider === "listenbrainz" && connection) {
    const { listenbrainzSubmit } = await import("./apiClients/listenbrainz.js");
    await listenbrainzSubmit({ token: connection.token, event });
    return;
  }
  if (provider === "koito" && connection) {
    const { listenbrainzSubmit } = await import("./apiClients/listenbrainz.js");
    await listenbrainzSubmit({
      token: connection.token,
      baseUrl: normalizeKoitoBaseUrl(connection.baseUrl || ""),
      event,
    });
    return;
  }
};
