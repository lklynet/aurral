import { hc } from "hono/client";
import type downloadClientSettings from "../../../../../backend/routes/settings/downloadClients.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const downloadClientSettingsClient = hc<typeof downloadClientSettings>(API_BASE_URL, {
  fetch: apiFetch,
}).settings;
