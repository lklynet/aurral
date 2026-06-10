import "./loadEnv.js";

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import path from "path";
import fs from "fs";
import { createServer } from "http";
import { fileURLToPath } from "url";

import { createAuthMiddleware } from "./middleware/auth.js";
import { cleanExpiredSessions } from "./config/session-helpers.js";
import {
  updateDiscoveryCache,
  getDiscoveryCache,
  getDiscoveryAutoRefreshHours,
} from "./services/discoveryService.js";
import { websocketService } from "./services/websocketService.js";
import { getAllDownloadStatuses } from "./routes/library/handlers/downloads.js";
import { getWeeklyFlowStatusSnapshot } from "./services/weeklyFlowStatusSnapshot.js";
import { dbOps } from "./config/db-helpers.js";

import settingsRouter from "./routes/settings.js";
import onboardingRouter from "./routes/onboarding.js";
import usersRouter from "./routes/users.js";
import artistsRouter from "./routes/artists.js";
import searchRouter from "./routes/search.js";
import libraryRouter from "./routes/library.js";
import discoveryRouter from "./routes/discovery.js";
import requestsRouter from "./routes/requests.js";
import healthRouter from "./routes/health.js";
import weeklyFlowRouter from "./routes/weeklyFlow.js";
import authRouter from "./routes/auth.js";
import imageProxyRouter from "./routes/imageProxy.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection:", reason);
});

const app = express();
const PORT = process.env.PORT || 3001;
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "5mb";

const allowedCorsOrigins = String(process.env.CORS_ORIGIN || "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const corsOptions =
  allowedCorsOrigins.length > 0
    ? {
        origin(origin, callback) {
          if (!origin || allowedCorsOrigins.includes(origin)) {
            return callback(null, true);
          }
          return callback(null, false);
        },
      }
    : { origin: false };

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

app.use(cors(corsOptions));
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
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
          "https://archive.org",
          "https://*.archive.org",
          "https://*.last.fm",
          "https://lastfm.freetls.fastly.net",
        ],
        connectSrc: ["'self'", "ws:", "wss:", "https://api.github.com"],
        mediaSrc: ["'self'", "https://*.dzcdn.net", "https://*.deezer.com"],
        frameSrc: [
          "'self'",
          "https://www.youtube-nocookie.com",
          "https://www.youtube.com",
        ],
        frameAncestors: null,
        upgradeInsecureRequests: null,
      },
    },
    frameguard: false,
  }),
);
app.use(express.json({ limit: JSON_BODY_LIMIT }));

app.use(createAuthMiddleware());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
});
app.use("/api/auth/login", authLimiter);
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
app.use("/api/weekly-flow", weeklyFlowRouter);
app.use("/api/auth", authRouter);
app.use("/api/image-proxy", imageProxyRouter);

const HOUR_MS = 60 * 60 * 1000;
setInterval(() => {
  import("./services/weeklyFlowScheduler.js")
    .then((m) => m.runScheduledRefresh())
    .catch((err) => console.error("Weekly flow scheduler error:", err.message));
}, HOUR_MS);

setInterval(() => {
  cleanExpiredSessions();
}, HOUR_MS);

setTimeout(() => {
  import("./services/weeklyFlowScheduler.js")
    .then((m) => m.startWorkerIfPending())
    .catch((err) =>
      console.error("Weekly flow startup check error:", err.message),
    );
}, 5000);

const REUSE_REPAIR_INTERVAL_MS = 30 * 60 * 1000;
setInterval(() => {
  import("./services/weeklyFlowWorker.js")
    .then((m) => m.weeklyFlowWorker.scheduleReuseLinkRepair(false))
    .catch((err) =>
      console.error("Weekly flow reuse repair error:", err.message),
    );
}, REUSE_REPAIR_INTERVAL_MS);

setTimeout(() => {
  import("./services/weeklyFlowWorker.js")
    .then((m) => m.weeklyFlowWorker.scheduleReuseLinkRepair(true))
    .catch((err) =>
      console.error("Weekly flow reuse repair startup error:", err.message),
    );
}, 15000);

setTimeout(async () => {
  try {
    const [{ migrateLegacyWeeklyFlowPaths, resolveWeeklyFlowRoot }, trackerModule] =
      await Promise.all([
        import("./services/weeklyFlowPaths.js"),
        import("./services/weeklyFlowDownloadTracker.js"),
      ]);
    const result = await migrateLegacyWeeklyFlowPaths(
      resolveWeeklyFlowRoot(),
      trackerModule.downloadTracker,
    );
    if (result.migrated > 0) {
      console.log(
        `[WeeklyFlow] Migrated ${result.migrated} legacy track paths to ${resolveWeeklyFlowRoot()}`,
      );
    }
  } catch (err) {
    console.error("Weekly flow path migration error:", err.message);
  }
}, 3000);

const frontendDist = path.join(__dirname, "..", "frontend", "dist");
const frontendFallbackRoute = /.*/;

