import { hc } from "hono/client";
import type visualizer from "../../../../../backend/routes/visualizer.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const visualizerClient = hc<typeof visualizer>(API_BASE_URL, { fetch: apiFetch }).visualizer;
