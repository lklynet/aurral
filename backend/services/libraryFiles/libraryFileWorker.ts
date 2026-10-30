import * as v from "valibot";
import createHonkerWorker from "../honkerWorkerFactory.ts";
import { getLibraryFileQueue } from "../honkerDb.ts";
import { processLibraryFileJob } from "./operations.ts";

const worker = createHonkerWorker({
  name: "library-files",
  schema: v.looseObject({ operationId: v.number() }),
  getQueue: getLibraryFileQueue,
  processJob: ({ operationId }) => processLibraryFileJob(operationId),
  idlePollS: 5,
  retryDelayS: 30,
});

export const {
  start: startLibraryFileWorker,
  stop: stopLibraryFileWorker,
  isRunning: isLibraryFileWorkerRunning,
} = worker;
