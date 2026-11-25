import http from "node:http";
import * as v from "valibot";
import { WebSocket, type RawData } from "ws";
import { appOrigin } from "../../middleware/security.ts";
import {
  FRAME_PING,
  FRAME_PONG,
  FRAME_REQ_DATA,
  FRAME_REQ_END,
  FRAME_REQ_HEAD,
  FRAME_RES_DATA,
  FRAME_RES_END,
  FRAME_RES_HEAD,
  FRAME_STREAM_PAUSE,
  FRAME_STREAM_RESUME,
  FRAME_STREAM_RST,
  FRAME_TICKET_REFRESH,
  FRAME_WS_ACCEPTED,
  FRAME_WS_CLOSE,
  FRAME_WS_DATA_BIN,
  FRAME_WS_DATA_TEXT,
  FRAME_WS_OPEN,
  TUNNEL_CLOSE_EXPIRED,
  TUNNEL_CLOSE_REPLACED,
  decodeFrame,
  decodeJsonPayload,
  decodeTextPayload,
  encodeFrame,
  encodeJsonFrame,
  encodeTextFrame,
  filterHeaders,
  parseReqHead,
  parseWsClose,
  parseWsOpen,
  safeWsCloseCode,
  safeWsCloseReason,
} from "../../../lib/connectTunnel.ts";
import { asAppError } from "../../../lib/errors.ts";
import { authorized, hubLinksEnabled, hubRequest, linkedLink, refusalOf } from "../hubLink.ts";
import { logger } from "../logger.ts";
import { getShareInstance, SHARE_ORIGIN } from "../shareLinks/store.ts";
import { reconcileShareTunnel } from "../shareLinks/tunnel.ts";
import {
  CONNECT_CLIENT_IP_HEADER,
  startConnectListener,
  type ConnectListenerHandle,
} from "./connectListener.ts";
import { detectLanHints, getConnectConfig, setConnectConfig } from "./connectStore.ts";

declare function clearTimeout(timeout: NodeJS.Timeout | string | number | null | undefined): void;

const RETRY_DELAYS_MS = [2000, 5000, 15000, 30000, 60000] as const;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_PENDING_WS_MESSAGES = 64;
const MAX_PENDING_WS_BYTES = 256 * 1024;
const PING_INTERVAL_MS = 25_000;

export type ConnectRuntimeState =
  | "off"
  | "connecting"
  | "online"
  | "subscription_required"
  | "replaced"
  | "error";

const ticketResponseSchema = v.object({
  ticket: v.string(),
  expiresAt: v.number(),
  slug: v.string(),
  connectUrl: v.string(),
  relayUrl: v.string(),
});

const serverInfoSchema = v.object({
  instanceId: v.string(),
  slug: v.string(),
  connectUrl: v.string(),
  name: v.string(),
  lanHints: v.array(v.string()),
});

const registerResponseSchema = v.object({
  server: serverInfoSchema,
});

export class ConnectServiceError extends Error {
  status: 400 | 403 | 404 | 409 | 422 | 502;
  code: string;

  constructor(status: 400 | 403 | 404 | 409 | 422 | 502, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type LocalHttpStream = {
  req: http.ClientRequest;
  res: http.IncomingMessage | null;
  pausedByRelay: boolean;
  pausedByBuffer: boolean;
};

type LocalWsStream = {
  ws: WebSocket;
  open: boolean;
  pending: (string | Uint8Array)[];
  pendingBytes: number;
};

function toBytes(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) {
    const joined = Buffer.concat(data);
    return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength);
  }
  return new Uint8Array(data);
}

function safeCloseWs(target: WebSocket, code: number | undefined, reason?: string) {
  if (target.readyState !== WebSocket.OPEN && target.readyState !== WebSocket.CONNECTING) return;
  try {
    target.close(safeWsCloseCode(code), safeWsCloseReason(reason));
  } catch {
    target.terminate();
  }
}

export interface TunnelSessionOptions {
  relayUrl: string;
  ticket: string;
  expiresAt: number;
  connectPort: number;
  refreshTicket?: () => Promise<{ ticket: string; expiresAt: number } | null>;
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
}

export interface TunnelSession {
  ws: WebSocket;
  close: () => void;
}

