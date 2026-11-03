import { hc } from "hono/client";
import type historyServers from "../../../../../backend/routes/historyServers.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const historyServersClient = hc<typeof historyServers>(API_BASE_URL, {
  fetch: apiFetch,
})["history-servers"];
