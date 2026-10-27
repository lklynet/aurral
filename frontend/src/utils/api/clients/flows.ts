import { hc } from "hono/client";
import type flows from "../../../../../backend/routes/playlists/handlers/flows.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const flowsClient = hc<typeof flows>(API_BASE_URL, { fetch: apiFetch }).playlists;
