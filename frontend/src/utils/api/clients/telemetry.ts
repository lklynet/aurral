import { hc } from "hono/client";
import type telemetry from "../../../../../backend/routes/telemetry.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const telemetryClient = hc<typeof telemetry>(API_BASE_URL, { fetch: apiFetch }).telemetry;
