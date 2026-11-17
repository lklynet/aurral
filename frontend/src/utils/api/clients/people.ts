import { hc } from "hono/client";
import type people from "../../../../../backend/routes/people.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const peopleClient = hc<typeof people>(API_BASE_URL, { fetch: apiFetch }).people;
