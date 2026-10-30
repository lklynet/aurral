import createHonkerWorker from "./honkerWorkerFactory.ts";
import { getReleaseMetadataQueue } from "./honkerDb.ts";
import { prepareSystemTask, processSystemTask, systemTaskSchema } from "./systemTaskWorker.ts";

const { start, stop, isRunning } = createHonkerWorker({
  name: "release-metadata-refresh",
  schema: systemTaskSchema,
  getQueue: getReleaseMetadataQueue,
  processJob: processSystemTask,
  prepareJob: prepareSystemTask,
  interruptible: true,
  idlePollS: 10,
  retryDelayS: 120,
});

export {
  start as startReleaseMetadataWorker,
  stop as stopReleaseMetadataWorker,
  isRunning as isReleaseMetadataWorkerRunning,
};