export function openTunnelSession(options: TunnelSessionOptions): TunnelSession {
  const ws = new WebSocket(options.relayUrl, {
    headers: { authorization: `Bearer ${options.ticket}` },
    perMessageDeflate: false,
  });

  const httpStreams = new Map<number, LocalHttpStream>();
  const wsStreams = new Map<number, LocalWsStream>();
  let refreshTimer: NodeJS.Timeout | null = null;
  let pingTimer: NodeJS.Timeout | null = null;
  let closed = false;

  const scheduleRefresh = (expiresAt: number, retryDelayMs?: number) => {
    clearTimeout(refreshTimer);
    refreshTimer = null;
    if (!options.refreshTicket || closed || ws.readyState !== WebSocket.OPEN) return;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) return;
    const delay =
      retryDelayMs !== undefined
        ? Math.min(retryDelayMs, Math.max(remaining - 2_000, 1_000))
        : Math.max(Math.floor(remaining * 0.65), 1_000);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      void options
        .refreshTicket?.()
        .catch(() => null)
        .then((next) => {
          if (closed || ws.readyState !== WebSocket.OPEN) return;
          if (!next) {
            const left = expiresAt - Date.now();
            if (left > 5_000) {
              const nextRetry =
                retryDelayMs === undefined ? 10_000 : Math.min(retryDelayMs * 2, 60_000);
              scheduleRefresh(expiresAt, nextRetry);
            }
            return;
          }
          ws.send(encodeTextFrame(FRAME_TICKET_REFRESH, 0, next.ticket));
          scheduleRefresh(next.expiresAt);
        });
    }, delay);
    refreshTimer.unref();
  };

  ws.on("open", () => {
    scheduleRefresh(options.expiresAt);
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encodeFrame(FRAME_PING, 0));
    }, PING_INTERVAL_MS);
    pingTimer.unref();
    options.onOpen?.();
  });

  ws.on("message", (raw, isBinary) => {
    if (!isBinary) return;
    const frame = decodeFrame(toBytes(raw));
    if (!frame) return;

    if (frame.type === FRAME_PING) {
      if (ws.readyState === WebSocket.OPEN) ws.send(encodeFrame(FRAME_PONG, 0));
      return;
    }
    if (frame.type === FRAME_PONG) return;

    if (frame.type === FRAME_REQ_HEAD) {
      const head = decodeJsonPayload(frame.payload, parseReqHead);
      if (!head) {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(encodeFrame(FRAME_STREAM_RST, frame.streamId));
        return;
      }
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of head.headers) {
        const lower = name.toLowerCase();
        if (lower === CONNECT_CLIENT_IP_HEADER) continue;
        const existing = headers[lower];
        if (existing === undefined) headers[lower] = value;
        else if (Array.isArray(existing)) existing.push(value);
        else headers[lower] = [existing, value];
      }
      if (head.remoteIp) headers[CONNECT_CLIENT_IP_HEADER] = head.remoteIp;

      let localReq: http.ClientRequest;
      try {
        localReq = http.request(
          {
            host: "127.0.0.1",
            port: options.connectPort,
            method: head.method,
            path: head.path,
            headers,
          },
          (localRes) => {
            const entry = httpStreams.get(frame.streamId);
            if (!entry || ws.readyState !== WebSocket.OPEN) {
              localRes.destroy();
              return;
            }
            entry.res = localRes;
            ws.send(
              encodeJsonFrame(FRAME_RES_HEAD, frame.streamId, {
                status: localRes.statusCode ?? 500,
                headers: filterHeaders(localRes.headers),
              }),
            );
            localRes.on("data", (chunk: Buffer) => {
              if (ws.readyState !== WebSocket.OPEN) {
                localRes.destroy();
                return;
              }
              ws.send(
                encodeFrame(
                  FRAME_RES_DATA,
                  frame.streamId,
                  new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
                ),
              );
              if (ws.bufferedAmount > MAX_BUFFERED_BYTES && !entry.pausedByBuffer) {
                entry.pausedByBuffer = true;
                localRes.pause();
                const drainCheck = setInterval(() => {
                  if (
                    closed ||
                    ws.readyState !== WebSocket.OPEN ||
                    ws.bufferedAmount <= MAX_BUFFERED_BYTES / 2
                  ) {
                    clearInterval(drainCheck);
                    entry.pausedByBuffer = false;
                    if (!entry.pausedByRelay && !localRes.destroyed) localRes.resume();
                  }
                }, 10);
                drainCheck.unref();
              }
            });
            localRes.on("end", () => {
              httpStreams.delete(frame.streamId);
              if (ws.readyState === WebSocket.OPEN)
                ws.send(encodeFrame(FRAME_RES_END, frame.streamId));
            });
            localRes.on("error", () => {
              httpStreams.delete(frame.streamId);
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(encodeFrame(FRAME_STREAM_RST, frame.streamId));
              }
            });
          },
        );
      } catch {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(encodeFrame(FRAME_STREAM_RST, frame.streamId));
        return;
      }

      httpStreams.set(frame.streamId, {
        req: localReq,
        res: null,
        pausedByRelay: false,
        pausedByBuffer: false,
      });
      localReq.on("error", () => {
        httpStreams.delete(frame.streamId);
        if (ws.readyState === WebSocket.OPEN)
          ws.send(encodeFrame(FRAME_STREAM_RST, frame.streamId));
      });
      return;
    }

    if (frame.type === FRAME_REQ_DATA) {
      httpStreams.get(frame.streamId)?.req.write(frame.payload);
      return;
    }

    if (frame.type === FRAME_REQ_END) {
      httpStreams.get(frame.streamId)?.req.end();
      return;
    }

    if (frame.type === FRAME_STREAM_PAUSE) {
      const entry = httpStreams.get(frame.streamId);
      if (entry) {
        entry.pausedByRelay = true;
        entry.res?.pause();
      }
      return;
    }

    if (frame.type === FRAME_STREAM_RESUME) {
      const entry = httpStreams.get(frame.streamId);
      if (entry) {
        entry.pausedByRelay = false;
        if (!entry.pausedByBuffer && entry.res && !entry.res.destroyed) entry.res.resume();
      }
      return;
    }

    if (frame.type === FRAME_STREAM_RST) {
      const entry = httpStreams.get(frame.streamId);
      if (entry) {
        httpStreams.delete(frame.streamId);
        entry.res?.destroy();
        entry.req.destroy();
      }
      const localWs = wsStreams.get(frame.streamId);
      if (localWs) {
        wsStreams.delete(frame.streamId);
        safeCloseWs(localWs.ws, 1000);
      }
      return;
    }

    if (frame.type === FRAME_WS_OPEN) {
      const open = decodeJsonPayload(frame.payload, parseWsOpen);
      if (!open || !open.path.startsWith("/ws") || open.path.includes("#")) {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(encodeFrame(FRAME_STREAM_RST, frame.streamId));
        return;
      }
      let localWs: WebSocket;
      try {
        localWs = new WebSocket(`ws://127.0.0.1:${options.connectPort}${open.path}`, {
          headers: open.remoteIp ? { [CONNECT_CLIENT_IP_HEADER]: open.remoteIp } : undefined,
        });
      } catch {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(encodeFrame(FRAME_STREAM_RST, frame.streamId));
        return;
      }
      const stream: LocalWsStream = { ws: localWs, open: false, pending: [], pendingBytes: 0 };
      wsStreams.set(frame.streamId, stream);
      localWs.on("open", () => {
        stream.open = true;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(encodeJsonFrame(FRAME_WS_ACCEPTED, frame.streamId, {}));
        }
        for (const queued of stream.pending) {
          if (localWs.readyState === WebSocket.OPEN) localWs.send(queued);
        }
        stream.pending.length = 0;
        stream.pendingBytes = 0;
      });
      localWs.on("message", (data, binary) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (binary) {
          ws.send(encodeFrame(FRAME_WS_DATA_BIN, frame.streamId, toBytes(data)));
        } else {
          ws.send(
            encodeTextFrame(FRAME_WS_DATA_TEXT, frame.streamId, decodeTextPayload(toBytes(data))),
          );
        }
      });
      localWs.on("close", (code, reason) => {
        wsStreams.delete(frame.streamId);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            encodeJsonFrame(FRAME_WS_CLOSE, frame.streamId, {
              code: safeWsCloseCode(code),
              reason: safeWsCloseReason(reason.toString("utf8")),
            }),
          );
        }
      });
      localWs.on("error", () => {
        wsStreams.delete(frame.streamId);
        if (ws.readyState === WebSocket.OPEN)
          ws.send(encodeFrame(FRAME_STREAM_RST, frame.streamId));
      });
      return;
    }

    if (frame.type === FRAME_WS_DATA_TEXT || frame.type === FRAME_WS_DATA_BIN) {
      const stream = wsStreams.get(frame.streamId);
      if (!stream) return;
      const item =
        frame.type === FRAME_WS_DATA_TEXT ? decodeTextPayload(frame.payload) : frame.payload;
      if (stream.open && stream.ws.readyState === WebSocket.OPEN) {
        stream.ws.send(item);
      } else if (
        !stream.open &&
        stream.pending.length < MAX_PENDING_WS_MESSAGES &&
        stream.pendingBytes + frame.payload.byteLength <= MAX_PENDING_WS_BYTES
      ) {
        stream.pending.push(item);
        stream.pendingBytes += frame.payload.byteLength;
      } else if (!stream.open) {
        wsStreams.delete(frame.streamId);
        stream.ws.terminate();
        if (ws.readyState === WebSocket.OPEN)
          ws.send(encodeFrame(FRAME_STREAM_RST, frame.streamId));
      }
      return;
    }

    if (frame.type === FRAME_WS_CLOSE) {
      const stream = wsStreams.get(frame.streamId);
      const closedPayload = decodeJsonPayload(frame.payload, parseWsClose);
      if (stream) {
        wsStreams.delete(frame.streamId);
        safeCloseWs(stream.ws, closedPayload?.code, closedPayload?.reason);
      }
    }
  });

  const cleanup = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    clearTimeout(refreshTimer);
    if (pingTimer) clearInterval(pingTimer);
    for (const entry of httpStreams.values()) {
      entry.res?.destroy();
      entry.req.destroy();
    }
    httpStreams.clear();
    for (const stream of wsStreams.values()) {
      safeCloseWs(stream.ws, 1012);
    }
    wsStreams.clear();
    options.onClose?.(code, reason);
  };

  ws.on("close", (code, reason) => cleanup(code, reason.toString("utf8")));
  ws.on("error", (error) => cleanup(1006, asAppError(error)?.message ?? "Tunnel error"));

  return {
    ws,
    close() {
      cleanup(1000, "Client closing");
      safeCloseWs(ws, 1000, "Client closing");
    },
  };
}

