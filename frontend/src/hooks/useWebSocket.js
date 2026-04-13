import { useEffect, useRef, useState } from "react";
import { getStoredAuth } from "../utils/api";

function getWsUrl() {
  const { token } = getStoredAuth();
  const apiUrl = import.meta.env.VITE_API_URL;
  if (apiUrl && (apiUrl.startsWith("http://") || apiUrl.startsWith("https://"))) {
    const url = new URL(apiUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    if (token) {
      url.searchParams.set("token", token);
    }
    return url.toString();
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${window.location.host}/ws`);
  if (token) {
    url.searchParams.set("token", token);
  }
  return url.toString();
}

export function useWebSocketChannel(channel, onMessage) {
  const wsRef = useRef(null);
  const onMessageRef = useRef(onMessage);
  const [isConnected, setIsConnected] = useState(false);
  onMessageRef.current = onMessage;

  useEffect(() => {
    let ws = null;
    let reconnectTimer = null;
    let reconnectAttempts = 0;
    let closed = false;

    const subscribe = () => {
      try {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "subscribe",
              channels: [channel],
            }),
          );
        }
      } catch {}
    };

    const scheduleReconnect = () => {
      if (closed) return;
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 15000);
      reconnectAttempts += 1;
      reconnectTimer = setTimeout(() => {
        connect();
      }, delay);
    };

    const connect = () => {
      ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttempts = 0;
        setIsConnected(true);
        subscribe();
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.channel === channel && msg.type && onMessageRef.current) {
            onMessageRef.current(msg);
          }
        } catch {}
      };

      ws.onclose = () => {
        setIsConnected(false);
        scheduleReconnect();
      };

      ws.onerror = () => {
        setIsConnected(false);
      };
    };

    connect();

    return () => {
      closed = true;
      setIsConnected(false);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      try {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "unsubscribe",
              channels: [channel],
            }),
          );
        }
      } catch {}
      try {
        ws?.close();
      } catch {}
      wsRef.current = null;
    };
  }, [channel]);

  return { isConnected };
}
