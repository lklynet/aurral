import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

// normalizeSettings rebuilds integrations from an explicit list of providers, so
// one missing from that list is dropped on every load and can never be saved.
test("lyrics provider settings survive normalization", async (t) => {
  const vite = await createServer({
    root: "frontend",
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  t.after(() => vite.close());

  const { normalizeSettings } = await vite.ssrLoadModule(
    "/src/pages/Settings/utils.js?lyrics-settings-test",
  );

  assert.deepEqual(normalizeSettings({ integrations: {} }).integrations.lrclib, {
    enabled: false,
    url: "",
    priority: 10,
  });

  assert.deepEqual(
    normalizeSettings({
      integrations: { lrclib: { enabled: true, url: "http://lrclib.local", priority: 3 } },
    }).integrations.lrclib,
    { enabled: true, url: "http://lrclib.local", priority: 3 },
  );
});
