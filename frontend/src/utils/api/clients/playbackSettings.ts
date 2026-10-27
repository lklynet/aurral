import { hc } from "hono/client";
import type playbackSettings from "../../../../../backend/routes/settings/playback.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const playbackSettingsClient = hc<typeof playbackSettings>(API_BASE_URL, {
  fetch: apiFetch,
}).settings;
