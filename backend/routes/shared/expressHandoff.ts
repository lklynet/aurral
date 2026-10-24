import type { IncomingMessage } from "node:http";
import { getRequestListener, type HttpBindings } from "@hono/node-server";
import type { Request, Response } from "express";
import { Hono } from "hono";
import type { AppEnv } from "../../middleware/requestUser.ts";
import { api } from "../api.ts";

const handedOver = new WeakMap<IncomingMessage, AppEnv["Variables"]>();

const listener = getRequestListener(
  new Hono<AppEnv & { Bindings: HttpBindings }>()
    .use(async (c, next) => {
      const variables = handedOver.get(c.env.incoming);
      c.set("user", variables?.user);
      c.set("clientIp", variables?.clientIp ?? "");
      if (c.env.incoming.headers["transfer-encoding"]) {
        // bodyLimit rebuilds chunked requests with new Request(), which rejects node-server's lightweight request.
        const { url, method, headers, body, signal } = c.req.raw;
        const init = { method, headers, body, signal, duplex: "half" };
        c.req.raw = new Request(url, init);
      }
      await next();
    })
    .route("/", api).fetch,
  { overrideGlobalObjects: false },
);

export function handToHono(req: Request, res: Response) {
  handedOver.set(req, { user: req.user, clientIp: req.ip || "" });
  req.url = req.originalUrl.replace(/^\/api/, "");
  return listener(req, res);
}
