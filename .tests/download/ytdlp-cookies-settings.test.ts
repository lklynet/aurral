import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vite-plus/test";
import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [isolatedState, { saveAppSettings }] = await setupIsolatedBackend(
  "ytdlp-cookies-settings",
  () => import("../../backend/services/appSettings.ts"),
);

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("a yt-dlp cookies file is checked when its path is saved, not on every later save", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aurral-ytdlp-cookies-settings-"));
  const cookiesPath = path.join(dir, "cookies.txt");
  const save = (ytdlp: { cookiesPath?: string; priority?: number }) =>
    saveAppSettings({ integrations: { ytdlp } });
  try {
    assert.match(String((await save({ cookiesPath })).error), /Cannot read the yt-dlp cookies/);

    await writeFile(cookiesPath, "# Netscape HTTP Cookie File\n");
    assert.equal((await save({ cookiesPath: ` ${cookiesPath} ` })).error, undefined);

    await rm(cookiesPath);
    assert.equal((await save({ cookiesPath, priority: 40 })).error, undefined);
    assert.match(
      String((await save({ cookiesPath: dir })).error),
      /Cannot read the yt-dlp cookies/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