let listener: ConnectListenerHandle | null = null;
let session: TunnelSession | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let deferredTransportTimer: NodeJS.Timeout | null = null;
let retryAttempt = 0;
let runtimeState: ConnectRuntimeState = "off";
let lastError: string | null = null;
let syncing = Promise.resolve();

const delayFor = (attempt: number) =>
  RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? RETRY_DELAYS_MS[0];

function clearDeferredTransport() {
  clearTimeout(deferredTransportTimer);
  deferredTransportTimer = null;
}

function scheduleDeferredTransport(task: () => Promise<void>) {
  clearDeferredTransport();
  deferredTransportTimer = setTimeout(() => {
    deferredTransportTimer = null;
    void task().catch((error) => {
      logger.error("connect", "Deferred Connect update failed:", {
        message: asAppError(error)?.message ?? "unknown",
      });
    });
  }, 150);
  deferredTransportTimer.unref();
}

function detachAndCloseSession() {
  const current = session;
  session = null;
  current?.close();
}

async function requestHubTicket(hubOrigin: string) {
  const { id: instanceId, secret } = getShareInstance();
  const response = await hubRequest(hubOrigin, "/v1/connect/ticket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instanceId, secret, lanHints: detectLanHints() }),
  }).catch(() => null);
  if (!response) return { ok: false as const, kind: "network" as const };
  if (response.status === 403) {
    const code = await refusalOf(response);
    return {
      ok: false as const,
      kind:
        code === "subscription_required" ? ("subscription_required" as const) : ("error" as const),
      code,
    };
  }
  if (response.status === 404) return { ok: false as const, kind: "not_enabled" as const };
  const parsed = response.ok
    ? v.safeParse(ticketResponseSchema, await response.json().catch(() => null))
    : null;
  if (!parsed?.success)
    return { ok: false as const, kind: "error" as const, code: "invalid_ticket" };
  return { ok: true as const, ...parsed.output };
}

