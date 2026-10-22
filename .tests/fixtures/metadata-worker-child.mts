import { shutdownHonkerInfrastructure } from "../../backend/services/honkerWorkerRuntime.ts";
import { startSystemTaskWorker } from "../../backend/services/systemTaskWorker.ts";
import { startReleaseMetadataWorker } from "../../backend/services/releaseMetadataWorker.ts";
const start = process.env.AURRAL_BACKGROUND_WORKER_GROUP === "release-metadata"
  ? startReleaseMetadataWorker : startSystemTaskWorker;
process.on("message", async (message) => {
  if (message.type === "queue-wake") void start();
  if (message.type === "sample") process.send({ type: "sample", rss: process.memoryUsage().rss, cpu: process.cpuUsage() });
  if (message.type === "shutdown") {
    await shutdownHonkerInfrastructure();
    process.exit(0);
  }
});
process.send({ type: "ready" });
