import { hc } from "hono/client";
import type backup from "../../../../../backend/routes/backup.ts";
import { API_BASE_URL, apiFetchWithin } from "../core.ts";

export const backupClient = hc<typeof backup>(API_BASE_URL, {
  fetch: apiFetchWithin(30 * 60 * 1000),
}).backup;
