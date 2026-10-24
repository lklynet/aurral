import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../middleware/requestUser.ts";
import { logger } from "../services/logger.ts";
import artistStream from "./artists/handlers/stream.ts";
import inbox from "./inbox.ts";
import libraryStreams from "./library/streams.ts";
import playlistStreams from "./playlists/handlers/stream.ts";

export const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "5mb";

function byteSize(value: string) {
  const match = /^(\d+(?:\.\d+)?)\s*([kmg]?b)?$/i.exec(value.trim());
  if (!match) return 5 * 1024 ** 2;
  const exponent = ["b", "kb", "mb", "gb"].indexOf((match[2] || "b").toLowerCase());
  return Math.floor(Number(match[1]) * 1024 ** exponent);
}

const jsonBodyLimit = bodyLimit({
  maxSize: byteSize(JSON_BODY_LIMIT),
  onError: (c) =>
    c.json(
      { error: "Payload too large", message: `Request body exceeds limit (${JSON_BODY_LIMIT})` },
      413,
    ),
});

export const api = new Hono<AppEnv>()
  .use((c, next) =>
    c.req.header("content-type")?.includes("json") ? jsonBodyLimit(c, next) : next(),
  )
  .route("/", inbox)
  .route("/", libraryStreams)
  .route("/", playlistStreams)
  .route("/", artistStream);

api.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  logger.error("system", "Request error:", error);
  return c.json({ error: "Internal server error" }, 500);
});
