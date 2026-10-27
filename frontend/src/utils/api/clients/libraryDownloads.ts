import { hc } from "hono/client";
import type libraryDownloads from "../../../../../backend/routes/library/handlers/downloads.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const libraryDownloadsClient = hc<typeof libraryDownloads>(API_BASE_URL, {
  fetch: apiFetch,
}).library;
