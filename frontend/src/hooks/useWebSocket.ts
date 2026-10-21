import { useEffect, useRef, useState } from "react";
import {
  isWebSocketOpen,
  subscribeToChannel,
  subscribeToStatus,
} from "../utils/webSocketConnection.ts";
import type { getPlaylistStatusSnapshot } from "../../../backend/services/playlists/playlistStatusSnapshot.ts";

type DownloadStatusEntry = { status: string; updatedAt: string; progress?: number };

type ChannelMessage = { channel: string; timestamp: number } & (
  | {
      type: "download_statuses";
      statuses: Partial<Record<string, DownloadStatusEntry>>;
      stale: boolean;
      error: string | null;
      updatedAt: string | null;
    }
  | { type: "library_scan_completed" }
  | { type: "release_metadata_refreshed" }
  | { type: "playlist_status"; status: ReturnType<typeof getPlaylistStatusSnapshot> }
  | { type: "discovery_update" }
);

export function useWebSocketChannel(
  channel: string,
  onMessage: (message: ChannelMessage) => void,
  options: { enabled?: boolean } = {},
) {
  const { enabled = true } = options;
  const onMessageRef = useRef(onMessage);
  const [isConnected, setIsConnected] = useState(isWebSocketOpen);
  onMessageRef.current = onMessage;

  useEffect(() => {
    if (!enabled) {
      setIsConnected(false);
      return undefined;
    }

    const unsubscribeStatus = subscribeToStatus(setIsConnected);
    const unsubscribeChannel = subscribeToChannel(channel, (message: ChannelMessage) => {
      onMessageRef.current?.(message);
    });

    return () => {
      unsubscribeChannel();
      unsubscribeStatus();
    };
  }, [channel, enabled]);

  return { isConnected };
}
