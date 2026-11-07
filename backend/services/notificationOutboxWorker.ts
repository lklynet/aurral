import { createJobWorker } from "./jobs/worker.ts";
import { notificationQueue } from "./jobs/queues.ts";
import { deliverQueuedNotification, queuedNotificationSchema } from "./notificationService.ts";

const { start, stop, isRunning } = createJobWorker(notificationQueue, {
  schema: queuedNotificationSchema,
  processJob: deliverQueuedNotification,
});

export {
  start as startNotificationOutboxWorker,
  stop as stopNotificationOutboxWorker,
  isRunning as isNotificationOutboxWorkerRunning,
};
