import { APP_NAME } from "../config/constants.ts";
import * as v from "valibot";
import { db, dbHelpers } from "../config/db-sqlite.ts";
import { listOf } from "../db/helpers/storedSchemas.ts";
import type { SubsonicPlayQueuesRow } from "../db/rows.ts";
import type { RequestUser } from "../middleware/requestUser.ts";
import { websocketService } from "./websocketService.ts";
import { getSong, queueEntryForSong, songIdForQueueEntry } from "./subsonicLibraryService.ts";

const readQueue = db.prepare<[number], SubsonicPlayQueuesRow>(
  "SELECT * FROM subsonic_play_queues WHERE user_id = ?",
);
const clearQueue = db.prepare<[number]>("DELETE FROM subsonic_play_queues WHERE user_id = ?");
const clearOwnQueue = db.prepare<[number, string]>(
  "DELETE FROM subsonic_play_queues WHERE user_id = ? AND changed_by = ?",
);
const writeQueue = db.prepare<[number, string, string | null, number | null, number, string]>(`
  INSERT INTO subsonic_play_queues
    (user_id, song_ids, current_song, position, changed_at, changed_by)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    song_ids = excluded.song_ids, current_song = excluded.current_song,
    position = excluded.position, changed_at = excluded.changed_at,
    changed_by = excluded.changed_by
`);

export function savePlayQueue(
  user: RequestUser,
  {
    ids,
    current,
    position,
    changedBy,
  }: { ids: string[]; current: string; position: number | null; changedBy: string },
) {
  if (!ids.length) {
    clearQueue.run(user.id);
    return;
  }
  const changedAt = Date.now();
  writeQueue.run(user.id, JSON.stringify(ids), current || null, position, changedAt, changedBy);
  websocketService.broadcast(
    "play-queue",
    { type: "play_queue_changed", changed: changedAt, changedBy },
    { userId: user.id },
  );
  return changedAt;
}

export function savePlayerQueue(
  user: RequestUser,
  {
    entries,
    current,
    positionMs,
    device,
  }: {
    entries: (Parameters<typeof songIdForQueueEntry>[1] | null)[];
    current: number;
    positionMs: number;
    device: string;
  },
) {
  const ids = entries.map((entry) => entry && songIdForQueueEntry(user, entry));
  const currentId = ids[current];
  if (!currentId) return null;
  return savePlayQueue(user, {
    ids: ids.filter((id) => id != null),
    current: currentId,
    position: positionMs,
    changedBy: device,
  });
}

export function clearPlayerQueue(user: RequestUser, device: string) {
  clearOwnQueue.run(user.id, device);
}

export function getPlayerQueue(user: RequestUser) {
  const saved = readQueue.get(user.id);
  if (!saved) return null;
  const ids = dbHelpers.readJSON(listOf(v.string()), saved.song_ids, "play queue") ?? [];
  return {
    changed: saved.changed_at,
    changedBy: saved.changed_by,
    entries: ids.map((id) => queueEntryForSong(user, id)),
    current: saved.current_song == null ? -1 : ids.indexOf(saved.current_song),
    positionMs: saved.position ?? 0,
  };
}

function readSubsonicQueue(user: RequestUser) {
  const saved = readQueue.get(user.id);
  const entry = (
    (saved && dbHelpers.readJSON(listOf(v.string()), saved.song_ids, "play queue")) ||
    []
  )
    .map((id) => getSong(id, user))
    .filter((song): song is NonNullable<typeof song> => Boolean(song));
  const currentIndex = entry.findIndex((song) => song.id === saved?.current_song);
  return {
    queue: {
      username: user.username,
      changed: new Date(saved?.changed_at ?? 0).toISOString(),
      changedBy: saved?.changed_by ?? APP_NAME,
      entry,
    },
    currentIndex,
    position: saved?.position ?? null,
  };
}

export function getPlayQueue(user: RequestUser) {
  const { queue, currentIndex, position } = readSubsonicQueue(user);
  const current = queue.entry[currentIndex];
  return {
    ...queue,
    ...(current ? { current: current.id, ...(position == null ? {} : { position }) } : {}),
  };
}

export function getPlayQueueByIndex(user: RequestUser) {
  const { queue, currentIndex, position } = readSubsonicQueue(user);
  return {
    ...queue,
    ...(currentIndex >= 0 ? { currentIndex, ...(position == null ? {} : { position }) } : {}),
  };
}
