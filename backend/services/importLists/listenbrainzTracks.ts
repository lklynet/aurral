import { dedupePlaylistTracks } from "../playlists/playlistTracks.ts";

const PLAYLIST_TRACK_EXTENSION = "https://musicbrainz.org/doc/jspf#track";
const TRACK_URI_PREFIX = "https://musicbrainz.org/recording/";
const ARTIST_URI_PREFIX = "https://musicbrainz.org/artist/";
const RELEASE_URI_PREFIX = "https://musicbrainz.org/release/";

interface ListenBrainzTrackExtension {
  artist_identifiers?: string[];
  release_identifier?: string;
}

interface ListenBrainzPlaylistTrack {
  identifier?: string | string[];
  title?: string;
  creator?: string;
  album?: string;
  duration?: number;
  extension?: { [PLAYLIST_TRACK_EXTENSION]?: ListenBrainzTrackExtension };
}

interface ListenBrainzPlaylistPayload {
  playlist?: { track?: ListenBrainzPlaylistTrack[] };
}

const getExtension = (track: ListenBrainzPlaylistTrack) =>
  track?.extension?.[PLAYLIST_TRACK_EXTENSION] || {};

const getIdentifier = (value: string | string[] | undefined, prefix: string) => {
  const candidate = Array.isArray(value) ? value[0] : value;
  const text = String(candidate || "").trim();
  return text.startsWith(prefix) ? text.slice(prefix.length) : text || null;
};

export function parseListenBrainzPlaylist(payload: ListenBrainzPlaylistPayload) {
  const stats = { incomplete: 0, duplicate: 0 };
  const raw = [];
  const tracks = Array.isArray(payload?.playlist?.track) ? payload.playlist.track : [];

  for (const track of tracks) {
    const extension = getExtension(track);
    const creator = String(track?.creator || "").trim();
    const artistMbid = getIdentifier(extension.artist_identifiers, ARTIST_URI_PREFIX);
    const artistName = artistMbid ? creator.split(";", 1)[0].trim() : creator;
    const trackName = String(track?.title || "").trim();
    if (!artistName || !trackName) {
      stats.incomplete += 1;
      continue;
    }
    raw.push({
      artistName,
      trackName,
      albumName: String(track?.album || "").trim() || null,
      trackMbid: getIdentifier(track?.identifier, TRACK_URI_PREFIX),
      artistMbid,
      releaseMbid: getIdentifier(extension.release_identifier, RELEASE_URI_PREFIX),
      durationMs: Number.isFinite(Number(track?.duration)) ? Number(track.duration) : null,
    });
  }

  const normalized = dedupePlaylistTracks(raw);
  stats.duplicate = Math.max(0, raw.length - normalized.length);
  return { tracks: normalized, stats };
}
