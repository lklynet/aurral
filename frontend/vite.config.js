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
  const apiTarget = env.AURRAL_API_PROXY_TARGET || "http://localhost:3001";

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
          description: "Self-hosted music discovery and library management.",
          theme_color: "#000000",
          background_color: "#000000",
          display: "standalone",
          orientation: "portrait",
          start_url: basePath,
          icons: [
            {
              src: `${basePath}icons/aurral-icon-192.png`,
              sizes: "192x192",
              type: "image/png",
              purpose: "any",
            },
            {
              src: `${basePath}icons/aurral-icon-512.png`,
              sizes: "512x512",
              type: "image/png",
              purpose: "any",
            },
            {
              src: `${basePath}icons/aurral-icon-maskable-512.png`,
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
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
      // Avoid speculative modulepreload requests that Chrome reports as unused
      // when a service worker controls the page and routes load on demand.
      modulePreload: false,
    },
    server: {
      port: 3000,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: false,
          xfwd: true,
          secure: false,
          ws: true,
          timeout: 60000,
          proxyTimeout: 60000,
        },
        "/sso/callback": {
          target: apiTarget,
          changeOrigin: true,
          xfwd: true,
          secure: false,
        },
        "/ws": {
          target: apiTarget.replace(/^http/, "ws"),
          ws: true,
        },
      },
    },
  };
});
