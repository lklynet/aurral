import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { IncomingMessage, Server } from "node:http";
import { EventEmitter } from "node:events";
import { dbOps, userOps } from "../db/helpers/index.ts";
import { logger } from "./logger.ts";
import { noteDeprecatedUsage } from "./deprecatedUsage.ts";
import {
  getAuthPassword,
  isProxyAuthEnabled,
  resolveLocalNetworkBypassUser,
  resolveSessionUserFromToken,
  resolveProxyUser,
} from "../middleware/auth.ts";
import type { getPlaylistStatusSnapshot } from "./playlists/playlistStatusSnapshot.ts";
import type { getDiscoveryMode } from "./discovery/helpers.ts";

type DownloadStatusEntry = { status: string; updatedAt: string; progress?: number };

type DiscoveryUpdateFields = {
  isUpdating: boolean;
  configured?: boolean;
  phase?: string | null;
  progress?: number;
  progressMessage?: string;
  error?: string;
  reason?: string;
  provider?: string | null;
  lastUpdated?: string | null;
  discoveryMode?: ReturnType<typeof getDiscoveryMode>;
};

export type WebSocketChannelPayload =
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
  | ({ type: "discovery_update" } & DiscoveryUpdateFields);

export type WebSocketServerMessage =
  | { type: "connected"; clientId: string; subscriptions: string[] }
  | { type: "subscribed"; channels: string[]; subscriptions: string[] }
  | { type: "unsubscribed"; channels: string[]; subscriptions: string[] }
  | { type: "pong"; timestamp: number }
  | ({ channel: string; timestamp: number } & WebSocketChannelPayload);

type ClientMessage = { type?: string; channels?: string[] };

type ClientUser = NonNullable<ReturnType<typeof resolveSessionUserFromToken>>;

type WebSocketClient = {
  id: string;
  ws: WebSocket;
  user: ClientUser | null;
  authSource: "session" | "local-network-bypass" | null;
  subscriptions: Set<string>;
  connectedAt: number;
  _lastPlaylistStatusHashByChannel?: Map<string, string>;
};

const isAuthRequired = () => {
  const settings = dbOps.getSettings();
  if (!settings.onboardingComplete) return false;
  const users = userOps.getAllUsers();
  const legacyPasswords = getAuthPassword();
  return isProxyAuthEnabled() || users.length > 0 || legacyPasswords.length > 0;
};

class WebSocketService extends EventEmitter {
  declare wss: WebSocketServer | null;
  declare clients: Set<WebSocketClient>;
  declare subscriptions: Map<string, unknown>;
  declare startTime: number;

  constructor() {
    super();
    this.wss = null;
    this.clients = new Set();
    this.subscriptions = new Map();
    this.startTime = Date.now();
  }

  initialize(server: Server) {
    this.startTime = Date.now();
    this.wss = new WebSocketServer({
      server,
      path: "/ws",
    });

    this.wss.on("connection", (ws, req) => {
      this.handleConnection(ws, req);
    });

    logger.info("system", "WebSocket server initialized on /ws");
    return this;
  }

  handleConnection(ws: WebSocket, req: IncomingMessage) {
    let sessionUser: WebSocketClient["user"] = null;
    let authSource: WebSocketClient["authSource"] = null;
    if (isAuthRequired()) {
      const requestUrl = new URL(req.url || "", "http://localhost");
      const token = requestUrl.searchParams.get("token");
      sessionUser = resolveSessionUserFromToken(token);
      if (!sessionUser) {
        sessionUser = resolveProxyUser(req);
      }
      if (sessionUser) {
        authSource = "session";
      } else {
        sessionUser = resolveLocalNetworkBypassUser({
          headers: req.headers || {},
          socket: req.socket || {},
          connection: req.connection || {},
          ip: req.socket?.remoteAddress || "",
          ips: [],
        });
        if (sessionUser) {
          authSource = "local-network-bypass";
        }
      }
      if (!sessionUser) {
        ws.close(4401, "Unauthorized");
        return;
      }
    }

    const clientId = this.generateClientId();

    const client: WebSocketClient = {
      id: clientId,
      ws,
      user: sessionUser,
      authSource,
      subscriptions: new Set(["status"]),
      connectedAt: Date.now(),
    };

    this.clients.add(client);
    logger.info("system", "Client connected", { clientId, totalClients: this.clients.size });

    ws.on("message", (message) => {
      this.handleMessage(client, message);
    });

    ws.on("close", () => {
      this.clients.delete(client);
      delete client._lastPlaylistStatusHashByChannel;
      this.emit("subscriptions-changed");
      logger.info("system", "Client disconnected", { clientId, totalClients: this.clients.size });
    });

    ws.on("error", (error) => {
      logger.error("system", "Client error", { clientId, error: error.message });
      this.clients.delete(client);
      delete client._lastPlaylistStatusHashByChannel;
      this.emit("subscriptions-changed");
    });

    this.send(client, {
      type: "connected",
      clientId,
      subscriptions: Array.from(client.subscriptions),
    });
  }

