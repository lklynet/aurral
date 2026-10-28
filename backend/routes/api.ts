import { Hono, type ErrorHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../middleware/requestUser.ts";
import { logger } from "../services/logger.ts";
import artists from "./artists/index.ts";
import artistStream from "./artists/handlers/stream.ts";
import auth from "./auth.ts";
import deezer from "./deezer.ts";
import discovery from "./discovery/index.ts";
import filesystem from "./filesystem.ts";
import health from "./health.ts";
import imageProxy from "./imageProxy.ts";
import inbox from "./inbox.ts";
import library from "./library/index.ts";
import libraryStreams from "./library/streams.ts";
import lidarrFeed from "./lidarrFeed.ts";
import lidarrWebhook from "./lidarrWebhook.ts";
import news from "./news.ts";
import onboarding from "./onboarding.ts";
import playEvents from "./playEvents.ts";
import playlistArtwork from "./playlists/handlers/artwork.ts";
import flows from "./playlists/handlers/flows.ts";
import playlistImports from "./playlists/handlers/imports.ts";
import playlistJobs from "./playlists/handlers/jobs.ts";
import staticPlaylists from "./playlists/handlers/staticPlaylists.ts";
import playlistStreams from "./playlists/handlers/stream.ts";
import playlistWorker from "./playlists/handlers/worker.ts";
import requests from "./requests.ts";
import scrobbling from "./scrobbling.ts";
import search from "./search.ts";
import settings from "./settings/index.ts";
import shareLinks from "./shareLinks.ts";
import settingsDownloadClients from "./settings/downloadClients.ts";
import settingsPlayback from "./settings/playback.ts";
import updates from "./updates.ts";
import users from "./users.ts";
import wrapped from "./wrapped.ts";
import userPlexLink from "./users/plexLinkHandlers.ts";

const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "5mb";

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
  .route("/", library)
  .route("/", requests)
  .route("/", playlistStreams)
  .route("/", playlistArtwork)
  .route("/", flows)
  .route("/", staticPlaylists)
  .route("/", playlistImports)
  .route("/", playlistJobs)
  .route("/", playlistWorker)
  .route("/", artistStream)
  .route("/", artists)
  .route("/", search)
  .route("/", imageProxy)
  .route("/", deezer)
  .route("/", settings)
  .route("/", settingsPlayback)
  .route("/", settingsDownloadClients)
  .route("/", updates)
  .route("/", auth)
  .route("/", users)
  .route("/", userPlexLink)
  .route("/", onboarding)
  .route("/", health)
  .route("/", scrobbling)
  .route("/", filesystem)
  .route("/", discovery)
  .route("/", news)
  .route("/", playEvents)
  .route("/", shareLinks)
  .route("/", wrapped)
  .route("/", lidarrWebhook)
  .route("/", lidarrFeed);

export const handleError: ErrorHandler<AppEnv> = (error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  logger.error("system", "Request error:", error);
  return c.json({ error: "Internal server error" }, 500);
};

api.onError(handleError);
