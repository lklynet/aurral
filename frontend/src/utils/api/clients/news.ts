import { hc } from "hono/client";
import type news from "../../../../../backend/routes/news.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const newsClient = hc<typeof news>(API_BASE_URL, { fetch: apiFetch }).news;