if (fs.existsSync(frontendDist)) {
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
  console.error(err);
  if (res.headersSent) return next(err);
  if (err?.type === "entity.too.large" || err?.status === 413) {
    return res.status(413).json({
      error: "Payload too large",
      message: `Request body exceeds limit (${JSON_BODY_LIMIT})`,
    });
  }
  return res.status(500).json({ error: "Internal server error" });
});

setInterval(
  () => {
    const discoveryCache = getDiscoveryCache();
    const lastUpdated = discoveryCache?.lastUpdated;
    const refreshHours = getDiscoveryAutoRefreshHours();
    const refreshIntervalMs = refreshHours * 60 * 60 * 1000;
    const parsedLastUpdated = lastUpdated ? new Date(lastUpdated).getTime() : 0;
    const needsUpdate =
      !Number.isFinite(parsedLastUpdated) ||
      parsedLastUpdated <= 0 ||
      Date.now() - parsedLastUpdated >= refreshIntervalMs;

    if (!needsUpdate) return;

    updateDiscoveryCache().catch((err) => {
      console.error("Error in scheduled discovery update:", err.message);
    });
  },
  15 * 60 * 1000,
);

setTimeout(async () => {
  const { getLastfmApiKey } = await import("./services/apiClients.js");
  const { libraryManager } =
    await import("./services/libraryManager.js");

  const hasLastfm = !!getLastfmApiKey();
  const libraryArtists = await libraryManager.getAllArtists();
  const hasArtists = libraryArtists.length > 0;

  if (!hasLastfm && !hasArtists) {
    console.log(
      "Discovery not configured (no Last.fm key and no artists). Clearing cache.",
    );
    try {
      dbOps.updateDiscoveryCache({
        recommendations: [],
        globalTop: [],
        basedOn: [],
        topTags: [],
        topGenres: [],
        lastUpdated: null,
      });
    } catch (error) {
      console.error("Failed to clear discovery cache:", error.message);
    }
    return;
  }

  const discoveryCache = dbOps.getDiscoveryCache();
  const lastUpdated = discoveryCache?.lastUpdated;
  const hasRecommendations =
    discoveryCache.recommendations && discoveryCache.recommendations.length > 0;
  const hasGenres =
    discoveryCache.topGenres && discoveryCache.topGenres.length > 0;

  const refreshHours = getDiscoveryAutoRefreshHours();
  const staleCutoff = Date.now() - refreshHours * 60 * 60 * 1000;
  const needsUpdate =
    !lastUpdated ||
    new Date(lastUpdated).getTime() < staleCutoff ||
    !hasRecommendations ||
    !hasGenres;

  if (needsUpdate) {
    console.log("Discovery cache needs update. Starting...");
    updateDiscoveryCache().catch((err) => {
      console.error("Error in initial discovery update:", err.message);
    });
  } else {
    console.log(
      `Discovery cache is fresh (last updated ${lastUpdated}). Skipping initial update.`,
    );
  }
}, 15000);

const httpServer = createServer(app);
websocketService.initialize(httpServer);

const DOWNLOAD_STATUS_INTERVAL_MS = 10000;
let lastDownloadStatusesPayload = null;
const hasWsSubscribers = (channel) => {
  const stats = websocketService.getStats();
  const total = Number(stats?.channels?.[channel] || 0);
  return total > 0;
};
const broadcastDownloadStatuses = async () => {
  try {
    if (!hasWsSubscribers("downloads")) return;
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
    console.warn("Failed to broadcast download statuses:", error.message);
  }
};

const WEEKLY_FLOW_STATUS_INTERVAL_MS = 4000;
const lastWeeklyFlowStatusPayloadByUser = new Map();
const broadcastWeeklyFlowStatus = async () => {
  try {
    if (!hasWsSubscribers("weekly-flow")) return;
    websocketService.broadcastPerClient("weekly-flow", (client) => {
      const status = getWeeklyFlowStatusSnapshot({
        user: client?.user || null,
      });
      const cacheKey =
        client?.user?.role === "admin"
          ? "admin"
          : client?.user?.id != null
            ? `user:${client.user.id}`
            : `anon:${client?.id || "unknown"}`;
      const payload = JSON.stringify(status);
      if (lastWeeklyFlowStatusPayloadByUser.get(cacheKey) === payload) {
        return null;
      }
      lastWeeklyFlowStatusPayloadByUser.set(cacheKey, payload);
      return {
        type: "weekly_flow_status",
        status,
      };
    });
  } catch (error) {
    console.warn("Failed to broadcast weekly flow status:", error.message);
  }
};

broadcastDownloadStatuses();
setInterval(broadcastDownloadStatuses, DOWNLOAD_STATUS_INTERVAL_MS);
broadcastWeeklyFlowStatus();
setInterval(broadcastWeeklyFlowStatus, WEEKLY_FLOW_STATUS_INTERVAL_MS);

httpServer.listen(PORT, "0.0.0.0", async () => {
  console.log(`Server running on port ${PORT}`);
});

httpServer.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. Please stop the other process or use a different port.`,
    );
    process.exit(1);
  } else {
    console.error("Server error:", error);
  }
});
