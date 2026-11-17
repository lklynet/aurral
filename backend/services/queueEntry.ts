export type QueueEntry = { trackId: number } | { jobId: string };

export function entryForStreamPath(path: string): QueueEntry | null {
  const library = /^\/library\/stream\/[^/]+\/(\d+)$/.exec(path);
  if (library) return { trackId: Number(library[1]) };
  const playlist = /^\/playlists\/stream\/([^/]+)$/.exec(path);
  if (!playlist?.[1]) return null;
  try {
    return { jobId: decodeURIComponent(playlist[1]) };
  } catch {
    return null;
  }
}
