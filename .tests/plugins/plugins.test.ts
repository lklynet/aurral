import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";
import { afterAll, afterEach, beforeEach, test, vi } from "vite-plus/test";
import type { RequestUser } from "../../backend/middleware/requestUser.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";
import { testUser } from "../helpers/userFixtures.ts";
import { writeFlacFixture } from "../helpers/flacFixture.ts";

const [
  state,
  { db },
  { default: pluginRoutes },
  { pluginsDir, pluginDataFolder },
  { stopAllPlugins },
  { refreshInstalledPlugins, listPlugins },
  { flowPlaylistConfig },
  { websocketService },
  { emitPluginEvent },
  { listHonkerJobs },
  { deliverQueuedNotification, queuedNotificationSchema },
  { scanMusicRoot },
  { getLibrary },
  { runDuePluginSchedules },
  { activePlugin, pluginInput, setSafeMode, whilePluginTests },
  { resolveRequestUser },
] = await setupIsolatedBackend(
  "plugins",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/routes/plugins.ts"),
  () => import("../../backend/services/plugins/pluginManifest.ts"),
  () => import("../../backend/services/plugins/pluginHost.ts"),
  () => import("../../backend/services/plugins/pluginService.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/websocketService.ts"),
  () => import("../../backend/services/plugins/pluginEvents.ts"),
  () => import("../../backend/services/honkerDb.ts"),
  () => import("../../backend/services/notificationService.ts"),
  () => import("../../backend/services/libraryFileScanner.ts"),
  () => import("../../backend/services/libraryQueryService.ts"),
  () => import("../../backend/services/plugins/pluginSchedule.ts"),
  () => import("../../backend/services/plugins/pluginStore.ts"),
  () => import("../../backend/middleware/auth.ts"),
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
  vi.restoreAllMocks();
  stopAllPlugins();
  await rm(pluginsDir(), { recursive: true, force: true });
  await rm(path.dirname(pluginDataFolder("any")), { recursive: true, force: true });
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

test("saving one setting keeps the others, and an empty value clears it", async () => {
  await install(
    "box",
    {
      settings: [
        { key: "url", label: "URL", type: "text" },
        { key: "token", label: "Token", type: "password" },
      ],
    },
    "export default {};",
  );
  const save = (settings: Record<string, unknown>) =>
    routes(admin).request("/plugins/box", json("PUT", { settings }));
  const stored = async () =>
    (await listPlugins()).plugins.find((plugin) => plugin.id === "box")?.settings;

  await save({ url: "https://box.test" });
  await save({ token: "secret" });
  assert.deepEqual(await stored(), { url: "https://box.test", token: "secret" });
  await save({ url: "" });
  assert.deepEqual(await stored(), { token: "secret" });
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
  assert.equal((await routes(admin).request("/plugins/broken", { method: "DELETE" })).status, 200);
  assert.deepEqual(
    (await listPlugins()).plugins.map((plugin) => plugin.id),
    ["future", "renamed"],
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

test("a turned-off capability is hidden and refused while the rest of the plugin works", async () => {
  await install(
    "box",
    {
      actions: [
        { id: "send", label: "Send to Box", target: "playlist" },
        { id: "share", label: "Share on Box", target: "playlist" },
      ],
    },
    `export default { actions: { send: () => null, share: () => null } };`,
  );
  await turnOn("box", { capabilities: { "action:send": false } });
  const playlistId = ownedPlaylist();

  assert.deepEqual(
    (await actionsFor(owner)).map((action: { id: string }) => action.id),
    ["share"],
  );
  assert.equal((await run(owner, "box", "send", playlistId)).status, 404);
  assert.equal((await run(owner, "box", "share", playlistId)).status, 200);
  assert.equal((await turnOn("box", { capabilities: { "action:nope": false } })).status, 400);

  await turnOn("box", { capabilities: { "action:send": true } });
  assert.equal((await actionsFor(owner)).length, 2);
});

test("album and track actions get the Library's album and tracks", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-plugin-library-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  for (const [index, title] of ["Night Drive", "Morning Run"].entries())
    await writeFlacFixture(path.join(root, `0${index + 1}.flac`), {
      title,
      artist: "Glass Coast",
      album_artist: "Glass Coast",
      album: "Lowlands",
      track: index + 1,
    });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const library = getLibrary({ availableOnly: true });
  const album = library.albums.find((entry) => entry.title === "Lowlands");
  assert.ok(album);
  const trackIds = library.tracks.map((track) => track.id);

  await install(
    "tags",
    {
      actions: [
        { id: "album", label: "Album", target: "album" },
        { id: "tracks", label: "Tracks", target: "track" },
      ],
    },
    `export default { actions: {
      album: ({ album }) => ({ message: album.artist + " / " + album.title + ": " + album.tracks.map((track) => track.trackNumber + " " + track.title).join(", ") }),
      tracks: ({ tracks }) => ({ message: tracks.map((track) => track.title + " @ " + track.album + " " + (track.path !== null)).sort().join(", ") }),
    } };`,
  );
  await turnOn("tags");
  const runOn = (action: string, body: object) =>
    routes(owner).request(`/plugins/tags/actions/${action}`, json("POST", body));

  assert.deepEqual(await (await runOn("album", { albumId: album.id })).json(), {
    message: "Glass Coast / Lowlands: 1 Night Drive, 2 Morning Run",
  });
  assert.deepEqual(await (await runOn("tracks", { trackIds })).json(), {
    message: "Morning Run @ Lowlands true, Night Drive @ Lowlands true",
  });
  assert.equal((await runOn("album", { albumId: "missing" })).status, 404);
});

test("a background action answers right away and reports its result to the user who ran it", async () => {
  await install(
    "slow",
    { actions: [{ id: "sync", label: "Sync", target: "playlist", background: true }] },
    `export default { actions: { sync: async () => ({ message: "Synced 12 tracks" }) } };`,
  );
  await turnOn("slow");
  const playlistId = ownedPlaylist();
  const finished = new Promise<unknown[]>((resolve) => {
    vi.spyOn(websocketService, "broadcast").mockImplementation((...args) => {
      resolve(args);
      return 1;
    });
  });

  assert.deepEqual(await (await run(owner, "slow", "sync", playlistId)).json(), {
    message: "Sync started",
  });
  assert.deepEqual(await finished, [
    "plugins",
    { type: "plugin_action_finished", ok: true, message: "Synced 12 tracks" },
    { userId: owner.id },
  ]);
});

test("an event is queued for each subscribed plugin and delivered with its data", async (t) => {
  const folder = await mkdtemp(path.join(tmpdir(), "aurral-plugin-event-"));
  t.onTestFinished(() => rm(folder, { recursive: true, force: true }));
  const out = path.join(folder, "played.json");
  await install(
    "scrobble",
    { events: ["track.played"], settings: [{ key: "out", label: "Out", type: "text" }] },
    `export default { events: { "track.played": async (input) => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(input.settings.out, JSON.stringify(input));
    } } };`,
  );
  const queued = () =>
    listHonkerJobs("_outbox:notifications").filter(
      (job) => v.parse(queuedNotificationSchema, job.payload).kind === "plugin",
    );
  const played = { track: { title: "Night Drive" }, playedAt: 5 };

  emitPluginEvent("track.played", played);
  assert.equal(queued().length, 0);

  await turnOn("scrobble", { settings: { out }, capabilities: { "event:track.played": false } });
  emitPluginEvent("track.played", played);
  assert.equal(queued().length, 0);

  await turnOn("scrobble", { capabilities: { "event:track.played": true } });
  emitPluginEvent("track.played", played);
  const [job] = queued();
  assert.ok(job);
  await deliverQueuedNotification(v.parse(queuedNotificationSchema, job.payload));
  const input = JSON.parse(await readFile(out, "utf8"));
  assert.equal(input.event, "track.played");
  assert.deepEqual(input.track, { title: "Night Drive" });
  assert.equal(input.playedAt, 5);
  assert.equal(typeof input.libraryFolder, "string");

  emitPluginEvent("track.played", played);
  const [stale] = queued();
  assert.ok(stale);
  await install(
    "scrobble",
    { settings: [{ key: "out", label: "Out", type: "text" }] },
    "export default {};",
  );
  for (let attempt = 0; attempt < 3; attempt += 1)
    await deliverQueuedNotification(v.parse(queuedNotificationSchema, stale.payload));
  assert.equal((await listPlugins()).plugins[0]?.enabled, true);
});

test("an import list previews links on its hosts and refuses others", async () => {
  await install(
    "camp",
    { importList: { label: "Bandcamp", hosts: ["bandcamp.com"] } },
    `export default { importList: { fetch: ({ url }) => ({
      name: "Picks from " + new URL(url).hostname,
      tracks: [{ artist: "Glass Coast", title: "Night Drive" }, { artist: "", title: "" }],
    }) } };`,
  );
  await turnOn("camp");
  const preview = (url: string) =>
    routes(owner).request("/plugins/camp/import/preview", json("POST", { url }));

  const response = await preview("https://glasscoast.bandcamp.com/album/lowlands");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.playlist.name, "Picks from glasscoast.bandcamp.com");
  assert.equal(body.trackCount, 1);
  assert.equal(body.skipped, 1);
  assert.equal((await preview("https://example.com/list")).status, 400);
});

test("a scheduled plugin runs once its interval passes and keeps files in its data folder", async () => {
  await install(
    "ticker",
    { schedule: "1h" },
    `import { readFile, writeFile } from "node:fs/promises";
    export default { async scheduled({ dataFolder }) {
      const file = dataFolder + "/runs";
      await writeFile(file, String(Number(await readFile(file, "utf8").catch(() => "0")) + 1));
    } };`,
  );
  const start = Date.now();
  const hours = (count: number) => start + count * 60 * 60_000;

  assert.deepEqual(await runDuePluginSchedules(start), []);
  await turnOn("ticker");
  assert.deepEqual(await runDuePluginSchedules(start), ["ticker"]);
  assert.deepEqual(await runDuePluginSchedules(hours(0.5)), []);
  assert.deepEqual(await runDuePluginSchedules(hours(1)), ["ticker"]);
  assert.equal(await readFile(path.join(pluginDataFolder("ticker"), "runs"), "utf8"), "2");

  await turnOn("ticker", { capabilities: { schedule: false } });
  assert.deepEqual(await runDuePluginSchedules(hours(3)), []);
  await routes(admin).request("/plugins/ticker", { method: "DELETE" });
  await assert.rejects(access(pluginDataFolder("ticker")));
});

test("a plugin's API key acts as an admin only while the plugin can run", async () => {
  await install("helper", { apiAccess: true }, "export default {};");
  await turnOn("helper");
  const plugin = activePlugin("helper");
  assert.ok(plugin);
  const key = pluginInput(plugin).api?.key ?? "";
  const userFor = (apiKey: string) => resolveRequestUser({ headers: { "x-api-key": apiKey } });

  assert.deepEqual(
    { username: userFor(key)?.username, role: userFor(key)?.role },
    { username: "plugin:helper", role: "admin" },
  );
  assert.equal(userFor(`${key}x`), null);

  await routes(admin).request("/plugins/helper", json("PUT", { enabled: false }));
  assert.equal(userFor(key), null);
  assert.equal((await whilePluginTests("helper", async () => userFor(key)))?.role, "admin");

  await turnOn("helper", { capabilities: { api: false } });
  assert.equal(userFor(key), null);
  await turnOn("helper", { capabilities: { api: true } });
  setSafeMode(true);
  assert.equal(userFor(key), null);
});
