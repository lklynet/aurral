// Download queues share one process because their workers coordinate in-memory state.
// Other background queues are isolated from the web process and from each other.
export const ISOLATED_QUEUE_GROUPS = Object.freeze({
  "release-metadata-refresh": "release-metadata",
  "library-scan": "library",
  "discovery-refresh": "discovery-refresh",
  "discovery-user-refresh": "discovery-user-refresh",
  "system-task-maintenance": "maintenance",
  "system-task-inbox": "inbox",
  "_outbox:notifications": "notifications",
  "_outbox:play-events": "play-events",
  "system-task": "downloads",
  playback: "downloads",
  "weekly-flow-operation": "downloads",
  "slskd-pipeline": "downloads",
  "playlist-mbid-enrichment": "downloads",
  "library-files": "downloads",
});

export const ISOLATED_WORKER_GROUPS = Object.freeze([
  ...new Set(Object.values(ISOLATED_QUEUE_GROUPS)),
  "scheduler",
]);

const WORKER_QUEUE_ALIASES = Object.freeze({
  "notification-outbox": "_outbox:notifications",
  "play-event-outbox": "_outbox:play-events",
});

const isIsolatedQueue = (queueName: string): queueName is keyof typeof ISOLATED_QUEUE_GROUPS =>
  Object.hasOwn(ISOLATED_QUEUE_GROUPS, queueName);

const isQueueAlias = (queueName: string): queueName is keyof typeof WORKER_QUEUE_ALIASES =>
  Object.hasOwn(WORKER_QUEUE_ALIASES, queueName);

export function getIsolatedQueueGroup(queueName: string) {
  return isIsolatedQueue(queueName) ? ISOLATED_QUEUE_GROUPS[queueName] : undefined;
}

export function shouldStartQueueHere(queueName: string) {
  if (process.env.NODE_ENV === "test" && !process.env.AURRAL_BACKGROUND_WORKER_GROUP) {
    return true;
  }
  const owner = getIsolatedQueueGroup(queueName);
  const group = process.env.AURRAL_BACKGROUND_WORKER_GROUP;
  return group ? owner === group : !owner;
}

export function isQueueOwnedByGroup(queueName: string, group: string | null = null) {
  const queue = isQueueAlias(queueName) ? WORKER_QUEUE_ALIASES[queueName] : queueName;
  const owner = getIsolatedQueueGroup(queue);
  return group ? owner === group : !owner;
}
