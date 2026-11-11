import "./config/restoreOnBoot.ts";
import dns from "node:dns";
import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";

dns.setDefaultResultOrder("ipv4first");

import { app } from "./app.ts";
import { getEnvApiKey, isProxyAuthEnabled } from "./services/auth.ts";
import { isOidcEnabled } from "./services/oidcAuth.ts";
import { logger, logUnhandledRejection } from "./services/logger.ts";
import { websocketService } from "./services/websocketService.ts";
import { startPlaylistStatusBroadcasts } from "./services/playlists/playlistStatusBroadcaster.ts";

import { warnAboutConfigDeprecations } from "./services/deprecatedUsage.ts";
import { syncSchedules } from "./services/jobs/schedules.ts";
import { initializeAppRuntime } from "./services/appRuntime.ts";
import { registerShutdownHandler, shutdownJobWorkers } from "./services/jobs/worker.ts";
import { stopShareListener, syncShareListener } from "./services/shareLinks/shareListener.ts";
import { stopAllPlugins } from "./services/plugins/pluginHost.ts";
import { refreshInstalledPlugins } from "./services/plugins/pluginService.ts";
import { asAppError } from "../lib/errors.ts";
import { startMainLogging } from "./services/logs.ts";
import { movePlaylistFiles } from "./services/playlistFilesystemMigration.ts";

startMainLogging();

process.on("uncaughtException", (error) => {
  logger.error("system", "Uncaught Exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", logUnhandledRejection);

const PORT = process.env.PORT || 3001;

try {
  getEnvApiKey();
} catch (error) {
  logger.error("system", asAppError(error)?.message || "AURRAL_API_KEY is invalid");
  process.exit(1);
}

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

const stopPlaylistStatusBroadcasts = startPlaylistStatusBroadcasts();

let shuttingDown = false;

const gracefulShutdown = async (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("system", `Received ${signal}, shutting down...`);
  stopPlaylistStatusBroadcasts();
  stopAllPlugins();
  await shutdownJobWorkers({ timeoutMs: 5000 });
  await stopShareListener();
  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
  });
  process.exit(0);
};

registerShutdownHandler(async () => {
  websocketService.close?.();
});

process.once("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});
process.once("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});

try {
  const moved = movePlaylistFiles();
  if (moved) logger.info("playlists", `Moved ${moved} playlist file(s) to the _playlists folder`);
} catch (error) {
  logger.error("playlists", "Couldn't move playlist files out of aurral-weekly-flow", {
    message: asAppError(error)?.message,
  });
}

httpServer.listen(PORT, async () => {
  logger.info("system", `Server running on port ${PORT}`);
  warnAboutConfigDeprecations();
  syncSchedules();
  initializeAppRuntime();
  void syncShareListener();
  refreshInstalledPlugins().catch((error) =>
    logger.warn("system", "Couldn't read the plugins folder", {
      message: asAppError(error)?.message,
    }),
  );
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
