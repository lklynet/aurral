import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("account settings save results only apply to the active account", async (t) => {
  const vite = await createServer({
    root: "frontend",
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  t.after(() => vite.close());

  const { isCurrentAccount } = await vite.ssrLoadModule(
    "/src/pages/Settings/hooks/useAccountSettings.js?account-switch-test",
  );
  assert.equal(isCurrentAccount(7, 7), true);
  assert.equal(isCurrentAccount(8, 7), false);
  assert.equal(isCurrentAccount(null, 7), false);
});
