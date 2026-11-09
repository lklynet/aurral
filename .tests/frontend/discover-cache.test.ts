import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import {
  getStoredRecentlyAddedAt,
  readStoredRecentlyAdded,
} from "../../frontend/src/pages/discoverUtils.ts";

test("discover cache timestamps follow fallback data", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
  });

  try {
    localStorage.setItem("discoverRecentlyAdded", JSON.stringify([{ id: 1 }]));
    localStorage.setItem("discoverRecentlyAdded:at", "999000");
    assert.deepEqual(readStoredRecentlyAdded(7), [{ id: 1 }]);
    assert.equal(getStoredRecentlyAddedAt(7), 999000);
  } finally {
    vi.unstubAllGlobals();
  }
});
