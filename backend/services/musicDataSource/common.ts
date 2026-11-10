import { UUID_REGEX } from "../../../lib/uuid.ts";
import type { SourceHealth } from "../discovery/tasteProfile.ts";

export const text = (value: unknown) => String(value ?? "").trim();

export const normalizeMbid = (value: unknown) => {
  const mbid = text(value).toLowerCase();
  return UUID_REGEX.test(mbid) ? mbid : null;
};

export const recordHealth = (health: SourceHealth | undefined, ok: boolean) => {
  if (!health) return;
  if (ok) health.success += 1;
  else health.failure += 1;
};
