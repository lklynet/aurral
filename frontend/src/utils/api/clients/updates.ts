import { hc } from "hono/client";
import type updates from "../../../../../backend/routes/updates.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const updatesClient = hc<typeof updates>(API_BASE_URL, { fetch: apiFetch }).updates;
