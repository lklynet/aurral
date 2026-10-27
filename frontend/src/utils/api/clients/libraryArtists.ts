import { hc } from "hono/client";
import type libraryArtists from "../../../../../backend/routes/library/handlers/artists.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const libraryArtistsClient = hc<typeof libraryArtists>(API_BASE_URL, {
  fetch: apiFetch,
}).library;
