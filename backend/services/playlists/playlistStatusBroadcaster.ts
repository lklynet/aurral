import { createHash } from "node:crypto";
import { websocketService } from "../websocketService.ts";
import { logger } from "../logger.ts";
import { asAppError } from "../../../lib/errors.ts";
import {
  clearPlaylistStatusCache,
  getPlaylistStatusSnapshot,
  getPlaylistStatusVersion,
} from "./playlistStatusSnapshot.ts";

type PlaylistStatusClient = Parameters<
  Parameters<typeof websocketService.broadcastPerClient>[1]
>[0];

export function startPlaylistStatusBroadcasts({ websocket = websocketService, log = logger } = {}) {
  let interval: ReturnType<typeof setInterval> | null = null;
  let lastVersion: string | null = null;
  const broadcast = (force = false) => {
    try {
      const channels = websocket.getStats().channels;
      if (!channels["weekly-flow"] && !channels.playlists && !channels["*"]) {
        if (interval) clearInterval(interval);
        interval = null;
        lastVersion = null;
        clearPlaylistStatusCache();
        return;
      }
      if (!interval) {
        interval = setInterval(broadcast, 4000);
        interval.unref?.();
      }
      const version = getPlaylistStatusVersion();
      if (!force && version === lastVersion) return;
      const payloadByAudience = new Map();
      const buildPayload = (channel: string) => (client: PlaylistStatusClient) => {
        const cacheKey =
          client?.user?.role === "admin"
            ? "admin"
            : client?.user?.id != null
              ? `user:${client.user.id}`
              : `anon:${client?.id || "unknown"}`;
        let cached = payloadByAudience.get(cacheKey);
        if (!cached) {
          const status = getPlaylistStatusSnapshot({ user: client?.user || null });
          cached = {
            hash: createHash("sha256").update(JSON.stringify(status)).digest("hex"),
            message: { type: "playlist_status", status },
          };
          payloadByAudience.set(cacheKey, cached);
        }
        client._lastPlaylistStatusHashByChannel ||= new Map();
        if (client._lastPlaylistStatusHashByChannel.get(channel) === cached.hash) return null;
        client._lastPlaylistStatusHashByChannel.set(channel, cached.hash);
        return cached.message;
      };
      websocket.broadcastPerClient("weekly-flow", buildPayload("weekly-flow"));
      websocket.broadcastPerClient("playlists", buildPayload("playlists"));
      lastVersion = version;
    } catch (error) {
      log.warn("system", "Failed to broadcast playlist status:", {
        message: asAppError(error)?.message,
      });
    }
  };
  const subscriptionsChanged = () => broadcast(true);
  websocket.on("subscriptions-changed", subscriptionsChanged);
  broadcast();
  return () => {
    if (interval) clearInterval(interval);
    websocket.off("subscriptions-changed", subscriptionsChanged);
    clearPlaylistStatusCache();
    for (const client of websocket.clients) delete client._lastPlaylistStatusHashByChannel;
  };
}
