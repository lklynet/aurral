import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("clearing canonical library pages preserves the mounted library view", async (t) => {
  const vite = await createServer({
    root: "frontend",
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  t.after(() => vite.close());

  const { queryClient, queryKeys } = await vite.ssrLoadModule(
    "/src/queryClient.js",
  );
  const { clearCanonicalLibraryPageCache } = await vite.ssrLoadModule(
    "/src/utils/api/endpoints/library.js?library-view-cache-test",
  );
  const viewKey = queryKeys.libraryView({ albumId: "7" });
  const canonicalKey = queryKeys.libraryCanonical({ kind: "tracks", albumId: "7" });
  const view = { library: { albums: [{ id: 7 }], artists: [], tracks: [] } };
  queryClient.setQueryData(viewKey, view);
  queryClient.setQueryData(canonicalKey, { items: [{ id: 8 }] });

  clearCanonicalLibraryPageCache();

  assert.strictEqual(queryClient.getQueryData(viewKey), view);
  assert.equal(queryClient.getQueryData(canonicalKey), undefined);
  queryClient.clear();
});
