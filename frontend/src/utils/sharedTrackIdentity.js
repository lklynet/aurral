export function normalizeTrackForSharedIdentity(track) {
  if (!track || typeof track !== "object" || Array.isArray(track)) {
    return null;
  }
  const artistName = String(
    track.artistName ??
      track.artist ??
      track.artist_name ??
      track["Artist Name(s)"] ??
      "",
  ).trim();
  const trackName = String(
    track.trackName ??
      track.title ??
      track.name ??
      track.track ??
      track["Track Name"] ??
      "",
  ).trim();
  if (!artistName || !trackName) return null;
  const albumName = String(
    track.albumName ?? track.album ?? track["Album Name"] ?? "",
  ).trim();
  const artistMbid = String(
    track.artistMbid ?? track.artistId ?? track.mbid ?? "",
  ).trim();
  const albumMbid = String(
    track.albumMbid ?? track.releaseGroupMbid ?? track.albumId ?? "",
  ).trim();
  const trackMbid = String(
    track.trackMbid ?? track.recordingMbid ?? track.recordingId ?? "",
  ).trim();
  const releaseYear = String(track.releaseYear ?? track.year ?? "").trim();
  return {
    artistName,
    trackName,
    albumName,
    artistMbid,
    albumMbid,
    trackMbid,
    releaseYear,
  };
}

export function buildSharedTrackIdentity(track) {
  const normalized = normalizeTrackForSharedIdentity(track);
  if (!normalized) return "";
  return [
    normalized.artistName.toLocaleLowerCase(),
    normalized.trackName.toLocaleLowerCase(),
    normalized.albumName.toLocaleLowerCase(),
    normalized.artistMbid,
    normalized.albumMbid,
    normalized.trackMbid,
    normalized.releaseYear,
  ].join("\u0001");
}

function buildCoreTrackIdentity(track) {
  const normalized = normalizeTrackForSharedIdentity(track);
  if (!normalized) return "";
  return `${normalized.artistName.toLocaleLowerCase()}\u0001${normalized.trackName.toLocaleLowerCase()}`;
}

function coreIdentityFromStoredIdentity(identity) {
  const parts = String(identity || "").split("\u0001");
  if (parts.length < 2) return "";
  return `${parts[0]}\u0001${parts[1]}`;
}

export function trackMatchesStoredIdentity(storedIdentity, track) {
  const normalized = normalizeTrackForSharedIdentity(track);
  if (!normalized) return false;
  const targetFull = buildSharedTrackIdentity(track);
  if (targetFull && storedIdentity === targetFull) return true;
  const targetCore = buildCoreTrackIdentity(track);
  if (!targetCore) return false;
  return coreIdentityFromStoredIdentity(storedIdentity) === targetCore;
}

export function playlistContainsTrack(playlist, track) {
  if (!track) return false;
  const identities = Array.isArray(playlist?.trackIdentities)
    ? playlist.trackIdentities
    : [];
  if (identities.length === 0) return false;
  return identities.some((identity) => trackMatchesStoredIdentity(identity, track));
}
