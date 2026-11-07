import { createJobWorker } from "./jobs/worker.ts";
import { playEventQueue } from "./jobs/queues.ts";
import { deliverPlayEvent, playEventDeliverySchema } from "./playEventService.ts";

const { start, stop, isRunning } = createJobWorker(playEventQueue, {
  schema: playEventDeliverySchema,
  processJob: deliverPlayEvent,
});

export {
  start as startPlayEventOutboxWorker,
  stop as stopPlayEventOutboxWorker,
  isRunning as isPlayEventOutboxWorkerRunning,
};
