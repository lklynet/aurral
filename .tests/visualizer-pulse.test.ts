import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, test } from "vite-plus/test";
import { signedInAs } from "./helpers/honoApp.ts";
import { testUser } from "./helpers/userFixtures.ts";
import { cleanupIsolatedState, setupIsolatedBackend } from "./helpers/backendTestHarness.ts";

const [state, { api }, { downloadTracker }, { flowPlaylistConfig }] = await setupIsolatedBackend(
  "visualizer-pulse",
  () => import("../backend/routes/api.ts"),
  () => import("../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../backend/services/playlists/flowPlaylistConfig.ts"),
);

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-visualizer-pulse-"));
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await cleanupIsolatedState(state);
});

const bass = path.join(dir, "bass.wav");
await promisify(execFile)("ffmpeg", [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=60:duration=2",
  bass,
]);

const listener = testUser(1, { permissions: { accessPlaylists: true } });
const stranger = testUser(2, { permissions: { accessPlaylists: true } });
const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Mine", ownerUserId: 1 });
const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Song" }, playlist.id);
assert.ok(jobId);
downloadTracker.setDone(jobId, bass);

const pulseFor = async (user: typeof listener) => {
  const app = signedInAs(user).route("/", api);
  const query = new URLSearchParams({ streamPath: `/playlists/stream/${jobId}` });
  const response = await app.request(`/visualizer/pulse?${query}`);
  assert.equal(response.status, 200);
  const { pulse } = (await response.json()) as { pulse: { fps: number } | null };
  return pulse;
};

test("a playlist track gets a pulse from its file", async () => {
  assert.equal((await pulseFor(listener))?.fps, 30);
});

test("a playlist track the user can't open gets no pulse", async () => {
  assert.equal(await pulseFor(stranger), null);
});
