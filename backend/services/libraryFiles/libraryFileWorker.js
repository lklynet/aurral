import createHonkerWorker from "../honkerWorkerFactory.js";
import { getLibraryFileQueue } from "../honkerDb.js";
import { processLibraryFileJob } from "./operations.js";

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
