import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import type { AppEnv, RequestUser } from "../../backend/middleware/requestUser.ts";

export const signedInAs = (user: RequestUser | undefined | (() => RequestUser | undefined)) =>
  new Hono<AppEnv>().use(async (c, next) => {
    c.set("user", typeof user === "function" ? user() : user);
    c.set("clientIp", "127.0.0.1");
    c.set("clientIps", ["127.0.0.1"]);
    c.set("protocol", "http");
    await next();
  });

export async function listen(app: { fetch: Parameters<typeof getRequestListener>[0] }) {
  const server = createServer(getRequestListener(app.fetch, { overrideGlobalObjects: false }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}
