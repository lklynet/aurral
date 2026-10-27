import { hc, type InferResponseType } from "hono/client";
import type settings from "../../../../../backend/routes/settings/index.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const settingsClient = hc<typeof settings>(API_BASE_URL, { fetch: apiFetch }).settings;

export type AppSettingsResponse = InferResponseType<typeof settingsClient.$get, 200>;
