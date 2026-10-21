import type { getPlaylistStatusSnapshot } from "../../../backend/services/playlists/playlistStatusSnapshot.ts";
import { getRequestToken } from "./api/core.ts";

function getWsUrl() {
  const token = getRequestToken();
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

export type DownloadStatusEntry = { status: string; updatedAt: string; progress?: number };

export type ChannelMessage = { channel: string; timestamp: number } & (
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
type ChannelListener = (message: ChannelMessage) => void;
type StatusListener = (isConnected: boolean) => void;

const OPEN = WebSocket.OPEN;
const CONNECTING = WebSocket.CONNECTING;
const CLOSING = WebSocket.CLOSING;
const CLOSE_DELAY_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 30000;
const HEARTBEAT_TIMEOUT_MS = 10000;

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let shouldReconnect = false;
let closeWhenPossible = false;

const channelListeners = new Map<string, Set<ChannelListener>>();
const statusListeners = new Set<StatusListener>();

const notifyConnectionState = (isConnected: boolean) => {
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

const clearHeartbeatTimeout = () => {
  if (heartbeatTimeout) {
    clearTimeout(heartbeatTimeout);
    heartbeatTimeout = null;
  }
};

const clearHeartbeat = () => {
  clearHeartbeatTimeout();
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
};

const sendSubscriptionUpdate = (type: "subscribe" | "unsubscribe", channels: string[]) => {
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

const retireSocket = (currentSocket: WebSocket) => {
  if (socket !== currentSocket) return;
  socket = null;
  clearHeartbeat();
  notifyConnectionState(false);
  try {
    currentSocket.close(4000, "Heartbeat timeout");
  } catch {}
  if (shouldReconnect && hasActiveListeners()) {
    scheduleReconnect();
  }
};

const sendHeartbeat = (currentSocket: WebSocket) => {
  if (socket !== currentSocket || currentSocket.readyState !== OPEN) return false;
  clearHeartbeatTimeout();
  try {
    currentSocket.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
  } catch {
    retireSocket(currentSocket);
    return false;
  }
  heartbeatTimeout = setTimeout(() => {
    heartbeatTimeout = null;
    retireSocket(currentSocket);
  }, HEARTBEAT_TIMEOUT_MS);
  return true;
};

const startHeartbeat = (currentSocket: WebSocket) => {
  clearHeartbeat();
  if (!sendHeartbeat(currentSocket)) return;
  heartbeatInterval = setInterval(() => {
    sendHeartbeat(currentSocket);
  }, HEARTBEAT_INTERVAL_MS);
};

function connectSocket() {
  clearReconnectTimer();
  clearCloseTimer();

  if (!hasActiveListeners()) {
    shouldReconnect = false;
    return;
  }

  shouldReconnect = true;

  if (socket && (socket.readyState === OPEN || socket.readyState === CONNECTING)) {
    return;
  }

  closeWhenPossible = false;
  let currentSocket: WebSocket;
  try {
    currentSocket = new WebSocket(getWsUrl());
  } catch {
    socket = null;
    notifyConnectionState(false);
    scheduleReconnect();
    return;
  }
  socket = currentSocket;

  currentSocket.onopen = () => {
    if (socket !== currentSocket) {
      try {
        currentSocket.close();
      } catch {}
      return;
    }
    reconnectAttempts = 0;
    notifyConnectionState(true);
    syncSubscriptions();
    startHeartbeat(currentSocket);

    if (closeWhenPossible && !hasActiveListeners()) {
      try {
        socket?.close();
      } catch {}
    }
  };

  currentSocket.onmessage = (event) => {
    if (socket !== currentSocket) return;
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "pong") {
        clearHeartbeatTimeout();
        return;
      }
      const listeners = channelListeners.get(msg.channel);
      if (!listeners?.size || !msg.type) return;
      for (const listener of listeners) {
        listener(msg);
      }
    } catch {}
  };

  currentSocket.onerror = () => {
    if (socket !== currentSocket) return;
    notifyConnectionState(false);
  };

  currentSocket.onclose = () => {
    if (socket !== currentSocket) return;
    clearHeartbeat();
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
  clearHeartbeat();
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

export const subscribeToChannel = (channel: string, listener: ChannelListener) => {
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

export const subscribeToStatus = (listener: StatusListener) => {
  clearCloseTimer();
  statusListeners.add(listener);
  listener(socket?.readyState === OPEN);
  connectSocket();

  return () => {
    statusListeners.delete(listener);
    scheduleCloseIfIdle();
  };
};

export const isWebSocketOpen = () => socket?.readyState === OPEN;
