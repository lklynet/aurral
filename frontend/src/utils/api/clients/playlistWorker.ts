import { hc } from "hono/client";
import type playlistWorker from "../../../../../backend/routes/playlists/handlers/worker.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const playlistWorkerClient = hc<typeof playlistWorker>(API_BASE_URL, {
  fetch: apiFetch,
}).playlists;
