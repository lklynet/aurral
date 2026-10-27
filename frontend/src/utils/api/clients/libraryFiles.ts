import { hc } from "hono/client";
import type libraryFiles from "../../../../../backend/routes/library/handlers/files.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const libraryFilesClient = hc<typeof libraryFiles>(API_BASE_URL, {
  fetch: apiFetch,
}).library;
