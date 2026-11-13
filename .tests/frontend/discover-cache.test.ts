import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import {
  getStoredRecentlyAddedAt,
  readStoredRecentlyAdded,
} from "../../frontend/src/utils/discoverUtils.ts";

test("discover cache follows fallback data and misses on entries an older Aurral wrote", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
  });

  try {
    const artist = { id: "1", artistName: "Artist" };
    localStorage.setItem("discoverRecentlyAdded", JSON.stringify([artist]));
    localStorage.setItem("discoverRecentlyAdded:at", "999000");
    assert.deepEqual(readStoredRecentlyAdded(7), [artist]);
    assert.equal(getStoredRecentlyAddedAt(7), 999000);

    localStorage.setItem("discoverRecentlyAdded", JSON.stringify([artist, { id: 1 }]));
    assert.equal(readStoredRecentlyAdded(7), null);
  } finally {
    vi.unstubAllGlobals();
  }
});
