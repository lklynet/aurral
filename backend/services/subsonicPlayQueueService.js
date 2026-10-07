import { APP_NAME } from "../config/constants.js";
import { db } from "../config/db-sqlite.js";
import { getSong } from "./subsonicLibraryService.js";

const readQueue = db.prepare("SELECT * FROM subsonic_play_queues WHERE user_id = ?");
const clearQueue = db.prepare("DELETE FROM subsonic_play_queues WHERE user_id = ?");
const writeQueue = db.prepare(`
  INSERT INTO subsonic_play_queues
    (user_id, song_ids, current_song, position, changed_at, changed_by)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    song_ids = excluded.song_ids, current_song = excluded.current_song,
    position = excluded.position, changed_at = excluded.changed_at,
    changed_by = excluded.changed_by
`);

export function savePlayQueue(user, { ids, current, position, changedBy }) {
  if (!ids.length) {
    clearQueue.run(user.id);
    return;
  }
  writeQueue.run(user.id, JSON.stringify(ids), current || null, position, Date.now(), changedBy);
}

export function getPlayQueue(user) {
  const saved = readQueue.get(user.id);
  if (!saved) return {
    username: user.username,
    changed: new Date(0).toISOString(),
    changedBy: APP_NAME,
    entry: [],
  };
  const entry = JSON.parse(saved.song_ids).map((id) => getSong(id, user)).filter(Boolean);
  const hasCurrent = entry.some((song) => song.id === saved.current_song);
  return {
    username: user.username,
    changed: new Date(saved.changed_at).toISOString(),
    changedBy: saved.changed_by,
    ...(hasCurrent ? {
      current: saved.current_song,
      ...(saved.position == null ? {} : { position: saved.position }),
    } : {}),
    entry,
  };
}
