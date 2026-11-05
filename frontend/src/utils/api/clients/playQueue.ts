import { hc } from "hono/client";
import type playQueue from "../../../../../backend/routes/playQueue.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const playQueueClient = hc<typeof playQueue>(API_BASE_URL, { fetch: apiFetch })[
  "play-queue"
];
