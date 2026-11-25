import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { WebSocketServer } from "ws";
import { isRootHtmlNavigation } from "../../../lib/connectTunnel.ts";
import { authenticateConnect } from "../../middleware/guards.ts";
import { rateLimit } from "../../middleware/rateLimit.ts";
import { createRequestFailureLogger } from "../../middleware/requestFailureLogger.ts";
import type { AppEnv } from "../../middleware/requestUser.ts";
import { appOrigin, corsHeaders, securityHeaders } from "../../middleware/security.ts";
import { api, handleError } from "../../routes/api.ts";
import subsonic from "../../routes/subsonic.ts";
import { withLogContext } from "../logger.ts";
import { createShareApp } from "../shareLinks/shareListener.ts";
import { websocketService } from "../websocketService.ts";

export const CONNECT_CLIENT_IP_HEADER = "x-aurral-connect-client-ip";

const FIFTEEN_MINUTES = 15 * 60 * 1000;

export function createConnectApp() {
  const signInLimit = rateLimit({
    windowMs: FIFTEEN_MINUTES,
    limit: 10,
    skipSuccessfulRequests: true,
  });
  const shareApp = createShareApp();

  return new Hono<AppEnv>({ strict: false })
    .use((c, next) => withLogContext({ req: randomUUID().slice(0, 8) }, next))
    .use(compress())
    .use(async (c, next) => {
      const incoming = c.env.incoming.headers;
      if (incoming["transfer-encoding"]) {
        const { url, method, headers, body, signal } = c.req.raw;
        const init = { method, headers, body, signal, duplex: "half" };
        c.req.raw = new Request(url, init);
      } else if (
        !Number(incoming["content-length"]) &&
        incoming["content-type"]?.includes("json") &&
        c.req.method !== "GET" &&
        c.req.method !== "HEAD"
      ) {
        const { url, method, headers, signal } = c.req.raw;
        c.req.raw = new Request(url, { method, headers, signal, body: "{}" });
      }
      await next();
    })
    .use(async (c, next) => {
      const forwardedIp = c.req.header(CONNECT_CLIENT_IP_HEADER)?.trim() ?? "";
      c.set("viaConnect", true);
      c.set("clientIp", forwardedIp);
      c.set("peerIp", "");
      c.set("protocol", "https");
      await next();
    })
    .use(corsHeaders)
    .use(createRequestFailureLogger())
    .use(securityHeaders)
    .use(rateLimit({ windowMs: FIFTEEN_MINUTES, limit: 5000 }))
    .use(authenticateConnect)
    .use("/api/auth/login", signInLimit)
    .use("/api/auth/pair", signInLimit)
    .use("/api/auth/connect-exchange", signInLimit)
    .use("/api/users/me/password", signInLimit)
    .route("/api", api)
    .route("/", subsonic)
    .route("/", shareApp)
    .all("/", (c) => {
      if (isRootHtmlNavigation(c.req.method, c.req.path, c.req.header("accept"))) {
        return c.redirect(appOrigin, 302);
      }
      return c.text("Not found", 404);
    })
    .notFound((c) =>
      c.req.path.startsWith("/api")
        ? c.json({ error: "Not found" }, 404)
        : c.text("Not found", 404),
    )
    .onError(handleError);
}

export interface ConnectListenerHandle {
  port: number;
  close: () => Promise<void>;
}

export async function startConnectListener(): Promise<ConnectListenerHandle> {
  const connectApp = createConnectApp();
  const server: Server = createServer(
    getRequestListener(connectApp.fetch, { overrideGlobalObjects: false }),
  );
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws, req) => {
    websocketService.handleConnection(ws, req, { strictSessionOnly: true });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;
  return {
    port,
    async close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
