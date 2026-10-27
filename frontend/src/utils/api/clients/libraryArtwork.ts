import { hc } from "hono/client";
import type libraryArtwork from "../../../../../backend/routes/library/handlers/artwork.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const libraryArtworkClient = hc<typeof libraryArtwork>(API_BASE_URL, {
  fetch: apiFetch,
}).library;
