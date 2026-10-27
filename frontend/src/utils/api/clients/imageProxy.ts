import { hc } from "hono/client";
import type imageProxy from "../../../../../backend/routes/imageProxy.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const imageProxyClient = hc<typeof imageProxy>(API_BASE_URL, { fetch: apiFetch })[
  "image-proxy"
];
