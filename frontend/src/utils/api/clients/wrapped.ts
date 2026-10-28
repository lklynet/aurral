import { hc } from "hono/client";
import type wrapped from "../../../../../backend/routes/wrapped.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const wrappedClient = hc<typeof wrapped>(API_BASE_URL, { fetch: apiFetch }).wrapped;
