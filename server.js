import "./loadEnv.js";

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import path from "path";
import fs from "fs";
import { createServer } from "http";
import { fileURLToPath } from "url";

import { createAuthMiddleware } from "./backend/middleware/auth.js";
import { cleanExpiredSessions } from "./backend/config/session-helpers.js";
import {
  updateDiscoveryCache,
  getDiscoveryCache,
  getDiscoveryAutoRefreshHours,
} from "./backend/services/discoveryService.js";
import { websocketService } from "./backend/services/websocketService.js";
import { getAllDownloadStatuses } from "./backend/routes/library/handlers/downloads.js";
import { getWeeklyFlowStatusSnapshot } from "./backend/services/weeklyFlowStatusSnapshot.js";
import { dbOps } from "./backend/config/db-helpers.js";

import settingsRouter from "./backend/routes/settings.js";
import onboardingRouter from "./backend/routes/onboarding.js";
import usersRouter from "./backend/routes/users.js";
import artistsRouter from "./backend/routes/artists.js";
import libraryRouter from "./backend/routes/library.js";
import discoveryRouter from "./backend/routes/discovery.js";
import requestsRouter from "./backend/routes/requests.js";
import healthRouter from "./backend/routes/health.js";
import weeklyFlowRouter from "./backend/routes/weeklyFlow.js";
import authRouter from "./backend/routes/auth.js";

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
          "https://coverartarchive.org",
          "https://archive.org",
          "https://*.last.fm",
          "https://lastfm.freetls.fastly.net",
        ],
        connectSrc: ["'self'", "ws:", "wss:", "https://api.github.com"],
        mediaSrc: ["'self'", "https://*.dzcdn.net", "https://*.deezer.com"],
        frameSrc: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
    frameguard: { action: "deny" },
  }),
);
app.use(express.json());

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
app.use("/api/search", artistsRouter);
app.use("/api/artists", artistsRouter);
app.use("/api/library", libraryRouter);
app.use("/api/discover", discoveryRouter);
app.use("/api/requests", requestsRouter);
app.use("/api/health", healthRouter);
app.use("/api/weekly-flow", weeklyFlowRouter);
app.use("/api/auth", authRouter);

const HOUR_MS = 60 * 60 * 1000;
setInterval(() => {
  import("./backend/services/weeklyFlowScheduler.js")
    .then((m) => m.runScheduledRefresh())
    .catch((err) => console.error("Weekly flow scheduler error:", err.message));
}, HOUR_MS);

setInterval(() => {
  cleanExpiredSessions();
}, HOUR_MS);

setTimeout(() => {
  import("./backend/services/weeklyFlowScheduler.js")
    .then((m) => m.startWorkerIfPending())
    .catch((err) =>
      console.error("Weekly flow startup check error:", err.message),
    );
}, 5000);

const frontendDist = path.join(__dirname, "frontend", "dist");

if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));

  app.get("*", (req, res) => {
    if (req.path.startsWith("/api")) {
      return res.status(404).json({ error: "Not found" });
    }
    res.sendFile(path.join(frontendDist, "index.html"));
  });
} else {
  app.get("*", (req, res) => {
    if (req.path.startsWith("/api")) {
      return res.status(404).json({ error: "Not found" });
    }
    res.status(503).send("Frontend not built. Run 'npm run build' first.");
  });
}

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
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
  const { getLastfmApiKey } = await import("./backend/services/apiClients.js");
  const { libraryManager } =
    await import("./backend/services/libraryManager.js");

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
let lastWeeklyFlowStatusPayload = null;
const broadcastWeeklyFlowStatus = async () => {
  try {
    if (!hasWsSubscribers("weekly-flow")) return;
    const status = getWeeklyFlowStatusSnapshot();
    const payload = JSON.stringify(status);
    if (payload !== lastWeeklyFlowStatusPayload) {
      lastWeeklyFlowStatusPayload = payload;
      websocketService.broadcast("weekly-flow", {
        type: "weekly_flow_status",
        status,
      });
    }
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
