import * as v from "valibot";
import { createJobWorker } from "../jobs/worker.ts";
import { libraryFileQueue } from "../jobs/queues.ts";
import { processLibraryFileJob } from "./operations.ts";

export const libraryFileJobSchema = v.looseObject({ operationId: v.number() });

const worker = createJobWorker(libraryFileQueue, {
  schema: libraryFileJobSchema,
  processJob: ({ operationId }) => processLibraryFileJob(operationId),
});

export const {
  start: startLibraryFileWorker,
  stop: stopLibraryFileWorker,
  isRunning: isLibraryFileWorkerRunning,
} = worker;
