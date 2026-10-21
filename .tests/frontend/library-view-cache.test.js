import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

test("clearing library pages preserves the mounted view during favorite updates", async () => {
  vi.resetModules();

  const { queryClient, queryKeys } = await import("../../frontend/src/queryClient.js");
  const { clearLibraryPageCache } = await import("../../frontend/src/utils/api/endpoints/library.js");
  const viewKey = queryKeys.libraryView({ albumId: "7" });
  const pageKey = queryKeys.libraryPage({ kind: "tracks", albumId: "7" });
  const view = {
    pageResults: [{ total: 1 }],
    library: { albums: [{ id: 7 }], artists: [], tracks: [] },
    favoriteIds: new Set(),
  };
  queryClient.setQueryData(viewKey, view);
  queryClient.setQueryData(pageKey, { items: [{ id: 8 }] });

  clearLibraryPageCache();

  assert.strictEqual(queryClient.getQueryData(viewKey), view);
  assert.equal(queryClient.getQueryData(pageKey), undefined);

  const favoriteIds = new Set(["album:7"]);
  queryClient.setQueryData(viewKey, (current) => ({
    ...(current || {}),
    favoriteIds,
  }));
  const updatedView = queryClient.getQueryData(viewKey);
  assert.deepEqual(updatedView?.pageResults, view.pageResults);
  assert.strictEqual(updatedView?.favoriteIds, favoriteIds);
  queryClient.clear();
});
