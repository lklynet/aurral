import { hc } from "hono/client";
import type inbox from "../../../../../backend/routes/inbox.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const inboxClient = hc<typeof inbox>(API_BASE_URL, { fetch: apiFetch }).inbox;
