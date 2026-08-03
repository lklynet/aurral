import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import path from "path";
import fs from "fs";
import { createServer } from "http";
import { fileURLToPath } from "url";
import { authMiddleware, isProxyAuthEnabled } from "./middleware/auth.js";
import { handleOidcCallback, isOidcEnabled } from "./services/oidcAuth.js";
import { logger } from "./services/logger.js";
import { websocketService } from "./services/websocketService.js";
import { getAllDownloadStatuses } from "./routes/library/handlers/downloads.js";
import { getWeeklyFlowStatusSnapshot } from "./services/weeklyFlow/weeklyFlowStatusSnapshot.js";

import settingsRouter from "./routes/settings/index.js";
import onboardingRouter from "./routes/onboarding.js";
import usersRouter from "./routes/users.js";
import artistsRouter from "./routes/artists/index.js";
import searchRouter from "./routes/search.js";
import libraryRouter from "./routes/library/index.js";
import discoveryRouter from "./routes/discovery/index.js";
import requestsRouter from "./routes/requests.js";
import healthRouter from "./routes/health.js";
import filesystemRouter from "./routes/filesystem.js";
import weeklyFlowRouter from "./routes/weeklyFlow/index.js";
import { bootstrapHonkerSchedules } from "./services/honkerDb.js";
import { initializeAppRuntime } from "./services/appRuntime.js";
import {
  registerHonkerShutdownHandler,
  shutdownHonkerInfrastructure,
} from "./services/honkerWorkerRuntime.js";
import authRouter from "./routes/auth.js";
import imageProxyRouter from "./routes/imageProxy.js";
import lidarrFeedRouter from "./routes/lidarrFeed.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.on("uncaughtException", (error) => {
  logger.error("system", "Uncaught Exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("system", "Unhandled Rejection:", reason);
});

const app = express();
const PORT = process.env.PORT || 3001;
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "5mb";

const allowedCorsOrigins = String(process.env.CORS_ORIGIN || "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

function corsMiddleware(req, res, next) {
  if (allowedCorsOrigins.length === 0) {
    if (req.method === "OPTIONS") {
      res.status(403).end();
      return;
    }
    next();
    return;
  }
  const origin = req.headers.origin;
  if (origin && allowedCorsOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.status(origin && allowedCorsOrigins.includes(origin) ? 204 : 403).end();
    return;
  }
  next();
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
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", "data:"],
        imgSrc: [
          "'self'",
          "data:",
          "https://*.deezer.com",
          "https://*.dzcdn.net",
          "https://ticketm.net",
          "https://*.ticketm.net",
          "https://ticketmaster.com",
          "https://*.ticketmaster.com",
          "https://caa.lkly.net",
          "https://imagecache.lidarr.audio",
          "https://*.lidarr.audio",
          "https://archive.org",
          "https://*.archive.org",
          "https://*.last.fm",
          "https://lastfm.freetls.fastly.net",
          "https://*.fanart.tv",
        ],
        connectSrc: connectSrcDirectives,
        mediaSrc: ["'self'", "https://*.dzcdn.net", "https://*.deezer.com"],
        frameSrc: ["'self'", "https://www.youtube-nocookie.com", "https://www.youtube.com"],
        frameAncestors: null,
        upgradeInsecureRequests: null,
      },
    },
    frameguard: false,
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  }),
);
app.use(express.json({ limit: JSON_BODY_LIMIT }));

app.use(authMiddleware);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
});
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/oidc/login", authLimiter);
app.use("/api/users/me/password", authLimiter);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
});
app.use("/api/", limiter);

app.use("/api/settings", settingsRouter);
app.use("/api/onboarding", onboardingRouter);
app.use("/api/users", usersRouter);
app.use("/api/search", searchRouter);
app.use("/api/artists", artistsRouter);
app.use("/api/library", libraryRouter);
app.use("/api/discover", discoveryRouter);
app.use("/api/requests", requestsRouter);
app.use("/api/health", healthRouter);
app.use("/api/filesystem", filesystemRouter);
app.use("/api/feeds", lidarrFeedRouter);
app.use("/api/playlists", weeklyFlowRouter);
app.use("/api/weekly-flow", (req, res) => {
  const target = req.originalUrl.replace("/api/weekly-flow", "/api/playlists");
  res.redirect(308, target);
});
app.use("/api/auth", authRouter);
app.use("/api/image-proxy", imageProxyRouter);

