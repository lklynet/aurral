export function mergePlexIntegration(existing = {}, input = {}) {
  return {
    ...existing,
    ...input,
    token: input.token ?? existing.token ?? "",
    clientId: input.clientId ?? existing.clientId ?? "",
  };
}
