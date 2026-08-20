import { dedupeSharedTracks } from "../weeklyFlow/weeklyFlowPlaylistConfig.js";

const getArtistName = (track) =>
  String(track?.artists?.[0]?.name || track?.artists?.[0]?._name || track?.artist?.name || track?.artist?._name || "").trim();

const getAlbumName = (track) => {
  const album = track?.primary_album ?? track?.album;
  return String(album?.name || album?._name || album || "").trim() || null;
};

export function parseLastfmStation(payload) {
  const stats = { incomplete: 0, duplicate: 0 };
  const raw = [];
  const tracks = Array.isArray(payload?.playlist) ? payload.playlist : [];

  for (const track of tracks) {
    const artistName = getArtistName(track);
    const trackName = String(track?.name || track?._name || "").trim();
    if (!artistName || !trackName) {
      stats.incomplete += 1;
      continue;
    }
    const duration = Number(track?.duration);
    raw.push({
      artistName,
      trackName,
      albumName: getAlbumName(track),
      trackMbid: String(track?.mbid || "").trim() || null,
      artistMbid: String(track?.artist?.mbid || track?.artists?.[0]?.mbid || "").trim() || null,
      albumMbid: String(track?.primary_album?.mbid || track?.album?.mbid || "").trim() || null,
      durationMs: Number.isFinite(duration) && duration >= 0 ? Math.round(duration * 1000) : null,
    });
  }

  const normalized = dedupeSharedTracks(raw);
  stats.duplicate = Math.max(0, raw.length - normalized.length);
  return { tracks: normalized, stats };
}
