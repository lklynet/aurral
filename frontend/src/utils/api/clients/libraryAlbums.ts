import { hc } from "hono/client";
import type libraryAlbums from "../../../../../backend/routes/library/handlers/albums.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const libraryAlbumsClient = hc<typeof libraryAlbums>(API_BASE_URL, {
  fetch: apiFetch,
}).library;
