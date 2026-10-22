import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { build } from "vite-plus";

test("the service worker leaves navigations to the network", async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), "aurral-sw-"));
  t.onTestFinished(() => rm(workDir, { recursive: true, force: true }));
  const entry = join(workDir, "entry.js");
  const outDir = join(workDir, "dist");
  await writeFile(entry, "export {};\n");

  await build({
    root: "frontend",
    logLevel: "silent",
    build: { outDir, emptyOutDir: true, rollupOptions: { input: entry } },
  });
  const serviceWorker = await readFile(join(outDir, "sw.js"), "utf8");

  assert.doesNotMatch(serviceWorker, /NavigationRoute/);
  assert.doesNotMatch(serviceWorker, /createHandlerBoundToURL/);
});