function scheduleReconnect() {
  clearTimeout(retryTimer);
  retryTimer = null;
  const config = getConnectConfig();
  if (!config.enabled || !hubLinksEnabled()) return;
  const delay = delayFor(retryAttempt);
  retryAttempt += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void syncConnect();
  }, delay);
  retryTimer.unref();
}

async function applyConnectState() {
  clearTimeout(retryTimer);
  retryTimer = null;
  const config = getConnectConfig();
  if (!config.enabled || !hubLinksEnabled()) {
    detachAndCloseSession();
    if (listener) {
      const current = listener;
      listener = null;
      await current.close();
    }
    runtimeState = "off";
    lastError = null;
    void reconcileShareTunnel();
    return;
  }

  if (!listener) {
    listener = await startConnectListener();
    logger.info("connect", `Connect listener running on 127.0.0.1:${listener.port}`);
  }
  if (session) return;

  const hubOrigin = config.hubOrigin || SHARE_ORIGIN;
  runtimeState = "connecting";
  const ticket = await requestHubTicket(hubOrigin);
  if (!ticket.ok) {
    if (ticket.kind === "subscription_required") {
      runtimeState = "subscription_required";
      lastError = "An active Aurral Connect subscription is required.";
      void reconcileShareTunnel();
      scheduleReconnect();
      return;
    }
    if (ticket.kind === "not_enabled") {
      setConnectConfig({ enabled: false, allowHubSignIn: false });
      runtimeState = "off";
      lastError = null;
      void reconcileShareTunnel();
      return;
    }
    runtimeState = "error";
    lastError = "Couldn't reach aurral.org for a Connect ticket.";
    scheduleReconnect();
    return;
  }

  if (ticket.slug !== config.slug || ticket.connectUrl !== config.connectUrl) {
    setConnectConfig({ slug: ticket.slug, connectUrl: ticket.connectUrl });
  }

  const activeSession = openTunnelSession({
    relayUrl: ticket.relayUrl,
    ticket: ticket.ticket,
    expiresAt: ticket.expiresAt,
    connectPort: listener.port,
    refreshTicket: async () => {
      const next = await requestHubTicket(hubOrigin);
      return next.ok ? { ticket: next.ticket, expiresAt: next.expiresAt } : null;
    },
    onOpen: () => {
      if (session !== activeSession) return;
      retryAttempt = 0;
      runtimeState = "online";
      lastError = null;
      logger.info("connect", `Aurral Connect is online at ${ticket.connectUrl}`);
      void reconcileShareTunnel();
    },
    onClose: (code, reason) => {
      if (session !== activeSession) return;
      session = null;
      if (code === TUNNEL_CLOSE_REPLACED) {
        runtimeState = "replaced";
        lastError =
          "Another Aurral instance connected with this server's identity (for example, a restored backup).";
        logger.warn("connect", lastError);
        void reconcileShareTunnel();
        return;
      }
      if (code === TUNNEL_CLOSE_EXPIRED) {
        runtimeState = "connecting";
      } else {
        runtimeState = "error";
        lastError = reason || "Connect tunnel disconnected.";
      }
      void reconcileShareTunnel();
      scheduleReconnect();
    },
  });
  session = activeSession;
}

