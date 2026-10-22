import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import BoundedMap from "../../backend/services/boundedMap.ts";

test("bounded maps evict the least recently written keys at their limit", () => {
  const cache = new BoundedMap(3, [
    ["a", 1],
    ["b", 2],
    ["c", 3],
  ]);
  cache.set("a", 10);
  cache.set("d", 4);

  assert.deepEqual([...cache.keys()], ["c", "a", "d"]);
  assert.equal(cache.get("a"), 10);
  assert.equal(cache.has("b"), false);
});
