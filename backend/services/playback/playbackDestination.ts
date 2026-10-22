import path from "node:path";
import { asAppError } from "../../../lib/errors.ts";

const REQUIRED_METHODS = [
  "testConnection",
  "ensureLibrary",
  "publishPlaylist",
  "deletePlaylist",
  "deleteEntityPlaylists",
  "getPointerEntityIds",
  "requestScan",
] as const;

type PlaybackOperation = (typeof REQUIRED_METHODS)[number] | "getReferencedPaths";

export type PlaybackResultOperation = Exclude<PlaybackOperation, "getPointerEntityIds">;

export type PlaybackOperationResult = {
  ok: boolean;
  pending?: boolean;
  deferred?: boolean;
  paths?: string[];
  error?: { code: string; message: string; retryable: boolean };
};

export type PlaybackDestination = {
  key: string;
  name: string;
  isConfigured(): boolean;
  updateConfig(config: unknown): void;
  getPointerEntityIds(): unknown;
} & Record<
  PlaybackResultOperation,
  (...args: unknown[]) => PlaybackOperationResult | Promise<PlaybackOperationResult>
>;

const REJECTED_HTTP_STATUSES = new Set([400, 401, 403]);
const REJECTED_SUBSONIC_CODES = new Set([10, 40, 41, 50]);

const requireText = (value: unknown, field: string) => {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
};

const optionalText = (value: unknown, field: string) => {
  if (value == null) return null;
  return requireText(value, field);
};

const normalizeOwnerUserId = (value: number | null) => {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("ownerUserId must be a positive integer or null");
  }
  return value;
};

export function createPlaybackPlaylistIdentity({
  entityId,
  ownerUserId = null,
}: { entityId?: unknown; ownerUserId?: number | null } = {}) {
  return Object.freeze({
    entityId: requireText(entityId, "entityId"),
    ownerUserId: normalizeOwnerUserId(ownerUserId),
  });
}

type PlaybackTrack = {
  path: string;
  title: string;
  artist: string;
  album?: string;
  mbid?: string;
  durationMs?: number;
};

export function createPlaybackPlaylistSnapshot({
  entityId,
  ownerUserId = null,
  displayName,
  description = null,
  tracks,
}: {
  entityId?: unknown;
  ownerUserId?: number | null;
  displayName?: unknown;
  description?: unknown;
  tracks?: unknown;
} = {}) {
  if (!Array.isArray(tracks)) {
    throw new TypeError("tracks must be an array");
  }
  const identity = createPlaybackPlaylistIdentity({ entityId, ownerUserId });
  const normalizedTracks = tracks.map((track, index) => {
    const trackPath = track?.path;
    requireText(trackPath, `tracks[${index}].path`);
    const normalized: PlaybackTrack = {
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

function requireAbsolutePaths(values: unknown, label: string) {
  if (!Array.isArray(values)) {
    throw new TypeError(`${label} must be an array`);
  }
  return Object.freeze(
    values.map((value, index) => {
      const text = requireText(value, `${label}[${index}]`);
      if (!path.isAbsolute(text))
        throw new TypeError(`${label}[${index}] must be an absolute path`);
      return path.resolve(text);
    }),
  );
}

export function createPlaybackScanRequest({
  folders,
  roots,
}: { folders?: unknown; roots?: unknown } = {}) {
  return Object.freeze({
    folders: requireAbsolutePaths(folders, "folders"),
    roots: requireAbsolutePaths(roots, "roots"),
  });
}

export function playbackOperationSuccess({ pending = false }: { pending?: boolean } = {}) {
  return Object.freeze(pending ? { ok: true, pending: true } : { ok: true });
}

export function isRetryablePlaybackError(error: unknown) {
  const failure = asAppError(error);
  return (
    !REJECTED_HTTP_STATUSES.has(Number(failure?.response?.status)) &&
    !REJECTED_SUBSONIC_CODES.has(Number(failure?.code))
  );
}

export function playbackScanDeferred() {
  return Object.freeze({ ok: true, deferred: true });
}

export function playbackOperationFailure({
  code,
  message,
  retryable = false,
}: { code?: unknown; message?: unknown; retryable?: unknown } = {}) {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code: requireText(code, "code"),
      message: requireText(message, "message"),
      retryable: retryable === true,
    }),
  });
}

export function assertPlaybackDestination<T extends Partial<Record<PlaybackOperation, unknown>>>(
  destination: T,
): T {
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