export function syncConnect() {
  syncing = syncing.then(applyConnectState).catch((error) => {
    runtimeState = "error";
    lastError = asAppError(error)?.message ?? "Connect sync failed";
    logger.error("connect", "Could not update Aurral Connect:", { message: lastError });
  });
  return syncing;
}

export async function stopConnect() {
  clearDeferredTransport();
  clearTimeout(retryTimer);
  retryTimer = null;
  await syncing;
  detachAndCloseSession();
  if (listener) {
    const current = listener;
    listener = null;
    await current.close();
  }
  runtimeState = "off";
  void reconcileShareTunnel();
}

export function activeConnectOrigin(): string | null {
  const config = getConnectConfig();
  return config.enabled && runtimeState === "online" && config.connectUrl
    ? config.connectUrl
    : null;
}

const connectAccountSchema = v.object({
  entitlement: v.object({
    status: v.string(),
    active: v.boolean(),
    maxServers: v.number(),
    currentPeriodEnd: v.nullable(v.number()),
    trialAvailable: v.boolean(),
  }),
  serverCount: v.number(),
});

export function getConnectStatus() {
  const config = getConnectConfig();
  const connectDomain = (process.env.AURRAL_CONNECT_DOMAIN || "aurral.dev")
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase();
  return {
    available: hubLinksEnabled(),
    enabled: config.enabled,
    allowHubSignIn: config.allowHubSignIn,
    slug: config.slug,
    name: config.name,
    connectUrl: config.connectUrl,
    hubOrigin: config.hubOrigin || SHARE_ORIGIN,
    appOrigin,
    connectDomain,
    state: runtimeState,
    lastError,
    lanHints: detectLanHints(),
  };
}

