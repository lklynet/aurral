export const QUEUE_STORAGE_KEY = "aurral.player.queue.v1";

const VERSION = 1;
const MAX_STORED_TRACKS = 200;
const HISTORY_KEPT = 20;
const REPEAT_MODES = new Set(["off", "all", "one"]);

type QueueTrack = { entryId?: unknown } & Record<string, unknown>;

interface QueueSnapshot {
  queue: QueueTrack[];
  playbackOrder: number[];
  currentIndex: number;
  isShuffleEnabled: boolean;
  repeatMode: string;
  source?: unknown;
}

interface StoredQueue {
  version?: unknown;
  owner?: unknown;
  tracks?: unknown;
  playbackOrder?: unknown;
  currentIndex?: unknown;
  isShuffleEnabled?: unknown;
  repeatMode?: unknown;
  source?: unknown;
  position?: unknown;
}

function splitQuery(value: string): [string, URLSearchParams | null] {
  const at = value.indexOf("?");
  if (at < 0) return [value, null];
  return [value.slice(0, at), new URLSearchParams(value.slice(at + 1))];
}

function withoutToken(value: string) {
  const [path, params] = splitQuery(value);
  if (!params?.has("token")) return null;
  params.delete("token");
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function withToken(value: string, token: string | null | undefined) {
  if (!token) return value;
  const [path, params] = splitQuery(value);
  const query = params ?? new URLSearchParams();
  query.set("token", token);
  return `${path}?${query.toString()}`;
}

function storedTrack(track: QueueTrack) {
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

function restoredTrack(track: Record<string, unknown>, token: string | null | undefined) {
  const { authFields, ...rest } = track;
  for (const key of Array.isArray(authFields) ? authFields : []) {
    if (typeof rest[key] === "string") rest[key] = withToken(rest[key], token);
  }
  return rest;
}

export function serializeQueue(
  state: QueueSnapshot,
  { owner, position = 0 }: { owner: string | null; position?: number },
) {
  if (owner == null || state.currentIndex < 0 || state.queue.length === 0) return null;
  const start = Math.max(
    0,
    Math.min(state.currentIndex - HISTORY_KEPT, state.playbackOrder.length - MAX_STORED_TRACKS),
  );
  const window = state.playbackOrder.slice(start, start + MAX_STORED_TRACKS);
  const kept = new Set(window);
  const keptQueueIndices = state.queue.map((_, index) => index).filter((index) => kept.has(index));
  const storedIndexOf = new Map<number, number>(
    keptQueueIndices.map((queueIndex, index): [number, number] => [queueIndex, index]),
  );
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

function isPermutation(order: unknown, length: number): order is number[] {
  if (!Array.isArray(order) || order.length !== length) return false;
  const seen = new Set(order);
  return (
    seen.size === length &&
    order.every((value) => Number.isInteger(value) && value >= 0 && value < length)
  );
}

export function parseStoredQueue(
  raw: string | null,
  { owner, token }: { owner: string | null; token: string | null | undefined },
) {
  if (!raw || owner == null) return null;
  let stored: StoredQueue;
  try {
    stored = JSON.parse(raw);
  } catch {
    return null;
  }
  if (stored?.version !== VERSION || stored.owner !== String(owner)) return null;
  const { tracks, playbackOrder, currentIndex } = stored;
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  if (
    !tracks.every(
      (track) => track && typeof track === "object" && typeof track.src === "string" && track.src,
    )
  ) {
    return null;
  }
  if (!isPermutation(playbackOrder, tracks.length)) return null;
  if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= tracks.length)
    return null;
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
