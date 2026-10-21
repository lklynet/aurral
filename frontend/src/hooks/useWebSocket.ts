import { useEffect, useRef, useState } from "react";
import {
  isWebSocketOpen,
  subscribeToChannel,
  subscribeToStatus,
} from "../utils/webSocketConnection.ts";
import type { ChannelMessage } from "../utils/webSocketConnection.ts";

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
