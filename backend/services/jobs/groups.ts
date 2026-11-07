export const WORKER_GROUPS = [
  "downloads",
  "library",
  "release-metadata",
  "discovery-refresh",
  "discovery-user-refresh",
  "maintenance",
  "inbox",
  "notifications",
  "play-events",
] as const;

export type WorkerGroup = (typeof WORKER_GROUPS)[number];
