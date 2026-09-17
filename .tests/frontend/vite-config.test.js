import assert from "node:assert/strict";
import test from "node:test";
import viteConfig from "../../frontend/vite.config.js";

test("production builds do not emit speculative modulepreload links", () => {
  const config = viteConfig({
    command: "build",
    mode: "production",
    isPreview: false,
    isSsrBuild: false,
  });

  assert.equal(config.build.modulePreload, false);
});
