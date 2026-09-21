import { dedupeSharedTracks } from "../weeklyFlow/weeklyFlowPlaylistConfig.js";

export function parseSpotifyPlaylistItems(items = []) {
  const stats = {
    unavailable: 0,
    podcast: 0,
    incomplete: 0,
    duplicate: 0,
  };
  const raw = [];
  for (const item of items) {
    const track = item?.item ?? item?.track;
    if (!track) {
      stats.unavailable += 1;
      continue;
    }
    if (track.type && track.type !== "track") {
      stats.podcast += 1;
      continue;
    }
    const trackName = String(track?.name || "").trim();
    const artistName = String(track?.artists?.[0]?.name || "").trim();
    const albumName = String(track?.album?.name || "").trim();
    if (!trackName || !artistName) {
      stats.incomplete += 1;
      continue;
    }
    raw.push({
      artistName,
      trackName,
      albumName: albumName || null,
    });
  }
  const tracks = dedupeSharedTracks(raw);
  stats.duplicate = Math.max(0, raw.length - tracks.length);
  return { tracks, stats };
}
