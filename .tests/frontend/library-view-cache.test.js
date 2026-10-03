import assert from "node:assert/strict";
import test from "node:test";
import { startFrontendServer } from "../helpers/frontendServer.js";

test("clearing library pages preserves the mounted view during favorite updates", async (t) => {
  const vite = await startFrontendServer();
  t.after(() => vite.close());

  const { queryClient, queryKeys } = await vite.ssrLoadModule(
    "/src/queryClient.js",
  );
  const { clearLibraryPageCache } = await vite.ssrLoadModule(
    "/src/utils/api/endpoints/library.js?library-view-cache-test",
  );
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