export async function getConnectAccount(userId: number) {
  if (!hubLinksEnabled()) return null;
  const link = linkedLink(userId);
  if (!link) return null;
  const response = await hubRequest(
    link.origin,
    "/v1/connect/account",
    authorized(link, "GET"),
  ).catch(() => null);
  if (!response?.ok) return null;
  const parsed = v.safeParse(connectAccountSchema, await response.json().catch(() => null));
  return parsed.success ? parsed.output : null;
}

export async function reconnectConnect() {
  const config = getConnectConfig();
  if (!config.enabled) {
    throw new ConnectServiceError(404, "connect_not_enabled", "Aurral Connect isn't enabled.");
  }
  clearDeferredTransport();
  clearTimeout(retryTimer);
  retryTimer = null;
  retryAttempt = 0;
  lastError = null;
  detachAndCloseSession();
  await syncConnect();
  return getConnectStatus();
}

function mapHubRefusal(status: number, code: string | null): ConnectServiceError {
  if (code === "subscription_required") {
    return new ConnectServiceError(
      403,
      code,
      "Start your 14-day trial or subscribe to Aurral Connect first.",
    );
  }
  if (code === "server_limit_reached") {
    return new ConnectServiceError(
      403,
      code,
      "Your Aurral Connect plan has reached its server limit.",
    );
  }
  if (code === "server_already_owned") {
    return new ConnectServiceError(
      409,
      code,
      "This server is already connected to another aurral.org account.",
    );
  }
  if (code === "slug_taken") {
    return new ConnectServiceError(409, code, "That *.aurral.dev address is already taken.");
  }
  if (code === "slug_reserved" || code === "slug_not_allowed") {
    return new ConnectServiceError(422, code, "That address isn't available. Pick another.");
  }
  if (code === "slug_invalid") {
    return new ConnectServiceError(
      400,
      code,
      "Use 3 to 32 lowercase letters, numbers, or hyphens.",
    );
  }
  if (status === 401) {
    return new ConnectServiceError(
      403,
      "link_required",
      "Link your aurral.org account before enabling Connect.",
    );
  }
  return new ConnectServiceError(502, code ?? "hub_error", "Couldn't reach aurral.org. Try again.");
}

export async function enableConnect(
  userId: number,
  params: {
    slug: string;
    name: string;
    startTrial?: boolean;
    allowHubSignIn?: boolean;
    deferTransportChange?: boolean;
  },
) {
  if (!hubLinksEnabled()) {
    throw new ConnectServiceError(403, "accounts_disabled", "aurral.org accounts are turned off.");
  }
  const link = linkedLink(userId);
  if (!link) {
    throw new ConnectServiceError(403, "link_required", "Link your aurral.org account first.");
  }
  const previousSlug = getConnectConfig().slug;
  const { id: instanceId, secret } = getShareInstance();
  const response = await hubRequest(
    link.origin,
    "/v1/connect/servers",
    authorized(link, "POST", {
      instanceId,
      secret,
      slug: params.slug,
      name: params.name,
      lanHints: detectLanHints(),
      startTrial: params.startTrial,
    }),
  ).catch(() => null);
  if (!response) {
    throw new ConnectServiceError(502, "hub_unreachable", "Couldn't reach aurral.org. Try again.");
  }
  if (!response.ok) {
    throw mapHubRefusal(response.status, await refusalOf(response));
  }
  const parsed = v.safeParse(registerResponseSchema, await response.json().catch(() => null));
  if (!parsed.success) {
    throw new ConnectServiceError(
      502,
      "hub_invalid_response",
      "Unexpected response from aurral.org.",
    );
  }
  clearDeferredTransport();
  const slugChanged = previousSlug !== null && previousSlug !== parsed.output.server.slug;
  setConnectConfig({
    enabled: true,
    allowHubSignIn: params.allowHubSignIn !== false,
    slug: parsed.output.server.slug,
    name: parsed.output.server.name,
    connectUrl: parsed.output.server.connectUrl,
    hubOrigin: link.origin,
  });
  if (slugChanged) {
    const reconnect = async () => {
      detachAndCloseSession();
      await syncConnect();
      void reconcileShareTunnel();
    };
    if (params.deferTransportChange) {
      scheduleDeferredTransport(reconnect);
    } else {
      await reconnect();
    }
  } else {
    await syncConnect();
  }
  return getConnectStatus();
}

