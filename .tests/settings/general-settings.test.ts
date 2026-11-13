import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import assert from "node:assert/strict";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import { join } from "node:path";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { dbOps }, { api }, { systemTaskQueue, maintenanceTaskQueue }] =
  await setupIsolatedBackend(
    "general-settings",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/routes/api.ts"),
    () => import("../../backend/services/jobs/queues.ts"),
  );

beforeEach(() => {
  vi.spyOn(systemTaskQueue, "start").mockImplementation(async () => undefined);
  vi.spyOn(maintenanceTaskQueue, "start").mockImplementation(async () => undefined);
  resetDatabase(db);
  dbOps.updateSettings({ integrations: {}, onboardingComplete: true });
});

afterAll(async () => {
  db.close();
  await cleanupIsolatedState(isolatedState);
});

test("Tidarr and an indexer's known download client survive a save", async () => {
  const { postSettings } = captureSettingsRoutes();
  const saved = await postSettings({
    integrations: {
      tidarr: { enabled: true, url: "http://tidarr.local:8484/", apiKey: " tidarr-key " },
      prowlarr: {
        indexers: {
          "1": { enabled: true, priority: 5, downloadClient: "nzbget" },
          "2": { enabled: true, priority: 5, downloadClient: "tidarr" },
        },
      },
    },
  });
  assert.equal(saved.statusCode, 200);
  const { tidarr, prowlarr } = dbOps.getSettings()!.integrations;
  assert.deepEqual(tidarr, {
    enabled: true,
    url: "http://tidarr.local:8484",
    apiKey: "tidarr-key",
    priority: 20,
  });
  assert.equal(prowlarr?.indexers?.["1"]?.downloadClient, "nzbget");
  assert.equal(prowlarr?.indexers?.["2"]?.downloadClient, undefined);
});

type SettingsBody = NonNullable<ReturnType<typeof dbOps.getSettings>>;

function captureSettingsRoutes() {
  const app = signedInAs(testUser(1, { role: "admin" })).route("/", api);
  const send = async (init?: RequestInit) => {
    const response = await app.request("/settings", init);
    const body: SettingsBody = await response.json();
    return { statusCode: response.status, body };
  };
  const postSettings = (body: unknown) =>
    send({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const getSettings = () => send();
  return { postSettings, getSettings };
}

test("an integration setting Aurral can't read is ignored without losing the rest", () => {
  dbOps.setJSONSetting("integrations", {
    slskd: { url: "http://slskd.test", priority: { high: true } },
    webhooks: [{ url: "http://hook.test" }, { body: "no url" }],
  });
  dbOps.invalidateSettingsCache();

  const { integrations } = dbOps.getSettings();
  assert.equal(integrations.slskd?.url, "http://slskd.test");
  assert.equal(integrations.slskd?.priority, undefined);
  assert.deepEqual(
    integrations.webhooks?.map(({ url }) => url),
    ["http://hook.test"],
  );
});

test("saving an integration setting Aurral can't read is rejected", async () => {
  const { postSettings } = captureSettingsRoutes();

  const rejected = await postSettings({
    integrations: { ticketmaster: { apiKey: "key", searchRadiusMiles: { miles: 50 } } },
  });
  assert.equal(rejected.statusCode, 400);
  assert.match(JSON.stringify(rejected.body), /ticketmaster\.searchRadiusMiles/);
  assert.equal(dbOps.getSettings().integrations.ticketmaster, undefined);

  const endless = await postSettings({
    integrations: { ticketmaster: { searchRadiusMiles: "1e309" } },
  });
  assert.equal(endless.statusCode, 400);
  assert.equal(dbOps.getSettings().integrations.ticketmaster, undefined);

  const hook = await postSettings({
    integrations: { webhooks: [{ url: "http://hook.test", body: 42 }] },
  });
  assert.equal(hook.statusCode, 400);
  assert.match(JSON.stringify(hook.body), /webhooks\.0\.body/);
  assert.equal(dbOps.getSettings().integrations.webhooks, undefined);

  const cleared = await postSettings({ integrations: { ticketmaster: { searchRadiusMiles: "" } } });
  assert.equal(cleared.statusCode, 200);
});

test("queues a news refresh only when news settings change", async () => {
  const queuedNewsRefresh = () =>
    maintenanceTaskQueue.list().find((job) => job.kind === "news-refresh") ?? null;
  const clearNewsRefresh = () => {
    for (const job of maintenanceTaskQueue.list()) {
      if (job.kind === "news-refresh") maintenanceTaskQueue.cancel(job.id);
    }
  };
  const { getSettings, postSettings } = captureSettingsRoutes();
  const news = (await getSettings()).body.integrations.news;
  clearNewsRefresh();

  await postSettings({ integrations: { news } });
  assert.equal(queuedNewsRefresh(), null);

  assert.ok(news != null);
  await postSettings({
    integrations: { news: { ...news, groups: { ...news.groups, jazz: false } } },
  });
  assert.ok(queuedNewsRefresh());
  clearNewsRefresh();
});

test("the Library folder cannot move into or around a read-only folder", async (t: import("vite-plus/test").TestContext) => {
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const folder = await mkdtemp(join(tmpdir(), "aurral-settings-read-only-"));
  t.onTestFinished(async () => {
    dbOps.setJSONSetting("readOnlyFolders", []);
    await rm(folder, { recursive: true, force: true });
  });
  await mkdir(join(folder, "Inside"));
  dbOps.setJSONSetting("readOnlyFolders", [folder]);
  const { postSettings } = captureSettingsRoutes();
  const before = dbOps.getSettings().downloadFolderPath;

  for (const rejected of [folder, join(folder, "Inside"), tmpdir()]) {
    const response = await postSettings({ downloadFolderPath: rejected });
    assert.equal(response.statusCode, 400, rejected);
  }
  dbOps.invalidateSettingsCache();
  assert.equal(dbOps.getSettings().downloadFolderPath, before);
});
