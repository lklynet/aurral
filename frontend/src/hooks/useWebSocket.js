import { useEffect, useRef, useState } from "react";
import { getStoredAuth } from "../utils/api";

function getWsUrl() {
  const { token } = getStoredAuth();
  const apiUrl = import.meta.env.VITE_API_URL;
  if (
    apiUrl &&
    (apiUrl.startsWith("http://") || apiUrl.startsWith("https://"))
  ) {
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

const OPEN = WebSocket.OPEN;
const CONNECTING = WebSocket.CONNECTING;
const CLOSING = WebSocket.CLOSING;
const CLOSE_DELAY_MS = 1000;

let socket = null;
let reconnectTimer = null;
let closeTimer = null;
let reconnectAttempts = 0;
let shouldReconnect = false;
let closeWhenPossible = false;

const channelListeners = new Map();
const statusListeners = new Set();

const notifyConnectionState = (isConnected) => {
  for (const listener of statusListeners) {
    listener(isConnected);
  }
};

const hasActiveListeners = () =>
  statusListeners.size > 0 ||
  Array.from(channelListeners.values()).some((listeners) => listeners.size > 0);

const getActiveChannels = () =>
  Array.from(channelListeners.entries())
    .filter(([, listeners]) => listeners.size > 0)
    .map(([channel]) => channel);

const clearReconnectTimer = () => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
};

const clearCloseTimer = () => {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
};

const sendSubscriptionUpdate = (type, channels) => {
  if (!channels.length || socket?.readyState !== OPEN) return;
  try {
    socket.send(JSON.stringify({ type, channels }));
  } catch {}
};

const syncSubscriptions = () => {
  sendSubscriptionUpdate("subscribe", getActiveChannels());
};

const scheduleReconnect = () => {
  if (!shouldReconnect || !hasActiveListeners()) return;
  clearReconnectTimer();
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 15000);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    connectSocket();
  }, delay);
};

function connectSocket() {
  clearReconnectTimer();
  clearCloseTimer();

  if (!hasActiveListeners()) {
    shouldReconnect = false;
    return;
  }

  shouldReconnect = true;

  if (
    socket &&
    (socket.readyState === OPEN || socket.readyState === CONNECTING)
  ) {
    return;
  }

  closeWhenPossible = false;
  socket = new WebSocket(getWsUrl());

  socket.onopen = () => {
    reconnectAttempts = 0;
    notifyConnectionState(true);
    syncSubscriptions();

    if (closeWhenPossible && !hasActiveListeners()) {
      try {
        socket?.close();
      } catch {}
    }
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      const listeners = channelListeners.get(msg.channel);
      if (!listeners?.size || !msg.type) return;
      for (const listener of listeners) {
        listener(msg);
      }
    } catch {}
  };

  socket.onerror = () => {
    notifyConnectionState(false);
  };

  socket.onclose = () => {
    notifyConnectionState(false);
    socket = null;
    if (shouldReconnect && hasActiveListeners()) {
      scheduleReconnect();
    }
  };
}

const scheduleCloseIfIdle = () => {
  clearCloseTimer();
  if (hasActiveListeners()) return;

  shouldReconnect = false;
  closeTimer = setTimeout(() => {
    if (hasActiveListeners()) return;
    clearReconnectTimer();

    if (!socket) return;

    if (socket.readyState === CONNECTING) {
      closeWhenPossible = true;
      return;
    }

    if (socket.readyState !== CLOSING) {
      try {
        socket.close();
      } catch {}
    }
  }, CLOSE_DELAY_MS);
};

const subscribeToChannel = (channel, listener) => {
  clearCloseTimer();

  let listeners = channelListeners.get(channel);
  if (!listeners) {
    listeners = new Set();
    channelListeners.set(channel, listeners);
  }

  const needsSubscribe = listeners.size === 0;
  listeners.add(listener);
  connectSocket();

  if (needsSubscribe) {
    sendSubscriptionUpdate("subscribe", [channel]);
  }

  return () => {
    const currentListeners = channelListeners.get(channel);
    if (!currentListeners) return;

    currentListeners.delete(listener);
    if (currentListeners.size === 0) {
      channelListeners.delete(channel);
      sendSubscriptionUpdate("unsubscribe", [channel]);
    }

    scheduleCloseIfIdle();
  };
};

const subscribeToStatus = (listener) => {
  clearCloseTimer();
  statusListeners.add(listener);
  listener(socket?.readyState === OPEN);
  connectSocket();

  return () => {
    statusListeners.delete(listener);
    scheduleCloseIfIdle();
  };
};

export function useWebSocketChannel(channel, onMessage, options = {}) {
  const { enabled = true } = options;
  const onMessageRef = useRef(onMessage);
  const [isConnected, setIsConnected] = useState(socket?.readyState === OPEN);
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
