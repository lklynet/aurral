import { hc } from "hono/client";
import type onboarding from "../../../../../backend/routes/onboarding.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const onboardingClient = hc<typeof onboarding>(API_BASE_URL, { fetch: apiFetch }).onboarding;
