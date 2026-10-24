import { Hono } from "hono";
import type { AppEnv, RequestUser } from "../../backend/middleware/requestUser.ts";

export const signedInAs = (user: RequestUser | undefined) =>
  new Hono<AppEnv>().use(async (c, next) => {
    c.set("user", user);
    c.set("clientIp", "127.0.0.1");
    await next();
  });
