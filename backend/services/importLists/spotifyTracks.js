import { buildSharedTrackIdentity, dedupeSharedTracks } from "../weeklyFlow/weeklyFlowPlaylistConfig.js";

export function parseSpotifyPlaylistItems(items = []) {
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
    const track = item?.item ?? item?.track;
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
    });
    positions.push(position);
  }
  const tracks = dedupeSharedTracks(raw);
  stats.duplicate = Math.max(0, raw.length - tracks.length);
  const seen = new Set();
  for (const [index, track] of raw.entries()) {
    const identity = buildSharedTrackIdentity(track);
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
