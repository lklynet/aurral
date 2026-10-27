import { hc } from "hono/client";
import type requests from "../../../../../backend/routes/requests.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const requestsClient = hc<typeof requests>(API_BASE_URL, { fetch: apiFetch }).requests;
