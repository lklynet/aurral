import createHonkerWorker from "../../backend/services/honkerWorkerFactory.ts";
import { getMaintenanceTaskQueue } from "../../backend/services/honkerDb.ts";
import { processSystemTask, systemTaskSchema } from "../../backend/services/systemTaskWorker.ts";
import { shutdownHonkerInfrastructure } from "../../backend/services/honkerWorkerRuntime.ts";

const worker = createHonkerWorker({
  name: "system-task-maintenance",
  schema: systemTaskSchema,
  getQueue: getMaintenanceTaskQueue,
  processJob: processSystemTask,
  idlePollS: 10,
});
const poll = setInterval(() => worker.start(), 2000);
type ParentMessage = { type: "queue-wake" | "park" | "shutdown" };

process.on("message", async (message: ParentMessage) => {
  if (message.type === "queue-wake") void worker.start();
  if (message.type === "park") {
    await worker.stop();
    process.send?.({ type: "parked" });
  }
  if (message.type === "shutdown") {
    clearInterval(poll);
    await shutdownHonkerInfrastructure();
    process.exit(0);
  }
});
process.send?.({ type: "ready" });
