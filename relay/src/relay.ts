import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import * as v from "valibot";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  CONNECT_SLUG_PATTERN,
  connectJwksSchema,
  tunnelTicketSchema,
  verifyConnectToken,
  type ConnectPublicJwk,
  type TunnelTicketPayload,
} from "../../lib/connectTokens.ts";
import {
  FRAME_PING,
  FRAME_PONG,
  FRAME_REQ_DATA,
  FRAME_REQ_END,
  FRAME_REQ_HEAD,
  FRAME_RES_DATA,
  FRAME_RES_END,
  FRAME_RES_HEAD,
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
  isRootHtmlNavigation,
  resHeadSchema,
  safeWsCloseCode,
  wsAcceptedSchema,
  wsCloseSchema,
} from "../../lib/connectTunnel.ts";

export interface RelayOptions {
  connectDomain?: string;
  appOrigin?: string;
  hubOrigin?: string;
  relaySecret?: string;
  publicKeys?: readonly ConnectPublicJwk[];
  maxStreamsPerTunnel?: number;
  maxBufferedBytes?: number;
  expiryCheckIntervalMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

type PendingHttpStream = {
  kind: "http";
  res: ServerResponse;
  headersSent: boolean;
};

type PendingWsStream = {
  kind: "ws";
  ws: WebSocket;
  accepted: boolean;
};

type ActiveTunnel = {
  slug: string;
  instanceId: string;
  ws: WebSocket;
  expiresAtMs: number;
  nextStreamId: number;
  streams: Map<number, PendingHttpStream | PendingWsStream>;
};

const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_REFRESH_MS = 30 * 1000;
const REQUEST_HEADER_STRIP = new Set([
  "host",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "cf-connecting-ip",
  "forwarded",
]);

function toBytes(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) {
    const joined = Buffer.concat(data);
    return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength);
  }
  return new Uint8Array(data);
}

function extractSlug(hostHeader: string | undefined, connectDomain: string): string | null {
  if (!hostHeader) return null;
  const hostname = hostHeader.split(":")[0]?.trim().toLowerCase() ?? "";
  const suffix = `.${connectDomain}`;
  if (!hostname.endsWith(suffix)) return null;
  const slug = hostname.slice(0, -suffix.length);
  return CONNECT_SLUG_PATTERN.test(slug) ? slug : null;
}

function bearerOrQueryTicket(req: IncomingMessage): string | null {
  const auth = req.headers.authorization ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim() || null;
  try {
    const url = new URL(req.url ?? "/", "http://relay.local");
    return url.searchParams.get("ticket")?.trim() || null;
  } catch {
    return null;
  }
}

function rejectUpgrade(socket: Duplex, status: number, text: string) {
  socket.write(
    `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${text.length}\r\n\r\n${text}`,
  );
  socket.destroy();
}

