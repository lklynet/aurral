import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { stackToast } from "../../frontend/src/utils/toastStack.ts";

const toast = (id: string, duration = 3000) => ({ id, duration });
const ids = (toasts: { id: string }[]) => toasts.map((entry) => entry.id);

test("drops the oldest toast once the stack is full", () => {
  const { kept, evicted } = stackToast([toast("c"), toast("b"), toast("a")], toast("d"), 3);
  assert.deepEqual(ids(kept), ["d", "c", "b"]);
  assert.deepEqual(ids(evicted), ["a"]);
});

test("keeps toasts that stay until dismissed when newer toasts fill the stack", () => {
  const { kept, evicted } = stackToast(
    [toast("c"), toast("b"), toast("star", Infinity)],
    toast("d"),
    3,
  );
  assert.deepEqual(ids(kept), ["d", "c", "star"]);
  assert.deepEqual(ids(evicted), ["b"]);
});
