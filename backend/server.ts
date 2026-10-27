import cors from "cors";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import path from "path";
import fs from "fs";
import { createServer } from "http";
import { fileURLToPath } from "url";
import dns from "node:dns";

dns.setDefaultResultOrder("ipv4first");

import { authMiddleware, isProxyAuthEnabled } from "./middleware/auth.ts";
import { createRequestFailureLogger } from "./middleware/requestFailureLogger.ts";
import { handleOidcCallback, isOidcEnabled } from "./services/oidcAuth.ts";
import { handleGoogleCallback } from "./services/googleAuth.ts";
import { logger, logUnhandledRejection } from "./services/logger.ts";
import { websocketService, type WebSocketChannelPayload } from "./services/websocketService.ts";
import {
  getLidarrStatusSnapshot,
  hasActiveLidarrStatusSnapshot,
} from "./routes/library/handlers/downloads.ts";
import { startPlaylistStatusBroadcasts } from "./services/playlists/playlistStatusBroadcaster.ts";

import artistsRouter from "./routes/artists/index.ts";
import searchRouter from "./routes/search.ts";
import discoveryRouter from "./routes/discovery/index.ts";
import { noteDeprecatedUsage, warnAboutConfigDeprecations } from "./services/deprecatedUsage.ts";
import { bootstrapHonkerSchedules } from "./services/honkerDb.ts";
import { initializeAppRuntime } from "./services/appRuntime.ts";
import {
  registerHonkerShutdownHandler,
  shutdownHonkerInfrastructure,
} from "./services/honkerWorkerRuntime.ts";
import imageProxyRouter from "./routes/imageProxy.ts";
import deezerRouter from "./routes/deezer.ts";
import lidarrFeedRouter from "./routes/lidarrFeed.ts";
import lidarrWebhookRouter from "./routes/lidarrWebhook.ts";
import newsRouter from "./routes/news.ts";
import subsonicRouter from "./routes/subsonic.ts";
import playEventsRouter from "./routes/playEvents.ts";
import shareLinksRouter from "./routes/shareLinks.ts";
import { stopShareListener, syncShareListener } from "./services/shareLinks/shareListener.ts";
import { asAppError, type AppError } from "../lib/errors.ts";
import { JSON_BODY_LIMIT } from "./routes/api.ts";
import { handToHono, resolveTokenUser } from "./routes/shared/expressHandoff.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.on("uncaughtException", (error) => {
  logger.error("system", "Uncaught Exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", logUnhandledRejection);

const app = express();
const PORT = process.env.PORT || 3001;

const allowedCorsOrigins = String(process.env.CORS_ORIGIN || "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const isSubsonicRequest = (req: Request) => req.path === "/rest" || req.path.startsWith("/rest/");
const isImageProxyRequest = (req: Request) =>
  (req.method === "GET" || req.method === "HEAD") && req.path.startsWith("/api/image-proxy/");

const corsDefaults = {
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  allowedHeaders: "Content-Type, Authorization",
};
const publicCors = cors(corsDefaults);
const apiCors = cors({ ...corsDefaults, origin: allowedCorsOrigins });

function corsMiddleware(req: Request, res: Response, next: NextFunction) {
  if (isSubsonicRequest(req) || isImageProxyRequest(req)) return publicCors(req, res, next);
  if (allowedCorsOrigins.length > 0) return apiCors(req, res, next);
  return next();
}

const trustProxyValue =
  process.env.TRUST_PROXY === undefined
    ? 1
    : process.env.TRUST_PROXY === "true"
      ? true
      : process.env.TRUST_PROXY === "false"
        ? false
        : Number.isNaN(Number(process.env.TRUST_PROXY))
          ? process.env.TRUST_PROXY
          : Number(process.env.TRUST_PROXY);
app.set("trust proxy", trustProxyValue);

if (isProxyAuthEnabled() && !process.env.AUTH_PROXY_TRUSTED_IPS) {
  logger.warn(
    "system",
    "AUTH_PROXY_ENABLED is on but AUTH_PROXY_TRUSTED_IPS is not set - any client that can reach " +
      "this server directly can impersonate any user via the proxy identity header. Set " +
      "AUTH_PROXY_TRUSTED_IPS to your reverse proxy's address to restrict this.",
  );
}

if (process.env.OIDC_ENABLED === "true" && !isOidcEnabled()) {
  logger.warn(
    "system",
    "OIDC_ENABLED is on but OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, or OIDC_REDIRECT_URI is missing.",
  );
}

const connectSrcDirectives = ["'self'", "ws:", "wss:", "https://api.github.com"];
if (process.env.AUTH_PROXY_DOMAIN) {
  connectSrcDirectives.push(process.env.AUTH_PROXY_DOMAIN);
}
if (process.env.OIDC_DOMAIN) {
  connectSrcDirectives.push(process.env.OIDC_DOMAIN);
}

app.use(corsMiddleware);
app.use(createRequestFailureLogger());
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", "data:"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: connectSrcDirectives,
        mediaSrc: ["'self'", "data:", "https:"],
        frameSrc: ["'self'", "https://www.youtube-nocookie.com", "https://www.youtube.com"],
        frameAncestors: null,
        upgradeInsecureRequests: null,
      },
    },
    frameguard: { action: "sameorigin" },
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  }),
);
app.use((req, res, next) => {
  if (isSubsonicRequest(req) || isImageProxyRequest(req)) {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  }
  next();
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
});

