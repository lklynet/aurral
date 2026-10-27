import { hc } from "hono/client";
import type filesystem from "../../../../../backend/routes/filesystem.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const filesystemClient = hc<typeof filesystem>(API_BASE_URL, { fetch: apiFetch }).filesystem;
