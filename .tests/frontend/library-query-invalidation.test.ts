import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

test("library cache invalidation does not abort an active request", async () => {
  vi.resetModules();

  const { clearLibraryPageCache } =
    await import("../../frontend/src/utils/api/endpoints/library.ts");
  const { queryClient, queryKeys } = await import("../../frontend/src/queryClient.ts");
  const options = { kind: "artists", page: 1, pageSize: 100 };
  const queryKey = queryKeys.libraryPage(options);
  const { promise: requestReady, resolve: markRequestReady } = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<unknown>();
  let aborted = false;
  const request = queryClient.fetchQuery({
    queryKey,
    staleTime: 0,
    queryFn: ({ signal }) =>
      new Promise<unknown>((resolve, reject) => {
        pending.promise.then(resolve, reject);
        markRequestReady();
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  });

  await requestReady;
  await clearLibraryPageCache();
  assert.equal(aborted, false);
  pending.resolve({ artists: [] });
  await request;

  assert.notDeepEqual(queryKeys.libraryPage(options), queryKey);
  queryClient.clear();
});

test("library requests forward caller cancellation", async () => {
  vi.resetModules();

  const { getLibraryPage, getLibraryFavorites } =
    await import("../../frontend/src/utils/api/endpoints/library.ts");
  const { queryClient, queryKeys } = await import("../../frontend/src/queryClient.ts");

  const assertForwardedCancellation = async (load: (signal: AbortSignal) => Promise<unknown>) => {
    const originalFetch = globalThis.fetch;
    let requestSignal: AbortSignal | null | undefined;
    const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
    const controller = new AbortController();
    globalThis.fetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        assert.ok(init?.signal);
        requestSignal = init.signal;
        markStarted();
        init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    try {
      const request = load(controller.signal);
      await started;
      assert.ok(requestSignal);
      controller.abort();
      await assert.rejects(request, /aborted/);
      assert.equal(requestSignal.aborted, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  };

  await assertForwardedCancellation((signal) =>
    getLibraryPage({ kind: "artists", page: 1, pageSize: 100 }, { signal }),
  );
  await assertForwardedCancellation((signal) => getLibraryFavorites({ signal }));

  const assertQueryCancellation = async (
    load: () => Promise<unknown>,
    queryKey: readonly unknown[],
  ) => {
    const originalFetch = globalThis.fetch;
    let requestSignal: AbortSignal | null | undefined;
    const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
    globalThis.fetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        assert.ok(init?.signal);
        requestSignal = init.signal;
        markStarted();
        init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    try {
      const request = load();
      await started;
      assert.ok(requestSignal);
      await queryClient.cancelQueries({ queryKey, exact: true });
      await assert.rejects(request);
      assert.equal(requestSignal.aborted, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  };

  await assertQueryCancellation(
    () => getLibraryPage({ kind: "artists", page: 1, pageSize: 100 }),
    queryKeys.libraryPage({
      kind: "artists",
      page: 1,
      pageSize: 100,
      source: "all",
    }),
  );
  await assertQueryCancellation(() => getLibraryFavorites(), queryKeys.libraryFavorites);
  queryClient.clear();
});

test("artist batch lookup stays within the API batch limit", async () => {
  vi.resetModules();

  const { lookupArtistsInLibraryBatch } =
    await import("../../frontend/src/utils/api/endpoints/library.ts");
  const { queryClient } = await import("../../frontend/src/queryClient.ts");
  const originalFetch = globalThis.fetch;
  const requestSizes: number[] = [];
  globalThis.fetch = async (_url, init) => {
    const { mbids }: { mbids: string[] } = JSON.parse(String(init?.body));
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

test("artist adds publish an immediate shared library lookup", async () => {
  vi.resetModules();

  const { addArtistToLibrary } = await import("../../frontend/src/utils/api/endpoints/library.ts");
  const { queryClient, queryKeys } = await import("../../frontend/src/queryClient.ts");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        foreignArtistId: "artist-1",
        artist: { mbid: "artist-1", artistName: "Artist" },
      }),
      {
        status: 201,
        headers: { "content-type": "application/json" },
      },
    );

  try {
    await addArtistToLibrary({
      foreignArtistId: "artist-1",
      artistName: "Artist",
      managedBy: "aurral",
    });
    assert.equal(queryClient.getQueryData(queryKeys.libraryLookup("artist-1")), true);
  } finally {
    globalThis.fetch = originalFetch;
    queryClient.clear();
  }
});

test("library refresh starts a new lookup after cancelling an active request", async () => {
  vi.resetModules();

  const { lookupArtistInLibrary } =
    await import("../../frontend/src/utils/api/endpoints/library.ts");
  const { queryClient, queryKeys } = await import("../../frontend/src/queryClient.ts");
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  let firstRequestSignal: AbortSignal | null | undefined;
  const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
  globalThis.fetch = (_url, init) => {
    requestCount += 1;
    if (requestCount === 1) {
      assert.ok(init?.signal);
      firstRequestSignal = init.signal;
      markStarted();
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    }
    return Promise.resolve(
      new Response(JSON.stringify({ exists: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  try {
    const initialRequest = lookupArtistInLibrary("artist-1", { bypassCache: true });
    await started;
    assert.ok(firstRequestSignal);
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
