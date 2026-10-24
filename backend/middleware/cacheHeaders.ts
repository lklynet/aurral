import { createMiddleware } from "hono/factory";

export const noCache = createMiddleware(async (c, next) => {
  c.header("Cache-Control", "no-cache, no-store, must-revalidate");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");
  await next();
});

export const cacheFor = (maxAgeSeconds: number) =>
  createMiddleware(async (c, next) => {
    if (c.req.method === "GET") {
      c.header("Cache-Control", `public, max-age=${maxAgeSeconds}`);
      c.header("Vary", "Accept");
      if (maxAgeSeconds > 0) {
        c.header("Expires", new Date(Date.now() + maxAgeSeconds * 1000).toUTCString());
      }
    }
    await next();
  });
