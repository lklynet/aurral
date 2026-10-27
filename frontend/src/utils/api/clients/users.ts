import { hc } from "hono/client";
import type users from "../../../../../backend/routes/users.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const usersClient = hc<typeof users>(API_BASE_URL, { fetch: apiFetch }).users;
