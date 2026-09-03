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
    }),
  );
  await assertQueryCancellation(() => getLibraryFavorites(), queryKeys.libraryFavorites);
  queryClient.clear();
});

test("artist batch lookup stays within the API batch limit", async (t) => {
  const vite = await createServer({
    root: "frontend",
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  t.after(() => vite.close());

  const { lookupArtistsInLibraryBatch } = await vite.ssrLoadModule(
    "/src/utils/api/endpoints/library.js?artist-batch-limit-test",
  );
  const { queryClient } = await vite.ssrLoadModule("/src/queryClient.js");
  const originalFetch = globalThis.fetch;
  const requestSizes = [];
  globalThis.fetch = async (_url, init) => {
    const { mbids } = JSON.parse(init.body);
    requestSizes.push(mbids.length);
    return new Response(JSON.stringify(Object.fromEntries(mbids.map((id) => [id, true]))), {
      status: mbids.length <= 100 ? 200 : 400,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const ids = Array.from({ length: 201 }, (_, index) => `artist-${index}`);
    const result = await lookupArtistsInLibraryBatch(ids);
    assert.deepEqual(requestSizes, [100, 100, 1]);
    assert.equal(Object.keys(result).length, 201);
  } finally {
    globalThis.fetch = originalFetch;
    queryClient.clear();
  }
});

test("artist adds publish an immediate shared library lookup", async (t) => {
  const vite = await createServer({
    root: "frontend",
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  t.after(() => vite.close());

  const { addArtistToLibrary } = await vite.ssrLoadModule(
    "/src/utils/api/endpoints/library.js?artist-add-lookup-test",
  );
  const { queryClient, queryKeys } = await vite.ssrLoadModule("/src/queryClient.js");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    foreignArtistId: "artist-1",
    artist: { mbid: "artist-1", artistName: "Artist" },
  }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });

  try {
    await addArtistToLibrary({ foreignArtistId: "artist-1", artistName: "Artist" });
    assert.equal(queryClient.getQueryData(queryKeys.libraryLookup("artist-1")), true);
  } finally {
    globalThis.fetch = originalFetch;
    queryClient.clear();
  }
});

test("library refresh starts a new lookup after cancelling an active request", async (t) => {
  const vite = await createServer({
    root: "frontend",
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  t.after(() => vite.close());

  const { lookupArtistInLibrary } = await vite.ssrLoadModule(
    "/src/utils/api/endpoints/library.js?library-refresh-cancellation-test",
  );
  const { queryClient, queryKeys } = await vite.ssrLoadModule("/src/queryClient.js");
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  let firstRequestSignal;
  globalThis.fetch = (_url, init) => {
    requestCount += 1;
    if (requestCount === 1) {
      firstRequestSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    }
    return Promise.resolve(new Response(JSON.stringify({ exists: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  };

  try {
    const initialRequest = lookupArtistInLibrary("artist-1", { bypassCache: true });
    await waitForRequestSignal(() => firstRequestSignal);
    await queryClient.cancelQueries({
      queryKey: queryKeys.libraryLookupDetails("artist-1"),
      exact: true,
    });
    await assert.rejects(initialRequest);

    const refreshed = await lookupArtistInLibrary("artist-1", { bypassCache: true });
    assert.equal(firstRequestSignal.aborted, true);
    assert.equal(requestCount, 2);
    assert.equal(refreshed.exists, true);
  } finally {
    globalThis.fetch = originalFetch;
    queryClient.clear();
  }
});
