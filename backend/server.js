import "./loadEnv.js";

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createServer } from "http";

process.on("uncaughtException", (err) => {
  if (err.code === "ERR_STREAM_DESTROYED") {
    console.warn(
      "[Process] Caught stream destroyed error (safe to ignore):",
      err.message,
    );
    return;
  }
  console.error("[Process] Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  if (reason?.code === "ERR_STREAM_DESTROYED") {
    console.warn(
      "[Process] Caught stream destroyed rejection (safe to ignore)",
    );
    return;
  }
  console.error("[Process] Unhandled Rejection:", reason);
});

import { createAuthMiddleware } from "./middleware/auth.js";
import { updateDiscoveryCache } from "./services/discoveryService.js";
import { libraryManager } from "./services/libraryManager.js";
import { lidarrSignalRService } from "./services/lidarrClient.js";
import { websocketService } from "./services/websocketService.js";

import settingsRouter from "./routes/settings.js";
import onboardingRouter from "./routes/onboarding.js";
import usersRouter from "./routes/users.js";
import artistsRouter from "./routes/artists.js";
import libraryRouter from "./routes/library.js";
import discoveryRouter from "./routes/discovery.js";
import requestsRouter from "./routes/requests.js";
import healthRouter from "./routes/health.js";
import weeklyFlowRouter from "./routes/weeklyFlow.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const DAY_MS = 24 * 60 * 60 * 1000;

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

app.use(cors());
app.use(helmet());
app.use(express.json());

app.use(createAuthMiddleware());

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

setInterval(updateDiscoveryCache, DAY_MS);

setInterval(() => {
  libraryManager
    .fullSyncFromLidarr()
    .then((result) => {
      if (result?.success) {
        console.log(
          `[LibrarySync] Full sync complete (${result.artists} artists, ${result.albums} albums)`,
        );
      } else if (result?.error && result.error !== "Lidarr is not configured") {
        console.warn("[LibrarySync] Full sync failed:", result.error);
      }
    })
    .catch((error) => {
      console.warn("[LibrarySync] Full sync failed:", error?.message || error);
    });
}, DAY_MS);

setTimeout(async () => {
  const { dbOps } = await import("./config/db-helpers.js");
  const discovery = dbOps.getDiscoveryCache();
  const lastUpdated = discovery?.lastUpdated;
  const twentyFourHoursAgo = Date.now() - DAY_MS;
  if (!lastUpdated || new Date(lastUpdated).getTime() < twentyFourHoursAgo) {
    updateDiscoveryCache();
  } else {
    console.log(
      `Discovery cache is fresh (last updated ${lastUpdated}). Skipping initial update.`,
    );
  }
}, 5000);

setTimeout(async () => {
  const lastSyncAt = libraryManager.getLastFullSyncAt();

  libraryManager.getAllArtists().catch(() => {});
  libraryManager.getAllAlbums().catch(() => {});

  if (!lastSyncAt || Date.now() - lastSyncAt > DAY_MS) {
    try {
      const result = await libraryManager.fullSyncFromLidarr();
      if (result?.success) {
        console.log(
          `[LibrarySync] Initial full sync complete (${result.artists} artists, ${result.albums} albums)`,
        );
      } else if (result?.error && result.error !== "Lidarr is not configured") {
        console.warn("[LibrarySync] Initial full sync failed:", result.error);
      }
    } catch (error) {
      console.warn(
        "[LibrarySync] Initial full sync failed:",
        error?.message || error,
      );
    }
  }
}, 8000);

const httpServer = createServer(app);

websocketService.initialize(httpServer);

httpServer.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket available at ws://localhost:${PORT}/ws`);
  lidarrSignalRService.start();
  libraryManager.startActivityPolling();
});
