import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { resolveLibraryScanChangedPaths } from "../../backend/services/libraryScanRequest.ts";

test("forced scans ignore accumulated watcher paths", () => {
  const registry = { changedPaths: ["/data/music/changed.flac"] };
  assert.equal(resolveLibraryScanChangedPaths(registry, true), null);
  assert.deepEqual(resolveLibraryScanChangedPaths(registry, false), registry.changedPaths);
});
