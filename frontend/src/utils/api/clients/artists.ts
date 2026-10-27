import { hc } from "hono/client";
import type artists from "../../../../../backend/routes/artists/index.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const artistsClient = hc<typeof artists>(API_BASE_URL, { fetch: apiFetch }).artists;
