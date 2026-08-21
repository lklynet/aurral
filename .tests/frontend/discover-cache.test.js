import assert from "node:assert/strict";
import test from "node:test";
import {
  getStoredRecentlyAddedAt,
  isStoredRecentlyAddedFresh,
  readStoredRecentlyAdded,
} from "../../frontend/src/pages/discoverUtils.js";

test("discover cache timestamps follow fallback data and reject future values", () => {
  const originalStorage = globalThis.localStorage;
  const originalNow = Date.now;
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  Date.now = () => 1_000_000;

  try {
    localStorage.setItem("discoverRecentlyAdded", JSON.stringify([{ id: 1 }]));
    localStorage.setItem("discoverRecentlyAdded:at", "999000");
    assert.deepEqual(readStoredRecentlyAdded(7), [{ id: 1 }]);
    assert.equal(getStoredRecentlyAddedAt(7), 999000);
    assert.equal(isStoredRecentlyAddedFresh(), true);

    localStorage.setItem("discoverRecentlyAdded:at", "1001000");
    assert.equal(isStoredRecentlyAddedFresh(), false);
  } finally {
    Date.now = originalNow;
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
  }
});
