import { shutdownHonkerInfrastructure } from "../../backend/services/honkerWorkerRuntime.js";
import { startSystemTaskWorker } from "../../backend/services/systemTaskWorker.js";
import { startReleaseMetadataWorker } from "../../backend/services/releaseMetadataWorker.js";
const start = process.env.AURRAL_BACKGROUND_WORKER_GROUP === "release-metadata"
  ? startReleaseMetadataWorker : startSystemTaskWorker;
process.on("message", async (message) => {
  if (message.type === "queue-wake") start();
  if (message.type === "sample") process.send({ type: "sample", rss: process.memoryUsage().rss, cpu: process.cpuUsage() });
  if (message.type === "shutdown") {
    await shutdownHonkerInfrastructure();
    process.exit(0);
  }
});
process.send({ type: "ready" });
