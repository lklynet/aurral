import { dedupeSharedTracks } from "../weeklyFlow/weeklyFlowPlaylistConfig.js";

const PLAYLIST_TRACK_EXTENSION = "https://musicbrainz.org/doc/jspf#track";
const TRACK_URI_PREFIX = "https://musicbrainz.org/recording/";
const ARTIST_URI_PREFIX = "https://musicbrainz.org/artist/";
const RELEASE_URI_PREFIX = "https://musicbrainz.org/release/";

const getExtension = (track) => track?.extension?.[PLAYLIST_TRACK_EXTENSION] || {};

const getIdentifier = (value, prefix) => {
  const candidate = Array.isArray(value) ? value[0] : value;
  const text = String(candidate || "").trim();
  return text.startsWith(prefix) ? text.slice(prefix.length) : text || null;
};

export function parseListenBrainzPlaylist(payload) {
  const stats = { incomplete: 0, duplicate: 0 };
  const raw = [];
  const tracks = Array.isArray(payload?.playlist?.track) ? payload.playlist.track : [];

  for (const track of tracks) {
    const extension = getExtension(track);
    const artistName = String(track?.creator || "").trim();
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
      artistMbid: getIdentifier(extension.artist_identifiers, ARTIST_URI_PREFIX),
      albumMbid: getIdentifier(extension.release_identifier, RELEASE_URI_PREFIX),
      durationMs: Number.isFinite(Number(track?.duration)) ? Number(track.duration) : null,
    });
  }

  const normalized = dedupeSharedTracks(raw);
  stats.duplicate = Math.max(0, raw.length - normalized.length);
  return { tracks: normalized, stats };
}