export async function updateConnect(
  userId: number,
  params: {
    slug?: string;
    name?: string;
    allowHubSignIn?: boolean;
    deferTransportChange?: boolean;
  },
) {
  const config = getConnectConfig();
  if (!config.enabled) {
    throw new ConnectServiceError(404, "connect_not_enabled", "Aurral Connect isn't enabled.");
  }
  if (params.slug !== undefined || params.name !== undefined) {
    const link = linkedLink(userId);
    if (!link) {
      throw new ConnectServiceError(403, "link_required", "Link your aurral.org account first.");
    }
    const { id: instanceId } = getShareInstance();
    const response = await hubRequest(
      link.origin,
      `/v1/connect/servers/${encodeURIComponent(instanceId)}`,
      authorized(link, "PATCH", {
        ...(params.slug !== undefined && { slug: params.slug }),
        ...(params.name !== undefined && { name: params.name }),
        lanHints: detectLanHints(),
      }),
    ).catch(() => null);
    if (!response) {
      throw new ConnectServiceError(
        502,
        "hub_unreachable",
        "Couldn't reach aurral.org. Try again.",
      );
    }
    if (!response.ok) throw mapHubRefusal(response.status, await refusalOf(response));
    const parsed = v.safeParse(registerResponseSchema, await response.json().catch(() => null));
    if (!parsed.success) {
      throw new ConnectServiceError(
        502,
        "hub_invalid_response",
        "Unexpected response from aurral.org.",
      );
    }
    const slugChanged = parsed.output.server.slug !== config.slug;
    setConnectConfig({
      slug: parsed.output.server.slug,
      name: parsed.output.server.name,
      connectUrl: parsed.output.server.connectUrl,
      ...(params.allowHubSignIn !== undefined && { allowHubSignIn: params.allowHubSignIn }),
    });
    if (slugChanged) {
      clearDeferredTransport();
      const reconnect = async () => {
        detachAndCloseSession();
        await syncConnect();
        void reconcileShareTunnel();
      };
      if (params.deferTransportChange) {
        scheduleDeferredTransport(reconnect);
      } else {
        await reconnect();
      }
    }
    return getConnectStatus();
  }
  if (params.allowHubSignIn !== undefined) {
    setConnectConfig({ allowHubSignIn: params.allowHubSignIn });
  }
  return getConnectStatus();
}

export async function disableConnect(
  userId: number,
  options: { deferTransportChange?: boolean } = {},
) {
  const link = linkedLink(userId);
  const config = getConnectConfig();
  if (link && config.enabled) {
    const { id: instanceId } = getShareInstance();
    await hubRequest(
      link.origin,
      `/v1/connect/servers/${encodeURIComponent(instanceId)}`,
      authorized(link, "DELETE"),
    ).catch(() => null);
  }
  clearDeferredTransport();
  setConnectConfig({ enabled: false, allowHubSignIn: false });
  if (options.deferTransportChange) {
    clearTimeout(retryTimer);
    retryTimer = null;
    scheduleDeferredTransport(() => stopConnect());
    return { ...getConnectStatus(), state: "off" as const };
  }
  await stopConnect();
  return getConnectStatus();
}
