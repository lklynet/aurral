import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const waitForRequestSignal = async (getSignal) => {
  const deadline = Date.now() + 1000;
  while (!getSignal() && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(getSignal(), "fetch was not called before the request signal timeout");
};

test("canonical cache invalidation does not abort an active request", async (t) => {
  const vite = await createServer({
    root: "frontend",
    server: { middlewareMode: true },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  t.after(() => vite.close());

  const { clearCanonicalLibraryPageCache } = await vite.ssrLoadModule(
    "/src/utils/api/endpoints/library.js?canonical-invalidation-test",
  );
  const { queryClient, queryKeys } = await vite.ssrLoadModule("/src/queryClient.js");
  const options = { kind: "artists", page: 1, pageSize: 100 };
  const queryKey = queryKeys.libraryCanonical(options);
  let resolveRequest;
  let aborted = false;
  const request = queryClient.fetchQuery({
    queryKey,
    staleTime: 0,
    queryFn: ({ signal }) => new Promise((resolve, reject) => {
      resolveRequest = resolve;
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      }, { once: true });
    }),
  });

  while (!resolveRequest) await new Promise((resolve) => setImmediate(resolve));
  await clearCanonicalLibraryPageCache();
  assert.equal(aborted, false);
  resolveRequest({ artists: [] });
  await request;

  assert.notDeepEqual(queryKeys.libraryCanonical(options), queryKey);
  queryClient.clear();
});

test("library requests forward caller cancellation", async (t) => {
  const vite = await createServer({
    root: "frontend",
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  t.after(() => vite.close());

  const { getCanonicalLibraryPage, getLibraryFavorites } = await vite.ssrLoadModule(
    "/src/utils/api/endpoints/library.js?library-request-cancellation-test",
  );
  const { queryClient, queryKeys } = await vite.ssrLoadModule("/src/queryClient.js");

  const assertForwardedCancellation = async (load) => {
    const originalFetch = globalThis.fetch;
    let requestSignal;
    const controller = new AbortController();
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      requestSignal = init.signal;
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    try {
      const request = load(controller.signal);
      await waitForRequestSignal(() => requestSignal);
      controller.abort();
      await assert.rejects(request, /aborted/);
      assert.equal(requestSignal.aborted, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  };

  await assertForwardedCancellation((signal) =>
    getCanonicalLibraryPage({ kind: "artists", page: 1, pageSize: 100 }, { signal }),
  );
  await assertForwardedCancellation((signal) => getLibraryFavorites({ signal }));

  const assertQueryCancellation = async (load, queryKey) => {
    const originalFetch = globalThis.fetch;
    let requestSignal;
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      requestSignal = init.signal;
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    try {
      const request = load();
      await waitForRequestSignal(() => requestSignal);
      await queryClient.cancelQueries({ queryKey, exact: true });
      await assert.rejects(request);
      assert.equal(requestSignal.aborted, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  };

  await assertQueryCancellation(
    () => getCanonicalLibraryPage({ kind: "artists", page: 1, pageSize: 100 }),
    queryKeys.libraryCanonical({
      kind: "artists",
      page: 1,
      pageSize: 100,
      source: "all",
      availableOnly: "false",
    }),
  );
  await assertQueryCancellation(() => getLibraryFavorites(), queryKeys.libraryFavorites);
  queryClient.clear();
});
