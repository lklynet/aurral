import { useEffect, useRef, useState } from "react";
import {
  isWebSocketOpen,
  subscribeToChannel,
  subscribeToStatus,
} from "../utils/webSocketConnection.js";

export function useWebSocketChannel(channel, onMessage, options = {}) {
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
    const unsubscribeChannel = subscribeToChannel(channel, (message) => {
      onMessageRef.current?.(message);
    });

    return () => {
      unsubscribeChannel();
      unsubscribeStatus();
    };
  }, [channel, enabled]);

  return { isConnected };
}
