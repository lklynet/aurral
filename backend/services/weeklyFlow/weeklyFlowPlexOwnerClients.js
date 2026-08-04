import { PlexClient } from "../plex.js";
import { plexConnectionStore } from "../plex/plexConnectionStore.js";

export function resolvePlexClientForOwner(globalPlexClient, ownerUserId, cache) {
  if (ownerUserId == null) return globalPlexClient;
  const key = String(ownerUserId);
  if (cache.has(key)) return cache.get(key);

  const connection = plexConnectionStore.getConnection(ownerUserId);
  if (!connection) {
    cache.set(key, globalPlexClient);
    return globalPlexClient;
  }
  if (!globalPlexClient) {
    cache.set(key, null);
    return null;
  }

  const client = new PlexClient(globalPlexClient.url, connection.token, connection.clientId);
  client._machineIdentifier = globalPlexClient._machineIdentifier || null;
  cache.set(key, client);
  return client;
}

export async function recoverManagedUserToken(ownerUserId, globalPlexClient) {
  const connection = plexConnectionStore.getConnection(ownerUserId);
  if (!connection || connection.linkType !== "managed" || connection.plexAccountId == null) {
    return null;
  }
  if (!globalPlexClient?.isConfigured()) return null;

  try {
    const freshToken = await PlexClient.switchHomeUser(
      connection.plexAccountId,
      globalPlexClient.token,
      globalPlexClient.clientId,
      connection.clientId,
    );
    if (!freshToken) throw new Error("Plex did not return a refreshed token");
    let serverToken = freshToken;
    try {
      const machineIdentifier = await globalPlexClient.getMachineIdentifier();
      const { servers } = await PlexClient.getResources(freshToken, connection.clientId);
      const match = (servers || []).find((s) => s.clientIdentifier === machineIdentifier);
      if (match?.accessToken) {
        serverToken = match.accessToken;
      }
    } catch {}
    plexConnectionStore.updateToken(ownerUserId, {
      token: serverToken,
      clientId: connection.clientId,
    });
    const client = new PlexClient(globalPlexClient.url, serverToken, connection.clientId);
    client._machineIdentifier = globalPlexClient._machineIdentifier || null;
    return client;
  } catch (error) {
    plexConnectionStore.setLastError(ownerUserId, error?.message || "Plex reconnect failed");
    return null;
  }
}
