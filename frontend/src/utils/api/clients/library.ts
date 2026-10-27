import { hc } from "hono/client";
import type library from "../../../../../backend/routes/library/handlers/libraryIndex.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const libraryClient = hc<typeof library>(API_BASE_URL, { fetch: apiFetch }).library;
