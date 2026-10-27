import { hc } from "hono/client";
import type scrobbling from "../../../../../backend/routes/scrobbling.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const scrobblingClient = hc<typeof scrobbling>(API_BASE_URL, { fetch: apiFetch }).scrobbling;
