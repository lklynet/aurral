import createHonkerWorker from "../../backend/services/honkerWorkerFactory.js";
import { getMaintenanceTaskQueue } from "../../backend/services/honkerDb.js";
import { processSystemTask } from "../../backend/services/systemTaskWorker.js";
import { shutdownHonkerInfrastructure } from "../../backend/services/honkerWorkerRuntime.js";

const worker = createHonkerWorker({
  name: "system-task-maintenance",
  getQueue: getMaintenanceTaskQueue,
  processJob: processSystemTask,
  idlePollS: 10,
});
const poll = setInterval(() => worker.start(), 2000);
process.on("message", async (message) => {
  if (message?.type === "queue-wake") worker.start();
  if (message?.type === "park") {
    await worker.stop();
    process.send({ type: "parked" });
  }
  if (message?.type === "shutdown") {
    clearInterval(poll);
    await shutdownHonkerInfrastructure();
    process.exit(0);
  }
});
process.send({ type: "ready" });
