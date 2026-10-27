import { hc } from "hono/client";
import type playlistJobs from "../../../../../backend/routes/playlists/handlers/jobs.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const playlistJobsClient = hc<typeof playlistJobs>(API_BASE_URL, {
  fetch: apiFetch,
}).playlists;
