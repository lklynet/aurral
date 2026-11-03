import { hc } from "hono/client";
import type logs from "../../../../../backend/routes/logs.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const logsClient = hc<typeof logs>(API_BASE_URL, { fetch: apiFetch }).logs;
