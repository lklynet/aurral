import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

type ToastApi = ReturnType<typeof import("../../frontend/src/contexts/ToastContext.tsx").useToast>;
type ToastMessage = Parameters<ToastApi["addToast"]>[0];
type ToastRecord = import("../../frontend/src/components/Toast.tsx").ToastItem & {
  open: boolean;
  onClose?: () => void;
};

const json = (value: unknown, status: number = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const until = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 1000 && !condition(); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(condition(), "condition was not reached");
};

const createToasts = () => {
  const toasts: ToastRecord[] = [];
  const add = (type: ToastRecord["type"], message: ToastMessage, duration?: number) => {
    const content = typeof message === "string" ? { message } : message;
    const toast = { id: String(toasts.length + 1), type, duration, open: true, ...content };
    toasts.push(toast);
    return toast.id;
  };
  const close = (id: string) => {
    const toast = toasts.find((entry) => entry.id === id && entry.open);
    if (!toast) return;
    toast.open = false;
    toast.onClose?.();
  };
  return {
    toasts,
    addToast: (content: ToastMessage, type: ToastRecord["type"], duration?: number) =>
      add(type, content, duration),
    removeToast: close,
    showSuccess: (message: ToastMessage) => add("success", message),
    showError: (message: ToastMessage) => add("error", message),
    showInfo: (message: ToastMessage) => add("info", message),
    close,
    undo(id: string) {
      const toast = toasts.find((entry) => entry.id === id);
      assert.ok(toast?.action?.onClick);
      toast.action.onClick();
      close(id);
    },
    open: () =>
      toasts.filter((toast) => toast.open).map(({ type, message }) => ({ type, message })),
  };
};

const openHarness = async (
  t: import("vite-plus/test").TestContext,
  suffix: string,
  { failRemoval = false }: { failRemoval?: boolean } = {},
) => {
  vi.resetModules();
  const { createPlaylistTrackChanges } =
    await import("../../frontend/src/pages/playlists/playlistTrackChanges.ts");
  const { queryClient } = await import("../../frontend/src/queryClient.ts");
  const originalFetch = globalThis.fetch;
  const removals: { jobIds: string[]; keepalive: boolean }[] = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    if (path.endsWith("/track-removals")) {
      const body: { jobIds: string[] } = JSON.parse(String(init.body));
      removals.push({ ...body, keepalive: init.keepalive === true });
      if (failRemoval) return json({ error: "Playlist is locked" }, 500);
      return json({
        queued: true,
        operationId: `op-${removals.length}`,
        acceptedJobIds: body.jobIds,
        rejected: [],
      });
    }
    if (path.includes("/operations/")) {
      const body = removals[Number(path.split("op-")[1]) - 1];
      return json({
        state: "completed",
        outcomes: body.jobIds.map((jobId) => ({ jobId, status: "removed" })),
      });
    }
    return json([]);
  };
  t.onTestFinished(() => {
    globalThis.fetch = originalFetch;
    queryClient.clear();
  });
  const toast = createToasts();
  const changes = createPlaylistTrackChanges(toast);
  const hidden = (playlistId = "road-trip") =>
    [...(changes.getHidden().get(playlistId) || [])].sort();
  return { changes, toast, removals, hidden };
};

const playlist = { id: "road-trip", name: "Road trip" };
const tracks = ["a", "b", "c"].map((id: string) => ({ id, trackName: `Song ${id.toUpperCase()}` }));

test("removed tracks leave the playlist at once and are only deleted when the Undo toast closes", async (t) => {
  const { changes, toast, removals, hidden } = await openHarness(t, "removal-commit");

  changes.remove(playlist, [tracks[0], tracks[2]]);

  assert.deepEqual(hidden(), ["a", "c"]);
  assert.deepEqual(toast.open(), [{ type: "success", message: "Removed 2 tracks from Road trip" }]);
  assert.equal(removals.length, 0);

  toast.close(toast.toasts[0].id);
  await until(() => hidden().length === 0);

  assert.deepEqual(removals, [{ jobIds: ["a", "c"], keepalive: true }]);
  assert.deepEqual(toast.open(), []);
});

test("undoing the second of two removals restores only that track and never deletes it", async (t) => {
  const { changes, toast, removals, hidden } = await openHarness(t, "removal-sequence");

  changes.remove(playlist, [tracks[0]]);
  changes.remove(playlist, [tracks[1]]);
  const [first, second] = toast.toasts;
  assert.equal(second.message, "Removed Song B from Road trip");

  toast.undo(second.id);
  assert.deepEqual(hidden(), ["a"]);
  assert.deepEqual(toast.open().at(-1), {
    type: "success",
    message: "Restored Song B to Road trip",
  });

  toast.close(first.id);
  await until(() => hidden().length === 0);
  assert.deepEqual(
    removals.map((removal) => removal.jobIds),
    [["a"]],
  );
});

test("leaving the page sends pending removals and closes their Undo toasts", async (t) => {
  const { changes, toast, removals, hidden } = await openHarness(t, "removal-flush");

  changes.remove(playlist, [tracks[1]]);
  changes.flush();

  assert.equal(toast.toasts[0].open, false);
  await until(() => hidden().length === 0);
  assert.deepEqual(
    removals.map((removal) => removal.jobIds),
    [["b"]],
  );
});

test("a rejected removal brings the tracks back and says nothing changed", async (t) => {
  const { changes, toast, hidden } = await openHarness(t, "removal-failure", { failRemoval: true });

  changes.remove(playlist, [tracks[0], tracks[1]]);
  toast.close(toast.toasts[0].id);
  await until(() => hidden().length === 0);

  assert.deepEqual(toast.open(), [
    {
      type: "error",
      message: "Could not remove 2 tracks from Road trip. Nothing changed. Playlist is locked.",
    },
  ]);
});
