import createHonkerWorker from "../honkerWorkerFactory.js";
import { getPlaylistReserveBuildQueue } from "../honkerDb.js";
import { downloadWorker } from "../downloadJobs/downloadWorker.js";

const {
  start: startFlowReserveBuildWorker,
  stop: stopFlowReserveBuildWorker,
  isRunning: isFlowReserveBuildWorkerRunning,
} = createHonkerWorker({
  name: "playlist-reserve-build",
  getQueue: getPlaylistReserveBuildQueue,
  processJob: (payload) => downloadWorker.runQueuedReserveBuild(payload),
  idlePollS: 10,
  retryDelayS: 120,
});

export {
  startFlowReserveBuildWorker,
  stopFlowReserveBuildWorker,
  isFlowReserveBuildWorkerRunning,
};
