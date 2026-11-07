import { requireFixture } from "./playlists/fixtures.ts";
import assert from "node:assert/strict";
import { test, beforeAll, beforeEach, afterAll, vi } from "vite-plus/test";

import { cleanupIsolatedState, setupIsolatedBackend } from "./helpers/backendTestHarness.ts";
import { signedInAs } from "./helpers/honoApp.ts";

const [
  isolatedState,
  { db },
  { dbOps, userOps },
  inboxService,
  { inboxTaskQueue },
  systemTaskWorker,
  { upsertLibraryArtist },
  { http },
  { api },
] = await setupIsolatedBackend(
  "inbox-refresh-queue",
  () => import("../backend/config/db-sqlite.ts"),
  () => import("../backend/db/helpers/index.ts"),
  () => import("../backend/services/inboxService.ts"),
  () => import("../backend/services/jobs/queues.ts"),
  () => import("../backend/services/systemTaskWorker.ts"),
  () => import("../backend/services/libraryMediaStore.ts"),
  () => import("../lib/http.ts"),
  () => import("../backend/routes/api.ts"),
);

const { enqueueInboxRefreshForUser, getInboxForUser, getInboxRefreshStatus, refreshInboxForUser } =
  inboxService;
const { processSystemTask } = systemTaskWorker;

const showDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

let userId: number;

function clearRefreshState() {
  db.prepare("DELETE FROM jobs").run();
  db.prepare("DELETE FROM inbox_items").run();
  db.prepare(
    "DELETE FROM settings WHERE key LIKE 'inboxRefresh:%' OR key LIKE 'user:%:nearbyLocation'",
  ).run();
}

beforeAll(() => {
  userId = userOps.createUser("inbox-refresh-user", "password-hash")!.id;
  upsertLibraryArtist({
    identityKey: "artist:inbox-refresh",
    mbid: "artist-mbid",
    name: "Inbox Refresh Artist",
  });
});

