import { hc } from "hono/client";
import type playlistImports from "../../../../../backend/routes/playlists/handlers/imports.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const playlistImportsClient = hc<typeof playlistImports>(API_BASE_URL, {
  fetch: apiFetch,
}).playlists;
