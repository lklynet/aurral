import assert from "node:assert/strict";
import test from "node:test";
import BoundedMap from "../../backend/services/boundedMap.js";

test("bounded maps evict the least recently written keys at their limit", () => {
  const cache = new BoundedMap(3, [["a", 1], ["b", 2], ["c", 3]]);
  cache.set("a", 10);
  cache.set("d", 4);

  assert.deepEqual([...cache.keys()], ["c", "a", "d"]);
  assert.equal(cache.get("a"), 10);
  assert.equal(cache.has("b"), false);
});

test("bounded maps stay bounded when given an invalid size", () => {
  for (const size of [0, -1, "many"]) {
    const cache = new BoundedMap(size);
    for (let index = 0; index < 5000; index += 1) cache.set(index, index);
    assert.ok(cache.size > 0 && cache.size < 5000, String(size));
    assert.equal(cache.get(4999), 4999);
  }
});
