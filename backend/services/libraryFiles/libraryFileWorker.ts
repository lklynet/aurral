import * as v from "valibot";
import { createJobWorker } from "../jobs/worker.ts";
import { libraryFileQueue } from "../jobs/queues.ts";
import { processLibraryFileJob } from "./operations.ts";

export const libraryFileJobSchema = v.looseObject({ operationId: v.number() });

export const { start: startLibraryFileWorker } = createJobWorker(libraryFileQueue, {
  schema: libraryFileJobSchema,
  processJob: ({ operationId }) => processLibraryFileJob(operationId),
});
