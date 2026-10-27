import { hc } from "hono/client";
import type libraryMonitoring from "../../../../../backend/routes/library/handlers/monitoring.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const libraryMonitoringClient = hc<typeof libraryMonitoring>(API_BASE_URL, {
  fetch: apiFetch,
}).library;
