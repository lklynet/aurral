import dns from "node:dns";
import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";

dns.setDefaultResultOrder("ipv4first");

import { app } from "./app.ts";
import { isProxyAuthEnabled } from "./middleware/auth.ts";
import { isOidcEnabled } from "./services/oidcAuth.ts";
import { logger, logUnhandledRejection } from "./services/logger.ts";
import { websocketService, type WebSocketChannelPayload } from "./services/websocketService.ts";
import {
  getLidarrStatusSnapshot,
  hasActiveLidarrStatusSnapshot,
} from "./routes/library/handlers/downloads.ts";
import { startPlaylistStatusBroadcasts } from "./services/playlists/playlistStatusBroadcaster.ts";

import { warnAboutConfigDeprecations } from "./services/deprecatedUsage.ts";
import { bootstrapHonkerSchedules } from "./services/honkerDb.ts";
import { initializeAppRuntime } from "./services/appRuntime.ts";
import {
  registerHonkerShutdownHandler,
  shutdownHonkerInfrastructure,
} from "./services/honkerWorkerRuntime.ts";
import { stopShareListener, syncShareListener } from "./services/shareLinks/shareListener.ts";
import { asAppError } from "../lib/errors.ts";

process.on("uncaughtException", (error) => {
  logger.error("system", "Uncaught Exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", logUnhandledRejection);

const PORT = process.env.PORT || 3001;

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

const httpServer = createServer(getRequestListener(app.fetch, { overrideGlobalObjects: false }));
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
