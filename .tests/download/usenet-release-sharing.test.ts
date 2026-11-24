import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { prowlarrClient }, { usenetSource }, { sabnzbdClient }, { dbOps }, { db }] =
  await setupIsolatedBackend(
    "usenet-release-sharing",
    () => import("../../backend/services/prowlarrClient.ts"),
    () => import("../../backend/services/usenetSource.ts"),
    () => import("../../backend/services/sabnzbdClient.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/config/db-sqlite.ts"),
  );

// each test wants its own release, since Aurral remembers sends for the whole process
let run = 0;
let root = "";
beforeEach(async () => {
  resetDatabase(db);
  run += 1;
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
  root = await mkdtemp(path.join(tmpdir(), "aurral-sharing-"));
  dbOps.updateSettings({
    integrations: {
      prowlarr: { enabled: true, url: "http://prowlarr.local", apiKey: "prowlarr-key" },
      sabnzbd: { enabled: true, url: "http://sabnzbd.local", apiKey: "sab-key" },
    },
  });
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  await cleanupIsolatedState(isolatedState);
});

const albums = usenetSource.albums!;
const status = usenetSource.status!;
const discard = usenetSource.discard!;

const release = (guid = `https://indexer/details/dirt-femme-${run}`) => ({
  id: guid,
  title: "Dirt Femme",
  artist: "Tove Lo",
  trackCount: 2,
  data: {
    guid,
    title: "Tove Lo - Dirt Femme (Extended Cut) FLAC",
    downloadUrl: "http://prowlarr.local/1/download?link=dirt-femme",
    indexerId: 1,
    indexer: "Music One",
    score: 10,
  },
});

// a staging folder per job, and the handover folder the pipeline gives a download
const staging = (name: string) => path.join(root, "_staging", "usenet", name);

// a fake SABnzbd: each NZB becomes a queue item, then a finished history item with audio files
function fakeSabnzbd() {
  const queue = new Set<string>();
  const history = new Map<string, { status: string; storage: string }>();
  let sent = 0;
  vi.spyOn(prowlarrClient, "downloadNzb").mockImplementation(async () => Buffer.from("<nzb/>"));
  vi.spyOn(sabnzbdClient, "isConfigured").mockReturnValue(true);
  vi.spyOn(sabnzbdClient, "appendNzb").mockImplementation(async () => {
    sent += 1;
    const nzbId = `SABnzbd_nzo_${sent}`;
    queue.add(nzbId);
    return { nzbId, nzbName: "release.nzb" };
  });
  vi.spyOn(sabnzbdClient, "getQueueItem").mockImplementation(async (id) =>
    queue.has(String(id)) ? ({ nzo_id: String(id) } as never) : null,
  );
  vi.spyOn(sabnzbdClient, "getHistoryItem").mockImplementation(
    async (id) => (history.get(String(id)) as never) ?? null,
  );
  vi.spyOn(sabnzbdClient, "deleteHistoryItem").mockImplementation(async (id) => {
    const item = history.get(String(id));
    history.delete(String(id));
    if (item) await rm(item.storage, { recursive: true, force: true });
    return true;
  });
  vi.spyOn(sabnzbdClient, "deleteQueueItem").mockImplementation(async (id) =>
    queue.delete(String(id)),
  );
  return {
    sent: () => sent,
    async finish(nzbId: string, outcome = "Completed") {
      const storage = path.join(root, "sab", "complete", nzbId);
      await mkdir(storage, { recursive: true });
      await writeFile(path.join(storage, "01 Dirt Femme.flac"), "one");
      await writeFile(path.join(storage, "02 Grapefruit.flac"), "two");
      queue.delete(nzbId);
      history.set(nzbId, { status: outcome, storage });
    },
  };
}

