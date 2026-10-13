import assert from "node:assert/strict";
import test from "node:test";
import { startFrontendServer } from "../helpers/frontendServer.js";

import {
  diffDiscoveryFeedback,
  previewArtistDiscoveryFeedback,
  revertDiscoveryFeedback,
} from "../../frontend/src/utils/discoveryFeedback.js";

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" },
});

const openHarness = async (t) => {
  const vite = await startFrontendServer();
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = (url, init = {}) => new Promise((resolve) => {
    requests.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null, resolve });
  });
  const { queryClient, queryKeys } = await vite.ssrLoadModule("/src/queryClient.js");
  t.after(() => {
    globalThis.fetch = originalFetch;
    queryClient.clear();
    return vite.close();
  });
  const waitForRequests = async (count) => {
    while (requests.length < count) await new Promise((resolve) => setImmediate(resolve));
  };
  return { vite, queryClient, queryKeys, requests, waitForRequests };
};

test("an album request shows as downloading at once and stops if the server refuses it", async (t) => {
  const { vite, queryClient, queryKeys, requests, waitForRequests } = await openHarness(t);
  const { requestAlbumFromSearch } = await vite.ssrLoadModule("/src/utils/api/endpoints/library.js");
  const activeAlbums = () => queryClient.getQueryData(queryKeys.activeDownloads)?.albums || [];

  const request = requestAlbumFromSearch({ albumMbid: "album-1", artistMbid: "artist-1" });
  await waitForRequests(1);
  assert.deepEqual(activeAlbums(), ["album-1"]);

  requests[0].resolve(json({ error: "Lidarr is unreachable" }, 502));
  await assert.rejects(request);
  assert.deepEqual(activeAlbums(), []);
});

test("undoing an unfavorite sends the removed stars back and reverts if the restore fails", async (t) => {
  const { vite, requests, waitForRequests } = await openHarness(t);
  const { showFavoriteRemoved } = await vite.ssrLoadModule("/src/utils/favoriteUndo.js");
  const toasts = [];
  const toast = {
    addToast: (content) => toasts.push(content),
    showSuccess: (message) => toasts.push({ message }),
    showError: (message) => toasts.push({ message, error: true }),
  };
  let starred = false;
  const removed = [{ id: "song:favorite-track", starredAt: 1000 }];

  showFavoriteRemoved(toast, {
    name: "Favorite Track",
    removed,
    restore: () => { starred = true; },
    revert: () => { starred = false; },
  });
  assert.equal(toasts[0].message, "Removed Favorite Track from favorites");

  const undone = toasts[0].action.onClick();
  assert.equal(starred, true);
  await waitForRequests(1);
  assert.deepEqual(requests[0].body, { favorites: removed });
  requests[0].resolve(json({ error: "Database is locked" }, 500));
  await undone;

  assert.equal(starred, false);
  assert.deepEqual(toasts.at(-1), {
    message: "Could not add Favorite Track back to favorites. It is still removed. Try again from its menu.",
    error: true,
  });
});

test("undoing less like this puts back the more like this it replaced, in place", () => {
  const artist = { id: "artist-1", name: "Taste Artist" };
  const block = { id: "b", artistName: "Other", action: "block_artist", createdAt: "2026-01-01T00:00:00.000Z" };
  const more = { id: "m", artistId: "artist-1", artistName: "Taste Artist", action: "more_like_this", createdAt: "2026-02-01T00:00:00.000Z" };
  const previous = [more, block];

  const preview = previewArtistDiscoveryFeedback(previous, {
    artist,
    action: "less_like_this",
    isSelected: false,
    payload: { artistId: "artist-1", artistName: "Taste Artist", action: "less_like_this" },
  });
  assert.deepEqual(preview.map((entry) => entry.action), ["less_like_this", "block_artist"]);

  const saved = [{ ...preview[0], id: "l", createdAt: "2026-03-01T00:00:00.000Z" }, block];
  const change = diffDiscoveryFeedback(previous, saved);
  assert.deepEqual(change.added.map((entry) => entry.id), ["l"]);
  assert.deepEqual(change.removed, [more]);
  assert.deepEqual(revertDiscoveryFeedback(saved, change), previous);
});
