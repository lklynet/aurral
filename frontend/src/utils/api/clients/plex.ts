import { hc } from "hono/client";
import type plex from "../../../../../backend/routes/plex.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const plexClient = hc<typeof plex>(API_BASE_URL, { fetch: apiFetch }).plex;