export function createRelayServer(options: RelayOptions = {}) {
  const connectDomain = (options.connectDomain ?? "aurral.dev")
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase();
  const appOrigin = (options.appOrigin ?? "https://music.aurral.org").replace(/\/+$/, "");
  const hubOrigin = (options.hubOrigin ?? "https://aurral.org").replace(/\/+$/, "");
  const maxStreams = options.maxStreamsPerTunnel ?? 200;
  const maxBufferedBytes = options.maxBufferedBytes ?? 1024 * 1024;
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchImpl ?? fetch;

  let cachedKeys: readonly ConnectPublicJwk[] = options.publicKeys ?? [];
  let keysFetchedAt = options.publicKeys ? Number.POSITIVE_INFINITY : 0;

  async function loadPublicKeys(forceRefresh = false): Promise<readonly ConnectPublicJwk[]> {
    if (options.publicKeys) return options.publicKeys;
    const current = now();
    if (!forceRefresh && cachedKeys.length > 0 && current - keysFetchedAt < JWKS_CACHE_TTL_MS) {
      return cachedKeys;
    }
    if (forceRefresh && current - keysFetchedAt < JWKS_MIN_REFRESH_MS && cachedKeys.length > 0) {
      return cachedKeys;
    }
    try {
      const response = await fetchImpl(`${hubOrigin}/v1/connect/keys`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return cachedKeys;
      const parsed = v.safeParse(connectJwksSchema, await response.json());
      if (parsed.success) {
        cachedKeys = parsed.output.keys;
        keysFetchedAt = current;
      }
    } catch {
      return cachedKeys;
    }
    return cachedKeys;
  }

  async function verifyTicket(ticket: string): Promise<TunnelTicketPayload | null> {
    const keys = await loadPublicKeys(false);
    let verified = await verifyConnectToken(ticket, keys, tunnelTicketSchema, {
      expectedIss: hubOrigin,
      expectedAud: "aurral-relay",
      nowMs: now(),
    });
    if (!verified && !options.publicKeys) {
      const refreshed = await loadPublicKeys(true);
      verified = await verifyConnectToken(ticket, refreshed, tunnelTicketSchema, {
        expectedIss: hubOrigin,
        expectedAud: "aurral-relay",
        nowMs: now(),
      });
    }
    return verified;
  }

  const tunnelsBySlug = new Map<string, ActiveTunnel>();
  const tunnelsByInstance = new Map<string, ActiveTunnel>();

  function reportStatus(instanceId: string, online: boolean) {
    if (!options.relaySecret) return;
    void fetchImpl(`${hubOrigin}/v1/connect/relay/status`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.relaySecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ updates: [{ instanceId, online }] }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);
  }

  function closeAllStreams(tunnel: ActiveTunnel) {
    for (const [, stream] of tunnel.streams) {
      if (stream.kind === "http") {
        if (!stream.headersSent && !stream.res.writableEnded) {
          stream.res.writeHead(502, { "content-type": "application/json" });
          stream.res.end(JSON.stringify({ error: "tunnel_closed" }));
        } else if (!stream.res.writableEnded) {
          stream.res.destroy();
        }
      } else if (
        stream.ws.readyState === WebSocket.OPEN ||
        stream.ws.readyState === WebSocket.CONNECTING
      ) {
        stream.ws.close(1012, "Tunnel disconnected");
      }
    }
    tunnel.streams.clear();
  }

  function unregisterTunnel(tunnel: ActiveTunnel, notifyOffline: boolean) {
    if (tunnelsBySlug.get(tunnel.slug) === tunnel) tunnelsBySlug.delete(tunnel.slug);
    if (tunnelsByInstance.get(tunnel.instanceId) === tunnel) {
      tunnelsByInstance.delete(tunnel.instanceId);
      if (notifyOffline) reportStatus(tunnel.instanceId, false);
    }
    closeAllStreams(tunnel);
  }

  function registerTunnel(ticket: TunnelTicketPayload, ws: WebSocket): ActiveTunnel {
    const existingBySlug = tunnelsBySlug.get(ticket.slug);
    if (existingBySlug) {
      unregisterTunnel(existingBySlug, existingBySlug.instanceId !== ticket.sub);
      existingBySlug.ws.close(TUNNEL_CLOSE_REPLACED, "Replaced by newer connection");
    }
    const existingByInstance = tunnelsByInstance.get(ticket.sub);
    if (existingByInstance && existingByInstance !== existingBySlug) {
      unregisterTunnel(existingByInstance, false);
      existingByInstance.ws.close(TUNNEL_CLOSE_REPLACED, "Replaced by newer connection");
    }

    const tunnel: ActiveTunnel = {
      slug: ticket.slug,
      instanceId: ticket.sub,
      ws,
      expiresAtMs: ticket.exp * 1000,
      nextStreamId: 1,
      streams: new Map(),
    };
    tunnelsBySlug.set(tunnel.slug, tunnel);
    tunnelsByInstance.set(tunnel.instanceId, tunnel);
    reportStatus(tunnel.instanceId, true);

    ws.on("message", (raw, isBinary) => {
      if (!isBinary) return;
      const frame = decodeFrame(toBytes(raw));
      if (!frame) return;
      if (frame.type === FRAME_PING) {
        if (ws.readyState === WebSocket.OPEN) ws.send(encodeFrame(FRAME_PONG, 0));
        return;
      }
      if (frame.type === FRAME_TICKET_REFRESH) {
        const nextToken = decodeTextPayload(frame.payload);
        void verifyTicket(nextToken).then((nextTicket) => {
          if (
            !nextTicket ||
            nextTicket.sub !== tunnel.instanceId ||
            nextTicket.slug !== tunnel.slug
          ) {
            ws.close(TUNNEL_CLOSE_EXPIRED, "Invalid refreshed ticket");
            return;
          }
          tunnel.expiresAtMs = nextTicket.exp * 1000;
        });
        return;
      }

      const stream = tunnel.streams.get(frame.streamId);
      if (!stream) return;

      if (stream.kind === "http") {
        if (frame.type === FRAME_RES_HEAD) {
          const head = decodeJsonPayload(frame.payload, resHeadSchema);
          if (!head) {
            tunnel.streams.delete(frame.streamId);
            stream.res.destroy();
            return;
          }
          if (!stream.headersSent && !stream.res.writableEnded) {
            for (const [name, value] of head.headers) {
              const existing = stream.res.getHeader(name);
              if (existing === undefined) {
                stream.res.setHeader(name, value);
              } else if (Array.isArray(existing)) {
                stream.res.setHeader(name, [...existing, value]);
              } else {
                stream.res.setHeader(name, [String(existing), value]);
              }
            }
            stream.res.writeHead(head.status);
            stream.headersSent = true;
          }
          return;
        }
        if (frame.type === FRAME_RES_DATA) {
          if (stream.headersSent && !stream.res.writableEnded) {
            stream.res.write(frame.payload);
          }
          return;
        }
        if (frame.type === FRAME_RES_END) {
          tunnel.streams.delete(frame.streamId);
          if (!stream.res.writableEnded) stream.res.end();
          return;
        }
        if (frame.type === FRAME_STREAM_RST) {
          tunnel.streams.delete(frame.streamId);
          if (!stream.headersSent && !stream.res.writableEnded) {
            stream.res.writeHead(502, { "content-type": "application/json" });
            stream.res.end(JSON.stringify({ error: "upstream_reset" }));
          } else {
            stream.res.destroy();
          }
          return;
        }
        return;
      }

      if (frame.type === FRAME_WS_ACCEPTED) {
        decodeJsonPayload(frame.payload, wsAcceptedSchema);
        stream.accepted = true;
        return;
      }
      if (frame.type === FRAME_WS_DATA_TEXT) {
        if (stream.ws.readyState === WebSocket.OPEN) {
          stream.ws.send(decodeTextPayload(frame.payload));
        }
        return;
      }
      if (frame.type === FRAME_WS_DATA_BIN) {
        if (stream.ws.readyState === WebSocket.OPEN) {
          stream.ws.send(frame.payload);
        }
        return;
      }
      if (frame.type === FRAME_WS_CLOSE) {
        const closed = decodeJsonPayload(frame.payload, wsCloseSchema);
        tunnel.streams.delete(frame.streamId);
        if (
          stream.ws.readyState === WebSocket.OPEN ||
          stream.ws.readyState === WebSocket.CONNECTING
        ) {
          stream.ws.close(safeWsCloseCode(closed?.code), closed?.reason ?? "");
        }
        return;
      }
      if (frame.type === FRAME_STREAM_RST) {
        tunnel.streams.delete(frame.streamId);
        if (
          stream.ws.readyState === WebSocket.OPEN ||
          stream.ws.readyState === WebSocket.CONNECTING
        ) {
          stream.ws.close(1011, "Upstream reset");
        }
      }
    });

    ws.on("close", () => unregisterTunnel(tunnel, true));
    ws.on("error", () => unregisterTunnel(tunnel, true));
    return tunnel;
  }

  function nextStreamId(tunnel: ActiveTunnel): number {
    let attempts = 0;
    while (attempts < 1000) {
      const id = tunnel.nextStreamId;
      tunnel.nextStreamId = id >= 0x7fffffff ? 1 : id + 1;
      if (!tunnel.streams.has(id)) return id;
      attempts += 1;
    }
    return 0;
  }

  function handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
    const urlPath = req.url ?? "/";
    if (urlPath === "/_relay/health" && (req.method === "GET" || req.method === "HEAD")) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(
        req.method === "HEAD"
          ? undefined
          : JSON.stringify({ ok: true, tunnels: tunnelsBySlug.size }),
      );
      return;
    }

    const slug = extractSlug(req.headers.host, connectDomain);
    if (!slug) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    if (isRootHtmlNavigation(req.method ?? "GET", urlPath, req.headers.accept)) {
      res.writeHead(302, { location: appOrigin, "cache-control": "no-store" });
      res.end();
      return;
    }

    const origin = req.headers.origin;
    const offlineHeaders: Record<string, string> = {
      "content-type": "application/json",
      "cache-control": "no-store",
      vary: "Origin",
      ...(origin === appOrigin && { "access-control-allow-origin": appOrigin }),
    };

    const tunnel = tunnelsBySlug.get(slug);
    if (!tunnel || tunnel.ws.readyState !== WebSocket.OPEN) {
      if (req.method === "OPTIONS" && origin === appOrigin) {
        res.writeHead(204, {
          "access-control-allow-origin": appOrigin,
          "access-control-allow-methods": "GET,HEAD,PUT,PATCH,POST,DELETE",
          "access-control-allow-headers": "Content-Type, Authorization, Range",
          "access-control-max-age": "600",
          vary: "Origin",
        });
        res.end();
        return;
      }
      res.writeHead(503, offlineHeaders);
      res.end(
        JSON.stringify({
          error: "server_offline",
          message: "This Aurral server is currently offline.",
        }),
      );
      return;
    }

    if (tunnel.streams.size >= maxStreams) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "tunnel_busy" }));
      return;
    }

    const streamId = nextStreamId(tunnel);
    if (!streamId) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "tunnel_busy" }));
      return;
    }

    tunnel.streams.set(streamId, { kind: "http", res, headersSent: false });

    const remoteIp =
      (typeof req.headers["x-forwarded-for"] === "string"
        ? req.headers["x-forwarded-for"].split(",")[0]?.trim()
        : undefined) ??
      req.socket.remoteAddress ??
      "";

    tunnel.ws.send(
      encodeJsonFrame(FRAME_REQ_HEAD, streamId, {
        method: req.method ?? "GET",
        path: urlPath,
        headers: filterHeaders(req.headers, REQUEST_HEADER_STRIP),
        remoteIp,
      }),
    );

    const sendChunk = (chunk: Buffer) => {
      if (tunnel.ws.readyState !== WebSocket.OPEN) return;
      tunnel.ws.send(
        encodeFrame(
          FRAME_REQ_DATA,
          streamId,
          new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        ),
      );
      if (tunnel.ws.bufferedAmount > maxBufferedBytes) {
        req.pause();
        const checkDrain = setInterval(() => {
          if (
            tunnel.ws.readyState !== WebSocket.OPEN ||
            tunnel.ws.bufferedAmount <= maxBufferedBytes / 2
          ) {
            clearInterval(checkDrain);
            req.resume();
          }
        }, 10);
        checkDrain.unref();
      }
    };

    req.on("data", sendChunk);
    req.on("end", () => {
      if (tunnel.ws.readyState === WebSocket.OPEN && tunnel.streams.has(streamId)) {
        tunnel.ws.send(encodeFrame(FRAME_REQ_END, streamId));
      }
    });
    res.on("close", () => {
      if (
        !res.writableEnded &&
        tunnel.streams.delete(streamId) &&
        tunnel.ws.readyState === WebSocket.OPEN
      ) {
        tunnel.ws.send(encodeFrame(FRAME_STREAM_RST, streamId));
      }
    });
  }

  const tunnelWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const clientWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  const server: Server = createServer(handleHttpRequest);

  server.on("upgrade", (req, socket, head) => {
    const pathname = (req.url ?? "/").split("?")[0] ?? "/";
    if (pathname === "/tunnel") {
      const ticketToken = bearerOrQueryTicket(req);
      if (!ticketToken) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }
      void verifyTicket(ticketToken).then((ticket) => {
        if (!ticket) {
          rejectUpgrade(socket, 401, "Unauthorized");
          return;
        }
        tunnelWss.handleUpgrade(req, socket, head, (ws) => {
          registerTunnel(ticket, ws);
        });
      });
      return;
    }

    if (pathname === "/ws") {
      const slug = extractSlug(req.headers.host, connectDomain);
      const tunnel = slug ? tunnelsBySlug.get(slug) : null;
      if (!tunnel || tunnel.ws.readyState !== WebSocket.OPEN) {
        rejectUpgrade(socket, 503, "Service Unavailable");
        return;
      }
      if (tunnel.streams.size >= maxStreams) {
        rejectUpgrade(socket, 503, "Service Unavailable");
        return;
      }
      const streamId = nextStreamId(tunnel);
      if (!streamId) {
        rejectUpgrade(socket, 503, "Service Unavailable");
        return;
      }
      clientWss.handleUpgrade(req, socket, head, (clientWs) => {
        tunnel.streams.set(streamId, { kind: "ws", ws: clientWs, accepted: false });
        tunnel.ws.send(
          encodeJsonFrame(FRAME_WS_OPEN, streamId, {
            path: req.url ?? "/ws",
            headers: filterHeaders(req.headers, REQUEST_HEADER_STRIP),
            remoteIp: req.socket.remoteAddress ?? "",
          }),
        );
        clientWs.on("message", (data, isBinary) => {
          if (tunnel.ws.readyState !== WebSocket.OPEN) return;
          if (isBinary) {
            tunnel.ws.send(encodeFrame(FRAME_WS_DATA_BIN, streamId, toBytes(data)));
          } else {
            tunnel.ws.send(
              encodeTextFrame(FRAME_WS_DATA_TEXT, streamId, decodeTextPayload(toBytes(data))),
            );
          }
        });
        clientWs.on("close", (code, reason) => {
          if (tunnel.streams.delete(streamId) && tunnel.ws.readyState === WebSocket.OPEN) {
            tunnel.ws.send(
              encodeJsonFrame(FRAME_WS_CLOSE, streamId, {
                code: safeWsCloseCode(code),
                reason: reason.toString("utf8"),
              }),
            );
          }
        });
      });
      return;
    }

    rejectUpgrade(socket, 404, "Not Found");
  });

  const expiryTimer = setInterval(() => {
    const current = now();
    for (const tunnel of [...tunnelsBySlug.values()]) {
      if (tunnel.expiresAtMs <= current) {
        tunnel.ws.close(TUNNEL_CLOSE_EXPIRED, "Ticket expired");
      }
    }
  }, options.expiryCheckIntervalMs ?? 30_000);
  expiryTimer.unref();

  return {
    server,
    activeTunnelCount: () => tunnelsBySlug.size,
    hasTunnel: (slug: string) => tunnelsBySlug.has(slug),
    async listen(port = 0, host = "127.0.0.1") {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      return (server.address() as AddressInfo).port;
    },
    async close() {
      clearInterval(expiryTimer);
      for (const tunnel of [...tunnelsBySlug.values()]) {
        tunnel.ws.terminate();
      }
      for (const client of tunnelWss.clients) client.terminate();
      for (const client of clientWss.clients) client.terminate();
      tunnelWss.close();
      clientWss.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
