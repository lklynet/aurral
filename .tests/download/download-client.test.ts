import { listeningAddress } from "../helpers/backendTestHarness.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "vite-plus/test";
import { assertDownloadClient } from "../../backend/services/download/downloadClient.ts";
import { DownloadClientRegistry } from "../../backend/services/download/downloadClientRegistry.ts";
import { SlskdClient } from "../../backend/services/slskdClient.ts";
import {
  DeemixClient,
  buildQueueUuid,
  describeBitrateSupport,
} from "../../backend/services/deemixClient.ts";
import { QUALITY_TIERS } from "../../backend/services/qualityProfileModel.ts";

function client(key: string, configured: boolean) {
  const updates: unknown[] = [];
  return {
    key,
    name: key,
    updates,
    isConfigured: () => configured,
    testConnection: async () => ({ ok: true, configured: true }),
    getStatus: () => ({ configured }),
    updateConfig: (config: unknown) => updates.push(config),
  };
}

test("download client registry validates, updates, and selects adapters", () => {
  const first = client("first", true);
  const second = client("second", false);
  const registry = new DownloadClientRegistry([first, second]);

  registry.updateConfig({ first: { url: "first" }, second: { url: "second" } });

  assert.equal(registry.get("first"), first);
  assert.deepEqual(registry.getAll(), [first, second]);
  assert.deepEqual(registry.getConfigured(), [first]);
  assert.deepEqual(first.updates, [{ url: "first" }]);
  assert.deepEqual(second.updates, [{ url: "second" }]);
  assert.throws(
    () => assertDownloadClient({ isConfigured() {} }),
    /DownloadClient\.testConnection must be a function/,
  );
});

test("deemix needs an enabled adapter with a server URL", () => {
  const client = new DeemixClient({ enabled: false, url: "http://deemix.local" });

  assert.equal(client.isConfigured(), false);
  client.updateConfig({ enabled: true, url: "http://deemix.local" });
  assert.equal(client.isConfigured(), true);
  assert.equal(client.getBitrate(), 9);
  client.updateConfig({ enabled: true, url: "http://deemix.local", bitrate: 3 });
  assert.equal(client.getBitrate(), 3);
  client.updateConfig({ enabled: true, url: "http://deemix.local", bitrate: 7 });
  assert.equal(client.getBitrate(), 9);
  assert.equal(buildQueueUuid("3135556", 9), "track_3135556_9");
});

test("deemix maps each bitrate to a real quality tier", () => {
  const client = new DeemixClient({ enabled: true, url: "http://deemix.local" });
  const tierIds = new Set(QUALITY_TIERS.map((tier) => tier.id));

  for (const [bitrate, expected] of [
    [9, "flac-standard"],
    [3, "mp3-320"],
    [1, "mp3-128"],
  ] as const) {
    client.updateConfig({ enabled: true, url: "http://deemix.local", bitrate });
    assert.equal(client.getQualityTierId(), expected);
    assert.equal(tierIds.has(expected), true);
  }
});

test("deemix reports a bitrate the Deezer plan cannot stream", () => {
  const free = { can_stream_lossless: false, can_stream_hq: false };
  const hifi = { can_stream_lossless: true, can_stream_hq: true };

  assert.match(describeBitrateSupport(free, 9) ?? "", /cannot stream FLAC/);
  assert.match(describeBitrateSupport(free, 3) ?? "", /cannot stream MP3 320/);
  assert.equal(describeBitrateSupport(free, 1), null);
  assert.equal(describeBitrateSupport(hifi, 9), null);
  assert.equal(describeBitrateSupport(undefined, 9), null);
});

test("slskd treats an explicitly disabled adapter as unconfigured", () => {
  const client = new SlskdClient({
    enabled: false,
    url: "http://slskd.local",
    apiKey: "test-key",
  });

  assert.equal(client.isConfigured(), false);
  client.updateConfig({ url: "http://slskd.local", apiKey: "test-key" });
  assert.equal(client.isConfigured(), true);
});

test("slskd test connection requires a URL but not an API key", async () => {
  const missingUrl = new SlskdClient({ enabled: true });
  const missingUrlResult = await missingUrl.testConnection({ force: true });
  assert.equal(missingUrlResult.configured, false);
  assert.equal(missingUrlResult.message, "slskd URL is required");

  const urlOnly = new SlskdClient({ enabled: true, url: "http://127.0.0.1:1" });
  const urlOnlyResult = await urlOnly.testConnection({ force: true });
  assert.equal(urlOnlyResult.configured, true);
  assert.equal(urlOnlyResult.ok, false);
});

test("slskd omits the X-API-KEY header when no API key is set", async () => {
  const headers: (string | string[] | undefined)[] = [];
  const server = createServer((req, res) => {
    headers.push(req.headers["x-api-key"]);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        server: { state: "Connected", isConnected: true },
        directories: {},
      }),
    );
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = listeningAddress(server);
    const url = `http://127.0.0.1:${port}`;

    const urlOnly = new SlskdClient({ enabled: true, url });
    assert.equal((await urlOnly.testConnection({ force: true })).ok, true);

    const withKey = new SlskdClient({ enabled: true, url, apiKey: "secret-key" });
    assert.equal((await withKey.testConnection({ force: true })).ok, true);

    assert.deepEqual(headers.slice(0, 2), [undefined, undefined]);
    assert.deepEqual(headers.slice(2, 4), ["secret-key", "secret-key"]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("download client test routes validate transient URLs", async () => {
  const { api } = await import("../../backend/routes/api.ts");
  const app = signedInAs(testUser(1, { role: "admin" })).route("/", api);

  const response = await app.request("/settings/download-clients/nzbget/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "http://169.254.169.254" }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "Connection failed",
    message: "Server URL: Target host is blocked",
  });
});