test("album jobs that want the same release together share one download", async () => {
  const sab = fakeSabnzbd();
  const [first, second, third] = await Promise.all(
    ["a", "b", "c"].map((job) =>
      albums.download({ result: release(), directory: staging(job) } as never),
    ),
  );
  assert.equal(sab.sent(), 1);
  assert.equal((first as { pending: string }).pending, "sabnzbd:SABnzbd_nzo_1");
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
});

test("a job that wants a release soon after it finished takes the kept files, not a new download", async () => {
  const sab = fakeSabnzbd();
  const { pending } = (await albums.download({
    result: release(),
    directory: staging("a"),
  } as never)) as { pending: string };
  await sab.finish("SABnzbd_nzo_1");
  assert.deepEqual(await status({ id: pending, directory: staging("handover-1") }), { done: true });

  const later = (await albums.download({
    result: release(),
    directory: staging("b"),
  } as never)) as {
    pending: string;
  };
  assert.equal(sab.sent(), 1);
  assert.match(later.pending, /^sabnzbd:aurral-kept:/);
  assert.deepEqual(await status({ id: later.pending, directory: staging("handover-2") }), {
    done: true,
  });
  assert.deepEqual((await readdir(staging("handover-2"))).sort(), [
    "01 Dirt Femme.flac",
    "02 Grapefruit.flac",
  ]);
  // a kept copy has nothing in the download client to remove
  await discard(later.pending);
});

test("a job sharing a download still gets the files after another job removed it from the client", async () => {
  const sab = fakeSabnzbd();
  const [first] = (await Promise.all(
    ["a", "b"].map((job) =>
      albums.download({ result: release(), directory: staging(job) } as never),
    ),
  )) as { pending: string }[];
  assert.ok(first);
  await sab.finish("SABnzbd_nzo_1");
  assert.deepEqual(await status({ id: first.pending, directory: staging("handover-a") }), {
    done: true,
  });
  // the first job rejected the files and let the download go
  await discard(first.pending);
  assert.deepEqual(await status({ id: first.pending, directory: staging("handover-b") }), {
    done: true,
  });
  assert.equal((await readdir(staging("handover-b"))).length, 2);
});

test("a release that failed is neither shared nor kept", async () => {
  const sab = fakeSabnzbd();
  const { pending } = (await albums.download({
    result: release(),
    directory: staging("a"),
  } as never)) as { pending: string };
  await sab.finish("SABnzbd_nzo_1", "Failed");
  await assert.rejects(status({ id: pending, directory: staging("handover-1") }), /failed/);
  // the failed download is not handed to another job; the pipeline's denials decide whether
  // the release is tried again
  const next = (await albums.download({ result: release(), directory: staging("b") } as never)) as {
    pending: string;
  };
  assert.equal(sab.sent(), 2);
  assert.equal(next.pending, "sabnzbd:SABnzbd_nzo_2");
});

test("another release, or a kept copy past its two hours, is downloaded as usual", async () => {
  const sab = fakeSabnzbd();
  const { pending } = (await albums.download({
    result: release(),
    directory: staging("a"),
  } as never)) as { pending: string };
  await sab.finish("SABnzbd_nzo_1");
  await status({ id: pending, directory: staging("handover-1") });

  await albums.download({
    result: release("https://indexer/details/other"),
    directory: staging("b"),
  } as never);
  assert.equal(sab.sent(), 2);

  // age the kept copy past its window
  const keptRoot = path.join(root, "_staging", "usenet", "kept-releases");
  for (const folder of await readdir(keptRoot)) {
    const mark = path.join(keptRoot, folder, ".aurral-kept.json");
    await writeFile(mark, JSON.stringify({ at: Date.now() - 3 * 60 * 60 * 1000 }));
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await utimes(mark, old, old);
  }
  const again = (await albums.download({
    result: release(),
    directory: staging("c"),
  } as never)) as {
    pending: string;
  };
  assert.equal(sab.sent(), 3);
  assert.match(again.pending, /^sabnzbd:SABnzbd_nzo_3$/);
});
