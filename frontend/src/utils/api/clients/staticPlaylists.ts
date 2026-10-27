import { hc } from "hono/client";
import type staticPlaylists from "../../../../../backend/routes/playlists/handlers/staticPlaylists.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const staticPlaylistsClient = hc<typeof staticPlaylists>(API_BASE_URL, {
  fetch: apiFetch,
}).playlists;
