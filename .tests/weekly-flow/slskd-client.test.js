import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  {
    isSearchComplete,
    isSearchInProgress,
    isSlskdCleanupAfterRunsEnabled,
    slskdClient,
  },
  { recordSlskdTransferOutcome },
  { dbOps },
  { db },
] = await setupIsolatedBackend(
  "slskd-client",
  "backend/services/slskdClient.js",
  "backend/services/slskdTransferHistory.js",
  "backend/db/helpers/index.js",
  "backend/config/db-sqlite.js",
);

test.beforeEach(() => {
  resetDatabase(db);
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("slskd search state helpers recognize active and completed searches", () => {
  assert.equal(isSearchInProgress({ state: "Requested" }), true);
  assert.equal(isSearchInProgress({ state: "InProgress" }), true);
  assert.equal(isSearchInProgress({ state: "Queued" }), true);
  assert.equal(isSearchInProgress({ state: "InProgress, Completed" }), false);
  assert.equal(isSearchInProgress({ isComplete: true }), false);
  assert.equal(isSearchComplete({ state: "Completed" }), true);
  assert.equal(isSearchComplete({ state: "InProgress, Completed" }), true);
  assert.equal(isSearchComplete({ isComplete: true }), true);
  assert.equal(isSearchComplete({ state: "InProgress" }), false);
  assert.equal(isSearchComplete({ state: "Requested" }), false);
});

test("testConnection explains an unavailable Soulseek connection without leaking its enum state", async () => {
  const originalSettings = dbOps.getSettings();
  const mock = await createMockHttpServer((request, response) => {
    request.resume();
    if (request.method === "GET" && request.url === "/api/v0/application") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ server: { state: "None", isConnected: false } }));
      return;
    }
    if (request.method === "GET" && request.url === "/api/v0/options") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ directories: { downloads: "/downloads" } }));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...(originalSettings.integrations || {}),
      slskd: { url: mock.url, apiKey: "test-key" },
    },
  });

  try {
    const result = await slskdClient.testConnection({ force: true });
    assert.equal(
      result.message,
      "slskd is reachable, but it is not connected to Soulseek. Open slskd and connect to the Soulseek server.",
    );
  } finally {
    dbOps.updateSettings(originalSettings);
    await mock.close();
  }
});

test("flattenSearchResults reads files and lockedFiles payloads", () => {
  const results = slskdClient.flattenSearchResults({
    responses: [
      {
        username: "peerOne",
        files: [
          {
            filename: "Artist\\Album\\01 - Track.flac",
            size: 123,
          },
        ],
        lockedFiles: [
          {
            filename: "Artist\\Album\\02 - Bonus.flac",
            size: 456,
          },
        ],
        hasFreeUploadSlot: true,
        uploadSpeed: 250000,
      },
    ],
  });

  assert.equal(results.length, 2);
  assert.equal(results[0].user, "peerOne");
  assert.equal(results[0].file, "Artist\\Album\\01 - Track.flac");
  assert.equal(results[1].file, "Artist\\Album\\02 - Bonus.flac");
  assert.equal(results[0].slots, 1);
  assert.equal(results[0].speed, 250000);
  assert.equal(results[0].locked, false);
  assert.equal(results[1].locked, true);
});

test("flattenSearchResults reads slskd collection wrapper payloads", () => {
  const results = slskdClient.flattenSearchResults({
    responses: {
      $values: [
        {
          username: "peerTwo",
          files: {
            $values: [
              {
                filename: "Artist/Album/03 - Wrapped.flac",
                size: 789,
                bitRate: 1411,
              },
            ],
          },
        },
      ],
    },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].user, "peerTwo");
  assert.equal(results[0].file, "Artist/Album/03 - Wrapped.flac");
  assert.equal(results[0].bitrate, 1411);
});

test("settleSearch cancels in-progress searches when requested", async () => {
  const originalDeleteSearch = slskdClient.deleteSearch.bind(slskdClient);
  let deletedId = null;
  try {
    slskdClient.deleteSearch = async (searchId) => {
      deletedId = searchId;
      return true;
    };
    await slskdClient.settleSearch("search-cancel", { cancel: true });
    assert.equal(deletedId, "search-cancel");
  } finally {
    slskdClient.deleteSearch = originalDeleteSearch;
  }
});

test("createSearch sends slskd search timeout in milliseconds", async () => {
  const originalSettings = dbOps.getSettings();
  let requestBody = null;
  const mock = await createMockHttpServer(async (request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      if (request.method === "POST" && request.url === "/api/v0/searches") {
        requestBody = JSON.parse(body);
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: requestBody.id }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
  });

  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...(originalSettings.integrations || {}),
      slskd: {
        url: mock.url,
        apiKey: "test-key",
      },
    },
  });

  try {
    await slskdClient.createSearch("Equipment Wet Mulch", {
      id: "00000000-0000-4000-8000-000000000003",
      searchTimeoutMs: 120000,
    });
    assert.equal(requestBody.searchTimeout, 120000);
  } finally {
    dbOps.updateSettings(originalSettings);
    await mock.close();
  }
});

