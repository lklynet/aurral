import { hc } from "hono/client";
import type libraryRadio from "../../../../../backend/routes/library/handlers/radio.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const libraryRadioClient = hc<typeof libraryRadio>(API_BASE_URL, {
  fetch: apiFetch,
}).library;
