import type { StoredIntegrations } from "../../../db/helpers/settings.ts";

export function mergePlexIntegration(
  existing: StoredIntegrations["plex"] = {},
  input: StoredIntegrations["plex"] = {},
) {
  return {
    ...existing,
    ...input,
    token: input.token ?? existing.token ?? "",
    clientId: input.clientId ?? existing.clientId ?? "",
  };
}
