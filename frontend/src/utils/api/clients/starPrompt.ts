import { hc } from "hono/client";
import type starPrompt from "../../../../../backend/routes/starPrompt.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const starPromptClient = hc<typeof starPrompt>(API_BASE_URL, { fetch: apiFetch })[
  "star-prompt"
];
