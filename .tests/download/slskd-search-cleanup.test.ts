import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { SlskdClient }, { db }] = await setupIsolatedBackend(
  "slskd-search-cleanup",
  () => import("../../backend/services/slskdClient.ts"),
  () => import("../../backend/config/db-sqlite.ts"),
);

beforeEach(() => resetDatabase(db));
afterAll(() => cleanupIsolatedState(isolatedState));

const endedAt = "2026-11-05T12:00:00Z";

test.each(["Requested", "Queued", "InProgress"])(
  "cancels an owned %s search and waits for final persistence before deletion",
  async (initialState) => {
    const calls: string[] = [];
    let cancelled = false;
    let finalizingPolls = 0;
    let finalized = false;
    let prematureDeletes = 0;
    const mock = await createMockHttpServer((request, response) => {
      request.resume();
      calls.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      if (request.method === "GET") {
        // slskd persists the Completed state before EndedAt and the final results.
        finalized = cancelled && ++finalizingPolls > 1;
        response.end(
          JSON.stringify({
            state: cancelled ? "Completed, Cancelled" : initialState,
            endedAt: finalized ? endedAt : null,
          }),
        );
      } else if (request.method === "PUT") {
        cancelled = true;
        response.end();
      } else {
        // DELETE succeeds even while running; slskd's subsequent UPDATE then fails.
        if (!finalized) prematureDeletes += 1;
        response.writeHead(204);
        response.end();
      }
    });
    try {
      const client = new SlskdClient({ url: mock.url });
      assert.equal(await client.deleteSearch("owned", { timeout: 2000 }), true);
      assert.equal(prematureDeletes, 0, "a live search row was removed before its final UPDATE");
      assert.deepEqual(calls, [
        "GET /api/v0/searches/owned?includeResponses=false",
        "PUT /api/v0/searches/owned",
        "GET /api/v0/searches/owned?includeResponses=false",
        "GET /api/v0/searches/owned?includeResponses=false",
        "DELETE /api/v0/searches/owned",
      ]);
      assert.equal(finalized, true);
    } finally {
      await mock.close();
    }
  },
);

test("deletes an already finalized search without cancelling it again", async () => {
  const calls: string[] = [];
  const mock = await createMockHttpServer((request, response) => {
    request.resume();
    calls.push(request.method || "");
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      response.end(JSON.stringify({ state: "Completed, TimedOut", endedAt }));
    } else {
      response.writeHead(204);
      response.end();
    }
  });
  try {
    assert.equal(await new SlskdClient({ url: mock.url }).deleteSearch("done"), true);
    assert.deepEqual(calls, ["GET", "DELETE"]);
  } finally {
    await mock.close();
  }
});

test.each(["InProgress", "Completed, Cancelled"])(
  "retains an unfinalized %s search when the cleanup budget expires",
  async (state) => {
    const calls: string[] = [];
    const mock = await createMockHttpServer((request, response) => {
      request.resume();
      calls.push(request.method || "");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ state, endedAt: null }));
    });
    try {
      const client = new SlskdClient({ url: mock.url });
      assert.equal(await client.deleteSearch("unfinished", { timeout: 50 }), false);
      assert.equal(calls.includes("DELETE"), false);
      assert.equal(
        calls.filter((method) => method === "PUT").length,
        state === "InProgress" ? 1 : 0,
      );
    } finally {
      await mock.close();
    }
  },
);

test.each(["GET", "PUT"])(
  "handles a search disappearing during %s idempotently",
  async (goneAt) => {
    const calls: string[] = [];
    const mock = await createMockHttpServer((request, response) => {
      request.resume();
      calls.push(request.method || "");
      response.setHeader("content-type", "application/json");
      response.writeHead(request.method === goneAt ? 404 : 200);
      response.end(JSON.stringify({ state: "Queued", endedAt: null }));
    });
    try {
      assert.equal(await new SlskdClient({ url: mock.url }).deleteSearch("gone"), true);
      assert.deepEqual(calls, goneAt === "GET" ? ["GET"] : ["GET", "PUT"]);
    } finally {
      await mock.close();
    }
  },
);

