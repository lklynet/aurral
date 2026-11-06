import fs from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../middleware/requestUser.ts";
import { sendFrom } from "../services/fileResponses.ts";
import { sendViaNode } from "./shared/sendViaNode.ts";

const uncached = new Set(["/oauth.html", "/spotify-oauth-callback.js"]);
const notBuilt = "Frontend not built. Run 'pnpm run build' first.";

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};
const ENCODINGS = [
  ["br", ".br"],
  ["gzip", ".gz"],
] as const;

const acceptedEncodings = (header = "") =>
  new Set(
    header
      .toLowerCase()
      .split(",")
      .map((part) => part.replace(/\s/g, ""))
      .filter((part) => !/;q=0(?:\.0*)?$/.test(part))
      .map((part) => part.split(";", 1).join("")),
  );

export function serveFrontend(dist: string) {
  const built = fs.existsSync(dist);
  const precompressed = new Set(
    built
      ? fs
          .readdirSync(dist, { recursive: true, encoding: "utf8" })
          .filter((file) => file.endsWith(".br") || file.endsWith(".gz"))
          .map((file) => `/${file.split(path.sep).join("/")}`)
      : [],
  );

  const send = (c: Context<AppEnv>, pathname: string, options: Parameters<typeof sendFrom>[4]) => {
    const contentType = CONTENT_TYPES[path.extname(pathname)];
    if (!contentType) return sendViaNode(c, sendFrom, dist, pathname, options);
    c.header("Vary", "Accept-Encoding");
    const accepted = acceptedEncodings(c.req.header("Accept-Encoding"));
    const match = ENCODINGS.find(
      ([name, suffix]) => accepted.has(name) && precompressed.has(pathname + suffix),
    );
    if (!match) return sendViaNode(c, sendFrom, dist, pathname, options);
    c.header("Content-Encoding", match[0]);
    return sendViaNode(c, sendFrom, dist, pathname + match[1], { ...options, contentType });
  };

  return new Hono<AppEnv>().get("*", async (c, next) => {
    const { pathname } = new URL(c.req.url);
    if (pathname.startsWith("/api")) return next();
    if (!built) return c.text(notBuilt, 503);
    if (uncached.has(pathname)) c.header("Cache-Control", "no-store");
    const caching = pathname.startsWith("/assets/") ? { maxAge: "1y", immutable: true } : {};
    return (
      (await send(c, pathname, { dotfiles: "ignore", index: false, ...caching })) ??
      (await send(c, "/index.html", {})) ??
      c.text(notBuilt, 503)
    );
  });
}

export default serveFrontend(path.join(import.meta.dirname, "..", "..", "frontend", "dist"));
