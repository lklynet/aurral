import assert from "node:assert/strict";
import test from "node:test";
import { assertDownloadClient } from "../../backend/services/download/downloadClient.js";
import { DownloadClientRegistry } from "../../backend/services/download/downloadClientRegistry.js";
import { getDownloadClientSettings } from "../../backend/services/download/downloadClientSettings.js";
import { NzbgetClient } from "../../backend/services/nzbgetClient.js";

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

  assert.deepEqual(Object.keys(settings), ["slskd", "ytdlp", "nzbget", "sabnzbd"]);
  assert.deepEqual(settings.nzbget.validation.required, ["url"]);
  assert.equal(settings.sabnzbd.fields.find((field) => field.key === "apiKey").secret, true);
  assert.equal(settings.ytdlp.fields.find((field) => field.key === "stagingPath").type, "path");
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
