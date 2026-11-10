import { createJobWorker } from "./jobs/worker.ts";
import { notificationQueue } from "./jobs/queues.ts";
import { deliverQueuedNotification, queuedNotificationSchema } from "./notificationService.ts";

export const { start: startNotificationOutboxWorker } = createJobWorker(notificationQueue, {
  schema: queuedNotificationSchema,
  processJob: deliverQueuedNotification,
});
