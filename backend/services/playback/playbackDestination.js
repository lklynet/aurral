import path from "node:path";

const REQUIRED_METHODS = [
  "testConnection",
  "ensureLibrary",
  "publishPlaylist",
  "deletePlaylist",
  "deleteEntityPlaylists",
  "getPointerEntityIds",
  "requestScan",
];

const REJECTED_HTTP_STATUSES = new Set([400, 401, 403]);
const REJECTED_SUBSONIC_CODES = new Set([10, 40, 41, 50]);

const requireText = (value, field) => {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
};

const optionalText = (value, field) => {
  if (value == null) return null;
  return requireText(value, field);
};

const normalizeOwnerUserId = (value) => {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("ownerUserId must be a positive integer or null");
  }
  return value;
};

export function createPlaybackPlaylistIdentity({ entityId, ownerUserId = null } = {}) {
  return Object.freeze({
    entityId: requireText(entityId, "entityId"),
    ownerUserId: normalizeOwnerUserId(ownerUserId),
  });
}

export function createPlaybackPlaylistSnapshot({
  entityId,
  ownerUserId = null,
  displayName,
  description = null,
  tracks,
} = {}) {
  if (!Array.isArray(tracks)) {
    throw new TypeError("tracks must be an array");
  }
  const identity = createPlaybackPlaylistIdentity({ entityId, ownerUserId });
  const normalizedTracks = tracks.map((track, index) => {
    const trackPath = track?.path;
    requireText(trackPath, `tracks[${index}].path`);
    const normalized = {
      path: trackPath,
      title: requireText(track?.title, `tracks[${index}].title`),
      artist: requireText(track?.artist, `tracks[${index}].artist`),
    };
    const album = optionalText(track?.album, `tracks[${index}].album`);
    const mbid = optionalText(track?.mbid, `tracks[${index}].mbid`);
    if (album) normalized.album = album;
    if (mbid) normalized.mbid = mbid;
    if (track?.durationMs != null) {
      if (!Number.isFinite(track.durationMs) || track.durationMs < 0) {
        throw new TypeError(`tracks[${index}].durationMs must be a non-negative number`);
      }
      normalized.durationMs = track.durationMs;
    }
    return Object.freeze(normalized);
  });
  const normalizedDescription = optionalText(description, "description");
  return Object.freeze({
    ...identity,
    displayName: requireText(displayName, "displayName"),
    ...(normalizedDescription ? { description: normalizedDescription } : {}),
    tracks: Object.freeze(normalizedTracks),
  });
}

function requireAbsolutePaths(values, label) {
  if (!Array.isArray(values)) {
    throw new TypeError(`${label} must be an array`);
  }
  return Object.freeze(values.map((value, index) => {
    const text = requireText(value, `${label}[${index}]`);
    if (!path.isAbsolute(text)) throw new TypeError(`${label}[${index}] must be an absolute path`);
    return path.resolve(text);
  }));
}

export function createPlaybackScanRequest({ folders, roots } = {}) {
  return Object.freeze({
    folders: requireAbsolutePaths(folders, "folders"),
    roots: requireAbsolutePaths(roots, "roots"),
  });
}

export function playbackOperationSuccess({ pending = false } = {}) {
  return Object.freeze(pending ? { ok: true, pending: true } : { ok: true });
}

export function isRetryablePlaybackError(error) {
  return !REJECTED_HTTP_STATUSES.has(Number(error?.response?.status))
    && !REJECTED_SUBSONIC_CODES.has(Number(error?.code));
}

export function playbackScanDeferred() {
  return Object.freeze({ ok: true, deferred: true });
}

export function playbackOperationFailure({ code, message, retryable = false } = {}) {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code: requireText(code, "code"),
      message: requireText(message, "message"),
      retryable: retryable === true,
    }),
  });
}

export function assertPlaybackDestination(destination) {
  if (!destination || (typeof destination !== "object" && typeof destination !== "function")) {
    throw new TypeError("PlaybackDestination must be an object");
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof destination[method] !== "function") {
      throw new TypeError(`PlaybackDestination.${method} must be a function`);
    }
  }
  return destination;
}
