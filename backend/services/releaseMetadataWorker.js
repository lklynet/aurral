import createHonkerWorker from "./honkerWorkerFactory.js";
import { getReleaseMetadataQueue } from "./honkerDb.js";
import { prepareSystemTask, processSystemTask } from "./systemTaskWorker.js";

const { start, stop, isRunning } = createHonkerWorker({
  name: "release-metadata-refresh",
  getQueue: getReleaseMetadataQueue,
  processJob: processSystemTask,
  prepareJob: prepareSystemTask,
  interruptible: true,
  idlePollS: 10,
  retryDelayS: 120,
});

export { start as startReleaseMetadataWorker, stop as stopReleaseMetadataWorker,
  isRunning as isReleaseMetadataWorkerRunning };
