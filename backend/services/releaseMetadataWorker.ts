import { createJobWorker } from "./jobs/worker.ts";
import { releaseMetadataQueue, systemTaskSchema } from "./jobs/queues.ts";
import { prepareSystemTask, processSystemTask } from "./systemTaskWorker.ts";

export const { start: startReleaseMetadataWorker } = createJobWorker(releaseMetadataQueue, {
  schema: systemTaskSchema,
  processJob: processSystemTask,
  prepareJob: prepareSystemTask,
  interruptible: true,
});
