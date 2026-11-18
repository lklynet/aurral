import { defineConfig, loadEnv, type Plugin } from "vite-plus";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { cwd } from "process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import { resolveAppVersion } from "../lib/app-version.ts";
import { hostedBuildPath } from "../lib/hostedBuild.ts";
import { normalizeBasePathWithTrailingSlash } from "./src/utils/basePath.ts";

const appVersion = resolveAppVersion({
  envValue: globalThis?.process?.env?.VITE_APP_VERSION,
  cwd: process.cwd(),
});
const releaseChannel = globalThis?.process?.env?.VITE_RELEASE_CHANNEL || "stable";

const COMPRESSIBLE = /\.(?:js|css|html|svg|json|webmanifest)$/;
const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

const precompress = (): Plugin => {
  let outDir = "";
  return {
    name: "aurral-precompress",
    apply: "build",
    configResolved: (config) => {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle: {
      order: "post",
      sequential: true,
      handler: async () => {
        const files = await fs.readdir(outDir, { recursive: true });
        await Promise.all(
          files
            .filter((file) => COMPRESSIBLE.test(file))
            .map(async (file) => {
              const full = path.join(outDir, file);
              const source = await fs.readFile(full);
              if (source.byteLength < 1024) return;
              const params = { [constants.BROTLI_PARAM_QUALITY]: 11 };
              await Promise.all([
                brotli(source, { params }).then((out) => fs.writeFile(`${full}.br`, out)),
                gzipAsync(source, { level: 9 }).then((out) => fs.writeFile(`${full}.gz`, out)),
              ]);
            }),
        );
      },
    },
  };
};

const HOSTED_SITE_DIR = "dist-hosted";

const hostedSite = (): Plugin => {
  let root = "";
  let outDir = "";
  return {
    name: "aurral-hosted-site",
    configResolved: (config) => {
      root = config.root;
      outDir = path.resolve(config.root, config.build.outDir);
    },
    transformIndexHtml: {
      order: "pre",
      handler: (html) => html.replace("/src/main.tsx", "/src/hosted/entry.ts"),
    },
    closeBundle: {
      order: "post",
      sequential: true,
      handler: async () => {
        const site = path.resolve(root, HOSTED_SITE_DIR);
        await fs.cp(path.join(outDir, "assets"), path.join(site, "assets"), { recursive: true });
        await fs.rm(path.join(outDir, "assets"), { recursive: true });
        await fs.copyFile(path.join(outDir, "index.html"), path.join(site, "index.html"));
      },
    },
  };
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, cwd(), "");
  const hosted = mode === "hosted";
  const basePath = hosted
    ? hostedBuildPath(appVersion)
    : normalizeBasePathWithTrailingSlash(env.VITE_BASE_PATH || "/");
  const isDev = mode === "development";
  const apiTarget = env.AURRAL_API_PROXY_TARGET || "http://localhost:3001";

  return {
    base: isDev ? "/" : basePath,
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(appVersion),
      "import.meta.env.VITE_RELEASE_CHANNEL": JSON.stringify(releaseChannel),
      "import.meta.env.VITE_HOSTED": JSON.stringify(hosted),
      ...(hosted && { "import.meta.env.VITE_BASE_PATH": JSON.stringify("/") }),
    },
    plugins: [
      react(),
      hosted && hostedSite(),
      VitePWA({
        disable: hosted,
        registerType: "autoUpdate",
        includeAssets: ["arralogo*.svg", "icons/*.png", "spotify-oauth-callback.js"],
        workbox: {
          navigateFallback: null,
          directoryIndex: null,
        },
        manifest: {
          name: "Aurral - Music Discovery",
          short_name: "Aurral",
          description: "Find new music, get it, and play it, all on your own server.",
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
      !hosted && precompress(),
    ],
    experimental: {
      renderBuiltUrl: (filename, { type }) =>
        hosted && type === "asset" ? `/${filename}` : undefined,
    },
    build: {
      outDir: hosted ? `${HOSTED_SITE_DIR}${hostedBuildPath(appVersion)}` : "dist",
      emptyOutDir: true,
      modulePreload: { polyfill: false },
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              { name: "startup-vendor", tags: ["$initial"], test: /node_modules/ },
              { name: "startup", tags: ["$initial"] },
            ],
          },
        },
      },
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
