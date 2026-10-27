import { hc } from "hono/client";
import type search from "../../../../../backend/routes/search.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const searchClient = hc<typeof search>(API_BASE_URL, { fetch: apiFetch }).search;
