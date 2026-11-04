import { hc } from "hono/client";
import type lyrics from "../../../../../backend/routes/lyrics.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const lyricsClient = hc<typeof lyrics>(API_BASE_URL, { fetch: apiFetch }).lyrics;