  handleMessage(client: WebSocketClient, rawMessage: RawData) {
    try {
      const message: ClientMessage | null = JSON.parse(rawMessage.toString());

      switch (message.type) {
        case "subscribe":
          this.handleSubscribe(client, message.channels || []);
          break;
        case "unsubscribe":
          this.handleUnsubscribe(client, message.channels || []);
          break;
        case "ping":
          this.send(client, { type: "pong", timestamp: Date.now() });
          break;
        default:
          logger.warn("system", "Unknown WebSocket message type", { messageType: message.type });
      }
    } catch (error) {
      logger.error("system", "Failed to parse WebSocket message", { error: error.message });
    }
  }

  handleSubscribe(client: WebSocketClient, channels: string[]) {
    for (const channel of channels) {
      client.subscriptions.add(channel);
      if (channel === "weekly-flow") noteDeprecatedUsage("weekly-flow-channel");
    }

    this.send(client, {
      type: "subscribed",
      channels,
      subscriptions: Array.from(client.subscriptions),
    });
    this.emit("subscriptions-changed");
  }

  handleUnsubscribe(client: WebSocketClient, channels: string[]) {
    for (const channel of channels) {
      client.subscriptions.delete(channel);
      client._lastPlaylistStatusHashByChannel?.delete(channel);
      if (channel === "*") delete client._lastPlaylistStatusHashByChannel;
    }

    this.send(client, {
      type: "unsubscribed",
      channels,
      subscriptions: Array.from(client.subscriptions),
    });
    this.emit("subscriptions-changed");
  }

  send(client: WebSocketClient, data: WebSocketServerMessage) {
    if (client.ws.readyState === 1) {
      client.ws.send(JSON.stringify(data));
    }
  }

  broadcast(
    channel: string,
    data: WebSocketChannelPayload,
    { userId = null }: { userId?: number | null } = {},
  ) {
    if (process.env.AURRAL_BACKGROUND_WORKER_GROUP && process.connected && process.send) {
      process.send({ type: "websocket-broadcast", channel, data, userId });
      return 0;
    }
    const targetUserId = userId == null ? null : Number(userId);
    const message = JSON.stringify({
      channel,
      timestamp: Date.now(),
      ...data,
    });

    let sent = 0;
    for (const client of this.clients) {
      if (targetUserId != null && Number(client.user?.id) !== targetUserId) continue;
      if (client.subscriptions.has(channel) || client.subscriptions.has("*")) {
        if (client.ws.readyState === 1) {
          client.ws.send(message);
          sent++;
        }
      }
    }

    return sent;
  }

  broadcastPerClient(
    channel: string,
    buildData: (client: WebSocketClient) => WebSocketChannelPayload | null,
  ) {
    let sent = 0;
    for (const client of this.clients) {
      if (!(client.subscriptions.has(channel) || client.subscriptions.has("*"))) {
        continue;
      }
      if (client.ws.readyState !== 1) {
        continue;
      }
      const payload = buildData(client);
      if (!payload) {
        continue;
      }
      client.ws.send(
        JSON.stringify({
          channel,
          timestamp: Date.now(),
          ...payload,
        }),
      );
      sent++;
    }
    return sent;
  }

  reconcileAuthState() {
    for (const client of this.clients) {
      if (client.authSource !== "local-network-bypass") {
        continue;
      }
      if (client.ws.readyState !== 1) {
        continue;
      }
      try {
        client.ws.close(4401, "Unauthorized");
      } catch {}
    }
  }

  disconnectUser(userId: number) {
    const targetUserId = Number(userId);
    if (!Number.isFinite(targetUserId)) return 0;
    let disconnected = 0;
    for (const client of [...this.clients]) {
      if (Number(client.user?.id) !== targetUserId) continue;
      this.clients.delete(client);
      client.subscriptions.clear();
      delete client._lastPlaylistStatusHashByChannel;
      client.user = null;
      try {
        client.ws.close(4403, "Account inactive");
      } catch {}
      disconnected++;
    }
    if (disconnected) this.emit("subscriptions-changed");
    return disconnected;
  }

  emitDiscoveryUpdate(
    data: DiscoveryUpdateFields,
    { userId = null }: { userId?: number | null } = {},
  ) {
    this.broadcast(
      "discovery",
      {
        type: "discovery_update",
        ...data,
      },
      { userId },
    );
  }

  getStats() {
    const channelStats = {};
    for (const client of this.clients) {
      for (const channel of client.subscriptions) {
        channelStats[channel] = (channelStats[channel] || 0) + 1;
      }
    }

    return {
      totalClients: this.clients.size,
      channels: channelStats,
      uptime: this.wss ? Date.now() - this.startTime : 0,
    };
  }

  generateClientId() {
    return `ws_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  close() {
    if (this.wss) {
      for (const client of this.clients) {
        client.ws.close();
      }
      this.clients.clear();
      this.wss.close();
      this.wss = null;
      this.emit("subscriptions-changed");
    }
  }
}

export const websocketService = new WebSocketService();
