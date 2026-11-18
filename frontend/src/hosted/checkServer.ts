import { isRecord } from "../../../lib/isRecord.ts";

export const checkServer = async (address: string) => {
  const response = await fetch(`${address}/api/health/bootstrap`, {
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const body: unknown = await response.json();
  if (!response.ok || !isRecord(body) || typeof body.appVersion !== "string") {
    throw new Error("Not an Aurral server");
  }
  return {
    version: body.appVersion,
    authRequired: body.authRequired === true,
    onboardingRequired: body.onboardingRequired === true,
  };
};
