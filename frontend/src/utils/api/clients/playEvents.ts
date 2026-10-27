import { hc } from "hono/client";
import type playEvents from "../../../../../backend/routes/playEvents.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const playEventsClient = hc<typeof playEvents>(API_BASE_URL, { fetch: apiFetch })[
  "play-events"
];