test("enqueueBatch rejects slskd all-failed enqueue responses", async () => {
  const originalSettings = dbOps.getSettings();
  const mock = await createMockHttpServer(async (request, response) => {
    request.resume();
    if (
      request.method === "POST" &&
      request.url === "/api/v0/transfers/downloads/peer"
    ) {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          enqueued: [],
          failed: ["Artist/Album/Locked.flac"],
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });

  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...(originalSettings.integrations || {}),
      slskd: {
        url: mock.url,
        apiKey: "test-key",
      },
    },
  });

  try {
    await assert.rejects(
      () =>
        slskdClient.enqueueBatch({
          username: "peer",
          files: [{ filename: "Artist/Album/Locked.flac", size: 123 }],
        }),
      /Artist\/Album\/Locked\.flac/,
    );
  } finally {
    dbOps.updateSettings(originalSettings);
    await mock.close();
  }
});

test("enqueueBatch uses current slskd download endpoint", async () => {
  const originalSettings = dbOps.getSettings();
  const transferId = "00000000-0000-4000-8000-000000000002";
  const calls = [];
  const mock = await createMockHttpServer(async (request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      calls.push({ method: request.method, url: request.url, body });
      if (
        request.method === "POST" &&
        request.url === "/api/v0/transfers/downloads/peer"
      ) {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            enqueued: [
              {
                id: transferId,
                username: "peer",
                filename: "Artist/Album/Open.flac",
                state: "Queued, Locally",
              },
            ],
            failed: [],
          }),
        );
        return;
      }
      response.writeHead(404);
      response.end();
    });
  });

  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...(originalSettings.integrations || {}),
      slskd: {
        url: mock.url,
        apiKey: "test-key",
      },
    },
  });

  try {
    const result = await slskdClient.enqueueBatch({
      username: "peer",
      files: [{ filename: "Artist/Album/Open.flac", size: 123 }],
    });
    assert.equal(result.legacy, true);
    assert.equal(result.transferId, transferId);
    assert.equal(result.batchId, null);
    assert.deepEqual(
      calls.map((call) => call.url),
      ["/api/v0/transfers/downloads/peer"],
    );
    assert.deepEqual(JSON.parse(calls[0].body), [
      { filename: "Artist/Album/Open.flac", size: 123 },
    ]);
  } finally {
    dbOps.updateSettings(originalSettings);
    await mock.close();
  }
});

test("isSlskdCleanupAfterRunsEnabled reads the integrations setting", () => {
  const originalSettings = dbOps.getSettings();
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...(originalSettings.integrations || {}),
      slskd: {
        ...(originalSettings.integrations?.slskd || {}),
        cleanupAfterRuns: true,
      },
    },
  });
  assert.equal(isSlskdCleanupAfterRunsEnabled(), true);
  dbOps.updateSettings(originalSettings);
});

test("cleanupAfterRun removes Aurral-owned searches and transfers", async () => {
  const originalSettings = dbOps.getSettings();
  const calls = [];
  const mock = await createMockHttpServer((request, response) => {
    calls.push({ method: request.method, url: request.url });
    if (
      request.method === "DELETE" &&
      request.url === "/api/v0/searches/search-owned"
    ) {
      response.writeHead(204);
      response.end();
      return;
    }
    if (
      request.method === "DELETE" &&
      request.url === "/api/v0/transfers/downloads/peer/transfer-owned?remove=true"
    ) {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });

  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...(originalSettings.integrations || {}),
      slskd: {
        url: mock.url,
        apiKey: "test-key",
      },
    },
  });

  try {
    recordSlskdTransferOutcome({
      job: {
        id: "job-owned",
        artistName: "Artist",
        trackName: "Track",
        albumName: "Album",
      },
      candidate: {
        raw: {
          user: "peer",
          file: "Artist/Album/Track.flac",
        },
      },
      status: "success",
      searchIds: ["search-owned"],
      transferId: "transfer-owned",
    });
    const result = await slskdClient.cleanupAfterRun();
    assert.equal(result.searchesRemoved, 1);
    assert.equal(result.transfersRemoved, 1);
    assert.equal(result.downloadsRemoved, true);
    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.url}`),
      [
        "DELETE /api/v0/searches/search-owned",
        "DELETE /api/v0/transfers/downloads/peer/transfer-owned?remove=true",
      ],
    );
  } finally {
    dbOps.updateSettings(originalSettings);
    await mock.close();
  }
});
