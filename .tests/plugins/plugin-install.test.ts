import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterAll, afterEach, beforeEach, test, vi } from "vite-plus/test";
import {
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";

const [
  state,
  { db },
  { default: pluginRoutes },
  { default: mcpRoutes },
  { pluginsDir },
  { stopAllPlugins },
  { listPlugins, updatePlugin },
  {
    checkPluginUpdates,
    inspectPluginLink,
    installPluginLink,
    unpackPluginArchive,
    updatePluginFromSource,
  },
  { pendingLidarrConversion, setUpLidarrPlugin },
  { encryptWithKey },
  { getSettingsEncryptionKey },
] = await setupIsolatedBackend(
  "plugin-install",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/routes/plugins.ts"),
  () => import("../../backend/routes/mcp.ts"),
  () => import("../../backend/services/plugins/pluginManifest.ts"),
  () => import("../../backend/services/plugins/pluginHost.ts"),
  () => import("../../backend/services/plugins/pluginService.ts"),
  () => import("../../backend/services/plugins/pluginInstaller.ts"),
  () => import("../../backend/services/lidarrConversionReport.ts"),
  () => import("../../backend/config/encryption.ts"),
  () => import("../../backend/db/helpers/settings.ts"),
);

const admin = signedInAs(testUser(1, { username: "admin", role: "admin" })).route(
  "/",
  pluginRoutes,
);

function zip(files: Record<string, string>) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const packed = zlib.deflateRawSync(data);
    const fileName = Buffer.from(name);
    const fields = (header: Buffer, at: number) => {
      header.writeUInt16LE(8, at);
      header.writeUInt32LE(zlib.crc32(data), at + 6);
      header.writeUInt32LE(packed.length, at + 10);
      header.writeUInt32LE(data.length, at + 14);
      header.writeUInt16LE(fileName.length, at + 18);
    };
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    fields(local, 8);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    fields(central, 10);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, packed);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const manifest = (version: string, id = "box") =>
  JSON.stringify({
    id,
    name: "Box",
    version,
    api: 1,
    actions: [{ id: "send", label: "Send to Box", target: "playlist" }],
  });
const plugin = (version: string) =>
  zip({
    "box-main/manifest.json": manifest(version),
    "box-main/index.js": `export default { actions: { send: () => ({ message: "${version}" }) } };`,
  });

let scratch = "";

