import * as v from "valibot";
import { buildPlaylistTrackIdentity, dedupePlaylistTracks } from "../playlists/playlistTracks.ts";
import { lenient, lenientText } from "../integrationData.ts";
import { catalogueTrackIds, isrcKey, NO_CATALOGUE_IDS } from "./catalogueIds.ts";

const spotifyPlaylistTrackSchema = lenient(
  v.nullable(
    v.looseObject({
      type: lenientText,
      name: lenientText,
      duration_ms: lenient(v.number()),
      artists: lenient(v.array(v.fallback(v.looseObject({ name: lenientText }), {}))),
      album: lenient(v.looseObject({ name: lenientText })),
      external_ids: lenient(v.looseObject({ isrc: lenientText })),
    }),
  ),
);

export const spotifyPlaylistItemSchema = v.fallback(
  v.nullable(
    v.looseObject({ item: spotifyPlaylistTrackSchema, track: spotifyPlaylistTrackSchema }),
  ),
  null,
);

export type SpotifyPlaylistItem = v.InferOutput<typeof spotifyPlaylistItemSchema>;

const spotifyTrack = (item: SpotifyPlaylistItem) => item?.item ?? item?.track;

export const spotifyIdKeys = (items: SpotifyPlaylistItem[]) =>
  items.map((item) => isrcKey(spotifyTrack(item)?.external_ids?.isrc));

export function parseSpotifyPlaylistItems(
  items: SpotifyPlaylistItem[] = [],
  ids = NO_CATALOGUE_IDS,
) {
  const stats = {
    sourceItems: items.length,
    itemOnly: 0,
    unavailable: 0,
    podcast: 0,
    incomplete: 0,
    duplicate: 0,
  };
  const raw = [];
  const positions = [];
  const excluded = [];
  for (const [index, item] of items.entries()) {
    const position = index + 1;
    if (item?.item && !item?.track) stats.itemOnly += 1;
    const track = spotifyTrack(item);
    if (!track) {
      stats.unavailable += 1;
      excluded.push({ position, reason: "unavailable" });
      continue;
    }
    if (track.type && track.type !== "track") {
      stats.podcast += 1;
      excluded.push({ position, reason: "podcast", trackName: track.name || null });
      continue;
    }
    const trackName = String(track?.name || "").trim();
    const artistName = String(track?.artists?.[0]?.name || "").trim();
    const albumName = String(track?.album?.name || "").trim();
    if (!trackName || !artistName) {
      stats.incomplete += 1;
      excluded.push({ position, reason: "incomplete", trackName: trackName || null });
      continue;
    }
    raw.push({
      artistName,
      trackName,
      albumName: albumName || null,
      durationMs: Number(track.duration_ms) > 0 ? Number(track.duration_ms) : null,
      ...catalogueTrackIds(ids, [isrcKey(track.external_ids?.isrc)]),
    });
    positions.push(position);
  }
  const tracks = dedupePlaylistTracks(raw);
  stats.duplicate = Math.max(0, raw.length - tracks.length);
  const seen = new Set<string>();
  for (const [index, track] of raw.entries()) {
    const identity = buildPlaylistTrackIdentity(track);
    if (seen.has(identity)) {
      excluded.push({
        position: positions[index],
        reason: "duplicate",
        artistName: track.artistName,
        trackName: track.trackName,
      });
    }
    seen.add(identity);
  }
  return { tracks, stats, excluded };
}
