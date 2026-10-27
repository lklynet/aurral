import { hc } from "hono/client";
import type libraryTracks from "../../../../../backend/routes/library/handlers/tracks.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const libraryTracksClient = hc<typeof libraryTracks>(API_BASE_URL, {
  fetch: apiFetch,
}).library;
