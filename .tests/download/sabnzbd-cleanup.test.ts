import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [
  state,
  { db },
  { dbOps },
  { SabnzbdClient },
  { removeSabnzbdDownloadFolder },
  { syncPathMappings },
  { lidarrClient },
] = await setupIsolatedBackend(
  "sabnzbd-cleanup",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/sabnzbdClient.ts"),
  () => import("../../backend/services/sabnzbdCleanup.ts"),
  () => import("../../backend/services/pathMappings.ts"),
  () => import("../../backend/services/lidarrClient.ts"),
);

let sequence = 0;
let root: string;

beforeEach(async () => {
  resetDatabase(db);
  syncPathMappings([]);
  root = path.join(state.baseDir, `completed-${++sequence}`);
  await fs.mkdir(path.join(root, "aurral", "release"), { recursive: true });
});

afterAll(() => cleanupIsolatedState(state));

const folder = () => path.join(root, "aurral", "release");
const remove = (
  historyItem: { storage: string } = { storage: folder() },
  directories: { destDir: string } = { destDir: root },
) =>
  removeSabnzbdDownloadFolder(historyItem, directories, "aurral", {
    key: "sabnzbd",
    name: "SABnzbd",
  });
const exists = async (target: string) => Boolean(await fs.stat(target).catch(() => null));

test("removes SABnzbd's completed folder and keeps sibling downloads", async () => {
  const sibling = path.join(root, "aurral", "other");
  await fs.mkdir(sibling);
  await fs.writeFile(path.join(sibling, "track.flac"), "other download");
  await fs.writeFile(path.join(folder(), "unwanted.flac"), "unused audio");

  await remove();

  assert.equal(await exists(folder()), false);
  assert.equal(await fs.readFile(path.join(sibling, "track.flac"), "utf8"), "other download");
});

test("refuses anything but a download directly inside a completed folder", async () => {
  await fs.mkdir(path.join(folder(), "disc2"));
  for (const target of [root, path.join(root, "aurral"), path.join(folder(), "disc2")]) {
    await assert.rejects(remove({ storage: target }), /not inside SABnzbd/);
    assert.equal(await exists(target), true);
  }
});

test("uses SABnzbd path mappings and refuses an unmapped Windows path", async () => {
  if (process.platform !== "win32") {
    await assert.rejects(
      remove({ storage: "D:\\completed\\aurral\\release" }, { destDir: "D:\\completed" }),
      /unmapped/,
    );
  }
  syncPathMappings([{ source: "sabnzbd", remote: "D:\\completed", local: root }]);

  await remove({ storage: "D:\\completed\\aurral\\release" }, { destDir: "D:\\completed" });

  assert.equal(await exists(folder()), false);
});

test("uses a SABnzbd path mapping scoped to the category folder", async () => {
  syncPathMappings([
    {
      source: "sabnzbd",
      remote: "D:\\completed\\aurral",
      local: path.join(root, "aurral"),
    },
  ]);

  await remove({ storage: "D:\\completed\\aurral\\release" }, { destDir: "D:\\completed" });

  assert.equal(await exists(folder()), false);
});

test("keeps history when cleanup is unsafe and honors the opt-out", async () => {
  const client = new SabnzbdClient({ category: "aurral", deleteLeftovers: true });
  const api = vi.spyOn(client, "api").mockImplementation(async (mode, params = {}) => {
    if (mode === "queue") return { queue: { slots: [] } };
    if (mode === "history" && params.name === "delete") return { status: true };
    if (mode === "history") return { history: { slots: [] } };
    return {};
  });
  vi.spyOn(client, "getDownloadDirectories").mockImplementation(async () => ({
    completedPath: "",
    categoryDestDir: "",
    destDir: root,
    interDir: "",
    mainDir: "",
  }));

  await assert.rejects(
    client.deleteHistoryItem("job", {
      deleteFiles: true,
      historyItem: { nzo_id: "job", storage: root },
    }),
    /not inside SABnzbd/,
  );
  assert.equal(
    api.mock.calls.some(([, params]) => params?.name === "delete"),
    false,
  );

  client.updateConfig({ category: "aurral", deleteLeftovers: false });
  assert.equal(
    await client.deleteHistoryItem("job", {
      deleteFiles: true,
      historyItem: { nzo_id: "job", storage: folder() },
    }),
    true,
  );
  assert.equal(await exists(folder()), true);
});

test("the last history item sharing a completed folder removes it", async () => {
  const client = new SabnzbdClient({ category: "aurral", deleteLeftovers: true });
  const history = ["first", "second"].map((nzo_id) => ({ nzo_id, storage: folder() }));
  vi.spyOn(client, "getDownloadDirectories").mockImplementation(async () => ({
    completedPath: "",
    categoryDestDir: "",
    destDir: root,
    interDir: "",
    mainDir: "",
  }));
  vi.spyOn(client, "api").mockImplementation(async (mode, params = {}) => {
    if (mode === "queue") return { queue: { slots: [] } };
    if (mode === "history" && params.name === "delete") {
      history.splice(
        history.findIndex((item) => item.nzo_id === params.value),
        1,
      );
      return { status: true };
    }
    return { history: { slots: [...history] } };
  });

  await Promise.all(
    history.map((item) =>
      client.deleteHistoryItem(item.nzo_id, { deleteFiles: true, historyItem: item }),
    ),
  );

  assert.equal(history.length, 0);
  assert.equal(await exists(folder()), false);
});

test("case-sensitive SABnzbd folders are not treated as shared", async () => {
  if (process.platform === "win32") return;
  const client = new SabnzbdClient({ category: "aurral", deleteLeftovers: true });
  vi.spyOn(client, "api").mockImplementation(async (mode) => {
    if (mode === "queue") {
      return { queue: { slots: [{ nzo_id: "other", storage: "/complete/album" }] } };
    }
    return { history: { slots: [] } };
  });

  assert.equal(
    await client.sharesDownloadFolder({ nzo_id: "job", storage: "/complete/Album" }),
    false,
  );
});

test("refuses a completed folder that contains the music library", async () => {
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    downloadFolderPath: path.join(folder(), "Music"),
  });
  await fs.mkdir(path.join(folder(), "Music"), { recursive: true });

  await assert.rejects(remove(), /music library/);

  assert.equal(await exists(folder()), true);
});

test("protects configured Lidarr roots while Lidarr is disabled", async () => {
  const musicLibrary = path.join(folder(), "Music");
  await fs.mkdir(musicLibrary, { recursive: true });
  const enabled = vi.spyOn(lidarrClient, "isEnabled").mockReturnValue(false);
  const roots = vi
    .spyOn(lidarrClient, "getConfiguredRootFolderPaths")
    .mockReturnValue([musicLibrary]);

  try {
    await assert.rejects(remove(), /music library/);
    assert.equal(await exists(folder()), true);
  } finally {
    enabled.mockRestore();
    roots.mockRestore();
  }
});
