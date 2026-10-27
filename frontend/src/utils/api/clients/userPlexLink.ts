import { hc } from "hono/client";
import type userPlexLink from "../../../../../backend/routes/users/plexLinkHandlers.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const userPlexLinkClient = hc<typeof userPlexLink>(API_BASE_URL, { fetch: apiFetch }).users;
