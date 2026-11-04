import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, test } from "vite-plus/test";
import type { RequestUser } from "../../backend/middleware/requestUser.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";
import { testUser } from "../helpers/userFixtures.ts";

const [
  state,
  { db },
  { default: pluginRoutes },
  { pluginsDir },
  { stopAllPlugins },
  { refreshInstalledPlugins, listPlugins },
  { flowPlaylistConfig },
] = await setupIsolatedBackend(
  "plugins",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/routes/plugins.ts"),
  () => import("../../backend/services/plugins/pluginManifest.ts"),
  () => import("../../backend/services/plugins/pluginHost.ts"),
  () => import("../../backend/services/plugins/pluginService.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
);

const admin = testUser(1, { username: "admin", role: "admin" });
const owner = testUser(2, { username: "owner", permissions: { accessFlow: true } });
const stranger = testUser(3, { username: "stranger", permissions: { accessFlow: true } });

const routes = (user: RequestUser) => signedInAs(user).route("/", pluginRoutes);
const json = (method: string, body: unknown) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function install(id: string, manifest: Record<string, unknown>, code: string) {
  const folder = path.join(pluginsDir(), id);
  await mkdir(folder, { recursive: true });
  await writeFile(
    path.join(folder, "manifest.json"),
    JSON.stringify({ id, name: `Plugin ${id}`, version: "1.0.0", api: 1, ...manifest }),
  );
  await writeFile(path.join(folder, "index.js"), code);
  await refreshInstalledPlugins();
}

const turnOn = (id: string, body: Record<string, unknown> = {}) =>
  routes(admin).request(`/plugins/${id}`, json("PUT", { enabled: true, ...body }));
const actionsFor = async (user: RequestUser) =>
  (await (await routes(user).request("/plugins/actions")).json()).actions;
const run = (user: RequestUser, id: string, action: string, playlistId: string) =>
  routes(user).request(`/plugins/${id}/actions/${action}`, json("POST", { playlistId }));

let playlists = 0;
function ownedPlaylist() {
  playlists += 1;
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: `Road trip ${playlists}`,
    ownerUserId: owner.id,
  });
  assert.ok(playlist);
  return playlist.id;
}

const sendAction = { actions: [{ id: "send", label: "Send to Box", target: "playlist" }] };

beforeEach(() => resetDatabase(db));

afterEach(async () => {
  stopAllPlugins();
  await rm(pluginsDir(), { recursive: true, force: true });
});

afterAll(async () => {
  await cleanupIsolatedState(state);
});

test("a playlist action shows once its plugin is on and set up, and gets the playlist", async () => {
  await install(
    "box",
    {
      ...sendAction,
      settings: [{ key: "token", label: "Token", type: "password", required: true }],
    },
    `export default { actions: { send: ({ settings, user, playlist }) => ({
      message: \`\${playlist.name} (\${playlist.kind}, \${playlist.tracks.length} tracks) for \${user.username} with \${settings.token}\`,
    }) } };`,
  );
  const playlistId = ownedPlaylist();

  assert.deepEqual(await actionsFor(owner), []);
  assert.equal((await turnOn("box")).status, 200);
  assert.deepEqual(await actionsFor(owner), []);
  assert.equal((await turnOn("box", { settings: { token: "secret" } })).status, 200);
  assert.deepEqual(await actionsFor(owner), [
    {
      pluginId: "box",
      pluginName: "Plugin box",
      id: "send",
      label: "Send to Box",
      target: "playlist",
    },
  ]);

  const response = await run(owner, "box", "send", playlistId);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    message: `Road trip ${playlists} (playlist, 0 tracks) for owner with secret`,
  });
  assert.equal((await run(stranger, "box", "send", playlistId)).status, 404);
  assert.notEqual(db.prepare("SELECT settings FROM plugins").pluck().get(), '{"token":"secret"}');
});

