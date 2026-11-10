import { createJobWorker } from "./jobs/worker.ts";
import { playEventQueue } from "./jobs/queues.ts";
import { deliverPlayEvent, playEventDeliverySchema } from "./playEventService.ts";

export const { start: startPlayEventOutboxWorker } = createJobWorker(playEventQueue, {
  schema: playEventDeliverySchema,
  processJob: deliverPlayEvent,
});
