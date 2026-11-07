import * as v from "valibot";
import { lenient, lenientCount, lenientText, oneOrMany } from "../integrationData.ts";
import { dedupePlaylistTracks } from "../playlists/playlistTracks.ts";

const PLAYLIST_TRACK_EXTENSION = "https://musicbrainz.org/doc/jspf#track";
const TRACK_URI_PREFIX = "https://musicbrainz.org/recording/";
const ARTIST_URI_PREFIX = "https://musicbrainz.org/artist/";
const RELEASE_URI_PREFIX = "https://musicbrainz.org/release/";

const PLAYLIST_EXTENSION = "https://musicbrainz.org/doc/jspf#playlist";

const trackSchema = v.looseObject({
  identifier: oneOrMany(v.string()),
  title: lenientText,
  creator: lenientText,
  album: lenientText,
  duration: lenientCount,
  extension: lenient(
    v.looseObject({
      [PLAYLIST_TRACK_EXTENSION]: lenient(
        v.looseObject({
          artist_identifiers: lenient(v.array(v.string())),
          release_identifier: lenientText,
        }),
      ),
    }),
  ),
});

const playlistSchema = v.looseObject({
  image: lenientText,
  identifier: lenientText,
  title: lenientText,
  date: lenientText,
  track: lenient(v.array(v.fallback(trackSchema, {}))),
  extension: lenient(
    v.looseObject({
      [PLAYLIST_EXTENSION]: lenient(
        v.looseObject({
          last_modified_at: lenientText,
          additional_metadata: lenient(
            v.looseObject({
              algorithm_metadata: lenient(v.looseObject({ source_patch: lenientText })),
            }),
          ),
        }),
      ),
    }),
  ),
});

export const listenbrainzPlaylistEntrySchema = v.fallback(
  v.looseObject({ ...playlistSchema.entries, playlist: lenient(playlistSchema) }),
  {},
);

export type ListenBrainzPlaylist = v.InferOutput<typeof playlistSchema>;

const getIdentifier = (value: string | string[] | undefined, prefix: string) => {
  const candidate = Array.isArray(value) ? value[0] : value;
  const text = String(candidate || "").trim();
  return text.startsWith(prefix) ? text.slice(prefix.length) : text || null;
};

export function parseListenBrainzPlaylist(payload: unknown) {
  const stats = { incomplete: 0, duplicate: 0 };
  const raw = [];
  const tracks = v.parse(listenbrainzPlaylistEntrySchema, payload).playlist?.track ?? [];

  for (const track of tracks) {
    const extension = track.extension?.[PLAYLIST_TRACK_EXTENSION] ?? {};
    const creator = String(track.creator || "").trim();
    const artistMbid = getIdentifier(extension.artist_identifiers, ARTIST_URI_PREFIX);
    const artistName = artistMbid ? (creator.split(";", 1)[0] ?? "").trim() : creator;
    const trackName = String(track.title || "").trim();
    if (!artistName || !trackName) {
      stats.incomplete += 1;
      continue;
    }
    raw.push({
      artistName,
      trackName,
      albumName: String(track.album || "").trim() || null,
      trackMbid: getIdentifier(track.identifier, TRACK_URI_PREFIX),
      artistMbid,
      releaseMbid: getIdentifier(extension.release_identifier, RELEASE_URI_PREFIX),
      durationMs: Number.isFinite(Number(track.duration)) ? Number(track.duration) : null,
    });
  }

  const normalized = dedupePlaylistTracks(raw);
  stats.duplicate = Math.max(0, raw.length - normalized.length);
  return { tracks: normalized, stats };
}