beforeEach(async () => {
  resetDatabase(db);
  scratch = await mkdtemp(path.join(tmpdir(), "aurral-plugin-install-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  stopAllPlugins();
  await rm(pluginsDir(), { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

afterAll(async () => {
  await cleanupIsolatedState(state);
});

test("a plugin installs off from a compressed zip link and updates from the same link", async (t) => {
  let served = plugin("1.0.0");
  const server = await createMockHttpServer((_request, response) => response.end(served));
  t.onTestFinished(server.close);
  const url = `${server.url}/box.zip`;

  const inspected = await inspectPluginLink(url);
  assert.deepEqual(
    inspected.plugins.map((found) => [found.manifest.id, found.installedVersion]),
    [["box", null]],
  );
  assert.equal((await listPlugins()).plugins.length, 0);

  await installPluginLink(inspected.token, ["box"]);
  const [installed] = (await listPlugins()).plugins;
  assert.equal(installed?.manifest?.version, "1.0.0");
  assert.equal(installed?.enabled, false);
  assert.equal(installed?.sourceUrl, url);
  await assert.rejects(installPluginLink(inspected.token, ["box"]), /Check the link again/);

  served = plugin("1.1.0");
  await updatePluginFromSource("box");
  assert.equal((await listPlugins()).plugins[0]?.manifest?.version, "1.1.0");
});

test("a GitHub repo link offers each plugin in it and installs the ones chosen", async (t) => {
  let version = "1.0.0";
  const requested: string[] = [];
  const server = await createMockHttpServer((request, response) => {
    requested.push(String(request.url));
    if (request.url === "/repos/you/aurral-plugins/releases/latest") {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.end(
      zip({
        "you-aurral-plugins-1a2b/README.md": "",
        "you-aurral-plugins-1a2b/plugins/box/manifest.json": manifest(version),
        "you-aurral-plugins-1a2b/plugins/box/index.js": "export default {};",
        "you-aurral-plugins-1a2b/plugins/crate/manifest.json": manifest(version, "crate"),
        "you-aurral-plugins-1a2b/plugins/crate/index.js": "export default {};",
        "you-aurral-plugins-1a2b/plugins/broken/manifest.json": "{",
      }),
    );
  });
  t.onTestFinished(server.close);
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    realFetch(String(input).replace("https://api.github.com", server.url), init),
  );
  const repo = "https://github.com/you/aurral-plugins";

  const inspected = await inspectPluginLink(repo);
  assert.deepEqual(
    inspected.plugins.map((found) => found.manifest.id),
    ["box", "crate"],
  );
  assert.deepEqual(inspected.problems, [
    { folder: "plugins/broken", error: "manifest.json is not valid JSON" },
  ]);
  assert.deepEqual(requested, [
    "/repos/you/aurral-plugins/releases/latest",
    "/repos/you/aurral-plugins/zipball",
  ]);

  assert.deepEqual(await installPluginLink(inspected.token, ["crate"]), {
    installed: [{ id: "crate", version: "1.0.0" }],
  });
  await installPluginLink(inspected.token, ["box"]);
  await assert.rejects(installPluginLink(inspected.token, ["box"]), /Check the link again/);

  version = "1.1.0";
  await updatePluginFromSource("crate");
  assert.deepEqual(
    (await listPlugins()).plugins.map((plugin) => [
      plugin.id,
      plugin.manifest?.version,
      plugin.sourceUrl,
    ]),
    [
      ["box", "1.0.0", repo],
      ["crate", "1.1.0", repo],
    ],
  );
});

test("an install converted from Lidarr sets up the official Lidarr plugin with Lidarr's saved connection", async (t) => {
  const requested: string[] = [];
  const server = await createMockHttpServer((request, response) => {
    requested.push(String(request.url));
    if (request.url === "/repos/lklynet/aurral-plugins/releases/latest") {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.end(
      zip({
        "aurral-plugins-1a2b/lidarr/manifest.json": JSON.stringify({
          id: "lidarr",
          name: "Lidarr",
          version: "1.0.0",
          api: 1,
          settings: [
            { key: "url", label: "Lidarr URL", type: "text", required: true },
            { key: "apiKey", label: "API key", type: "password", required: true },
            { key: "rootFolder", label: "Root folder for new artists", type: "text" },
          ],
          test: true,
        }),
        "aurral-plugins-1a2b/lidarr/index.js": `export default {
          test: ({ settings }) => {
            if (settings.apiKey !== "key") throw new Error("Lidarr answered HTTP 401");
            return { message: "Connected" };
          },
        };`,
        "aurral-plugins-1a2b/box/manifest.json": manifest("1.0.0"),
        "aurral-plugins-1a2b/box/index.js": "export default {};",
      }),
    );
  });
  t.onTestFinished(server.close);
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    realFetch(String(input).replace("https://api.github.com", server.url), init),
  );
  db.prepare("INSERT INTO settings (key, value) VALUES ('lidarrConversion', ?)").run(
    JSON.stringify({
      convertedAt: 1,
      folders: [],
      connection: {
        url: "http://lidarr.test",
        apiKey: encryptWithKey("old", getSettingsEncryptionKey()),
        rootFolder: "",
      },
    }),
  );
  const lidarr = async () => {
    const { plugins } = await listPlugins();
    return plugins.map((plugin) => [plugin.id, plugin.enabled, plugin.settings, plugin.sourceUrl]);
  };

  await assert.rejects(setUpLidarrPlugin(), /HTTP 401/);
  assert.deepEqual(await lidarr(), [
    [
      "lidarr",
      false,
      { url: "http://lidarr.test", apiKey: "old" },
      "https://github.com/lklynet/aurral-plugins",
    ],
  ]);

  updatePlugin("lidarr", { settings: { apiKey: "key" } });
  assert.deepEqual(await setUpLidarrPlugin(), { message: "Connected" });
  assert.deepEqual(await lidarr(), [
    [
      "lidarr",
      true,
      { url: "http://lidarr.test", apiKey: "key" },
      "https://github.com/lklynet/aurral-plugins",
    ],
  ]);
  assert.equal(requested.length, 2);
  assert.equal(pendingLidarrConversion(), null);
});

test("the daily check finds newer versions with what they add, and Update all installs them", async (t) => {
  let box = manifest("1.0.0");
  const server = await createMockHttpServer((_request, response) =>
    response.end(
      zip({
        "plugins/box/manifest.json": box,
        "plugins/box/index.js": "export default {};",
        "plugins/crate/manifest.json": manifest("1.0.0", "crate"),
        "plugins/crate/index.js": "export default {};",
      }),
    ),
  );
  t.onTestFinished(server.close);
  const inspected = await inspectPluginLink(`${server.url}/plugins.zip`);
  await installPluginLink(inspected.token, ["box", "crate"]);
  const updates = async () => {
    const list = await listPlugins();
    return {
      checkedAt: list.updatesCheckedAt,
      plugins: list.plugins.map((plugin) => [
        plugin.id,
        plugin.manifest?.version,
        plugin.update?.version,
        plugin.update?.adds.map((capability) => capability.key),
      ]),
    };
  };

  box = JSON.stringify({ ...JSON.parse(manifest("1.1.0")), apiAccess: true });
  await checkPluginUpdates(1000);
  assert.deepEqual(await updates(), {
    checkedAt: 1000,
    plugins: [
      ["box", "1.0.0", "1.1.0", ["api"]],
      ["crate", "1.0.0", undefined, undefined],
    ],
  });

  const response = await admin.request("/plugins/updates", { method: "POST" });
  assert.deepEqual(await response.json(), { installed: [{ id: "box", version: "1.1.0" }] });
  assert.deepEqual((await updates()).plugins, [
    ["box", "1.1.0", undefined, undefined],
    ["crate", "1.0.0", undefined, undefined],
  ]);
});

test("a zip with a path outside its folder is refused before anything is written", async () => {
  const archive = path.join(scratch, "evil.zip");
  await writeFile(
    archive,
    zip({ "manifest.json": manifest("1.0.0"), "index.js": "", "../escaped.js": "" }),
  );
  const target = path.join(scratch, "plugin");

  await assert.rejects(unpackPluginArchive(archive, target), /a path outside its folder/);
  await assert.rejects(access(path.join(scratch, "escaped.js")));

  const nested = path.join(scratch, "nested.zip");
  await writeFile(
    nested,
    zip({ "repo/manifest.json": manifest("1.0.0"), "repo/index.js": "", "repo/../escaped.js": "" }),
  );
  await assert.rejects(unpackPluginArchive(nested, target), /a path outside its folder/);
  await assert.rejects(access(path.join(scratch, "escaped.js")));
});

test("an agent with a developer key writes and tests a plugin over MCP, and it stays off", async () => {
  let id = 0;
  const rpc = (key: string | null, method: string, params: object = {}) =>
    mcpRoutes.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key && { Authorization: `Bearer ${key}` }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: (id += 1), method, params }),
    });
  const call = async (key: string, name: string, args: object) => {
    const { result } = await (await rpc(key, "tools/call", { name, arguments: args })).json();
    return { ...result, text: result.content[0].text };
  };

  assert.equal((await rpc("aurral_dev_guess", "tools/list")).status, 401);
  const { key } = await (await admin.request("/plugins/dev-keys", { method: "POST" })).json();
  assert.equal(
    (await (await rpc(key, "initialize")).json()).result.serverInfo.name,
    "aurral-plugins",
  );
  assert.match((await call(key, "plugin_docs", {})).text, /## Download sources/);

  const broken = await call(key, "write_plugin", {
    id: "box",
    manifest: { id: "box", name: "Box", version: "1", api: 1, actions: [{ id: "send" }] },
    code: "export default {};",
  });
  assert.match(JSON.parse(broken.text).error, /actions\.0\.label/);

  const written = await call(key, "write_plugin", {
    id: "box",
    manifest: JSON.parse(manifest("1.0.0")),
    code: `export default { actions: { send: ({ playlist, user }) => { console.log("sending"); return { message: user.username + " sent " + playlist.name }; } } };`,
  });
  assert.equal(JSON.parse(written.text).loads, true);

  const tested = JSON.parse(
    (
      await call(key, "test_plugin", {
        id: "box",
        path: "actions.send",
        input: { playlist: { name: "Road trip" } },
      })
    ).text,
  );
  assert.deepEqual(tested.answer, { message: "agent sent Road trip" });
  assert.ok(tested.logs.some((line: { message: string }) => line.message === "sending"));
  assert.equal((await listPlugins()).plugins[0]?.enabled, false);

  await admin.request("/plugins/box", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  const refused = await call(key, "write_plugin", {
    id: "box",
    manifest: JSON.parse(manifest("1.0.1")),
    code: "export default {};",
  });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /box is on/);

  const [listed] = (await (await admin.request("/plugins/dev-keys")).json()).keys;
  await admin.request(`/plugins/dev-keys/${listed.id}`, { method: "DELETE" });
  assert.equal((await rpc(key, "tools/list")).status, 401);
});
