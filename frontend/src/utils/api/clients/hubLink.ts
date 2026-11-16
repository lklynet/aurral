import { hc } from "hono/client";
import type hubLink from "../../../../../backend/routes/hubLink.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const hubLinkClient = hc<typeof hubLink>(API_BASE_URL, { fetch: apiFetch })["hub-link"];
