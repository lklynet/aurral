interface ImportedTrack {
  artistName?: unknown;
  artist?: unknown;
  artist_name?: unknown;
  trackName?: unknown;
  title?: unknown;
  name?: unknown;
  track?: unknown;
  albumName?: unknown;
  album?: unknown;
  artistMbid?: unknown;
  artistId?: unknown;
  albumMbid?: unknown;
  releaseGroupMbid?: unknown;
  albumId?: unknown;
  trackMbid?: unknown;
  recordingMbid?: unknown;
  recordingId?: unknown;
  mbid?: unknown;
  releaseYear?: unknown;
  year?: unknown;
  durationMs?: unknown;
  artistAliases?: unknown;
  reason?: unknown;
  releaseMbid?: unknown;
  trackNumber?: unknown;
  discNumber?: unknown;
}

type ImportedValue = ImportedTrack | string | number | boolean | unknown[] | null | undefined;

export const normalizeNameKey = (value: string | null | undefined) =>
  String(value || "")
    .trim()
    .toLowerCase();

export const reserveUniqueName = (
  reservedNames: Set<string>,
  baseName: string | null | undefined,
) => {
  const normalizedBase = String(baseName || "").trim() || "Flow";
  const baseKey = normalizeNameKey(normalizedBase);
  if (!reservedNames.has(baseKey)) {
    reservedNames.add(baseKey);
    return normalizedBase;
  }
  let index = 2;
  while (index < 10000) {
    const candidate = `${normalizedBase} ${index}`;
    const key = normalizeNameKey(candidate);
    if (!reservedNames.has(key)) {
      reservedNames.add(key);
      return candidate;
    }
    index += 1;
  }
  const fallback = `${normalizedBase} ${Date.now()}`;
  reservedNames.add(normalizeNameKey(fallback));
  return fallback;
};

export const reserveUniquePlaylistName = (
  playlists: readonly { name?: string | null }[] | null | undefined,
  baseName = "Playlist",
) =>
  reserveUniqueName(
    new Set((playlists ?? []).map((playlist) => normalizeNameKey(playlist?.name)).filter(Boolean)),
    String(baseName || "").trim() || "Playlist",
  );

const normalizeDurationMs = (value: unknown) => {
  const numeric = Number(value);
  return value != null && Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : null;
};

const normalizeArtistAliases = (aliases: unknown) =>
  Array.isArray(aliases) ? aliases.map((entry) => String(entry || "").trim()).filter(Boolean) : [];

const positiveInteger = (value: unknown) =>
  Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;

const albumPlacement = (track: ImportedTrack | null | undefined) => ({
  releaseMbid: String(track?.releaseMbid || "").trim() || null,
  trackNumber: positiveInteger(track?.trackNumber),
  discNumber: positiveInteger(track?.discNumber),
});

export const normalizePlaylistTrackEntry = (track: ImportedValue) => {
  if (!track || typeof track !== "object" || Array.isArray(track)) return null;
  const artistName = String(track.artistName ?? track.artist ?? track.artist_name ?? "").trim();
  const trackName = String(
    track.trackName ?? track.title ?? track.name ?? track.track ?? "",
  ).trim();
  if (!artistName || !trackName) return null;
  const albumName = String(track.albumName ?? track.album ?? "").trim();
  const artistMbid = String(track.artistMbid ?? track.artistId ?? "").trim();
  const albumMbid = String(track.albumMbid ?? track.releaseGroupMbid ?? track.albumId ?? "").trim();
  const trackMbid = String(
    track.trackMbid ?? track.recordingMbid ?? track.recordingId ?? track.mbid ?? "",
  ).trim();
  const releaseYear = String(track.releaseYear ?? track.year ?? "").trim();
  return {
    artistName,
    trackName,
    albumName: albumName || null,
    artistMbid: artistMbid || null,
    albumMbid: albumMbid || null,
    trackMbid: trackMbid || null,
    releaseYear: releaseYear || null,
    durationMs: normalizeDurationMs(track.durationMs),
    artistAliases: normalizeArtistAliases(track.artistAliases),
    reason: track.reason ? String(track.reason).trim() : null,
    ...albumPlacement(track),
  };
};

const normalizeTrackDurationMs = (value: unknown) =>
  value != null && Number.isFinite(Number(value)) ? Number(value) : null;

interface StaticPlaylistTrackInput {
  artistName?: string;
  trackName?: string;
  albumName?: string;
  artistMbid?: string;
  albumMbid?: string;
  releaseMbid?: string | null;
  trackMbid?: string;
  releaseYear?: string | null;
  durationMs?: number | null;
  trackNumber?: number | null;
  discNumber?: number | null;
  reason?: string | null;
}

export const buildStaticPlaylistTrackPayload = ({
  artistName = "",
  trackName = "",
  albumName = "",
  artistMbid = "",
  albumMbid = "",
  releaseMbid = null,
  trackMbid = "",
  releaseYear = null,
  durationMs = null,
  trackNumber = null,
  discNumber = null,
  reason = null,
}: StaticPlaylistTrackInput = {}) => ({
  artistName,
  trackName,
  albumName,
  artistMbid,
  albumMbid,
  releaseMbid: releaseMbid || null,
  trackMbid,
  releaseYear: releaseYear || null,
  durationMs: normalizeTrackDurationMs(durationMs),
  trackNumber: trackNumber || null,
  discNumber: discNumber || null,
  reason,
  artistAliases: [],
});
