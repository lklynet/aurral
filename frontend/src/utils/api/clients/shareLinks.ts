import { hc } from "hono/client";
import type shareLinks from "../../../../../backend/routes/shareLinks.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const shareLinksClient = hc<typeof shareLinks>(API_BASE_URL, { fetch: apiFetch })[
  "share-links"
];