beforeEach(() => {
  clearRefreshState();
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("GET inbox reads cached rows without creating refresh work", () => {
  const result = getInboxForUser(userId);
  const jobs = inboxTaskQueue.list();

  assert.equal(result.refreshStatus.status, "idle");
  assert.equal(result.refreshing, false);
  assert.equal(jobs.length, 0);
});

test("manual refreshes deduplicate per user", async () => {
  const queue = inboxTaskQueue;
  const originalEnqueue = queue.enqueue;
  queue.enqueue = function enqueueWithFutureRunAt(payload, options = {}) {
    return originalEnqueue.call(this, payload, {
      ...options,
      runAt: Date.now() + 120_000,
    });
  };

  let first: { queued: boolean; jobId: number; status: string };
  let second: { queued: boolean; jobId: number; status: string };
  try {
    first = await enqueueInboxRefreshForUser(userId, { reason: "manual" });
    second = await enqueueInboxRefreshForUser(userId, { reason: "manual" });
  } finally {
    queue.enqueue = originalEnqueue;
  }

  assert.equal(first.queued, true);
  assert.equal(second.queued, false);
  assert.equal(second.jobId, first.jobId);
  assert.equal(inboxTaskQueue.list().length, 1);
  const status = getInboxRefreshStatus(userId);
  assert.equal(status.status, "queued");
  assert.equal(status.jobId, first.jobId);
});

test("a removed queued refresh is reported stale", async () => {
  const queue = inboxTaskQueue;
  const originalEnqueue = queue.enqueue;
  queue.enqueue = function enqueueWithFutureRunAt(payload, options = {}) {
    return originalEnqueue.call(this, payload, {
      ...options,
      runAt: Date.now() + 120_000,
    });
  };
  let refresh: { queued: boolean; jobId: number; status: string };
  try {
    refresh = await enqueueInboxRefreshForUser(userId, { reason: "manual" });
  } finally {
    queue.enqueue = originalEnqueue;
  }
  db.prepare("DELETE FROM jobs WHERE id = ?").run(refresh.jobId);

  const status = getInboxRefreshStatus(userId);
  assert.equal(status.status, "stale");
  assert.equal(status.stale, true);
  assert.match(requireFixture(status.error), /no longer active/i);
});

test("provider failure preserves rows and marks the inbox stale", async () => {
  const previous = dbOps.upsertInboxItem({
    userId,
    kind: "release",
    sourceKey: "prior:release",
    title: "Previously cached release",
  });
  assert.ok(previous != null);
  const originalGet = http.get;
  const originalTicketmasterKey = process.env.TICKETMASTER_API_KEY;
  process.env.TICKETMASTER_API_KEY = "test-ticketmaster-key";
  http.get = (url, options) => {
    if (String(url).includes("zippopotam.us")) {
      return Promise.resolve({
        status: 200,
        statusText: "OK",
        headers: {},
        data: {
          places: [
            {
              "place name": "New York",
              state: "New York",
              "state abbreviation": "NY",
              latitude: "40.71",
              longitude: "-74.00",
            },
          ],
        },
      });
    }
    if (String(url).includes("ticketmaster.com")) {
      return Promise.reject(new Error("Ticketmaster unavailable"));
    }
    return originalGet(url, options);
  };

  try {
    const refreshed = await refreshInboxForUser(userId, {
      force: true,
      ipAddress: "127.0.0.1",
      zipCode: "10001",
    });
    assert.equal(refreshed, false);
    const status = getInboxRefreshStatus(userId);
    assert.equal(status.status, "stale");
    assert.equal(status.stale, true);
    assert.match(requireFixture(status.error), /shows: Ticketmaster unavailable/);
    assert.equal(
      dbOps.getInboxItem(userId, requireFixture(previous.id))?.title,
      "Previously cached release",
    );
  } finally {
    http.get = originalGet;
    if (originalTicketmasterKey === undefined) delete process.env.TICKETMASTER_API_KEY;
    else process.env.TICKETMASTER_API_KEY = originalTicketmasterKey;
  }
});

test("refresh adds nearby shows for library artists only", async () => {
  const originalGet = http.get;
  const originalTicketmasterKey = process.env.TICKETMASTER_API_KEY;
  process.env.TICKETMASTER_API_KEY = "test-ticketmaster-key";
  const event = (id: string, performer: string) => ({
    id,
    name: `${performer} live`,
    url: `https://www.ticketmaster.com/event/${id}`,
    dates: { start: { localDate: showDate } },
    _embedded: {
      venues: [{ name: "Hall", city: { name: "New York" } }],
      attractions: [{ name: performer }],
    },
  });
  http.get = (url, options) => {
    if (String(url).includes("zippopotam.us")) {
      return Promise.resolve({
        status: 200,
        statusText: "OK",
        headers: {},
        data: {
          places: [{ "place name": "New York", latitude: "40.73", longitude: "-73.99" }],
        },
      });
    }
    if (String(url).includes("ticketmaster.com")) {
      return Promise.resolve({
        status: 200,
        statusText: "OK",
        headers: {},
        data: {
          _embedded: {
            events: [
              event("library-show", "Inbox Refresh Artist"),
              event("other-show", "Someone Else"),
            ],
          },
        },
      });
    }
    return originalGet(url, options);
  };

  try {
    await refreshInboxForUser(userId, {
      force: true,
      ipAddress: "127.0.0.1",
      zipCode: "10003",
    });
    const shows = dbOps.getInboxItems(userId, { kinds: ["show"] });
    assert.deepEqual(
      shows
        .filter((item) => item != null)
        .map(({ sourceKey, title, subtitle }) => ({ sourceKey, title, subtitle })),
      [
        {
          sourceKey: "library-show",
          title: "Inbox Refresh Artist live",
          subtitle: `Inbox Refresh Artist · ${showDate} · Hall · New York`,
        },
      ],
    );
  } finally {
    http.get = originalGet;
    if (originalTicketmasterKey === undefined) delete process.env.TICKETMASTER_API_KEY;
    else process.env.TICKETMASTER_API_KEY = originalTicketmasterKey;
  }
});

test("scheduled refresh finds shows near the location last used on Discover", async () => {
  const originalTicketmasterKey = process.env.TICKETMASTER_API_KEY;
  process.env.TICKETMASTER_API_KEY = "test-ticketmaster-key";
  vi.spyOn(http, "get").mockImplementation(async (url) => {
    if (String(url).includes("zippopotam.us/us/60614")) {
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        data: { places: [{ "place name": "Chicago", latitude: "41.92", longitude: "-87.65" }] },
      };
    }
    if (String(url).includes("ticketmaster.com")) {
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        data: {
          _embedded: {
            events: [
              {
                id: "chicago-show",
                name: "Inbox Refresh Artist in Chicago",
                dates: { start: { localDate: showDate } },
                _embedded: { attractions: [{ name: "Inbox Refresh Artist" }] },
              },
            ],
          },
        },
      };
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  try {
    const user = { id: userId, username: "inbox-refresh-user", role: "user", permissions: {} };
    const discover = await signedInAs(user)
      .route("/", api)
      .request("/discover/nearby-shows?zip=60614&country=US");
    assert.equal(discover.status, 200);

    await processSystemTask({ kind: "inbox-refresh", userId }, { id: 9003 } as Parameters<
      typeof processSystemTask
    >[1]);

    assert.deepEqual(
      dbOps.getInboxItems(userId, { kinds: ["show"] }).map((item) => item?.sourceKey),
      ["chicago-show"],
    );
  } finally {
    if (originalTicketmasterKey === undefined) delete process.env.TICKETMASTER_API_KEY;
    else process.env.TICKETMASTER_API_KEY = originalTicketmasterKey;
  }
});

test("failed refreshes are explicit and a worker retry can complete", async () => {
  const previous = dbOps.upsertInboxItem({
    userId,
    kind: "release",
    sourceKey: "failed:release",
    title: "Retained while refresh fails",
  });
  assert.ok(previous != null);
  const originalGetSettings = dbOps.getSettings;
  dbOps.getSettings = () => {
    throw new Error("Inbox provider unavailable");
  };

  try {
    await assert.rejects(
      processSystemTask({ kind: "inbox-refresh", userId }, { id: 9001 } as Parameters<
        typeof processSystemTask
      >[1]),
      /Inbox provider unavailable/,
    );
    const failed = getInboxRefreshStatus(userId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.stale, true);
    assert.match(requireFixture(failed.error), /Inbox provider unavailable/);
    assert.equal(
      dbOps.getInboxItem(userId, requireFixture(previous.id))?.title,
      "Retained while refresh fails",
    );
  } finally {
    dbOps.getSettings = originalGetSettings;
  }

  await processSystemTask({ kind: "inbox-refresh", userId }, { id: 9002 } as Parameters<
    typeof processSystemTask
  >[1]);
  const recovered = getInboxRefreshStatus(userId);
  assert.equal(recovered.status, "complete");
  assert.equal(recovered.stale, false);
  assert.equal(requireFixture(recovered.lastSuccessAt) > 0, true);
});