test.each(["GET", "PUT"])("does not delete after a failed %s request", async (failedAt) => {
  const calls: string[] = [];
  const mock = await createMockHttpServer((request, response) => {
    request.resume();
    calls.push(request.method || "");
    response.setHeader("content-type", "application/json");
    response.writeHead(request.method === failedAt ? 502 : 200);
    response.end(JSON.stringify({ state: "Queued", endedAt: null }));
  });
  try {
    assert.equal(await new SlskdClient({ url: mock.url }).deleteSearch("failed"), false);
    assert.equal(calls.includes("DELETE"), false);
  } finally {
    await mock.close();
  }
});

test("bounds a stalled cancellation request and retains its search record", async () => {
  const calls: string[] = [];
  const mock = await createMockHttpServer((request, response) => {
    request.resume();
    calls.push(request.method || "");
    if (request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ state: "Queued", endedAt: null }));
    }
  });
  try {
    assert.equal(
      await new SlskdClient({ url: mock.url }).deleteSearch("stalled", { timeout: 50 }),
      false,
    );
    assert.deepEqual(calls, ["GET", "PUT"]);
  } finally {
    await mock.close();
  }
});

test("keeps collected results when an early exit safely cancels its search", async () => {
  let cancelled = false;
  let deleted = false;
  const mock = await createMockHttpServer((request, response) => {
    request.resume();
    response.setHeader("content-type", "application/json");
    if (request.method === "PUT") {
      cancelled = true;
      response.end();
    } else if (request.method === "DELETE") {
      deleted = cancelled;
      response.writeHead(cancelled ? 204 : 409);
      response.end();
    } else {
      response.end(
        JSON.stringify({
          state: cancelled ? "Completed, Cancelled" : "InProgress",
          endedAt: cancelled ? endedAt : null,
          responses: [{ username: "peer", files: [{ filename: "Artist/Album/Track.flac" }] }],
        }),
      );
    }
  });
  try {
    const client = new SlskdClient({ url: mock.url });
    const settled = vi.fn();
    const result = await client.waitForSearch("enough", 2000, {
      earlyExitWhen: () => true,
      onSearchSettled: settled,
    });
    assert.equal(client.flattenSearchResults(result).length, 1);
    assert.equal(deleted, true);
    assert.deepEqual(settled.mock.calls, [["enough"]]);
  } finally {
    await mock.close();
  }
});

test("concurrent cleanup attempts tolerate another caller removing the finalized search", async () => {
  let cancelled = false;
  let removed = false;
  let prematureDeletes = 0;
  const mock = await createMockHttpServer((request, response) => {
    request.resume();
    response.setHeader("content-type", "application/json");
    if (removed) {
      response.writeHead(404);
      response.end();
    } else if (request.method === "GET") {
      response.end(
        JSON.stringify({
          state: cancelled ? "Completed, Cancelled" : "InProgress",
          endedAt: cancelled ? endedAt : null,
        }),
      );
    } else if (request.method === "PUT") {
      cancelled = true;
      response.end();
    } else {
      if (!cancelled) prematureDeletes += 1;
      removed = true;
      response.writeHead(204);
      response.end();
    }
  });
  try {
    const client = new SlskdClient({ url: mock.url });
    assert.deepEqual(
      await Promise.all([client.deleteSearch("same"), client.deleteSearch("same")]),
      [true, true],
    );
    assert.equal(prematureDeletes, 0);
    assert.equal(removed, true);
  } finally {
    await mock.close();
  }
});

test("an aborted cleanup leaves ownership with the caller without issuing a delete", async () => {
  const calls: string[] = [];
  const mock = await createMockHttpServer((request, response) => {
    calls.push(request.method || "");
    response.end();
  });
  try {
    const client = new SlskdClient({ url: mock.url });
    assert.equal(await client.deleteSearch("aborted", { signal: AbortSignal.abort() }), false);
    assert.deepEqual(calls, []);
  } finally {
    await mock.close();
  }
});
