import assert from "node:assert/strict";
import test from "node:test";
import {
  getStoredRecentlyAddedAt,
  readStoredRecentlyAdded,
} from "../../frontend/src/pages/discoverUtils.js";

test("discover cache timestamps follow fallback data", () => {
  const originalStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };

  try {
    localStorage.setItem("discoverRecentlyAdded", JSON.stringify([{ id: 1 }]));
    localStorage.setItem("discoverRecentlyAdded:at", "999000");
    assert.deepEqual(readStoredRecentlyAdded(7), [{ id: 1 }]);
    assert.equal(getStoredRecentlyAddedAt(7), 999000);
  } finally {
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
  }
});
