import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  state,
  { db },
  { dbOps },
  { SabnzbdClient },
  { removeSabnzbdDownloadFolder },
  { syncPathMappings },
] = await setupIsolatedBackend(
  "sabnzbd-cleanup",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/sabnzbdClient.js",
  "backend/services/sabnzbdCleanup.js",
  "backend/services/pathMappings.js",
);

let sequence = 0;
let root;

beforeEach(async () => {
  resetDatabase(db);
  syncPathMappings([]);
  root = path.join(state.baseDir, `completed-${++sequence}`);
  await fs.mkdir(path.join(root, "aurral", "release"), { recursive: true });
});

afterAll(() => cleanupIsolatedState(state));

const folder = () => path.join(root, "aurral", "release");
const remove = (historyItem = { storage: folder() }, directories = { destDir: root }) =>
  removeSabnzbdDownloadFolder(historyItem, directories, "aurral");
const exists = async (target) => Boolean(await fs.stat(target).catch(() => null));

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

test("keeps history when cleanup is unsafe and honors the opt-out", async () => {
  const client = new SabnzbdClient({ category: "aurral", deleteLeftovers: true });
  const api = vi.spyOn(client, "api").mockImplementation(async (mode, params = {}) => {
    if (mode === "queue") return { queue: { slots: [] } };
    if (mode === "history" && params.name === "delete") return { status: true };
    if (mode === "history") return { history: { slots: [] } };
    return {};
  });
  vi.spyOn(client, "getDownloadDirectories").mockImplementation(async () => ({ destDir: root }));

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
  vi.spyOn(client, "getDownloadDirectories").mockImplementation(async () => ({ destDir: root }));
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

test("refuses a completed folder that contains the music library", async () => {
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    downloadFolderPath: path.join(folder(), "Music"),
  });
  await fs.mkdir(path.join(folder(), "Music"), { recursive: true });

  await assert.rejects(remove(), /music library/);

  assert.equal(await exists(folder()), true);
});