app.use(limiter);

app.use(authMiddleware);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
});
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/oidc/login", authLimiter);
app.use("/api/auth/oidc/exchange", authLimiter);
app.use("/api/users/me/password", authLimiter);

app.use(
  [
    "/api/library/canonical-stream",
    "/api/library/file-stream",
    "/api/library/stream",
    "/api/playlists/stream",
    "/api/playlists/staging-stream",
    "/api/artists/:mbid/stream",
  ],
  resolveTokenUser,
  handToHono,
);
app.get(
  [
    "/api/library/albums/:albumId/cover",
    "/api/library/artwork/:kind/:id",
    "/api/playlists/artwork/:playlistId",
    "/api/playlists/track-artwork/:jobId",
  ],
  resolveTokenUser,
  handToHono,
);
app.all(/^\/rest\/stream(?:\.view)?\/?$/i, handToHono);
app.use(
  [
    "/api/inbox",
    "/api/library",
    "/api/requests",
    "/api/settings",
    "/api/updates",
    "/api/auth",
    "/api/users",
    "/api/onboarding",
    "/api/health",
    "/api/scrobbling",
    "/api/filesystem",
    "/api/playlists",
  ],
  handToHono,
);

app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use("/api/search", searchRouter);
app.use("/api/artists", artistsRouter);
app.use("/api/discover", discoveryRouter);
app.use("/api/news", newsRouter);
app.use("/api/webhooks/lidarr", lidarrWebhookRouter);
app.use("/api/feeds", lidarrFeedRouter);
app.use("/api/weekly-flow", (req, res) => {
  noteDeprecatedUsage("weekly-flow-api");
  const parsed = new URL(req.url, "http://localhost");
  res.redirect(308, `/api/playlists${parsed.pathname}${parsed.search}`);
});
app.use("/api/play-events", playEventsRouter);
app.use("/api/share-links", shareLinksRouter);
app.use("/api/image-proxy", imageProxyRouter);
app.use("/api/deezer", deezerRouter);
app.use("/rest", express.urlencoded({ extended: false }), subsonicRouter);

app.get("/sso/callback", async (req, res) => {
  try {
    const result = await handleOidcCallback(req);
    const code = encodeURIComponent(result.code);
    res.redirect(302, `/sso/complete#code=${code}`);
  } catch (error) {
    const failure = asAppError(error);
    logger.error("auth", "OIDC callback failed:", { message: failure?.message });
    const message = encodeURIComponent(failure?.message || "OIDC login failed");
    res.redirect(302, `/sso/complete#error=${message}`);
  }
});

app.get("/sso/google/callback", async (req, res) => {
  try {
    const result = await handleGoogleCallback(req);
    const code = encodeURIComponent(result.code);
    res.redirect(302, `/sso/complete#code=${code}&provider=google`);
  } catch (error) {
    const failure = asAppError(error);
    logger.error("auth", "Google callback failed:", { message: failure?.message });
    const message = encodeURIComponent(failure?.message || "Google login failed");
    res.redirect(302, `/sso/complete#error=${message}&provider=google`);
  }
});

const frontendDist = path.join(__dirname, "..", "frontend", "dist");
const frontendFallbackRoute = /.*/;