test("an admin-only action is hidden from other users and refused for them", async () => {
  await install(
    "retag",
    { actions: [{ id: "fix", label: "Fix tags", target: "playlist", admin: true }] },
    `export default { actions: { fix: () => ({ message: "Fixed" }) } };`,
  );
  await turnOn("retag");
  const playlistId = ownedPlaylist();

  assert.equal((await actionsFor(owner)).length, 0);
  assert.equal((await actionsFor(admin)).length, 1);
  assert.equal((await run(owner, "retag", "fix", playlistId)).status, 403);
  assert.equal((await run(admin, "retag", "fix", playlistId)).status, 200);
});

test("a plugin that answers wrongly or keeps crashing is blamed and turned off", async () => {
  await install(
    "flaky",
    sendAction,
    `let runs = 0;
    export default { actions: { send: () => {
      runs += 1;
      if (runs === 1) return { message: 5 };
      process.exit(3);
    } } };`,
  );
  await turnOn("flaky");
  const playlistId = ownedPlaylist();

  const invalid = await run(owner, "flaky", "send", playlistId);
  assert.equal(invalid.status, 502);
  assert.match(
    (await invalid.json()).error,
    /^Plugin flaky: returned something Aurral can't read at message/,
  );

  const crashed = await run(owner, "flaky", "send", playlistId);
  assert.match((await crashed.json()).error, /^Plugin flaky: its process stopped with exit code 3/);
  await run(owner, "flaky", "send", playlistId);

  const [flaky] = (await listPlugins()).plugins;
  assert.equal(flaky?.enabled, false);
  assert.match(String(flaky?.lastError), /Turned off after 3 failures in a row/);
  assert.equal((await run(owner, "flaky", "send", playlistId)).status, 404);
});

test("an error the plugin throws is reported without turning it off", async () => {
  await install(
    "down",
    sendAction,
    `export default { actions: { send: () => { throw new Error("Box is unreachable"); } } };`,
  );
  await turnOn("down");
  const playlistId = ownedPlaylist();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await run(owner, "down", "send", playlistId);
    assert.equal((await response.json()).error, "Plugin down: Box is unreachable");
  }
  const [down] = (await listPlugins()).plugins;
  assert.equal(down?.enabled, true);
  assert.equal(down?.lastError, "Box is unreachable");
});

test("safe mode hides plugin actions and refuses to run them", async () => {
  await install("box", sendAction, `export default { actions: { send: () => null } };`);
  await turnOn("box");
  const playlistId = ownedPlaylist();

  await routes(admin).request("/plugins/safe-mode", json("PUT", { enabled: true }));
  assert.deepEqual(await actionsFor(owner), []);
  assert.equal((await run(owner, "box", "send", playlistId)).status, 404);

  await routes(admin).request("/plugins/safe-mode", json("PUT", { enabled: false }));
  assert.deepEqual(await (await run(owner, "box", "send", playlistId)).json(), {
    message: "Send to Box finished",
  });
});

test("plugin folders that can't load are listed with the reason", async () => {
  await install("renamed", { id: "other" }, "");
  await install("future", { api: 2 }, "");
  await mkdir(path.join(pluginsDir(), "broken"), { recursive: true });
  await writeFile(path.join(pluginsDir(), "broken", "manifest.json"), "{");

  const listed = Object.fromEntries(
    (await listPlugins()).plugins.map((plugin) => [plugin.id, plugin.error]),
  );
  assert.deepEqual(listed, {
    broken: "manifest.json is not valid JSON",
    future: "Needs plugin API 2. This Aurral runs plugin API 1.",
    renamed: "The folder has to be named other",
  });
  assert.equal(
    (await routes(admin).request("/plugins/renamed", json("PUT", { enabled: true }))).status,
    404,
  );
});

test("only admins see and change plugins", async () => {
  await install("box", sendAction, `export default { actions: { send: () => null } };`);

  assert.equal((await routes(owner).request("/plugins")).status, 403);
  assert.equal(
    (await routes(owner).request("/plugins/box", json("PUT", { enabled: true }))).status,
    403,
  );
});
