import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import type { AppEnv } from "../middleware/requestUser.ts";
import { sendFrom } from "../services/fileResponses.ts";
import { sendViaNode } from "./shared/sendViaNode.ts";

const dist = path.join(import.meta.dirname, "..", "..", "frontend", "dist");
const built = fs.existsSync(dist);
const uncached = new Set(["/oauth.html", "/spotify-oauth-callback.js"]);
const notBuilt = "Frontend not built. Run 'pnpm run build' first.";

export default new Hono<AppEnv>().get("*", async (c, next) => {
  const { pathname } = new URL(c.req.url);
  if (pathname.startsWith("/api")) return next();
  if (!built) return c.text(notBuilt, 503);
  if (uncached.has(pathname)) c.header("Cache-Control", "no-store");
  const caching = pathname.startsWith("/assets/") ? { maxAge: "1y", immutable: true } : {};
  return (
    (await sendViaNode(c, sendFrom, dist, pathname, {
      dotfiles: "ignore",
      index: false,
      ...caching,
    })) ??
    (await sendViaNode(c, sendFrom, dist, "/index.html")) ??
    c.text(notBuilt, 503)
  );
});
