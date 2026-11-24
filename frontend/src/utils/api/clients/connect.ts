import { hc } from "hono/client";
import type connect from "../../../../../backend/routes/connect.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const connectClient = hc<typeof connect>(API_BASE_URL, { fetch: apiFetch }).connect;
