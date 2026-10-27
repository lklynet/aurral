import { hc } from "hono/client";
import type auth from "../../../../../backend/routes/auth.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const authClient = hc<typeof auth>(API_BASE_URL, { fetch: apiFetch }).auth;
