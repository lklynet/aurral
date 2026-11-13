import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { applyCustomOrder } from "../../frontend/src/utils/playlistOrder.ts";

test("a custom order leads and anything it doesn't name keeps its own order after it", () => {
  const items = ["a", "b", "c", "d", "e"].map((id) => ({ id }));

  assert.deepEqual(
    applyCustomOrder(items, ["d", "gone", "b"]).map(({ id }) => id),
    ["d", "b", "a", "c", "e"],
  );
});
