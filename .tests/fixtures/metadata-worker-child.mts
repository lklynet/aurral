import { shutdownJobWorkers } from "../../backend/services/jobs/worker.ts";
import { startSystemTaskWorker } from "../../backend/services/systemTaskWorker.ts";
import { startReleaseMetadataWorker } from "../../backend/services/releaseMetadataWorker.ts";

const start =
  process.env.AURRAL_BACKGROUND_WORKER_GROUP === "release-metadata"
    ? () => startReleaseMetadataWorker()
    : () => startSystemTaskWorker("system-task");

process.on("message", async (message: { type: "queue-wake" | "shutdown" }) => {
  if (message.type === "queue-wake") void start();
  if (message.type === "shutdown") {
    await shutdownJobWorkers();
    process.exit(0);
  }
});
process.send?.({ type: "ready" });
