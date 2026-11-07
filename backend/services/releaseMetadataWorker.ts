import { createJobWorker } from "./jobs/worker.ts";
import { releaseMetadataQueue, systemTaskSchema } from "./jobs/queues.ts";
import { prepareSystemTask, processSystemTask } from "./systemTaskWorker.ts";

const { start, stop, isRunning } = createJobWorker(releaseMetadataQueue, {
  schema: systemTaskSchema,
  processJob: processSystemTask,
  prepareJob: prepareSystemTask,
  interruptible: true,
});

export {
  start as startReleaseMetadataWorker,
  stop as stopReleaseMetadataWorker,
  isRunning as isReleaseMetadataWorkerRunning,
};
