import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("a resolved auth session survives a temporary bootstrap failure", async (t) => {
  const vite = await createServer({
    root: "frontend",
    server: { middlewareMode: true },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });

  t.after(() => vite.close());

  const { shouldResetAuthAfterBootstrapFailure } = await vite.ssrLoadModule(
    "/src/contexts/AuthContext.jsx?auth-failure-test",
  );
  assert.equal(shouldResetAuthAfterBootstrapFailure(true), false);
  assert.equal(shouldResetAuthAfterBootstrapFailure(false), true);
});
