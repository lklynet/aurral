import { hc } from "hono/client";
import type plugins from "../../../../../backend/routes/plugins.ts";
import { API_BASE_URL, apiFetchWithin } from "../core.ts";

export const pluginsClient = hc<typeof plugins>(API_BASE_URL, {
  fetch: apiFetchWithin(150_000),
}).plugins;
