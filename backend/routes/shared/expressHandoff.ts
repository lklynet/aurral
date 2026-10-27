import type { IncomingMessage } from "node:http";
import { getRequestListener } from "@hono/node-server";
import type { NextFunction, Request, Response } from "express";
import { Hono } from "hono";
import { verifyTokenAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../middleware/requestUser.ts";
import { api } from "../api.ts";
import subsonic from "../subsonic.ts";

const handedOver = new WeakMap<IncomingMessage, AppEnv["Variables"]>();

const listener = getRequestListener(
  new Hono<AppEnv>({ strict: false })
    .use(async (c, next) => {
      const variables = handedOver.get(c.env.incoming);
      c.set("user", variables?.user);
      c.set("clientIp", variables?.clientIp ?? "");
      c.set("clientIps", variables?.clientIps ?? []);
      c.set("protocol", variables?.protocol ?? "http");
      const incoming = c.env.incoming.headers;
      if (incoming["transfer-encoding"]) {
        // bodyLimit rebuilds chunked requests with new Request(), which rejects node-server's lightweight request.
        const { url, method, headers, body, signal } = c.req.raw;
        const init = { method, headers, body, signal, duplex: "half" };
        c.req.raw = new Request(url, init);
      } else if (
        !Number(incoming["content-length"]) &&
        incoming["content-type"]?.includes("json") &&
        c.req.method !== "GET" &&
        c.req.method !== "HEAD"
      ) {
        // Express read an empty JSON body as {}, and clients still send JSON content types with no body.
        const { url, method, headers, signal } = c.req.raw;
        c.req.raw = new Request(url, { method, headers, signal, body: "{}" });
      }
      await next();
    })
    .route("/api", api)
    .route("/", subsonic)
    .notFound((c) => c.json({ error: "Not found" }, 404)).fetch,
  { overrideGlobalObjects: false },
);

export function handToHono(req: Request, res: Response) {
  handedOver.set(req, {
    user: req.user,
    clientIp: req.ip || "",
    clientIps: [req.socket.remoteAddress, ...req.ips].filter((ip) => ip !== undefined),
    protocol: req.protocol,
  });
  req.url = req.originalUrl;
  return listener(req, res);
}

export function resolveTokenUser(req: Request, _res: Response, next: NextFunction) {
  verifyTokenAuth(req);
  next();
}