if (fs.existsSync(frontendDist)) {
  const oauthHtmlPath = path.join(frontendDist, "oauth.html");
  const oauthCallbackPath = path.join(frontendDist, "spotify-oauth-callback.js");
  app.get("/oauth.html", (req, res, next) => {
    if (!fs.existsSync(oauthHtmlPath)) return next();
    res.setHeader("Cache-Control", "no-store");
    return res.sendFile(oauthHtmlPath);
  });
  app.get("/spotify-oauth-callback.js", (req, res, next) => {
    if (!fs.existsSync(oauthCallbackPath)) return next();
    res.setHeader("Cache-Control", "no-store");
    return res.sendFile(oauthCallbackPath);
  });
  app.use(
    "/assets",
    express.static(path.join(frontendDist, "assets"), { maxAge: "1y", immutable: true }),
  );
  app.use(express.static(frontendDist));

  app.get(frontendFallbackRoute, (req, res) => {
    if (req.path.startsWith("/api")) {
      return res.status(404).json({ error: "Not found" });
    }
    res.sendFile("index.html", { root: frontendDist });
  });
} else {
  app.get(frontendFallbackRoute, (req, res) => {
    if (req.path.startsWith("/api")) {
      return res.status(404).json({ error: "Not found" });
    }
    res.status(503).send("Frontend not built. Run 'pnpm run build' first.");
  });
}

app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  logger.error("system", "Express error:", err || "(no error object)");
  res.locals.failureLogged = true;
  if (res.headersSent) return next(err);
  const failure: (AppError & { type?: string }) | undefined = asAppError(err);
  if (failure?.type === "entity.too.large" || failure?.status === 413) {
    return res.status(413).json({
      error: "Payload too large",
      message: `Request body exceeds limit (${JSON_BODY_LIMIT})`,
    });
  }
  return res.status(500).json({ error: "Internal server error" });
});

const httpServer = createServer(app);
websocketService.initialize(httpServer);

const DOWNLOAD_STATUS_INTERVAL_MS = 10000;
let lastDownloadStatusesPayload: string | null = null;
let downloadStatusBroadcastInFlight = false;
const hasWsSubscribers = (channel: string) => {
  const stats = websocketService.getStats();
  const total = Number(stats?.channels?.[channel] || 0);
  return total > 0;
};
const broadcastDownloadStatuses = async () => {
  if (downloadStatusBroadcastInFlight) return;
  downloadStatusBroadcastInFlight = true;
  try {
    if (!hasWsSubscribers("downloads") && !hasActiveLidarrStatusSnapshot()) return;
    const snapshot = await getLidarrStatusSnapshot();
    const message: WebSocketChannelPayload = {
      type: "download_statuses",
      statuses: snapshot.statuses,
      stale: snapshot.stale,
      error: snapshot.error,
      updatedAt: snapshot.updatedAt,
    };
    const payload = JSON.stringify(message);
    if (payload !== lastDownloadStatusesPayload) {
      lastDownloadStatusesPayload = payload;
      websocketService.broadcast("downloads", message);
    }
  } catch (error) {
    const failure = asAppError(error);
    logger.warn("system", "Failed to broadcast download statuses:", { message: failure?.message });
  } finally {
    downloadStatusBroadcastInFlight = false;
  }
};

const broadcastIntervals: NodeJS.Timeout[] = [];

const scheduleBroadcast = (fn: () => void, intervalMs: number) => {
  fn();
  broadcastIntervals.push(setInterval(fn, intervalMs));
};

scheduleBroadcast(broadcastDownloadStatuses, DOWNLOAD_STATUS_INTERVAL_MS);
const stopPlaylistStatusBroadcasts = startPlaylistStatusBroadcasts();

let shuttingDown = false;

const gracefulShutdown = async (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("system", `Received ${signal}, shutting down...`);
  for (const interval of broadcastIntervals) {
    clearInterval(interval);
  }
  stopPlaylistStatusBroadcasts();
  await shutdownHonkerInfrastructure({ timeoutMs: 5000 });
  await stopShareListener();
  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
  });
  process.exit(0);
};

registerHonkerShutdownHandler(async () => {
  websocketService.close?.();
});

process.once("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});
process.once("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});

httpServer.listen(PORT, async () => {
  logger.info("system", `Server running on port ${PORT}`);
  warnAboutConfigDeprecations();
  bootstrapHonkerSchedules();
  initializeAppRuntime({ logger });
  void syncShareListener();
});

httpServer.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    logger.error(
      "system",
      `Port ${PORT} is already in use. Please stop the other process or use a different port.`,
    );
    process.exit(1);
  } else {
    logger.error("system", "Server error:", error);
  }
});
