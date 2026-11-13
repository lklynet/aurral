import { apiPathOf } from "./api/core.ts";
import type { QueueAction, QueueSource, RepeatMode } from "./audioQueue.ts";
import { isRecord } from "../../../lib/isRecord.ts";
import { unknownList } from "../../../lib/unknownList.ts";

export const QUEUE_STORAGE_KEY = "aurral.player.queue.v1";

const VERSION = 1;
const MAX_STORED_TRACKS = 200;
const HISTORY_KEPT = 20;
const REPEAT_MODES = new Set<unknown>(["off", "all", "one"]);

type RestoreQueueAction = Extract<QueueAction, { type: "RESTORE_QUEUE" }>;

const isRepeatMode = (value: unknown): value is RepeatMode => REPEAT_MODES.has(value);

type QueueTrack = { entryId?: unknown } & Record<string, unknown>;

interface QueueSnapshot {
  queue: QueueTrack[];
  playbackOrder: number[];
  currentIndex: number;
  isShuffleEnabled: boolean;
  repeatMode: string;
  source?: unknown;
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
  if (typeof rest.src === "string") {
    rest.src = rest.src.replace("/library/canonical-stream/", "/library/stream/");
  }
  for (const key of unknownList(authFields)) {
    if (typeof key !== "string") continue;
    const value = rest[key];
    if (typeof value === "string") rest[key] = withToken(value, token);
  }
  return rest;
}

const positionOrZero = (position: number) =>
  Number.isFinite(position) && position > 0 ? position : 0;

function storedWindow(state: Pick<QueueSnapshot, "currentIndex" | "playbackOrder">) {
  const start = Math.max(
    0,
    Math.min(state.currentIndex - HISTORY_KEPT, state.playbackOrder.length - MAX_STORED_TRACKS),
  );
  return { start, window: state.playbackOrder.slice(start, start + MAX_STORED_TRACKS) };
}

export function remoteQueueFor(
  state: Pick<QueueSnapshot, "currentIndex" | "playbackOrder"> & {
    queue: { src?: string | null }[];
  },
  position: number,
) {
  if (state.currentIndex < 0) return null;
  const { start, window } = storedWindow(state);
  const paths = window.map((queueIndex) => apiPathOf(state.queue[queueIndex]?.src ?? ""));
  const current = state.currentIndex - start;
  if (!paths[current]) return null;
  return {
    streamPaths: paths.filter((path) => path != null),
    current: paths.slice(0, current).filter((path) => path != null).length,
    positionMs: Math.round(positionOrZero(position) * 1000),
  };
}

export function serializeQueue(
  state: QueueSnapshot,
  { owner, position = 0 }: { owner: string | null; position?: number },
) {
  if (owner == null || state.currentIndex < 0 || state.queue.length === 0) return null;
  const { start, window } = storedWindow(state);
  const kept = new Set(window);
  const keptQueue = [...state.queue.entries()].filter(([index]) => kept.has(index));
  const storedIndexOf = new Map<number, number>(
    keptQueue.map(([queueIndex], index): [number, number] => [queueIndex, index]),
  );
  return JSON.stringify({
    version: VERSION,
    owner: String(owner),
    tracks: keptQueue.map(([, track]) => storedTrack(track)),
    playbackOrder: window.map((queueIndex) => storedIndexOf.get(queueIndex)),
    currentIndex: state.currentIndex - start,
    isShuffleEnabled: state.isShuffleEnabled,
    repeatMode: state.repeatMode,
    source: state.source ?? null,
    position: positionOrZero(position),
  });
}

const isStoredTrack = (track: unknown): track is Record<string, unknown> & { src: string } =>
  isRecord(track) && typeof track.src === "string" && track.src !== "";

const isQueueSource = (source: unknown): source is QueueSource =>
  isRecord(source) &&
  typeof source.type === "string" &&
  (typeof source.id === "string" || typeof source.id === "number");

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
  { owner, token }: { owner: string | null; token?: string | null },
): (Omit<RestoreQueueAction, "type"> & { position: number }) | null {
  if (!raw || owner == null) return null;
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(stored) || stored.version !== VERSION || stored.owner !== String(owner))
    return null;
  const { playbackOrder, currentIndex } = stored;
  const tracks = unknownList(stored.tracks);
  if (tracks.length === 0 || !tracks.every(isStoredTrack)) return null;
  if (!isPermutation(playbackOrder, tracks.length)) return null;
  if (
    typeof currentIndex !== "number" ||
    !Number.isInteger(currentIndex) ||
    currentIndex < 0 ||
    currentIndex >= tracks.length
  )
    return null;
  return {
    queue: tracks.map((track) => restoredTrack(track, token)) as RestoreQueueAction["queue"],
    playbackOrder,
    currentIndex,
    isShuffleEnabled: stored.isShuffleEnabled === true,
    repeatMode: isRepeatMode(stored.repeatMode) ? stored.repeatMode : "off",
    source: isQueueSource(stored.source) ? stored.source : null,
    position: typeof stored.position === "number" ? positionOrZero(stored.position) : 0,
  };
}
