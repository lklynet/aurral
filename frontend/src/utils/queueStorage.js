export const QUEUE_STORAGE_KEY = "aurral.player.queue.v1";

const VERSION = 1;
const MAX_STORED_TRACKS = 200;
const HISTORY_KEPT = 20;
const REPEAT_MODES = new Set(["off", "all", "one"]);

function splitQuery(value) {
  const at = value.indexOf("?");
  if (at < 0) return [value, null];
  return [value.slice(0, at), new URLSearchParams(value.slice(at + 1))];
}

function withoutToken(value) {
  const [path, params] = splitQuery(value);
  if (!params?.has("token")) return null;
  params.delete("token");
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function withToken(value, token) {
  if (!token) return value;
  const [path, params] = splitQuery(value);
  const query = params ?? new URLSearchParams();
  query.set("token", token);
  return `${path}?${query.toString()}`;
}

function storedTrack(track) {
  const { entryId: _entryId, ...rest } = track;
  const authFields = [];
  for (const [key, value] of Object.entries(rest)) {
    if (typeof value !== "string") continue;
    const stripped = withoutToken(value);
    if (stripped == null) continue;
    rest[key] = stripped;
    authFields.push(key);
  }
  return authFields.length > 0 ? { ...rest, authFields } : rest;
}

function restoredTrack(track, token) {
  const { authFields, ...rest } = track;
  for (const key of Array.isArray(authFields) ? authFields : []) {
    if (typeof rest[key] === "string") rest[key] = withToken(rest[key], token);
  }
  return rest;
}

export function serializeQueue(state, { owner, position = 0 }) {
  if (owner == null || state.currentIndex < 0 || state.queue.length === 0) return null;
  const start = Math.max(0, Math.min(state.currentIndex - HISTORY_KEPT, state.playbackOrder.length - MAX_STORED_TRACKS));
  const window = state.playbackOrder.slice(start, start + MAX_STORED_TRACKS);
  const kept = new Set(window);
  const keptQueueIndices = state.queue.map((_, index) => index).filter((index) => kept.has(index));
  const storedIndexOf = new Map(keptQueueIndices.map((queueIndex, index) => [queueIndex, index]));
  return JSON.stringify({
    version: VERSION,
    owner: String(owner),
    tracks: keptQueueIndices.map((queueIndex) => storedTrack(state.queue[queueIndex])),
    playbackOrder: window.map((queueIndex) => storedIndexOf.get(queueIndex)),
    currentIndex: state.currentIndex - start,
    isShuffleEnabled: state.isShuffleEnabled,
    repeatMode: state.repeatMode,
    source: state.source ?? null,
    position: Number.isFinite(position) && position > 0 ? position : 0,
  });
}

function isPermutation(order, length) {
  if (!Array.isArray(order) || order.length !== length) return false;
  const seen = new Set(order);
  return seen.size === length && order.every((value) => Number.isInteger(value) && value >= 0 && value < length);
}

export function parseStoredQueue(raw, { owner, token }) {
  if (!raw || owner == null) return null;
  let stored;
  try {
    stored = JSON.parse(raw);
  } catch {
    return null;
  }
  if (stored?.version !== VERSION || stored.owner !== String(owner)) return null;
  const { tracks, playbackOrder, currentIndex } = stored;
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  if (!tracks.every((track) => track && typeof track === "object" && typeof track.src === "string" && track.src)) {
    return null;
  }
  if (!isPermutation(playbackOrder, tracks.length)) return null;
  if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= tracks.length) return null;
  return {
    queue: tracks.map((track) => restoredTrack(track, token)),
    playbackOrder,
    currentIndex,
    isShuffleEnabled: stored.isShuffleEnabled === true,
    repeatMode: REPEAT_MODES.has(stored.repeatMode) ? stored.repeatMode : "off",
    source: stored.source && typeof stored.source === "object" ? stored.source : null,
    position: Number.isFinite(stored.position) && stored.position > 0 ? stored.position : 0,
  };
}
