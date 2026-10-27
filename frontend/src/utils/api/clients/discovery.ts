import { hc } from "hono/client";
import type discovery from "../../../../../backend/routes/discovery/index.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const discoveryClient = hc<typeof discovery>(API_BASE_URL, { fetch: apiFetch }).discover;
