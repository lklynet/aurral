import { hc } from "hono/client";
import type playlistArtwork from "../../../../../backend/routes/playlists/handlers/artwork.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const playlistArtworkClient = hc<typeof playlistArtwork>(API_BASE_URL, {
  fetch: apiFetch,
}).playlists;
