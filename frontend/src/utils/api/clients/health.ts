import { hc } from "hono/client";
import type health from "../../../../../backend/routes/health.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const healthClient = hc<typeof health>(API_BASE_URL, { fetch: apiFetch }).health;
