import createHonkerWorker from "../honkerWorkerFactory.ts";
import { getLibraryFileQueue } from "../honkerDb.ts";
import { processLibraryFileJob } from "./operations.ts";

const worker = createHonkerWorker({
  name: "library-files",
  getQueue: getLibraryFileQueue,
  processJob: (payload) => processLibraryFileJob(payload),
  idlePollS: 5,
  retryDelayS: 30,
});

export const {
  start: startLibraryFileWorker,
  stop: stopLibraryFileWorker,
  isRunning: isLibraryFileWorkerRunning,
} = worker;
