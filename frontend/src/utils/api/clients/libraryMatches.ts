import { hc } from "hono/client";
import type libraryMatches from "../../../../../backend/routes/library/handlers/matches.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const libraryMatchesClient = hc<typeof libraryMatches>(API_BASE_URL, {
  fetch: apiFetch,
}).library;
