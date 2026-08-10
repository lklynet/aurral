const REQUIRED_METHODS = [
  "testConnection",
  "ensureLibrary",
  "publishPlaylist",
  "deletePlaylist",
  "requestScan",
];

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
    const normalized = {
      path: requireText(track?.path, `tracks[${index}].path`),
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

export function playbackOperationSuccess() {
  return Object.freeze({ ok: true });
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
