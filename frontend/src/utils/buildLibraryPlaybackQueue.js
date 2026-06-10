import { getLibraryPlaybackQueue } from "./api";
import { normalizeQueueTrack } from "./audioQueue";

export async function buildLibraryPlaybackQueue({ onProgress } = {}) {
  onProgress?.({ processed: 0, total: 1, queueLength: 0 });
  const tracks = await getLibraryPlaybackQueue();
  const queue = [];
  const seen = new Set();

  for (const track of tracks) {
    if (!track?.preview_url) continue;
    const id = track.id;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(
      normalizeQueueTrack({
        id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        src: track.preview_url,
        streamFormat: track.streamFormat,
        quality: track.quality,
      }),
    );
  }

  onProgress?.({ processed: 1, total: 1, queueLength: queue.length });
  return queue;
}
