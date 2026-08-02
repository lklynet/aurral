import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { cwd } from "process";
import { resolveAppVersion } from "../lib/app-version.js";
import { normalizeBasePathWithTrailingSlash } from "./src/utils/basePath.js";

const appVersion = resolveAppVersion({
  envValue: globalThis?.process?.env?.VITE_APP_VERSION,
  cwd: process.cwd(),
});
const releaseChannel = globalThis?.process?.env?.VITE_RELEASE_CHANNEL || "stable";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, cwd(), "");
  const basePath = normalizeBasePathWithTrailingSlash(env.VITE_BASE_PATH || "/");
  const isDev = mode === "development";

  return {
    base: isDev ? "/" : basePath,
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(appVersion),
      "import.meta.env.VITE_RELEASE_CHANNEL": JSON.stringify(releaseChannel),
    },
    plugins: [
      react(),
      VitePWA({
        registerType: "autoUpdate",
        includeAssets: ["arralogo.svg", "icons/*.png", "spotify-oauth-callback.js"],
        workbox: {
          navigateFallback: null,
          directoryIndex: null,
        },
        manifest: {
          name: "Aurral - Music Discovery",
          short_name: "Aurral",
          description: "Self-hosted music discovery for the Lidarr stack",
          theme_color: "#ffffff",
          background_color: "#ffffff",
          display: "standalone",
          orientation: "portrait",
          start_url: basePath,
          icons: [
            {
              src: `${basePath}icons/aurral-icon-iOS-Default-1024x1024@1x.png`,
              sizes: "1024x1024",
              type: "image/png",
              purpose: "any",
            },
          ],
        },
        devOptions: {
          enabled: false,
        },
      }),
    ],
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
    server: {
      port: 3000,
      proxy: {
        "/api": {
          target: "http://localhost:3001",
          changeOrigin: true,
          secure: false,
          ws: true,
          timeout: 60000,
          proxyTimeout: 60000,
        },
        "/ws": {
          target: "ws://localhost:3001",
          ws: true,
        },
      },
    },
  };
});
