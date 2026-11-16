import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import type { ToastItem } from "../../frontend/src/components/Toast.tsx";
import { stackToast } from "../../frontend/src/utils/toastStack.ts";

const toast = (id: string, duration = 3000): ToastItem => ({
  id,
  type: "info",
  message: id,
  duration,
});
const undo = (id: string, message: string): ToastItem => ({
  ...toast(id, 8000),
  message,
  action: { label: "Undo", onClick: () => {} },
});
const error = (id: string, message: string): ToastItem => ({
  ...toast(id),
  type: "error",
  message,
});
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

test("a repeated message replaces its earlier copy instead of pushing out an Undo toast", () => {
  const { kept, evicted } = stackToast(
    [error("e2", "Failed"), error("e1", "Failed"), undo("u", "Queue cleared")],
    error("e3", "Failed"),
    3,
  );
  assert.deepEqual(ids(kept), ["e3", "u"]);
  assert.deepEqual(ids(evicted), []);
});

test("toasts with their own action stay separate even when the message repeats", () => {
  const { kept } = stackToast([undo("u1", "Queue cleared")], undo("u2", "Queue cleared"), 3);
  assert.deepEqual(ids(kept), ["u2", "u1"]);
});
