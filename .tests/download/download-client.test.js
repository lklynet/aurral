import assert from "node:assert/strict";
import test from "node:test";
import { assertDownloadClient } from "../../backend/services/download/downloadClient.js";
import { DownloadClientRegistry } from "../../backend/services/download/downloadClientRegistry.js";
import { getDownloadClientSettings } from "../../backend/services/download/downloadClientSettings.js";
import { NzbgetClient } from "../../backend/services/nzbgetClient.js";
import { SlskdClient } from "../../backend/services/slskdClient.js";
import { DeemixClient, buildQueueUuid } from "../../backend/services/deemixClient.js";
import { registerDownloadClients } from "../../backend/routes/settings/handlers/downloadClients.js";

function client(key, configured) {
  const updates = [];
  return {
    key,
    name: key,
    updates,
    isConfigured: () => configured,
    testConnection: async () => ({ ok: true, configured: true }),
    getStatus: () => ({ configured }),
    updateConfig: (config) => updates.push(config),
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

test("download adapters expose settings metadata without field values", () => {
  const settings = getDownloadClientSettings();

  assert.deepEqual(Object.keys(settings), ["slskd", "ytdlp", "nzbget", "sabnzbd", "deemix"]);
  assert.deepEqual(settings.nzbget.validation.required, ["url"]);
  assert.equal(settings.sabnzbd.fields.find((field) => field.key === "apiKey").secret, true);
  assert.equal(settings.ytdlp.fields.find((field) => field.key === "stagingPath").type, "path");
  assert.deepEqual(settings.deemix.validation.required, ["url"]);
  assert.equal(settings.deemix.fields.find((field) => field.key === "bitrate").type, "select");
  for (const definition of Object.values(settings)) {
    for (const field of definition.fields) {
      assert.equal("value" in field, false);
      assert.equal("default" in field, false);
    }
  }
});

test("download client instances can receive adapter configuration", () => {
  const client = new NzbgetClient();

  client.updateConfig({ enabled: true, url: "http://nzbget.local" });
  assert.equal(client.isConfigured(), true);
  client.updateConfig({ enabled: false, url: "http://nzbget.local" });
  assert.equal(client.isConfigured(), false);
});

test("deemix needs an enabled adapter with a server URL", () => {
  const client = new DeemixClient({ enabled: false, url: "http://deemix.local" });

  assert.equal(client.isConfigured(), false);
  client.updateConfig({ enabled: true, url: "http://deemix.local" });
  assert.equal(client.isConfigured(), true);
  assert.equal(client.getBitrate(), 9);
  client.updateConfig({ enabled: true, url: "http://deemix.local", bitrate: "3" });
  assert.equal(client.getBitrate(), 3);
  client.updateConfig({ enabled: true, url: "http://deemix.local", bitrate: 7 });
  assert.equal(client.getBitrate(), 9);
  assert.equal(buildQueueUuid("3135556", 9), "track_3135556_9");
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

test("download client test routes validate transient URLs", async () => {
  const routes = [];
  const router = {
    get(path, handler) {
      routes.push({ method: "GET", path, handler });
    },
    post(path, handler) {
      routes.push({ method: "POST", path, handler });
    },
  };
  registerDownloadClients(router);
  const route = routes.find(
    ({ method, path }) => method === "POST" && path === "/download-clients/:key/test",
  );
  const response = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };

  await route.handler(
    {
      params: { key: "nzbget" },
      body: { url: "http://169.254.169.254" },
    },
    response,
  );

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.payload, {
    error: "Connection failed",
    message: "Server URL: Target host is blocked",
  });
});
