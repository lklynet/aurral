import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "vite";

test("the service worker leaves navigations to the network", async (t) => {
  const outDir = await mkdtemp(join(tmpdir(), "aurral-sw-"));
  t.after(() => rm(outDir, { recursive: true, force: true }));

  await build({ root: "frontend", logLevel: "silent", build: { outDir, emptyOutDir: true } });
  const serviceWorker = await readFile(join(outDir, "sw.js"), "utf8");

  assert.doesNotMatch(serviceWorker, /NavigationRoute/);
  assert.doesNotMatch(serviceWorker, /createHandlerBoundToURL/);
});
