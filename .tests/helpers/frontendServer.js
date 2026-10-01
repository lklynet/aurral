import { createServer } from "vite";

export function startFrontendServer() {
  return createServer({
    root: "frontend",
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
}
