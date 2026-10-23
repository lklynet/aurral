import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

import {
  diffDiscoveryFeedback,
  previewArtistDiscoveryFeedback,
  revertDiscoveryFeedback,
} from "../../frontend/src/utils/discoveryFeedback.ts";

const json = (value: unknown, status: number = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const openHarness = async (t: import("vite-plus/test").TestContext) => {
  vi.resetModules();
  const originalFetch = globalThis.fetch;
  const requests: { url: string; body: unknown; resolve: (response: Response) => void }[] = [];
  globalThis.fetch = (url, init = {}) =>
    new Promise<Response>((resolve) => {
      requests.push({
        url: String(url),
        body: init.body ? JSON.parse(String(init.body)) : null,
        resolve,
      });
    });
  const { queryClient, queryKeys } = await import("../../frontend/src/queryClient.ts");
  t.onTestFinished(() => {
    globalThis.fetch = originalFetch;
    queryClient.clear();
  });
  const waitForRequests = async (count: number) => {
    while (requests.length < count) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return { queryClient, queryKeys, requests, waitForRequests };
};

test("an album request shows as downloading at once and stops if the server refuses it", async (t) => {
  const { queryClient, queryKeys, requests, waitForRequests } = await openHarness(t);
  const { requestAlbumFromSearch } =
    await import("../../frontend/src/utils/api/endpoints/library.ts");
  const activeAlbums = () =>
    queryClient.getQueryData<{ albums: string[] }>(queryKeys.activeDownloads)?.albums || [];

  const request = requestAlbumFromSearch({
    albumMbid: "album-1",
    artistMbid: "artist-1",
    albumName: "Album",
    artistName: "Artist",
    managedBy: "aurral",
    triggerSearch: true,
  });
  await waitForRequests(1);
  assert.deepEqual(activeAlbums(), ["album-1"]);

  requests[0].resolve(json({ error: "Lidarr is unreachable" }, 502));
  await assert.rejects(request);
  assert.deepEqual(activeAlbums(), []);
});

test("undoing an unfavorite sends the removed stars back and reverts if the restore fails", async (t) => {
  const { requests, waitForRequests } = await openHarness(t);
  const { showFavoriteRemoved } = await import("../../frontend/src/utils/favoriteUndo.ts");
  type ToastApi = Parameters<typeof showFavoriteRemoved>[0];
  type ToastMessage = Parameters<ToastApi["addToast"]>[0];
  type CapturedToast = {
    message?: import("react").ReactNode;
    action?: { label: string; onClick: () => void };
    error?: boolean;
  };
  const toasts: CapturedToast[] = [];
  const capture = (message: ToastMessage, error: boolean = false) => {
    toasts.push({
      ...(typeof message === "string" ? { message } : message),
      ...(error ? { error: true } : {}),
    });
    return String(toasts.length);
  };
  const toast: ToastApi = {
    addToast: (content) => capture(content),
    showSuccess: (message) => capture(message),
    showError: (message) => capture(message, true),
    showInfo: (message) => capture(message),
    removeToast: () => {},
  };
  let starred = false;
  const removed = [{ id: "song:favorite-track", starredAt: 1000 }];

  showFavoriteRemoved(toast, {
    name: "Favorite Track",
    removed,
    restore: () => {
      starred = true;
    },
    revert: () => {
      starred = false;
    },
  });
  assert.equal(toasts[0].message, "Removed Favorite Track from favorites");

  assert.ok(toasts[0].action);
  const undone = toasts[0].action.onClick();
  assert.equal(starred, true);
  await waitForRequests(1);
  assert.deepEqual(requests[0].body, { favorites: removed });
  requests[0].resolve(json({ error: "Database is locked" }, 500));
  await undone;

  assert.equal(starred, false);
  assert.deepEqual(toasts.at(-1), {
    message:
      "Could not add Favorite Track back to favorites. It is still removed. Try again from its menu.",
    error: true,
  });
});

test("undoing less like this puts back the more like this it replaced, in place", () => {
  const artist = { id: "artist-1", name: "Taste Artist" };
  const block = {
    id: "b",
    artistName: "Other",
    action: "block_artist",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const more = {
    id: "m",
    artistId: "artist-1",
    artistName: "Taste Artist",
    action: "more_like_this",
    createdAt: "2026-02-01T00:00:00.000Z",
  };
  const previous = [more, block];

  const preview = previewArtistDiscoveryFeedback(previous, {
    artist,
    action: "less_like_this",
    isSelected: false,
    payload: { artistId: "artist-1", artistName: "Taste Artist", action: "less_like_this" },
  });
  assert.deepEqual(
    preview.map((entry) => entry.action),
    ["less_like_this", "block_artist"],
  );

  const saved = [{ ...preview[0], id: "l", createdAt: "2026-03-01T00:00:00.000Z" }, block];
  const change = diffDiscoveryFeedback(previous, saved);
  assert.deepEqual(
    change.added.map((entry) => entry.id),
    ["l"],
  );
  assert.deepEqual(change.removed, [more]);
  assert.deepEqual(revertDiscoveryFeedback(saved, change), previous);
});
