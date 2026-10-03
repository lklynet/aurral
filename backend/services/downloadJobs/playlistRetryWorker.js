import createHonkerWorker from "../honkerWorkerFactory.js";
import { getPlaylistRetryQueue, withHonkerLock } from "../honkerDb.js";
import { downloadWorker } from "./downloadWorker.js";

const {
  start: startPlaylistRetryWorker,
  stop: stopPlaylistRetryWorker,
  isRunning: isPlaylistRetryWorkerRunning,
} = createHonkerWorker({
  name: "playlist-retry",
  getQueue: getPlaylistRetryQueue,
  idlePollS: 10,
  retryDelayS: 300,
  filterJob(job) {
    const playlistType = String(job.payload?.playlistType || "").trim();
    const scheduledJobId = playlistType
      ? downloadWorker.getScheduledRetryJobId(playlistType)
      : null;
    if (!playlistType || scheduledJobId !== job.id) {
      return false;
    }
    downloadWorker.markIncompleteRetryDequeued(playlistType, job.id);
    return true;
  },
  processJob: (payload) =>
    withHonkerLock(
      `playlist-mutation:${payload.playlistType}`,
      () => downloadWorker.retryIncompletePlaylist(payload.playlistType),
      {
        ttlSeconds: 180,
        waitTimeoutMs: 5 * 60 * 1000,
      },
    ),
  onJobError(_error, job) {
    const playlistType = String(job.payload?.playlistType || "").trim();
    if (job.attempts < 4) {
      downloadWorker.restoreScheduledRetryJobId(playlistType, job.id);
    }
  },
});

export {
  startPlaylistRetryWorker,
  stopPlaylistRetryWorker,
  isPlaylistRetryWorkerRunning,
};
