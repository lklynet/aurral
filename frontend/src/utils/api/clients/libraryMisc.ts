import { hc } from "hono/client";
import type libraryMisc from "../../../../../backend/routes/library/handlers/misc.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const libraryMiscClient = hc<typeof libraryMisc>(API_BASE_URL, { fetch: apiFetch }).library;
