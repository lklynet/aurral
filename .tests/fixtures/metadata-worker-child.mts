import { shutdownJobWorkers } from "../../backend/services/jobs/worker.ts";
import { startSystemTaskWorker } from "../../backend/services/systemTaskWorker.ts";
import { LISTENBRAINZ_API } from "../../backend/config/constants.ts";
import { http } from "../../lib/http.ts";

const listenbrainz = process.env.LISTENBRAINZ_MOCK_URL;
if (listenbrainz) {
  const get = http.get;
  http.get = (url, options) => get(String(url).replace(LISTENBRAINZ_API, listenbrainz), options);
}

const start = () =>
  startSystemTaskWorker(
    process.env.AURRAL_BACKGROUND_WORKER_GROUP === "release-metadata"
      ? "release-metadata-refresh"
      : "system-task",
  );

process.on("message", async (message: { type: "queue-wake" | "shutdown" }) => {
  if (message.type === "queue-wake") void start();
  if (message.type === "shutdown") {
    await shutdownJobWorkers();
    process.exit(0);
  }
});
process.send?.({ type: "ready" });