app.get("/sso/callback", async (req, res) => {
  try {
    const result = await handleOidcCallback(req);
    const token = encodeURIComponent(result.token);
    res.redirect(302, `/sso/complete#token=${token}`);
  } catch (error) {
    logger.error("auth", "OIDC callback failed:", { message: error.message });
    const message = encodeURIComponent(error.message || "OIDC login failed");
    res.redirect(302, `/sso/complete#error=${message}`);
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
    res.sendFile(path.join(frontendDist, "index.html"));
  });
} else {
  app.get(frontendFallbackRoute, (req, res) => {
    if (req.path.startsWith("/api")) {
      return res.status(404).json({ error: "Not found" });
    }
    res.status(503).send("Frontend not built. Run 'npm run build' first.");
  });
}

app.use((err, req, res, next) => {
  logger.error("system", "Express error:", err || "(no error object)");
  if (res.headersSent) return next(err);
  if (err?.type === "entity.too.large" || err?.status === 413) {
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
let lastDownloadStatusesPayload = null;
let downloadStatusBroadcastInFlight = false;
const hasWsSubscribers = (channel) => {
  const stats = websocketService.getStats();
  const total = Number(stats?.channels?.[channel] || 0);
  return total > 0;
};
const broadcastDownloadStatuses = async () => {
  if (downloadStatusBroadcastInFlight) return;
  downloadStatusBroadcastInFlight = true;
  try {
    if (!hasWsSubscribers("downloads")) return;
    const { lidarrClient } = await import("./services/lidarrClient.js");
    if (lidarrClient.isCircuitOpen()) return;
    const statuses = await getAllDownloadStatuses();
    const payload = JSON.stringify(statuses);
    if (payload !== lastDownloadStatusesPayload) {
      lastDownloadStatusesPayload = payload;
      websocketService.broadcast("downloads", {
        type: "download_statuses",
        statuses,
      });
    }
  } catch (error) {
    logger.warn("system", "Failed to broadcast download statuses:", { message: error.message });
  } finally {
    downloadStatusBroadcastInFlight = false;
  }
};

const WEEKLY_FLOW_STATUS_INTERVAL_MS = 4000;
let weeklyFlowStatusBroadcastInFlight = false;
const broadcastWeeklyFlowStatus = async () => {
  if (weeklyFlowStatusBroadcastInFlight) return;
  weeklyFlowStatusBroadcastInFlight = true;
  try {
    if (!hasWsSubscribers("weekly-flow") && !hasWsSubscribers("playlists")) {
      return;
    }
    const payloadByAudience = new Map();
    const buildPayload = (channel) => (client) => {
      const cacheKey =
        client?.user?.role === "admin"
          ? "admin"
          : client?.user?.id != null
            ? `user:${client.user.id}`
            : `anon:${client?.id || "unknown"}`;
      let cached = payloadByAudience.get(cacheKey);
      if (!cached) {
        const status = getWeeklyFlowStatusSnapshot({
          user: client?.user || null,
        });
        cached = {
          payload: JSON.stringify(status),
          message: {
            type: "playlist_status",
            status,
          },
        };
        payloadByAudience.set(cacheKey, cached);
      }
      if (!client._lastWeeklyFlowStatusPayloadByChannel) {
        client._lastWeeklyFlowStatusPayloadByChannel = new Map();
      }
      if (client._lastWeeklyFlowStatusPayloadByChannel.get(channel) === cached.payload) {
        return null;
      }
      client._lastWeeklyFlowStatusPayloadByChannel.set(channel, cached.payload);
      return cached.message;
    };
    websocketService.broadcastPerClient("weekly-flow", buildPayload("weekly-flow"));
    websocketService.broadcastPerClient("playlists", buildPayload("playlists"));
  } catch (error) {
    logger.warn("system", "Failed to broadcast weekly flow status:", { message: error.message });
  } finally {
    weeklyFlowStatusBroadcastInFlight = false;
  }
};

const broadcastIntervals = [];

const scheduleBroadcast = (fn, intervalMs) => {
  fn();
  broadcastIntervals.push(setInterval(fn, intervalMs));
};

scheduleBroadcast(broadcastDownloadStatuses, DOWNLOAD_STATUS_INTERVAL_MS);
scheduleBroadcast(broadcastWeeklyFlowStatus, WEEKLY_FLOW_STATUS_INTERVAL_MS);

let shuttingDown = false;

const gracefulShutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("system", `Received ${signal}, shutting down...`);
  for (const interval of broadcastIntervals) {
    clearInterval(interval);
  }
  await shutdownHonkerInfrastructure({ timeoutMs: 30000 });
  await new Promise((resolve) => {
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

httpServer.listen(PORT, "::", async () => {
  logger.info("system", `Server running on port ${PORT}`);
  bootstrapHonkerSchedules();
  initializeAppRuntime({ logger });
});

httpServer.on("error", (error) => {
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
